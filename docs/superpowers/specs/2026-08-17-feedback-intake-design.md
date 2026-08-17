# Sprint 7B — Public Feedback Intake Design

**Status:** self-approved under standing project delegation  
**Base:** `main@44e4bd18b6dd604af17e3bbce4383a9e91b0b73f`  
**Scope:** anonymous structured feedback about an immutable published guide version  
**Production delivery:** explicitly out of scope

## 1. Purpose

Sprint 7B adds a narrow public-write boundary so readers can report likely problems in a published guide without weakening existing trust and Publication invariants.

Feedback is **community signal only**. A feedback receipt is never Evidence, HumanReview, Moderation, Eligibility, Publication, rollback, retraction, or a Sprint 7A monitoring alert by itself.

Authority remains:

`Public reader -> validated feedback intake -> replay-aware abuse gate -> immutable PostgreSQL feedback receipt -> internal operator read boundary -> future human triage`

Any later trust or Publication change must still use the existing Evidence / HumanReview / Moderation / Eligibility / Publication authorities.

## 2. Context

The production gateway already serves the frontend and reverse-proxies `/api/v1/*` to the private backend on the same origin. Sprint 7B therefore does not add CORS.

The public Publication API already exposes both `publicationId` and `publicationVersionId`, so feedback can pin the exact immutable version the reader saw.

The backend already owns PostgreSQL and Redis connections. PostgreSQL remains durable authority. Redis is limited to short-lived abuse/replay-control state and cannot mutate domain authority.

Sprint 7A monitoring remains advisory and independent. Feedback cannot open or resolve monitoring alerts in Sprint 7B.

## 3. Approach selection

### Selected: anonymous structured feedback

Any reader may submit a bounded report without an account. Same-origin JSON requests are replay-safe, rate-limited and duplicate-suppressed. PostgreSQL stores the immutable report; Redis stores only expiring keyed abuse state.

This is preferred over reviewer-only feedback because it actually collects community signal, and preferred over a hybrid authenticated design because an auth subsystem is unnecessary for the initial value.

## 4. Goals

1. Accept anonymous public feedback for an existing PublicationVersion.
2. Pin every receipt to both `publication_id` and `publication_version_id`.
3. Use a client-generated UUID `submissionId` for replay-safe retries.
4. Reject reuse of a submission ID with a different canonical request.
5. Enforce short-lived abuse controls without making Redis domain authority.
6. Never durably store raw IP, IP fingerprint, user-agent, cookies, authorization headers, session identifiers, email, or account identifiers.
7. Keep optional detail text plain, bounded, non-link-bearing, operator-only data.
8. Keep feedback outside all trust/Publication/monitoring state machines.
9. Preserve public GET availability if feedback intake is disabled or unavailable.
10. Provide an internal PostgreSQL-backed feedback signal reader.
11. Provide a minimal public `Báo lỗi nội dung` interaction.
12. Add dedicated CI and repository security contracts.

## 5. Non-goals

Sprint 7B does not add accounts, login, CAPTCHA/vendor integration, public comments/history/counts, attachments, screenshots, URLs, Markdown/rich text, reporter contact fields, automatic Evidence creation, automatic trust decisions, automatic Publication mutation, automatic monitoring alerts, operator mutation UI, notifications, ML classification, production secret provisioning, or production deployment.

## 6. Public HTTP contract

### Route

`POST /api/v1/publications/:publicationId/feedback`

The existing gateway `/api/v1/*` reverse proxy is reused.

### Required request headers

- `Content-Type: application/json`
- `X-Hai-Dau-Feedback: web-v1`

The custom header prevents ordinary cross-site HTML form submission from satisfying the contract. No CORS headers are introduced.

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

Allowed `reasonCode` values are exactly:

- `OUTDATED`
- `WRONG_BUILD`
- `WRONG_ITEMS`
- `WRONG_AUGMENTS`
- `MISMATCHED_CHAMPION`
- `OTHER`

Unknown properties are rejected.

### Detail normalization

- request body limit: 2 KiB;
- `details`: 1–280 Unicode characters after normalization when present;
- `OTHER` requires non-empty details;
- NFC normalize, trim, collapse internal whitespace;
- reject ASCII control characters;
- reject URL-like content containing `http://`, `https://`, or `www.` case-insensitively;
- always treat details as plain text; never render as HTML.

### Publication relationship validation

The backend reloads PostgreSQL and requires that the supplied Publication exists and that the supplied PublicationVersion belongs to it.

