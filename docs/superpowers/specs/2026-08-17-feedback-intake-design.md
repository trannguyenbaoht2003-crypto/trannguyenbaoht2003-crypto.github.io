# Sprint 7B — Public Feedback Intake Design

**Status:** self-approved under standing project delegation  
**Base:** `main@44e4bd18b6dd604af17e3bbce4383a9e91b0b73f`  
**Scope:** anonymous, structured feedback about an immutable published guide version  
**Production delivery:** explicitly out of scope

## 1. Purpose

Sprint 7B adds a narrow public-write boundary so readers can report likely problems in a published guide without weakening the existing trust and Publication invariants.

The feature collects **community signal only**. A feedback submission is never Evidence, never a HumanReview, never a Moderation decision, never an Eligibility decision, never a Publication command, and never a post-publication monitoring alert by itself.

The authority boundary remains:

`Public reader -> validated/rate-limited feedback intake -> immutable PostgreSQL feedback record -> internal operator read boundary -> future human triage`

Any later change to trust or Publication state must still go through the existing Evidence / HumanReview / Moderation / Eligibility / Publication authorities.

## 2. Context and constraints

The production gateway already serves the frontend and reverse-proxies `/api/v1/*` to the backend on the same origin. Sprint 7B therefore does not need browser CORS expansion.

The public Publication API already exposes both `publicationId` and `publicationVersionId`. Feedback can therefore pin the exact immutable PublicationVersion the reader saw.

The backend already owns PostgreSQL and Redis connections. PostgreSQL remains the durable authority. Redis may be used only for short-lived abuse controls; Redis state must never decide or mutate Publication/trust authority.

Sprint 7A monitoring remains advisory and independent. Feedback does not open or resolve monitoring alerts in Sprint 7B.

## 3. Approaches considered

### A. Anonymous structured feedback — selected

Any reader may submit a bounded structured report without creating an account. Same-origin JSON requests are rate-limited and duplicate-suppressed. PostgreSQL stores the immutable report; Redis stores only short-lived keyed abuse state.

Benefits:
- lowest contribution friction;
- useful community signal immediately;
- no account/auth subsystem;
- keeps public write scope narrow;
- compatible with static frontend + same-origin production gateway.

Cost:
- requires explicit abuse/rate-limit controls;
- feedback must remain untrusted and isolated from trust authority.

### B. Authenticated reviewer-only feedback — rejected for 7B

Safer, but it does not collect community signal and duplicates existing reviewer/operator workflows.

### C. Hybrid anonymous reason + authenticated free text — rejected for 7B

Adds an authentication boundary before there is enough value to justify it. The selected design keeps optional free text highly bounded instead.

## 4. Goals

1. Accept anonymous public feedback for an existing PublicationVersion.
2. Pin every submission to both `publication_id` and `publication_version_id`.
3. Use a client-generated UUID submission ID for replay-safe idempotency.
4. Reject an idempotency key reused with a different normalized payload.
5. Apply short-lived abuse control before accepting new anonymous submissions.
6. Never persist raw IP addresses, user-agent strings, cookies, authorization headers, or the abuse fingerprint in PostgreSQL.
7. Keep optional detail text plain, short, non-HTML, non-link-bearing, and operator-only.
8. Keep feedback outside the Evidence / Review / Moderation / Eligibility / Publication / Monitoring state machines.
9. Preserve public-read availability when feedback intake is unavailable.
10. Provide an internal PostgreSQL-backed reader for feedback summaries and recent bounded samples.
11. Provide a minimal public frontend interaction for submitting feedback.
12. Add a dedicated CI/repository contract for the new public-write boundary.

## 5. Non-goals

Sprint 7B does **not** add:

- user accounts or login;
- CAPTCHA or a third-party anti-abuse vendor;
- voting, likes, comments, public discussion, or public feedback history;
- attachments, screenshots, URLs, Markdown, or rich text;
- email addresses or contact fields;
- automatic Evidence creation;
- automatic Moderation, Eligibility, Publication, rollback, hide, or retraction;
- automatic Sprint 7A monitoring alerts from feedback;
- operator mutation UI;
- notifications;
- machine-learning classification;
- production secret provisioning or production deployment.

## 6. Public HTTP contract

### Route

`POST /api/v1/publications/:publicationId/feedback`

The production gateway already proxies `/api/v1/*`; no Caddy routing expansion is required.

### Request headers

Required:

