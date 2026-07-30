# Hải Đấu backend runbook

This runbook covers the Sprint 2A production foundation, Sprint 2B catalog
authority, Sprint 3A deterministic normalization and Candidate Registry,
Sprint 3B Evidence v3 and Human Review persistence, Sprint 4A Moderation and
Eligibility, and Sprint 4B Publication authority and public read.

PostgreSQL is the system of record. Redis/BullMQ is delivery infrastructure and
never owns catalog, Candidate, trust, Eligibility, Publication, or public-read
truth.

## Prerequisites

- Node.js 22.13 or newer.
- PostgreSQL 17.
- Redis 7.
- A disposable database dedicated to local development or tests.

Never point these commands at production data. There are No production
credentials in this repository or workflow.

## Install and root commands

From the repository root:

```bash
npm ci --cache /tmp/aram-root-npm-cache
npm --prefix backend ci --cache /tmp/aram-backend-npm-cache
```

The root orchestration commands are:

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

Tests recreate the public schema. Use only a fresh or disposable database.

Run the complete backend gate:

```bash
npm run backend:typecheck
npm run backend:test
npm run backend:build
```

Run the migration and runbook contract alone:

```bash
cd backend
node --import tsx --test --test-concurrency=1 test/migration.test.ts
```

Migrations are applied in lexical order and recorded with SHA-256 checksums.
Applied migrations are never edited. There is no production migration CLI.

## Local runtime

Build first:

```bash
npm run backend:build
```

Start the HTTP process:

```bash
DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/hai_dau_test \
REDIS_URL=redis://127.0.0.1:6379 \
npm --prefix backend start
```

Start the normalization, Eligibility, and Publication projection workers in a
separate terminal:

```bash
DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/hai_dau_test \
REDIS_URL=redis://127.0.0.1:6379 \
npm --prefix backend run start:worker
```

Health endpoints:

- `GET /health/live` checks that the Node process responds.
- `GET /health/ready` checks PostgreSQL and Redis and returns only `ready` or
  `not_ready`.

There is no continuous production outbox scheduler in Sprint 4B. Tests invoke
the dispatcher boundary explicitly. Process supervision and production
scheduling remain deferred.

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

A domain transaction commits its immutable audit and outbox rows in PostgreSQL
before queue delivery. The dispatcher claims eligible rows with a lease and
`FOR UPDATE SKIP LOCKED`, then uses the outbox event ID as the BullMQ `jobId`.

If Redis is unavailable:

1. committed domain state and the immutable outbox payload remain in PostgreSQL;
2. delivery records `retryable_failed`, clears the lease, and advances
   `available_at`;
3. a later dispatcher pass reclaims the same event;
4. deterministic job IDs prevent a second logical BullMQ job;
5. workers reload authoritative event data from PostgreSQL;
6. lost-ack retry returns `duplicate_noop` and creates no second normalization,
   Eligibility, or Publication projection effect.

Never edit an outbox identity or payload to recover delivery. Restore Redis and
re-dispatch the same PostgreSQL event.

## Catalog authority operations

Sprint 2B accepts only a `CatalogSnapshotV1` supplied by a deterministic
adapter. It contains structured game entities, compatibility rules, adapter
version, and source digest. It contains no HTML, transcripts, comments, raw
community text, images, or credentials.

Catalog import is the application command with idempotency scope
`catalog_import`. Import requires an active Patch and exact Source Policy
revision and writes revision, entity/rule children, seal, lifecycle, audit, and
outbox atomically.

A sealed catalog is immutable. Activation uses compare-and-swap; a stale
expectation fails with `CATALOG_ACTIVE_POINTER_CONFLICT`. Selection validation
requires the exact active patch, mode, and catalog revision; stale input returns
`CATALOG_REVISION_NOT_ACTIVE`.

- No external catalog fetch.
- Catalog lifecycle events are not normalization or Eligibility jobs.

## Deterministic normalization and Candidate Registry

Sprint 3A consumes a bounded `ObservationNormalizationSnapshotV1` from permitted
aggregate metadata. It validates schema version, patch, `aram_mayhem`, origin,
champion, augment IDs, and item IDs before hashing or persistence.

In operational terms, reference_only cannot supply a stored aggregate snapshot.
Only `aggregate_only` or `blob_allowed` may retain the structured normalization
snapshot.

