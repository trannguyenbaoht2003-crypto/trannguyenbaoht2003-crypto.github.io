# Hải Đấu backend runbook

This runbook covers the Sprint 2A production foundation and Sprint 2B catalog authority. PostgreSQL is the system of record; Redis/BullMQ is delivery infrastructure.

## Prerequisites

- Node.js 22.13 or newer.
- PostgreSQL 17.
- Redis 7.
- A disposable database dedicated to local development or tests.

Never point the commands in this runbook at production data.

## Install

From the repository root:

```bash
npm ci --cache /tmp/aram-root-npm-cache
npm --prefix backend ci --cache /tmp/aram-backend-npm-cache
```

The root package keeps the frontend build contract. Backend checks are exposed through these root orchestration commands:

```bash
npm run backend:typecheck
npm run backend:test
npm run backend:build
```

## Test environment

Integration tests require test-only service URLs:

```bash
export TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/hai_dau_test
export TEST_REDIS_URL=redis://127.0.0.1:6379
```

Use a fresh or disposable database. Tests recreate schemas and are not safe for a shared database.

Run the complete backend gate:

```bash
npm run backend:typecheck
npm run backend:test
npm run backend:build
```

Run the migration contract alone:

```bash
cd backend
node --import tsx --test --test-concurrency=1 test/migration.test.ts
```

The migration test applies every SQL file in lexical order, verifies the recorded SHA-256 checksums, and proves append-only and rollback constraints. Sprint 2A does not expose a production migration CLI; production infrastructure and credential handling remain deferred.

## Local runtime

Build before starting either process:

```bash
npm run backend:build
```

Start the HTTP process:

```bash
DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/hai_dau_test \
REDIS_URL=redis://127.0.0.1:6379 \
npm --prefix backend start
```

Start the normalization worker in a separate terminal:

```bash
DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/hai_dau_test \
REDIS_URL=redis://127.0.0.1:6379 \
npm --prefix backend run start:worker
```

Health endpoints:

- `GET /health/live` checks only that the Node process responds.
- `GET /health/ready` checks PostgreSQL and Redis and returns only `ready` or `not_ready`; it does not expose credentials or internal errors.

The continuous outbox scheduler is not a Sprint 2A runtime process. The dispatcher is an application boundary exercised by the PostgreSQL/Redis integration tests; scheduling and production process supervision are deferred.

## Source Policy storage permissions

Every observation resolves the active Source Policy before it is stored:

| Permission | Stored representation |
|---|---|
| `blob_allowed` | Structured reference and permitted raw blob |
| `reference_only` | Structured reference; raw blob forced to `null` |
| `aggregate_only` | Only permitted aggregate metadata; raw reference and blob forced to `null` |
| `prohibited` | Command rejected with no observation, audit, outbox, or completed idempotency side effect |

Reusing an idempotency key with the same canonical payload returns the recorded result. Reusing it with a different payload is rejected.

## Redis failure and outbox recovery

A domain transaction commits its audit and outbox rows in PostgreSQL before queue delivery. The dispatcher claims eligible rows with a lease and `FOR UPDATE SKIP LOCKED`, then uses the outbox event ID as the BullMQ `jobId`.

If Redis is unavailable:

1. the committed domain change and immutable outbox payload remain in PostgreSQL;
2. the dispatcher records `retryable_failed`, clears the lease, and advances `available_at`;
3. a later dispatcher pass reclaims the same event;
4. the deterministic `jobId` prevents a second logical BullMQ job;
5. the worker reloads authoritative event data from PostgreSQL;
6. a retry after a lost acknowledgement records `duplicate_noop` and creates no second normalization effect.

Do not edit an outbox identity or payload to recover delivery. Database triggers intentionally reject that mutation. Diagnose connectivity, restore Redis, and let the same PostgreSQL event be dispatched again.

## Catalog authority operations

Sprint 2B accepts only a `CatalogSnapshotV1` supplied to the application by a deterministic adapter. The snapshot contains structured game entities, compatibility rules, adapter version, and a source digest. It must not contain source HTML, transcripts, comments, raw community text, images, or credentials.

Catalog import is an application command, not a network collector or operator CLI. It requires an active Patch and the exact active Source Policy revision. The idempotency scope is `catalog_import`: replaying the same canonical payload returns the recorded result, while reusing the key with changed input fails closed. Import writes the revision, entity/rule children, content seal, lifecycle, audit, and outbox atomically.

A seal makes the revision and its children immutable. Any correction requires a new catalog revision; never edit a sealed row. Semantic validation reconstructs the snapshot from PostgreSQL, verifies the seal and references, and records an immutable passed or failed result. Failed validation history remains available for audit and cannot authorize activation.

Activation requires the caller's expected current revision. A stale compare-and-swap fails with `CATALOG_ACTIVE_POINTER_CONFLICT` and creates no activation side effect. Read-only selection validation requires an exact active patch, `aram_mayhem` mode, and catalog revision; stale input returns only `CATALOG_REVISION_NOT_ACTIVE` before entity or rule evaluation.

Catalog lifecycle events remain in PostgreSQL. The outbox dispatcher allowlist still contains only `RawObservationIngested`, so catalog events are not normalization jobs.

- No external catalog fetch.
- No normalization.
- No Candidate, Evidence, AI, or Publication behavior.
- No production credentials.
- No deployment or infrastructure provisioning.

## Full Sprint 2A–2B gate

The GitHub Actions workflow starts PostgreSQL 17 and Redis 7, installs both lockfiles, and runs:

```bash
npm run validate:community
npm run lint
npm test
npm run build:pages
npm run backend:typecheck
npm run backend:test
npm run backend:build
git diff --check
```

It also requires a clean repository after generated-output checks and scans the workflow for write permissions or deployment commands.

## Sprint 2A–2B safety boundary

- No AI.
- No publication.
- No production credentials.
- No deployment.
- No external crawler.
- No production infrastructure provisioning.

The worker only records acceptance at the normalization boundary. It has no publication dependency or command.
