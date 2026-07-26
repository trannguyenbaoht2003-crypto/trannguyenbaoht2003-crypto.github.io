# Hải Đấu backend runbook

This runbook covers the Sprint 2A production foundation, Sprint 2B catalog
authority, and Sprint 3A deterministic normalization and Candidate Registry.
PostgreSQL is the system of record; Redis/BullMQ is delivery infrastructure.

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
| `blob_allowed` | Structured reference, permitted aggregate metadata, and permitted raw blob |
| `reference_only` | Structured reference; aggregate metadata and raw blob forced to `null` |
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

## Deterministic normalization and Candidate Registry

Sprint 3A consumes a bounded `ObservationNormalizationSnapshotV1` from
permitted `aggregate_metadata`. It accepts schema version 1, patch key,
`aram_mayhem`, origin, champion external ID, augment external IDs, and item
external IDs. The runtime validator trims IDs, rejects empty or duplicate
IDs, and sorts augment and item selections by code-point order before hashing.
It does not fetch, infer, or parse external source content.

The aggregate wrapper may contain only `normalizationSnapshot`, and the
snapshot may contain only those seven declared fields. Each identifier is at
most 128 characters and each augment/item list has at most 64 entries.
Sparse JavaScript arrays, additional fields, or oversized values fail before
idempotency hashing or storage. Both immutable payload columns also use the
PostgreSQL `is_candidate_selection_payload_v1` check, which enforces the exact
three-key V1 canonical payload, bounds, uniqueness, and code-point ordering
even when application validation is bypassed.

In operational terms, reference_only cannot supply a stored aggregate snapshot.
Only `aggregate_only` or `blob_allowed` policy can retain the structured
snapshot. The worker treats a policy that cannot retain the snapshot, or an
authoritative observation without that snapshot, as terminal
`not_normalizable`: it records one attempt before reserving a normalization
effect, never calls the registrar, and does not retry. A callable observation
whose metadata disappears still fails with
`NORMALIZATION_SNAPSHOT_UNAVAILABLE`; malformed input fails through stable
normalization reason codes.

### Fingerprint exclusions

The Candidate fingerprint includes only the patch ID, game mode, canonical
subject external ID, and normalized selection signature. It excludes source,
Source Policy revision, raw observation ID, origin, reference, adapter
version, timestamps, and catalog revision. Patch remains in the fingerprint,
so identity cannot cross a patch boundary.

### Candidate identity and CandidateRevision identity

Candidate identity is the patch-scoped semantic fingerprint. A repeated
fingerprint reuses one immutable Candidate.

CandidateRevision identity is the immutable representation under an exact
active catalog revision. `CandidateRevision` pins the catalog revision, while
the Candidate does not. The same fingerprint under the same catalog reuses
the revision; the same fingerprint after a catalog refresh creates the next
immutable revision on the same Candidate.

PostgreSQL composite foreign keys require every normalized observation and
CandidateRevision to use a catalog owned by the same patch. A provenance
insert guard also requires the Candidate, CandidateRevision, and normalized
observation to share subject, patch, mode, catalog revision, normalized
signature, and canonical payload.

### Provenance chain

Every accepted raw observation creates an append-only provenance link:

```text
candidate_provenance → normalized_observation → raw_observation
```

The chain preserves origin, source, Source Policy revision, adapter version,
content hash, permitted reference, and collection time without copying
governed source content into Candidate rows. Provenance counts are derived
from immutable rows; Candidate rows are never updated as counters.

The normalization worker reloads observation ID and correlation ID from the
PostgreSQL outbox event and ignores source fields in the Redis payload. Its
normalization reservation, normalized observation, Candidate,
CandidateRevision, provenance, audit, and outbox writes share one transaction.
Patch lifecycle writers lock the Patch row `FOR UPDATE`; candidate
registration first locks that row `FOR SHARE` in its own statement, then reads
the latest lifecycle event and locks the active-catalog pointer. This ordering
prevents a withdrawal append from racing between lifecycle validation and
Candidate creation.

- Scenario S1: an injected failure before commit rolls back every domain,
  audit, outbox, and normalization-effect row; retry can succeed once.
- Scenario S12: a patch, active-catalog, or catalog-selection mismatch fails
  closed before Candidate creation and leaves no partial side effect.
- Scenario S21: source-independent observations with one semantic
  fingerprint converge to one Candidate and one catalog-pinned revision while
  retaining one provenance row per observation.

A retry after commit returns `duplicate_noop` and does not create another
registry effect. Candidate outbox events are not dispatched in Sprint 3A:
the dispatcher allowlist remains limited to `RawObservationIngested`.

## Full Sprint 2A–3A gate

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

## Sprint 2A–3A safety boundary

- No Evidence.
- No AI.
- No Publication. No publication command or dependency.
- No production credentials.
- No deployment.
- No merge.
- No external crawler.
- No production infrastructure provisioning.

The worker registers deterministic Candidates only. It creates no Evidence,
review, eligibility, or publication decision and has no publication
dependency or command.
