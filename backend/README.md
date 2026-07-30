# Hải Đấu backend runbook

This runbook covers Sprint 2A production foundation, Sprint 2B catalog authority,
Sprint 3A deterministic normalization and Candidate Registry, Sprint 3B Evidence
v3 and Human Review, Sprint 4A Moderation and Eligibility, Sprint 4B Publication
authority, and the Sprint 5A Read-only Publication HTTP boundary.

PostgreSQL is the system of record. Redis 7 and BullMQ are delivery
infrastructure; they never own catalog, Candidate, trust, Eligibility,
Publication, or public API truth.

## Prerequisites and test environment

- Node.js 22.13 or newer.
- PostgreSQL 17.
- Redis 7.
- A fresh disposable database.
- No production credentials.

```bash
npm ci --cache /tmp/aram-root-npm-cache
npm --prefix backend ci --cache /tmp/aram-backend-npm-cache
export TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/hai_dau_test
export TEST_REDIS_URL=redis://127.0.0.1:6379
npm run backend:typecheck
npm run backend:test
npm run backend:build
```

Tests recreate the public schema. Applied migrations are immutable and recorded
with SHA-256 checksums. There is no production migration CLI.

## Local runtime

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

Workers start separately with `npm --prefix backend run start:worker`. There is
no continuous production scheduler. Production supervision remains deferred.

## Source Policy and delivery recovery

The active Source Policy decides whether storage is `blob_allowed`,
`reference_only`, `aggregate_only`, or `prohibited`. In operational terms,
reference_only cannot supply a stored aggregate snapshot.

Domain state, audit, and outbox rows commit in PostgreSQL before queue delivery.
The dispatcher leases rows with `FOR UPDATE SKIP LOCKED`. Redis failure records
`retryable_failed`; a later pass retries the same immutable event. Deterministic
job IDs and effect rows make lost-ack delivery `duplicate_noop`.

## Catalog authority

Sprint 2B accepts one deterministic `CatalogSnapshotV1`. The application command
uses idempotency scope `catalog_import`. Sealed revisions are immutable.
Activation uses compare-and-swap and returns `CATALOG_ACTIVE_POINTER_CONFLICT`
on stale expectation. Read validation returns `CATALOG_REVISION_NOT_ACTIVE` for
stale selection input. There is No external catalog fetch.

## Normalization and Candidate Registry

Sprint 3A consumes a bounded `ObservationNormalizationSnapshotV1`.

### Fingerprint exclusions

The fingerprint excludes source, Source Policy revision, raw observation,
origin, reference, adapter version, timestamps, and catalog revision.

### Candidate identity and CandidateRevision identity

Candidate identity is patch-scoped semantic identity. CandidateRevision identity
is the immutable representation under one exact active catalog revision.

### Provenance chain

```text
candidate_provenance → normalized_observation → raw_observation
```

- Scenario S1: pre-commit failure rolls back domain, audit, outbox, and effect.
- Scenario S12: patch/catalog/selection mismatch leaves no partial graph.
- Scenario S21: source-independent observations converge while preserving
  provenance membership.

## Evidence and Human Review

Sprint 3B persists Claim-level Evidence. AI provenance is not Evidence.

### Candidate claim-set seal

A Candidate claim-set seal closes the complete Claim membership and cannot be
edited or extended.

### Evidence input snapshot and Evidence decision history

Every Evidence input snapshot pins exact association membership and policy.
Evidence decision history is immutable and current pointers cannot move backward.
Cross-patch revalidation is explicit.

### Human Review input snapshot and Review quorum

A Human Review input snapshot pins exact Claims, Evidence decisions, provenance,
and policy. Only `completed + confirmed + reviewer` records with the same input
hash count toward Review quorum.

Trust writers use the shared order Candidate → CandidateRevision → Claim.

## Moderation and Eligibility

### Moderation decision history

Moderation history is append-only and has No default clear.

### Eligibility input snapshot

An Eligibility input snapshot pins current trust authority. Only required Claims
determine Eligibility. Stale Eligibility reads needs_review.

### Eligibility re-evaluation queue

Eligibility events route to `hai-dau-eligibility-v1`. PostgreSQL remains
Eligibility authority; Redis carries event identity only.

## Publication authority

PostgreSQL remains Publication authority.

### Publication payload and immutable versions