### Fingerprint exclusions

The Candidate fingerprint includes patch ID, mode, canonical subject ID, and
normalized selection signature. It excludes source, Source Policy revision,
raw observation, origin, reference, adapter version, timestamps, and catalog
revision.

### Candidate identity and CandidateRevision identity

Candidate identity is the patch-scoped semantic fingerprint. A repeated
fingerprint reuses one immutable Candidate.

CandidateRevision identity is the immutable representation under one exact
active catalog revision. A catalog refresh may append a new CandidateRevision
without changing Candidate identity.

### Provenance chain

Every accepted raw observation creates an append-only chain:

```text
candidate_provenance → normalized_observation → raw_observation
```

Workers reload PostgreSQL authority and ignore forged Redis fields. The key
regression scenarios are:

- Scenario S1: a failure before commit rolls back domain, audit, outbox, and
  worker-effect rows.
- Scenario S12: patch, active-catalog, or selection mismatch creates no partial
  Candidate graph.
- Scenario S21: source-independent observations converge to one Candidate while
  retaining distinct provenance rows.

## Evidence v3 and Human Review persistence

Sprint 3B adds Claim-level Evidence and immutable Human Review history to a
CandidateRevision. AI provenance is not Evidence.

### Candidate claim-set seal

`defineCandidateClaimSet` creates the complete Claim set and Candidate claim-set
seal atomically. A sealed set contains at least one Claim and at least one
`required` Claim and cannot later be edited or extended.

### Evidence input snapshot and Evidence decision history

Each Evidence input snapshot pins Candidate, CandidateRevision, Claim,
claim-set seal, policy, exact association membership, and canonical hashes.
Evidence decision history is append-only. Re-evaluation advances only a narrow
current pointer and cannot move it backward.

Cross-patch revalidation is explicit. An association from another Patch must
carry the revalidation flag and a reason; an old decision is never silently
reused for a new Patch.

### Human Review input snapshot and Review quorum

A Human Review input snapshot pins the exact CandidateRevision, Claims, current
Evidence decisions, provenance membership, and Review policy visible to the
reviewer. Only `completed + confirmed + reviewer` reviews with the same exact
input hash can count.

Review quorum history is immutable. The current pointer advances only to a
newer valid evaluation and preserves exact eligible review membership and
distinct reviewer identities.

Trust-layer writers use the shared lock order Candidate → CandidateRevision → Claim
before Evidence, Review, Moderation, Eligibility, and Publication pointers.

## Moderation and Eligibility

Sprint 4A adds backend-only, revision-scoped Moderation and Eligibility.

### Moderation decision history

A Moderation command snapshots CandidateRevision, claim-set seal, and complete
provenance membership before appending `clear`, `needs_review`, or `blocked`.
There is No default clear. History is immutable and the current pointer advances
by domain time and PostgreSQL sequence.

### Eligibility input snapshot

An Eligibility input snapshot pins active policy, subordinate policies,
CandidateRevision, claim-set seal, current Moderation, current Review quorum,
and every required Claim with its current Evidence decision or explicit absence.

Only required Claims determine Eligibility. Supporting and informational Claims
remain auditable but do not directly determine the result.

The deterministic precedence is:

1. current blocked Moderation or a contradicted required Claim is `ineligible`;
2. missing, stale, or unresolved authority is `needs_review`;
3. only current clear Moderation, supported required Claims, and satisfied
   current Review quorum are `eligible`.

Stale Eligibility reads needs_review. The read boundary reloads live authority
and never continues serving an old eligible result after provenance, Evidence,
Review, Moderation, or policy changes.

### Eligibility re-evaluation queue

Candidate and trust events are routed only to `hai-dau-eligibility-v1`.
PostgreSQL remains Eligibility authority. Redis carries only immutable outbox
identity; workers derive and persist evaluations from PostgreSQL authority.

Manual recovery calls the same `evaluateCandidateEligibility` command with an
explicit idempotency key. There is no privileged override.

## Publication authority and public read

Sprint 4B publishes immutable CandidateRevision content only after the exact
current trust graph is eligible. PostgreSQL remains Publication authority.
Redis, workers, and projection rows are monitoring and delivery concerns only.

### Publication payload and immutable versions

PublicationVersion immutable is a hard database invariant. A version pins:

