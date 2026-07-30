# Hải Đấu backend runbook

This runbook covers Sprint 2A production foundation, Sprint 2B catalog authority,
Sprint 3A deterministic normalization and Candidate Registry, Sprint 3B Evidence
v3 and Human Review persistence, Sprint 4A Moderation and Eligibility, Sprint 4B
Publication authority, and Sprint 5A Read-only Publication HTTP boundary.

PostgreSQL is the system of record. Redis 7 and BullMQ are delivery
infrastructure; they never own catalog, Candidate, trust, Eligibility,
Publication, or public API truth.

## Prerequisites

- Node.js 22.13 or newer.
- PostgreSQL 17.
- Redis 7.
- A disposable database dedicated to local development or tests.

There are No production credentials in this repository or workflow. Never point
these commands at production data.

## Install and root commands

```bash
npm ci --cache /tmp/aram-root-npm-cache
npm --prefix backend ci --cache /tmp/aram-backend-npm-cache
npm run backend:typecheck
npm run backend:test
npm run backend:build
```

## Test environment

```bash
export TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/hai_dau_test
export TEST_REDIS_URL=redis://127.0.0.1:6379
```

Tests recreate the public schema. Use only a fresh or disposable database.
Migrations run in lexical order and are recorded with SHA-256 checksums. Applied
migrations are immutable; there is no production migration CLI.

Run the migration and runbook contract alone:

```bash
cd backend
node --import tsx --test --test-concurrency=1 test/migration.test.ts
```

## Local runtime

Build first, then start the HTTP process:

```bash
npm run backend:build
DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/hai_dau_test \
REDIS_URL=redis://127.0.0.1:6379 \
npm --prefix backend start
```

The HTTP process exposes:

- `GET /health/live`
- `GET /health/ready`
- `GET /api/v1/publications`
- `GET /api/v1/publications/:publicationId`

Start normalization, Eligibility, and Publication projection workers separately:

```bash
DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/hai_dau_test \
REDIS_URL=redis://127.0.0.1:6379 \
npm --prefix backend run start:worker
```

There is no continuous production scheduler. Tests invoke dispatcher boundaries
explicitly; production process supervision remains deferred.

## Source Policy storage permissions

Every observation resolves an active Source Policy before storage:

| Permission | Stored representation |
|---|---|
| `blob_allowed` | Structured reference, permitted aggregate metadata, and permitted raw blob |
| `reference_only` | Structured reference only; aggregate metadata and raw blob are forced to `null` |
| `aggregate_only` | Permitted aggregate metadata only; raw reference and blob are forced to `null` |
| `prohibited` | Rejected with no observation, audit, outbox, or completed idempotency effect |

Reusing an idempotency key with the same canonical payload returns the recorded
result. Reusing it with changed input fails closed.

## Redis failure and outbox recovery

Domain state, audit, and outbox rows commit in PostgreSQL before queue delivery.
The dispatcher leases rows with `FOR UPDATE SKIP LOCKED` and uses the outbox event
ID as BullMQ `jobId`.

If Redis is unavailable, delivery records `retryable_failed`, clears the lease,
and advances `available_at`. A later pass retries the same immutable event.
Deterministic job IDs and worker effect rows make lost-ack delivery
`duplicate_noop`. Never edit an outbox identity or payload to recover delivery.

## Catalog authority operations

Sprint 2B accepts only a deterministic `CatalogSnapshotV1`. The application
command uses idempotency scope `catalog_import`, requires an active Patch and
exact Source Policy revision, and atomically writes revision, children, seal,
lifecycle, audit, and outbox.

A sealed catalog is immutable. Activation uses compare-and-swap and fails with
`CATALOG_ACTIVE_POINTER_CONFLICT` on stale expectation. Selection validation
requires the exact active patch, mode, and catalog revision; stale input returns
`CATALOG_REVISION_NOT_ACTIVE`.

- No external catalog fetch.
- Catalog lifecycle events are not normalization or Eligibility jobs.

## Deterministic normalization and Candidate Registry

Sprint 3A consumes a bounded `ObservationNormalizationSnapshotV1`. It validates
patch, `aram_mayhem`, origin, champion, augment IDs, and item IDs before hashing
or persistence.

In operational terms, reference_only cannot supply a stored aggregate snapshot.
Only `aggregate_only` or `blob_allowed` may retain the structured snapshot.

### Fingerprint exclusions

The Candidate fingerprint includes patch ID, mode, canonical subject ID, and
normalized selection signature. It excludes source, Source Policy revision, raw
observation, origin, reference, adapter version, timestamps, and catalog
revision.

### Candidate identity and CandidateRevision identity

Candidate identity is the patch-scoped semantic fingerprint. CandidateRevision
identity is the immutable representation under one exact active catalog
revision. A catalog refresh may append a revision without changing Candidate
identity.

### Provenance chain

```text
candidate_provenance → normalized_observation → raw_observation
```

Workers reload PostgreSQL authority and ignore forged Redis fields.

- Scenario S1: a pre-commit failure rolls back domain, audit, outbox, and effect.
- Scenario S12: patch/catalog/selection mismatch creates no partial graph.
- Scenario S21: source-independent observations converge to one Candidate while
  retaining distinct provenance.

## Evidence v3 and Human Review persistence

Sprint 3B adds Claim-level Evidence and immutable Human Review history. AI
provenance is not Evidence.

### Candidate claim-set seal

Candidate claim-set seal creation is atomic and requires at least one Claim and
one required Claim. The sealed set cannot be edited or extended.

