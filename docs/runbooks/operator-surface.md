# Operator Surface Runbook

Sprint 7C provides a local, read-only operator console that composes Sprint 7A monitoring alerts and Sprint 7B feedback signals from PostgreSQL. Sprint 9B adds an independent candidate review queue that displays the persisted Sprint 9A confidence assessment without granting review or publication authority.

## Security boundary

The operator runtime is intentionally separate from the public backend and public Next application. It must bind only to loopback (`127.0.0.1`, `::1`, or `localhost`). Never set `OPERATOR_HOST=0.0.0.0`, never expose the operator port through Caddy or Railway, and never add a public `/operator` route.

The console has no Publication, Evidence, HumanReview, Moderation, Eligibility, monitoring-alert, or feedback-submission mutation authority. Monitoring and feedback remain advisory/read-only signals. PostgreSQL is the only runtime dependency; Redis and BullMQ are not used.

## Local startup

```bash
cd backend
DATABASE_URL='postgres://...' npm run operator:dev
# open http://127.0.0.1:3011
```

Optional loopback configuration:

```bash
OPERATOR_HOST=127.0.0.1 OPERATOR_PORT=3011 DATABASE_URL='postgres://...' npm run operator:dev
```

`OPERATOR_HOST` rejects non-loopback values. The production script is:

```bash
cd backend
DATABASE_URL='postgres://...' npm run operator
```

Use it only in a private host/network context where the process remains loopback-only; Sprint 7C does not provision or deploy this runtime.

## Endpoints

- `GET /` — self-contained operator console.
- `GET /operator.js` and `GET /operator.css` — local assets.
- `GET /api/operator/v1/snapshot` — unified read-only snapshot.
- `GET /api/operator/v1/candidate-review-queue` — candidate review queue with persisted confidence context.
- `GET /api/operator/v1/candidate-review-dossiers/:candidateRevisionId` — current Candidate Evidence dossier.
- `GET /health/live` — process liveness.
- `GET /health/ready` — PostgreSQL readiness only.

Snapshot query parameters are bounded: `sinceHours=1..720`, `limit=1..100`, `detailSampleLimit=0..5`.
The candidate queue accepts only `limit=1..100`, with a default of 50. Unknown, duplicate, non-integer, signed, whitespace-padded, zero, and out-of-range values are rejected before the reader runs.

All responses use `Cache-Control: no-store` and restrictive security headers. Feedback detail text is untrusted and rendered only with DOM `textContent`; there is no `innerHTML`, polling timer, browser credential, CORS expansion, write method, or external fetch.

## Operator interpretation

Priority order is `critical` monitoring alert, then `warning` monitoring alert, then feedback-only signal. Feedback is grouped by exact immutable `(publicationId, publicationVersionId)` so historical feedback cannot be silently attached to a different active version.

A console row is not a command. If investigation requires changing publication state, use the existing reviewed authority workflow rather than adding a shortcut to this surface.

### Candidate review queue

A candidate appears only when it belongs to the active catalog for its patch and game mode, is the latest revision of that candidate in the catalog, has a sealed claim set, and has an unresolved active review policy. A candidate with a satisfied active-policy quorum is excluded.

Confidence is persisted and advisory. It is never evaluated on read, and a missing assessment is shown as `unscored`. The queue does not infer or recompute confidence from evidence.

The deterministic order is:

1. `in_progress` reviews before `unreviewed` candidates;
2. confidence bands `very_high`, `high`, `medium`, `low`, then `unscored`;
3. confidence score descending;
4. oldest CandidateRevision creation time;
5. candidate and revision identifiers as stable tie-breakers.

Candidate review and monitoring/feedback have separate read and failure boundaries. A failed candidate read returns a sanitized 503 response and does not disable the monitoring view; a failed monitoring read likewise does not mutate or complete candidate review. The console contains no approve, decline, moderation, eligibility, publication, or rollback controls.

### Candidate Evidence dossier

The dossier accepts a canonical lowercase version 1–5 UUID and no query keys. It revalidates the queue predicate inside one `REPEATABLE READ READ ONLY` transaction: active catalog, latest revision, sealed claim set, and unresolved active review policy. A stale or missing revision returns 404; a satisfied quorum under a historical policy does not hide a candidate under the active policy.

Each Claim shows only its current Claim Evidence decision and the exact immutable input-snapshot members in ordinal order. Historical decisions and later Evidence associations are excluded. Claims use stable claim-key order; Candidate provenance is complete, ordered by UUID, and grouped by origin in the UI. Persisted confidence remains advisory and is never evaluated on read.

Sources expose their current `active`, `suspended`, or `retired` status and captured source policy. References allow HTTPS only, without credentials, up to 2,048 UTF-8 bytes; optional platform/author/publishedAt/sourceContentId fields are bounded to 128/256/64/256 bytes, with canonical date or timestamp validation. An invalid reference becomes null. `aggregate_only` sources and `ai_generated` provenance never expose a reference. Links open manually with `target="_blank"`, `rel="noopener noreferrer"`, and `referrerPolicy="no-referrer"`; the console never fetches or previews source URLs.

Bounds are 256 Claims, 64 Evidence members per Claim, and 2,048 Evidence associations per dossier. Inconsistent graphs or exceeded bounds fail closed; results are never silently truncated. The projection excludes `raw_blob`, `aggregate_metadata`, content hashes, actor and correlation identifiers, provider payloads, and AI run identifiers.

Use **Xem hồ sơ**, **Làm mới hồ sơ**, and **Quay lại hàng đợi** for manual navigation. Returning after a 404 refreshes the queue once. Filters remain intact. Loading or failure clears prior detail, and late responses cannot overwrite a newer selection or the monitoring view. `Chưa có quyết định Evidence hiện hành` denotes a null decision; `Quyết định hiện hành không gắn Evidence` denotes a valid decision with no snapshot members. All untrusted text uses `textContent` or `createTextNode`.

Failures are sanitized: 400 for an invalid ID or any query key, 404 for a revision outside the current queue, and 503 for unavailable policy/database or invalid graph. Neither response nor log reveals the underlying error. There are no mutations to HumanReview, Evidence, confidence, moderation, eligibility, publication, audit, idempotency, or outbox state. This endpoint remains loopback-only and deployment-free.

Sprint 9C CI runs PostgreSQL 17 and the complete inherited backend suite. Redis is a test-only service required by existing queue/worker tests; the operator runtime and dossier tests require only PostgreSQL. This corrects the implementation plan's incompatible combination of “full backend tests” and “no Redis” in CI.

## Failure behavior

If PostgreSQL is unavailable, readiness fails and snapshot or candidate-queue reads return a sanitized service-unavailable response. There is no Redis dependency and public Publication GET behavior is unaffected because the operator runtime is a separate process.

## Deployment prohibition

Sprint 7C intentionally adds no Caddy route, Railway service, public Next route, DNS binding, production secret, or deployment command. Production delivery remains a separate gate.