- `Content-Type: application/json`
- `X-Hai-Dau-Feedback: web-v1`

The custom header intentionally makes ordinary cross-site browser form submission insufficient. No CORS headers are added.

### Body

```json
{
  "schemaVersion": 1,
  "submissionId": "uuid",
  "publicationVersionId": "uuid",
  "reasonCode": "WRONG_ITEMS",
  "details": "Optional bounded plain text"
}
```

`details` is optional except for `OTHER`.

Allowed `reasonCode` values are exactly:

- `OUTDATED`
- `WRONG_BUILD`
- `WRONG_ITEMS`
- `WRONG_AUGMENTS`
- `MISMATCHED_CHAMPION`
- `OTHER`

Unknown properties are rejected.

### Payload limits

- route body limit: 2 KiB;
- `details`: 1–280 Unicode characters after normalization;
- `OTHER` requires non-empty `details`;
- other reasons may omit `details`;
- details are Unicode-NFC normalized, trimmed, and internal whitespace collapsed;
- ASCII control characters are rejected;
- URL-like content (`http://`, `https://`, `www.`) is rejected;
- details are always treated as plain text and are never rendered as HTML.

### Publication validation

The backend reloads PostgreSQL authority and requires:

- `publicationId` exists;
- `publicationVersionId` exists;
- that PublicationVersion belongs to the supplied Publication.

The version does **not** have to remain active at transaction time. A reader may legitimately submit feedback moments after a concurrent publish/rollback changed the active pointer. The immutable version remains a valid historical target.

The record stores whether the version was active when the backend accepted the submission so operators can distinguish current-version signals from raced/historical signals.

### Responses

- `202` — accepted or exact idempotent replay;
- `400` — malformed UUID/header/schema/body;
- `404` — Publication or PublicationVersion relationship not found;
- `409` — `submissionId` already exists with a different normalized request hash;
- `413` — body exceeds 2 KiB;
- `429` — anonymous abuse limit exceeded, with bounded `Retry-After`;
- `503` — feedback intake disabled/misconfigured or Redis/PostgreSQL intake dependency unavailable.

A successful response does not expose the server feedback row ID or any abuse-control metadata.

## 7. Idempotency contract

`submissionId` is generated by the browser with `crypto.randomUUID()` and reused for retries of the same user action.

The backend computes a canonical request hash from:

- schemaVersion;
- publicationId;
- publicationVersionId;
- reasonCode;
- normalized details or null.

PostgreSQL has a unique constraint on `client_submission_id`.

Behavior:

1. unseen ID + valid request -> insert once;
2. same ID + same canonical hash -> return the original accepted semantic result without another row;
3. same ID + different canonical hash -> `409 IDEMPOTENCY_CONFLICT`.

Redis is not the idempotency authority.

## 8. Abuse and privacy boundary

### Fingerprint

For rate limiting only, the backend computes:

`HMAC-SHA256(FEEDBACK_FINGERPRINT_SECRET, normalized request.ip)`

Rules:

- raw IP is never written to PostgreSQL;
- fingerprint is never written to PostgreSQL;
- user-agent is not part of durable data;
- logs must not contain raw IP, fingerprint, request body details, cookies, authorization, or the fingerprint secret;
- Redis keys contain only the keyed HMAC digest and bounded identifiers;
- all feedback abuse keys have TTLs;
- rotating the fingerprint secret may reset abuse counters; that is acceptable.

### Required server secret

`FEEDBACK_FINGERPRINT_SECRET` is required only when public feedback intake is enabled.

`FEEDBACK_INTAKE_ENABLED` defaults to `false` so merging the code cannot accidentally expose an unaudited public-write route in an existing environment. Staging/CI explicitly exercise enabled mode. Production enablement and secret provisioning remain a separate production gate.

### Rate limits

For a new anonymous submission:

- burst: max 5 accepted attempts per fingerprint per rolling 10 minutes;
- daily: max 20 accepted attempts per fingerprint per rolling 24 hours;
- duplicate signal: same fingerprint + PublicationVersion + reasonCode at most once per 30 minutes.

Exact idempotent retries of the same `submissionId` remain replay-safe in PostgreSQL. The limiter implementation must avoid using Redis as a source of domain truth.

### Redis failure

Feedback intake fails closed with `503` if the abuse-control operation cannot be completed. Public Publication GET routes remain independent and continue to work from PostgreSQL/public projection semantics.

