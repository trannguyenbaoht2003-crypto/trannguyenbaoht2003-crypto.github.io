# Public Feedback Intake Runbook

## Purpose

Sprint 7B adds a narrow anonymous feedback channel for readers of a published guide. Feedback is **community signal only**. It is not Evidence and cannot directly create HumanReview, Moderation, Eligibility, Publication, rollback/retraction, or Sprint 7A monitoring state.

Repository integration does not enable the feature in production. `FEEDBACK_INTAKE_ENABLED` defaults to `false` and checked-in staging/production examples keep it disabled.

## Public endpoint

`POST /api/v1/publications/:publicationId/feedback`

Required headers:

- `Content-Type: application/json`
- `X-Hai-Dau-Feedback: web-v1`
- `X-Hai-Dau-Client-IP` is **not a browser contract**. The public Caddy gateway overwrites this header with `{remote_host}` before proxying `/api/v1/*` to the private backend.

Body:

```json
{
  "schemaVersion": 1,
  "submissionId": "uuid",
  "publicationVersionId": "uuid",
  "reasonCode": "WRONG_ITEMS",
  "details": "Optional plain text"
}
```

Reason codes:

- `OUTDATED`
- `WRONG_BUILD`
- `WRONG_ITEMS`
- `WRONG_AUGMENTS`
- `MISMATCHED_CHAMPION`
- `OTHER`

`OTHER` requires details. Details are NFC-normalized, trimmed, whitespace-collapsed, limited to 280 Unicode characters, and reject control characters and URL-like content. The route body limit is 2 KiB.

Responses:

- `202`: accepted or exact replay;
- `400`: malformed feedback contract;
- `404`: Publication/PublicationVersion ownership not found;
- `409`: `submissionId` reused with a different canonical request;
- `413`: body too large;
- `429`: anonymous abuse limit exceeded;
- `503`: enabled intake cannot safely complete Redis/PostgreSQL work.

## Idempotency and replay order

The browser creates one `submissionId` per semantic report and reuses it when retrying the same report.

PostgreSQL is the final idempotency authority through unique `client_submission_id` + canonical `request_hash`:

1. unseen ID + valid target -> insert one immutable receipt;
2. same ID + same hash -> `202` replay, no second row;
3. same ID + different hash -> `409`.

Redis also stores an expiring replay marker keyed by the HMAC fingerprint + `submissionId`. The first new signal consumes rate-limit quota and creates the marker. A retry with the same marker returns `replay_pass` and does not consume quota again. That marker never proves a PostgreSQL receipt exists; PostgreSQL still decides insert/replay/conflict.

## Anonymous abuse controls

Redis prefix: `hai-dau:feedback:v1:`.

Limits for a new signal:

- burst: 5 per fingerprint / 10 minutes;
- daily: 20 per fingerprint / 24 hours;
- duplicate signal: same fingerprint + PublicationVersion + reason code once / 30 minutes;
- replay marker TTL: 24 hours.

All four checks/updates happen in one atomic Redis script. Redis failure is fail-closed for feedback POST. Public Publication GET does not depend on the feedback limiter.

## Trusted network identity and privacy

The backend does not use arbitrary browser forwarding headers for anonymous identity. Both staging and production Caddy overwrite:

```caddy
header_up X-Hai-Dau-Client-IP {remote_host}
```

The enabled backend validates that value as IPv4/IPv6 and computes:

`HMAC-SHA256(FEEDBACK_FINGERPRINT_SECRET, canonical_ip)`

The raw address is discarded after fingerprinting.

Do not persist or log:

- raw IP;
- IP fingerprint;
- user-agent;
- cookies;
- authorization values;
- session/account/email/contact identity;
- feedback detail text;
- `FEEDBACK_FINGERPRINT_SECRET`.

PostgreSQL `publication_feedback_submissions` deliberately contains none of those fields. The table is append-only.

## PostgreSQL authority

Migration: `0013_publication_feedback_intake.sql`.

`publication_feedback_submissions` pins both `publication_id` and `publication_version_id` through a composite foreign key. Historical immutable PublicationVersions remain valid targets, and each receipt records whether that version was active when the database transaction accepted it.

Do not UPDATE or DELETE feedback receipts. The database immutable trigger rejects both.

Anonymous feedback creates no trust-domain outbox event. It is not routed to eligibility, monitoring, or publication queues.

## Internal signal reader

`readPublicationFeedbackSignals(pool, options)` is an internal PostgreSQL-only read boundary. It groups recent receipts by exact PublicationVersion, marks the currently active version, returns bounded counts by reason, and samples only a small number of recent detail strings.

Defaults:

- lookback: 168 hours;
- result limit: 50;
- detail samples: 3.

Caps:

- lookback: 720 hours;
- result limit: 100;
- detail samples: 5.

There is no public feedback-history/count endpoint in Sprint 7B.

## Frontend behavior

Guides carrying `publicPublication` metadata expose `Báo lỗi nội dung`. The client sends the exact visible `publicationId` + `publicationVersionId` to the same-origin endpoint and does not add auth credentials or CORS behavior.

On temporary failure, the component preserves the same `submissionId` for retry. Changing the semantic report creates a new future submission ID. Feedback text is rendered only through ordinary React text nodes; no `dangerouslySetInnerHTML` is used.

Guide reading remains available when feedback is disabled, Redis is down, or feedback POST returns `503`.

## Feature configuration

Disabled/default:

```text
FEEDBACK_INTAKE_ENABLED=false
```

Intentional enablement additionally requires server-only `FEEDBACK_FINGERPRINT_SECRET` with at least 32 UTF-8 bytes of unpredictable secret material.

Never commit, print, paste into chat, or expose that real secret to frontend code.

## Production enablement prerequisites

Production enablement is a separate delivery decision. Before enabling:

1. backend remains private behind the public gateway;
2. gateway client-IP overwrite is deployed and verified;
3. server-only fingerprint secret is provisioned through the production secret system;
4. `FEEDBACK_INTAKE_ENABLED=true` is intentionally configured;
5. live smoke checks verify 202/replay/429/503 behavior without logging raw network identity or details;
6. existing public Publication GET still works if Redis/feedback intake is unavailable.

Sprint 7B repository merge does **not** perform these production actions.

## Failure handling

- PostgreSQL unavailable: feedback POST -> `503`; public GET is independent.
- Redis unavailable: feedback POST -> `503` before a new un-rate-limited write.
- missing/weak secret while enabled: startup/config validation fails closed.
- missing/invalid gateway client IP: feedback fails closed; no untrusted X-Forwarded-For fallback.
- lost HTTP response: retry the same `submissionId`; Redis does not double-charge quota and PostgreSQL resolves exact replay.
- concurrent publish/rollback: immutable historical version remains a valid target; `was_active_at_submission` records the transaction-observed state.

## Verification

Repository contract:

```bash
npm run test:feedback-intake
```

Backend:

```bash
npm --prefix backend run typecheck
npm --prefix backend test
npm --prefix backend run build
```

Frontend:

```bash
npm run test:public-data
npm run build:pages
```

Dedicated CI: `Sprint 7B feedback intake gate` / `verify public feedback intake`.

The dedicated workflow is read-only and contains no deploy step.