The version need not remain active at acceptance time. A reader may submit moments after a concurrent publish/rollback. Historical immutable versions remain valid feedback targets.

The row records `was_active_at_submission` so operators can distinguish current-version feedback from raced/historical feedback.

### Responses

- `202` — accepted or exact idempotent replay;
- `400` — invalid header/content type/UUID/schema/body;
- `404` — Publication or PublicationVersion ownership relationship not found;
- `409` — same `submissionId` with a different canonical request hash;
- `413` — payload exceeds 2 KiB;
- `429` — abuse limit exceeded, with bounded `Retry-After`;
- `503` — enabled intake cannot safely complete its Redis/PostgreSQL dependency work.

Successful responses expose neither internal feedback row IDs nor abuse metadata.

## 7. Idempotency and replay order

`submissionId` is generated by the browser with `crypto.randomUUID()` and reused for retries of the same user action.

The canonical request hash covers:

- schemaVersion;
- publicationId;
- publicationVersionId;
- reasonCode;
- normalized details or null.

PostgreSQL has a unique constraint on `client_submission_id` and remains the final idempotency authority.

Behavior:

1. unseen ID + valid request -> one insert;
2. same ID + same canonical hash -> semantic replay, one row total;
3. same ID + different hash -> `409 IDEMPOTENCY_CONFLICT`.

### Redis replay marker

The abuse limiter also receives `submissionId` and keeps an expiring keyed replay marker for `fingerprint + submissionId`.

- first allowed attempt atomically consumes quota and sets the replay marker;
- a retry with the same marker returns `replay_pass` and does **not** consume burst/daily/duplicate-signal quota again;
- PostgreSQL still decides whether that retry is an exact replay, a first durable insert after a prior PostgreSQL failure, or an idempotency conflict;
- the replay marker is not evidence that a PostgreSQL receipt exists.

This prevents lost-response retries from punishing the user while keeping Redis non-authoritative.

## 8. Trusted client network identity

The backend must not trust arbitrary browser-supplied `X-Forwarded-For` or `X-Hai-Dau-Client-IP` values.

### Gateway rule

Both production and staging Caddy reverse-proxy blocks for `/api/v1/*` overwrite a private application header:

`X-Hai-Dau-Client-IP: {remote_host}`

The gateway **replaces**, rather than forwards, any incoming value for this header.

The public backend topology remains private behind the gateway. Feedback intake may be enabled only in this topology.

### Backend rule

The enabled feedback route requires the gateway-provided `X-Hai-Dau-Client-IP` value to parse as a valid IPv4 or IPv6 address. It does not derive anonymous identity from arbitrary forwarding headers.

The backend computes only:

`HMAC-SHA256(FEEDBACK_FINGERPRINT_SECRET, canonical_ip)`

The raw address is discarded after fingerprint creation.

## 9. Abuse and privacy boundary

### Secret

`FEEDBACK_FINGERPRINT_SECRET` is server-only and required only when feedback intake is enabled. It must contain at least 32 bytes of unpredictable secret material after decoding/normalization by the configuration parser.

`FEEDBACK_INTAKE_ENABLED` defaults to `false`. Existing environments therefore do not gain a public-write route merely by merging Sprint 7B.

### Rate limits

For a **new** anonymous signal:

- burst: max 5 allowed attempts per fingerprint per rolling 10 minutes;
- daily: max 20 allowed attempts per fingerprint per rolling 24 hours;
- duplicate signal: same fingerprint + PublicationVersion + reasonCode at most once per 30 minutes.

Exact replay-marker retries do not increment these counters.

The limiter uses one atomic Redis script/transaction so concurrent requests cannot exceed a limit by racing.

### Redis key material

Redis keys contain only:

- a versioned feedback prefix;
- the keyed HMAC fingerprint;
- bounded UUID/reason-code components where required.

Every abuse/replay key has a TTL. No raw IP appears in a Redis key/value.

### Logging

Application logging must redact or avoid:

- `req.headers.authorization`;
- `req.headers.cookie`;
- `req.headers.x-hai-dau-client-ip`;
- request socket/remote-address network identity where the logger exposes it;
- feedback `details`;
- HMAC fingerprint;
- `FEEDBACK_FINGERPRINT_SECRET`;
- database/redis credentials and existing token/API-key paths.

Feedback logs may contain bounded IDs, reason codes, HTTP/domain error codes, and retry-after seconds only.

### Redis failure

Feedback POST fails closed with `503` if abuse control cannot complete. Existing Publication GET routes stay independent.