- one Publication and Candidate;
- one CandidateRevision, Patch, mode, CatalogRevision, and normalized signature;
- the active Eligibility policy and current Eligibility evaluation/input hash;
- the current Moderation decision and policy;
- exact required-Claim membership and Evidence decision IDs;
- a closed canonical `PublicationPayloadV1` and SHA-256 payload hash;
- a monotonic version number, actor, correlation, and creation sequence.

The application reconstructs the payload from PostgreSQL. Callers cannot submit
public content, trust outcomes, source text, HTML, comments, reviewer identity,
moderation reason, credentials, or private references.

### Permission boundary

Publisher permission required applies to both publish and rollback. The command
accepts a closed application authorization context containing `publisher`.
Missing permission fails before Publication, audit, outbox, or completed
idempotency effects.

This is an application authorization boundary, not an identity provider. There
is No HTTP mutation route and No UI for publication in Sprint 4B.

### Publish, replay, CAS conflict, and stale-input recovery

A successful publish locks and reloads Candidate, CandidateRevision, Claims,
current Evidence and Review pointers, current Moderation, active Eligibility
policy/current evaluation, Publication, and active Publication pointer in the
shared order.

Fresh Eligibility rechecked at commit means deferred PostgreSQL guards compare
the stored version pins with the live authority graph immediately before COMMIT.
A concurrent provenance, Evidence, Review, Moderation, policy, or Eligibility
change makes the transaction fail closed and creates no version or activation.

First publish expects no active version. Later publish uses compare-and-swap
against the expected active PublicationVersion. A stale expectation returns a
stable conflict and leaves no orphan version, history, pointer, audit, outbox, or
idempotency completion.

Replaying the same completed idempotency command is side-effect-free. Reusing an
idempotency key with changed input fails. After a stale-input failure, recompute
Moderation/Eligibility through the normal authority commands and retry publish
with the new expected IDs; never patch Publication rows directly.

### Publication activation history

Publication activation history is append-only. Every pointer movement records
`published` or `rolled_back`, from-version, to-version, actor, audit/outbox
correlation, time, and database sequence.

A publish activation can target only the newest appended version. The latest
activation and active pointer must match at COMMIT. Direct SQL cannot create a
pointer without matching history or history without the matching pointer.

### Item-level rollback

Item-level rollback requires `publisher`, the expected current active version,
and an existing immutable target version owned by the same Publication. It
appends rollback history and changes only that Publication's active pointer.
It never edits or deletes a PublicationVersion and never changes another item.

Concurrent publish versus rollback has one compare-and-swap winner. Rollbacks
of different Publication items proceed independently. A new command targeting
the already active version fails rather than inventing no-op history.

### Public read independent from workers

Public read independent from workers means the read boundary joins the active
Publication pointer directly to immutable PublicationVersion rows in PostgreSQL.
Active content remains readable when Redis and all workers are stopped.
Unpublished Candidates and inactive versions remain hidden. Projection delay
cannot delay or alter public truth.

### Projection delivery and replay

`PublicationPublished` and `PublicationRolledBack` route only to
`hai-dau-publication-v1`. The projection worker accepts only the closed event
set, requires the BullMQ job ID to equal the outbox event ID, reloads the source
row and Publication graph from PostgreSQL, and ignores forged Redis fields.

Duplicate or lost-ack delivery creates one `publication_projection_effect`.
Concurrent duplicate delivery is replay-safe. The projection worker never reads
or changes the active Publication pointer and cannot publish or retract content.

## Full Sprint 2A–4B gate

The GitHub Actions workflow starts PostgreSQL 17 and Redis 7, installs both
lockfiles, and runs on one immutable commit:

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

The workflow also requires a clean checkout, `contents: read`, no deployment
command, and no production credential material. The separate deployment workflow
runs only a dry-run build and confirms publishing is disabled.

## Sprint 4B safety boundary

- No automatic publication.
- No HTTP mutation route.
- No UI.
- No identity provider or account administration.
- No AI discovery or generated Candidate workflow.
- No external crawler.
- No production scheduler or infrastructure provisioning.
- No production credentials.
- No merge.
- No deploy.

Sprint 4B stops at backend Publication authority, item-level rollback, direct
PostgreSQL public read, and replay-safe projection monitoring. It does not merge
or deploy itself.