### Evidence input snapshot and Evidence decision history

Each Evidence input snapshot pins Candidate, CandidateRevision, Claim, seal,
policy, exact association membership, and canonical hashes. Evidence decision
history is append-only and a narrow current pointer cannot move backward.

Cross-patch revalidation is explicit and requires a reason; an old Patch decision
is never silently reused.

### Human Review input snapshot and Review quorum

A Human Review input snapshot pins exact Claims, current Evidence, provenance,
and policy. Only `completed + confirmed + reviewer` records with the same input
hash can count. Review quorum history remains immutable.

Trust writers use the shared lock order Candidate → CandidateRevision → Claim.

## Moderation and Eligibility

### Moderation decision history

Moderation snapshots CandidateRevision, claim-set seal, and provenance before
appending `clear`, `needs_review`, or `blocked`. There is No default clear.

### Eligibility input snapshot

Eligibility pins active and subordinate policies, CandidateRevision, seal,
current Moderation, current Review quorum, and every required Claim. Only required
Claims determine Eligibility.

The precedence is blocked/contradicted → `ineligible`; missing, stale, or
unresolved → `needs_review`; otherwise fresh clear/supported/quorum authority →
`eligible`.

Stale Eligibility reads needs_review and never continues serving an old eligible
result after a trust or policy change.

### Eligibility re-evaluation queue

Eligibility events route only to `hai-dau-eligibility-v1`. PostgreSQL remains
Eligibility authority. Redis carries immutable event identity, not trust values.

## Publication authority and public read

Sprint 4B publishes immutable CandidateRevision content only after the exact
current trust graph is eligible. PostgreSQL remains Publication authority.

### Publication payload and immutable versions

PublicationVersion immutable is a hard database invariant. Each version pins its
Publication, Candidate, CandidateRevision, Patch, CatalogRevision, normalized
signature, active Eligibility policy/evaluation/hash, current Moderation,
required-Claim membership, closed `PublicationPayloadV1`, payload hash, actor,
correlation, and monotonic version number.

### Permission boundary

Publisher permission required applies to publish and rollback. Missing permission
creates no Publication, audit, outbox, or completed idempotency effect. This is an
application boundary, not an identity provider.

### Publish and stale-input recovery

Fresh Eligibility rechecked at commit means deferred PostgreSQL guards compare
stored pins with the live authority graph immediately before COMMIT. A concurrent
provenance, Evidence, Review, Moderation, Eligibility, or policy change fails
closed.

Publish uses idempotency and compare-and-swap. A stale active pointer leaves no
orphan version, activation, audit, outbox, or completed idempotency effect.

### Publication activation history

Publication activation history is append-only. Every `published` or
`rolled_back` pointer change records from-version, to-version, actor,
audit/outbox correlation, time, and database sequence.

### Item-level rollback

Item-level rollback requires `publisher`, the expected active version, and a
target version owned by the same Publication. It changes only that item's active
pointer and never edits immutable versions.

### Public read independent from workers

Public read independent from workers joins the PostgreSQL active pointer directly
to immutable PublicationVersion rows. Redis, workers, and projection effects do
not delay, change, publish, or retract public truth.

### Projection delivery and replay

`PublicationPublished` and `PublicationRolledBack` route only to
`hai-dau-publication-v1`. Projection validates PostgreSQL source events, ignores
forged Redis fields, records one replay-safe effect, and never changes the active
Publication pointer.

## Read-only Publication HTTP boundary

Sprint 5A exposes exactly:

- `GET /api/v1/publications`
- `GET /api/v1/publications/:publicationId`

Public API reads PostgreSQL only. The Fastify adapter receives a narrow
`PublicPublicationReader`; it does not receive Redis, BullMQ, dispatcher,
projection worker, publish command, or rollback command dependencies.

List responses use `{ "schemaVersion": 1, "publications": [...] }`. Single-item
responses use `{ "schemaVersion": 1, "publication": {...} }`. Records are built
field-by-field from the validated active Publication read; unknown database or
domain fields are not spread into HTTP output.

A malformed Publication UUID returns `INVALID_PUBLICATION_ID` with HTTP 400. A
valid UUID without an active Publication returns `PUBLICATION_NOT_FOUND` with
HTTP 404. Reader failures return only `PUBLICATION_READ_FAILED` with HTTP 500;
SQL, connection URLs, credentials, stack traces, and source exception messages
are not exposed.

Rollback visibility is immediate because both endpoints read the current
PostgreSQL active pointer. An eligible but unpublished Candidate remains hidden.
The endpoints remain readable when Redis and all workers are unavailable and
when no projection effect exists.

- No Publication mutation route.
- No frontend integration.
- No auth provider.
- No pagination, filtering, cache, ETag, or CORS expansion.

## Full Sprint 2A–5A gate

The GitHub Actions workflow starts PostgreSQL 17 and Redis 7 and runs on one
immutable commit:

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

The workflow requires a clean checkout, `contents: read`, no deployment command,
and no production credential material. The separate deployment workflow performs
only a dry-run build and confirms publishing is disabled.

## Sprint 5A safety boundary

- No automatic publication.
- No HTTP mutation route.
- No UI.
- No Publication mutation route.
- No frontend integration.
- No auth provider.
- No AI discovery or generated Candidate workflow.
- No external crawler.
- No production scheduler or infrastructure provisioning.
- No production credentials.
- No merge.
- No deploy.

Sprint 5A stops at backend read-only Publication HTTP delivery. It does not add
frontend consumption, mutation APIs, authentication, merge, or deployment.