## 10. PostgreSQL model

Add forward-only migration:

`0013_publication_feedback_intake.sql`

### `publication_feedback_submissions`

Append-only columns:

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

Database constraints:

- composite FK proves `(publication_version_id, publication_id)` ownership against PublicationVersion authority;
- reason code check permits exactly the six 7B codes;
- details length is `1..280` when non-null;
- `OTHER` requires non-null details;
- append-only trigger rejects UPDATE and DELETE;
- schema contains no raw-IP/fingerprint/user-agent/cookie/auth/session/email/account field.

The immutable row itself is the feedback receipt. Sprint 7B emits no trust-domain audit/outbox event from anonymous feedback.

## 11. Backend components

### `modules/feedback/types.ts`

Defines reason codes, normalized command/result types, rate-limit results, and internal read models.

### `modules/feedback/normalize-feedback-input.ts`

Pure input normalization/validation and canonical request-hash input construction. No I/O.

### `modules/feedback/feedback-fingerprint.ts`

Pure/isolated helper that canonicalizes a validated gateway IP and returns only the keyed HMAC digest. The raw IP never crosses into durable persistence APIs.

### `modules/feedback/feedback-rate-limiter.ts`

Redis-only abuse component that accepts the fingerprint, `submissionId`, PublicationVersion ID and reason code. One atomic operation enforces replay marker, burst, daily and duplicate-signal windows. It has no PostgreSQL or domain mutation authority.

### `modules/feedback/submit-publication-feedback.ts`

PostgreSQL authority that:

- validates Publication/PublicationVersion ownership from PostgreSQL;
- reads active state in the same transaction;
- performs unique-ID/hash idempotency resolution;
- inserts one immutable row;
- returns accepted/replayed/conflict/not-found outcomes;
- never imports Publication, Trust, Moderation, Eligibility, or Monitoring mutation commands.

### `modules/feedback/read-publication-feedback-signals.ts`

Internal PostgreSQL reader only. It returns bounded aggregates and a small bounded sample of recent plain-text details. There is no public feedback GET endpoint.

## 12. HTTP/application ordering

`buildApp()` receives an optional enabled feedback-intake dependency. Disabled mode registers no POST route.

For an enabled request:

1. validate custom header, JSON content type, route UUID and body schema;
2. normalize feedback and compute canonical request hash;
3. validate gateway client-IP header and derive the HMAC fingerprint;
4. execute replay-aware atomic Redis abuse gate;
5. if denied -> `429`;
6. if allowed or replay-pass -> call PostgreSQL submission authority;
7. map domain outcome to `202`, `404`, `409`, or `503`;
8. never log detail text, raw IP or fingerprint.

A prior PostgreSQL failure after the Redis first-pass is safe: the retry marker lets the same submission bypass additional quota, and PostgreSQL can perform the first durable insert.

Existing Publication GET routes retain their existing reader and do not depend on feedback limiter/service health.

## 13. Frontend interaction

For guides backed by live public Publication IDs, add a compact `Báo lỗi nội dung` action.

Flow:

1. open panel/modal;
2. select one reason;
3. enter optional details up to 280 chars; `OTHER` requires details;
4. create one `submissionId` and retain it while retrying that user action;
5. POST same-origin JSON with `X-Hai-Dau-Feedback: web-v1`;
6. `202`: neutral acknowledgement and reset;
7. `429`: retry-later state;
8. network/`503`: temporarily unavailable state without affecting guide content.

No feedback count, reporter identity, public comment text, or internal triage state is shown publicly.

React renders user text normally; feedback code never uses `dangerouslySetInnerHTML`.

## 14. Trust-isolation invariants

Dedicated tests must prove:

- feedback modules do not import/call Publication mutation commands;
- feedback modules do not import/call Evidence/HumanReview/Moderation/Eligibility/Monitoring mutation authority;
- no anonymous feedback event is routed into eligibility, monitoring or publication queues;
- public Publication projection/read SQL does not join the feedback table;
- feedback cannot hide, retract, replace or mutate an active PublicationVersion;
- feedback counts alone cannot become Evidence.

## 15. Failure behavior

### PostgreSQL unavailable

Feedback POST returns `503`. Existing public GET remains governed by the current public-read path.

### Redis unavailable

Feedback POST returns `503` before a new un-rate-limited write can occur.

### Feature enabled with missing/weak secret

Configuration/startup fails closed for the feedback dependency.

### Missing/invalid gateway client IP

Feedback request is rejected/fails closed; backend never falls back to untrusted browser forwarding headers.