## 9. PostgreSQL model

One forward-only migration follows `0012_post_publication_monitoring.sql`.

### `publication_feedback_submissions`

Append-only table:

- `id uuid primary key`
- `client_submission_id uuid not null unique`
- `request_hash text not null`
- `publication_id uuid not null`
- `publication_version_id uuid not null`
- `reason_code text not null`
- `details text null`
- `was_active_at_submission boolean not null`
- `received_at timestamptz not null`
- `created_at timestamptz not null default now()`

Constraints:

- composite FK proves `(publication_version_id, publication_id)` ownership against PublicationVersion authority;
- reason code check permits only the six 7B codes;
- details length check is `1..280` when non-null;
- `OTHER` requires details;
- append-only trigger rejects UPDATE and DELETE;
- no IP, fingerprint, user-agent, cookie, auth token, session ID, email, or account field exists.

The immutable row is the feedback receipt/audit record. Sprint 7B does not emit trust-domain audit/outbox events for anonymous feedback.

## 10. Backend components

### `modules/feedback/types.ts`

Defines the six reason codes, normalized command/result types, and internal read types.

### `modules/feedback/normalize-feedback-input.ts`

Pure function that:

- validates/normalizes reason and details;
- rejects control characters and URL-like details;
- computes canonical representation boundaries but performs no I/O.

### `modules/feedback/submit-publication-feedback.ts`

PostgreSQL authority function that:

- reloads Publication/PublicationVersion ownership;
- computes active-at-submission state;
- performs idempotency conflict detection;
- inserts exactly one immutable row;
- returns accepted/replayed/conflict/not-found domain outcomes;
- never imports or calls Publication, Trust, Moderation, Eligibility, or Monitoring mutation functions.

### `modules/feedback/feedback-rate-limiter.ts`

Redis-backed abuse boundary that:

- receives only a keyed HMAC fingerprint and bounded identifiers;
- uses an atomic Redis script/transaction to enforce burst, daily, and duplicate-signal windows;
- returns allow/deny/retry-after;
- has no PostgreSQL/domain mutation authority.

### `modules/feedback/read-publication-feedback-signals.ts`

Internal PostgreSQL reader only; no public GET route.

Returns bounded operator data such as:

- Publication/PublicationVersion IDs;
- current-active flag;
- counts by reason in a bounded recent window;
- newest receipt time;
- a small bounded list of recent plain-text details where present.

Default ordering prioritizes currently active versions, then highest recent report count, then newest receipt.

## 11. HTTP/application composition

`buildApp()` receives an optional feedback intake dependency.

If feedback intake is disabled, the POST route is not registered.

If enabled:

1. route validates header/content type/UUID/schema/body;
2. route derives the HMAC fingerprint from `request.ip` through an injected fingerprint function;
3. abuse limiter executes;
4. if allowed, normalized domain command is sent to PostgreSQL submission authority;
5. route maps domain outcome to bounded HTTP response;
6. logs use IDs/error codes only and never include detail text or fingerprint.

The existing public Publication GET reader remains unchanged and does not depend on the feedback service.

## 12. Frontend interaction

The public guide experience adds a small `Báo lỗi nội dung` action for a guide with a live `publicationId` + `publicationVersionId`.

Interaction:

1. open a compact feedback panel/modal;
2. choose one reason code;
3. optional details field, max 280 characters; required for `OTHER`;
4. frontend creates one `submissionId` for the submit attempt and reuses it for retry;
5. POST same-origin JSON with `X-Hai-Dau-Feedback: web-v1`;
6. on `202`, show a neutral acknowledgement and close/reset;
7. on `429`, show a bounded retry-later message;
8. on offline/503, show that feedback is temporarily unavailable without affecting guide reading.

No feedback count, user identity, comments, or moderation state is displayed publicly.

The frontend must escape all user-entered text by normal React rendering; it never uses `dangerouslySetInnerHTML` for feedback.

## 13. Trust isolation invariants

Sprint 7B has explicit source-level and integration tests proving:

- feedback modules do not import `publishCandidateRevision` or `rollbackPublication`;
- feedback modules do not call Evidence, HumanReview, Moderation, Eligibility, or Monitoring mutation authority;
- no `FeedbackSubmitted` event is routed into eligibility/monitoring/publication queues;
- no feedback table is joined into public Publication projection/read selection;
- feedback cannot hide, retract, replace, or mutate an active PublicationVersion;
- feedback counts alone cannot become Evidence.

