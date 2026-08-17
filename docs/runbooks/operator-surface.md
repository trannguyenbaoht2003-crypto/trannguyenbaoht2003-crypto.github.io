# Operator Surface Runbook

Sprint 7C provides a local, read-only operator console that composes Sprint 7A monitoring alerts and Sprint 7B feedback signals from PostgreSQL.

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
- `GET /health/live` — process liveness.
- `GET /health/ready` — PostgreSQL readiness only.

Snapshot query parameters are bounded: `sinceHours=1..720`, `limit=1..100`, `detailSampleLimit=0..5`.

All responses use `Cache-Control: no-store` and restrictive security headers. Feedback detail text is untrusted and rendered only with DOM `textContent`; there is no `innerHTML`, polling timer, browser credential, CORS expansion, write method, or external fetch.

## Operator interpretation

Priority order is `critical` monitoring alert, then `warning` monitoring alert, then feedback-only signal. Feedback is grouped by exact immutable `(publicationId, publicationVersionId)` so historical feedback cannot be silently attached to a different active version.

A console row is not a command. If investigation requires changing publication state, use the existing reviewed authority workflow rather than adding a shortcut to this surface.

## Failure behavior

If PostgreSQL is unavailable, readiness fails and snapshot reads return a sanitized service-unavailable response. There is no Redis dependency and public Publication GET behavior is unaffected because the operator runtime is a separate process.

## Deployment prohibition

Sprint 7C intentionally adds no Caddy route, Railway service, public Next route, DNS binding, production secret, or deployment command. Production delivery remains a separate gate.