### Duplicate/lost response

Same submission ID reuses the Redis replay marker without consuming quota and PostgreSQL returns exact replay semantics.

### Concurrent Publication activation change

The immutable target version remains valid. `was_active_at_submission` records the state observed by the database transaction.

## 16. Security requirements

1. No CORS expansion.
2. JSON-only route plus custom feedback header.
3. Route-specific 2 KiB payload limit.
4. Strict body schema with no unknown properties.
5. Gateway overwrites a dedicated client-IP header.
6. Backend does not trust arbitrary forwarding headers for fingerprinting.
7. No durable raw-IP/fingerprint/user-agent/auth/cookie/session/contact data.
8. Secret and fingerprint never logged/returned.
9. Feedback details never logged.
10. Redis abuse keys contain only HMAC identity and bounded components with TTL.
11. Append-only PostgreSQL receipts.
12. Composite FK pins exact Publication/PublicationVersion ownership.
13. Public reads remain independent.
14. No automatic trust/publication/monitoring mutation.
15. Repository contract scans forbidden feedback-to-authority imports, unsafe logging, CORS expansion, and untrusted-IP fallback.

## 17. Required tests

1. migration creates feedback table and append-only guard;
2. DB rejects cross-Publication version ownership;
3. DB reason/details constraints hold;
4. normalization accepts bounded Vietnamese/Unicode plain text;
5. normalization rejects URLs/control/oversized details;
6. `OTHER` requires details;
7. first PostgreSQL submission inserts once;
8. exact PostgreSQL replay returns accepted semantics with one row;
9. same submission ID + different hash conflicts;
10. historical PublicationVersion is valid;
11. `was_active_at_submission` is correct;
12. unknown ownership returns not-found;
13. fingerprint is deterministic keyed HMAC and never raw IP;
14. malformed gateway IP is rejected;
15. Redis burst limit is atomic;
16. Redis daily limit is atomic;
17. duplicate-signal window is atomic;
18. same submission replay marker does not consume quota twice;
19. Redis failure fails feedback closed;
20. route requires JSON + custom header;
21. body is bounded to 2 KiB;
22. malformed schema/UUID fails without persistence;
23. no raw IP/header/fingerprint/details appear in logs;
24. disabled mode registers no POST route;
25. enabled mode requires strong fingerprint secret;
26. gateway overwrites `X-Hai-Dau-Client-IP` in staging and production configs;
27. feedback cannot mutate Publication/trust/monitoring authority;
28. public GET works if feedback limiter is unavailable;
29. internal reader returns bounded aggregates/samples;
30. frontend sends exact PublicationVersion and stable submission ID;
31. frontend handles 202/429/503 without hiding guide content;
32. XSS regression proves details are never interpreted as HTML;
33. existing frontend/backend regression stays green;
34. dedicated Sprint 7B CI/repository contract passes.

## 18. Rollout boundary

Repository integration may merge after exact-head CI is green.

Real production enablement is separate and requires, at minimum:

- private backend remains reachable only through the gateway topology;
- gateway client-IP overwrite is deployed;
- `FEEDBACK_INTAKE_ENABLED=true`;
- server-only `FEEDBACK_FINGERPRINT_SECRET` is provisioned securely;
- production smoke/abuse checks are explicitly authorized.

Sprint 7B does not create, request in chat, print, commit, or deploy any real production secret.

The existing production release gate is **not** changed to require a ninth global secret while feedback remains disabled by default. A later production rollout change may add conditional binding checks when the feature is intentionally enabled.

## 19. Acceptance criteria

Repository-ready means:

- one bounded anonymous report can be submitted for an exact PublicationVersion;
- retries are idempotent and do not double-charge abuse quota;
- conflicting idempotency reuse is rejected;
- abuse controls are atomic and fail closed;
- trusted network identity comes only from the gateway-overwritten header;
- no raw network identity is durably stored or logged;
- feedback remains outside trust/Publication/monitoring authority;
- guide GET/read rendering survives disabled/unavailable feedback intake;
- internal code can read bounded feedback signals for human triage;
- frontend offers a minimal usable report flow;
- dedicated and inherited exact-head CI is green;
- no production deployment occurs as part of merge.

## 20. Deferred work

Separate future design/specs may cover operator triage UI, authenticated reporter reputation, CAPTCHA/vendor integration if abuse warrants it, notifications, feedback-derived investigation suggestions, human-governed conversion of a verified report into Evidence, and production rollout/live abuse tuning.