## 14. Failure behavior

### PostgreSQL unavailable

POST returns `503`; public GET behavior remains governed by the existing public-read path.

### Redis unavailable

POST returns `503` fail-closed; no un-rate-limited write occurs.

### Fingerprint secret missing while enabled

Backend startup/config validation fails for the enabled intake dependency. Existing environments remain safe because intake defaults disabled.

### Duplicate/lost response

Client retry with the same submission ID produces an exact replay, not a second row.

### Publication activation changes during submit

The immutable target version remains valid. `was_active_at_submission` reflects the authority state observed by the submission transaction.

### Malicious detail text

Oversized, URL-bearing, control-character, or invalid `OTHER` payloads are rejected before persistence.

## 15. Security requirements

1. No CORS expansion.
2. JSON-only POST with custom feedback header.
3. Route-specific 2 KiB body limit.
4. Strict schema with `additionalProperties: false`.
5. No raw IP/fingerprint/user-agent/auth/cookie persistence.
6. HMAC secret never logged or returned.
7. Feedback detail text never logged.
8. Redis keys contain no raw IP.
9. Append-only feedback rows.
10. Composite FK pins feedback to the exact PublicationVersion/Publication pair.
11. Public read path remains independent.
12. No automatic trust/publication/monitoring mutation.
13. Repository security contract scans for forbidden feedback-to-authority imports and unsafe logging.

## 16. Required tests

1. migration creates feedback table and append-only guard;
2. database rejects cross-Publication PublicationVersion ownership;
3. exact reason-code/details constraints hold;
4. normalization accepts bounded Vietnamese/Unicode plain text;
5. normalization rejects URL/control/oversized detail;
6. `OTHER` requires detail;
7. first submission inserts one row;
8. exact replay returns accepted semantic result with one row;
9. same submission ID + different payload returns conflict;
10. historical/non-current PublicationVersion can still receive a valid report;
11. `was_active_at_submission` is correct;
12. unknown Publication/version relationship returns not-found;
13. Redis burst limit is atomic;
14. daily limit is atomic;
15. duplicate-signal window is enforced;
16. Redis failure fails POST closed;
17. route requires JSON + custom header;
18. route body size is bounded;
19. malformed UUID/schema fails without persistence;
20. no raw IP/fingerprint/details appear in application logs;
21. disabled mode registers no public POST route;
22. enabled mode requires fingerprint secret;
23. feedback cannot mutate Publication/trust/monitoring authority;
24. public Publication GET remains available if feedback limiter is unavailable;
25. internal reader aggregates bounded reason counts and samples;
26. frontend sends exact PublicationVersion ID and stable submission ID;
27. frontend handles 202/429/503 without affecting guide rendering;
28. XSS regression: feedback detail is never interpreted as HTML;
29. existing frontend/backend regression remains green;
30. dedicated Sprint 7B CI/repository contract passes.

## 17. Rollout and deployment boundary

Repository integration may merge once exact-head CI is green.

Production enablement is separate because it requires a new server secret/binding:

- `FEEDBACK_INTAKE_ENABLED=true`
- `FEEDBACK_FINGERPRINT_SECRET=<server-only secret>`

No production secret is committed, printed, requested in chat, or created by Sprint 7B repository implementation.

The existing production bootstrap/delivery gate must be updated before real deployment so the new secret requirement is explicit and fail-closed.

## 18. Acceptance criteria

Sprint 7B is repository-ready when:

- a reader can submit one bounded anonymous report for an exact PublicationVersion;
- replay is idempotent and conflict-safe;
- anonymous abuse controls are atomic and fail closed;
- no raw network identity is durably stored;
- feedback remains completely outside trust/Publication/monitoring authority;
- the public guide remains readable when feedback intake is disabled or unavailable;
- internal code can read bounded feedback signals for later human triage;
- frontend offers a minimal usable report flow;
- exact-head dedicated + inherited regression/staging/release/dry-run CI is green;
- no production deployment occurs as part of the Sprint 7B merge.

## 19. Deferred work

Potential later work, requiring a separate design/spec:

- operator feedback triage UI;
- authenticated reporter reputation;
- CAPTCHA/vendor anti-abuse integration if needed;
- notification workflows;
- feedback-derived candidate investigation suggestions;
- carefully governed conversion of a human-verified report into Evidence;
- production rollout and live abuse tuning.
