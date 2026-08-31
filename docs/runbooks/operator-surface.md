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

## Failure behavior

If PostgreSQL is unavailable, readiness fails and snapshot or candidate-queue reads return a sanitized service-unavailable response. There is no Redis dependency and public Publication GET behavior is unaffected because the operator runtime is a separate process.

## Deployment prohibition

Sprint 7C intentionally adds no Caddy route, Railway service, public Next route, DNS binding, production secret, or deployment command. Production delivery remains a separate gate.