PublicationVersion immutable is a database invariant. Each version pins the
CandidateRevision, Patch, CatalogRevision, Eligibility, Moderation,
required-Claim graph, closed payload, hash, actor, and version number.

### Permission and freshness

Publisher permission required applies to publish and rollback. Fresh Eligibility
rechecked at commit rejects concurrent trust or policy changes.

### Publication activation history

Publication activation history is append-only and must match the active pointer.

### Item-level rollback

Item-level rollback changes only one Publication's active pointer and never edits
an immutable version.

### Public read independent from workers

Public read independent from workers joins active Publication pointers directly
to immutable PostgreSQL versions. Redis, workers, and projections do not own or
change public truth.

## Read-only Publication HTTP boundary

Sprint 5A exposes exactly:

- `GET /api/v1/publications`
- `GET /api/v1/publications/:publicationId`

Public API reads PostgreSQL only. The Fastify route adapter receives only a
`PublicPublicationReader`; it does not receive Redis, BullMQ, dispatcher,
worker, publish, rollback, or projection dependencies.

The list response is `{ "schemaVersion": 1, "publications": [...] }`. The single
response is `{ "schemaVersion": 1, "publication": {...} }`. Every response is
built field-by-field from the validated active Publication read.

A malformed UUID returns HTTP 400 with `INVALID_PUBLICATION_ID`. A valid UUID
without an active Publication returns HTTP 404 with `PUBLICATION_NOT_FOUND`.
Reader failure returns HTTP 500 with `PUBLICATION_READ_FAILED`; SQL, URLs,
credentials, stack traces, and source exception details are not returned.

Rollback is visible immediately because HTTP reads the current PostgreSQL active
pointer. Eligible but unpublished Candidates remain hidden. An already-running
HTTP process continues to serve Publication reads when Redis or workers are
unavailable and when no projection effect exists.

- No Publication mutation route.
- No frontend integration.
- No auth provider.
- No pagination, filtering, cache, ETag, or CORS expansion.

## Full Sprint 2A–5A gate

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

The workflow uses PostgreSQL 17 and Redis 7, keeps `contents: read`, requires a
clean checkout, and scans for deployment commands and credential material. The
separate deployment workflow is dry-run only.

## CI contract index

These exact phrases are intentionally kept contiguous for the repository-owned
runbook/workflow regression contract:

- PostgreSQL 17
- Redis 7
- TEST_DATABASE_URL
- TEST_REDIS_URL
- reference_only
- retryable_failed
- No production credentials
- CatalogSnapshotV1
- catalog_import
- CATALOG_ACTIVE_POINTER_CONFLICT
- CATALOG_REVISION_NOT_ACTIVE
- No external catalog fetch
- ObservationNormalizationSnapshotV1
- Fingerprint exclusions
- Candidate identity
- CandidateRevision identity
- Provenance chain
- Scenario S1
- Scenario S12
- Scenario S21
- reference_only cannot supply a stored aggregate snapshot
- Claim-level Evidence
- Candidate claim-set seal
- Evidence input snapshot
- Evidence decision history
- Cross-patch revalidation
- Human Review input snapshot
- completed + confirmed
- Review quorum
- Candidate → CandidateRevision → Claim
- AI provenance is not Evidence
- Moderation decision history
- No default clear
- Eligibility input snapshot
- Only required Claims determine Eligibility
- Stale Eligibility reads needs_review
- Eligibility re-evaluation queue
- PostgreSQL remains Eligibility authority
- PublicationVersion immutable
- Publisher permission required
- Fresh Eligibility rechecked at commit
- Publication activation history
- Item-level rollback
- Public read independent from workers
- PostgreSQL remains Publication authority
- No automatic publication
- No HTTP mutation route
- No UI
- GET /api/v1/publications
- GET /api/v1/publications/:publicationId
- Read-only Publication HTTP boundary
- Public API reads PostgreSQL only
- No Publication mutation route
- No frontend integration
- No auth provider
- No merge
- No deploy

## Sprint 5A safety boundary

- No automatic publication.
- No HTTP mutation route.
- No UI.
- No Publication mutation route.
- No frontend integration.
- No auth provider.
- No production scheduler or infrastructure provisioning.
- No production credentials.
- No merge.
- No deploy.

Sprint 5A stops at backend read-only Publication HTTP delivery. It does not add
frontend consumption, mutation APIs, authentication, merge, or deployment.
