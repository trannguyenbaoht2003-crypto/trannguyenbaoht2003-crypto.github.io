# Sprint 3A Deterministic Normalization and Candidate Registry Design

## Status

Approved for design and implementation under the project owner's standing
delegation to continue the agreed Hải Đấu Core roadmap without requiring a
prompt for every previously ordered step.

This design is implemented only on the stacked draft branch
`feat/3a-deterministic-candidate-registry`, based on the verified Sprint 2B
head `d1d325e847e499a88e2f246f1e1e40822d4cadc4`. It does not authorize merging
PR #8, PR #9, PR #10, or the Sprint 3A PR; production credentials;
infrastructure provisioning; external collection; data migration; or
deployment.

## Goal

Turn one immutable raw observation into a deterministic normalized
observation and register it against the exact active catalog without creating
source-specific duplicate candidates.

Sprint 3A establishes this dependency boundary:

> Raw Observation → Active Catalog Lock → Deterministic Normalization →
> Catalog Selection Validation → Candidate Revision → Provenance

It implements the production forms of Common Harness transaction boundary T3
and scenarios S1, S12, and S21 while preserving PostgreSQL as the system of
record and the existing static frontend as the public read path.

## Inputs

- Architecture Baseline v0.2.
- Data Model Domain Spec v0.2.
- ADR-0002 selecting Node/Fastify + PostgreSQL + BullMQ/Redis.
- Sprint 2A production foundation at
  `16ab189b96041b3b00355a25c07689f487b844ff`.
- Sprint 2B catalog authority at
  `d1d325e847e499a88e2f246f1e1e40822d4cadc4`.
- Common Harness T3 and scenarios S1, S12, and S21.
- Existing immutable raw observations, active catalog pointer, catalog
  selection validator, transactional outbox, and normalization worker.

## Non-goals

Sprint 3A does not:

- fetch or parse Riot, CommunityDragon, Hải Đấu, Bilibili, Douyin, or any
  other external source;
- add a new collector adapter or network dependency;
- create claims, Evidence decisions, HumanReview, Moderation, Eligibility,
  Publication, or public API records;
- infer or generate candidate content with AI;
- treat an `ai_generated` provenance label as review or publication approval;
- alter generated frontend guides or the public read path;
- route Candidate events to a downstream queue before Sprint 3B provides a
  consumer;
- provision production PostgreSQL/Redis, use production credentials, merge,
  or deploy.

## Approaches considered

### 1. Create one Candidate per raw observation

This is easy to implement, but source identity becomes part of candidate
identity. The same build collected from Bilibili, Douyin, editorial input, or
an AI discovery path would create duplicate candidates and violate Common
Harness scenario S21.

### 2. Keep one canonical Candidate, immutable CandidateRevisions, and
append-only provenance

The backend derives a semantic signature from normalized game selections and
then derives a fingerprint from patch, mode, subject, and that signature.
Source, origin, reference, adapter version, raw observation ID, and timestamps
are excluded. A repeated fingerprint reuses the canonical Candidate; an exact
catalog binding reuses its CandidateRevision; every independent observation
adds provenance.

### 3. Store only an event stream and build Candidate projections

This provides a complete replayable history, but it would add event-store and
projection-rebuild infrastructure before the Evidence and Publication
aggregates exist. PostgreSQL append-only domain rows plus the existing outbox
already provide the required auditability for Sprint 3A.

## Decision

Use approach 2.

The Candidate is a patch-scoped semantic identity. CandidateRevision is the
immutable catalog-pinned representation that future Evidence decisions will
reference. Provenance belongs to a CandidateRevision and preserves every
independent origin without contaminating the fingerprint.

## Branch and integration strategy

Sprint 3A is a stacked draft change:

- base commit: Sprint 2B PASS head
  `d1d325e847e499a88e2f246f1e1e40822d4cadc4`;
- head branch: `feat/3a-deterministic-candidate-registry`;
- pull request base: `feat/2b-catalog-authority`;
- intended merge order, only after separate approval: ADR PR #8 → Sprint 2A
  PR #9 → Sprint 2B PR #10 → Sprint 3A;
- no merge and no deployment during implementation.

PR #10 remains frozen as the auditable Sprint 2B checkpoint.

## Normalization snapshot contract

The application accepts only `ObservationNormalizationSnapshotV1` from a
deterministic adapter boundary:

```ts
export type CandidateOrigin =
  | 'collector_detected'
  | 'community_submitted'
  | 'editorial'
  | 'ai_generated';

export interface ObservationNormalizationSnapshotV1 {
  schemaVersion: 1;
  patchKey: string;
  gameModeExternalId: 'aram_mayhem';
  origin: CandidateOrigin;
  subjectExternalId: string;
  augmentExternalIds: string[];
  itemExternalIds: string[];
}
```

The snapshot contains structured game identity only. It must not contain
source HTML, transcript text, comments, images, credentials, popularity
signals, moderation state, or publication copy.

The runtime shape is closed: the snapshot must contain exactly the seven
declared properties, and the aggregate wrapper must contain only
`normalizationSnapshot`. Every trimmed identifier is limited to 128
characters and each augment/item list is limited to 64 entries. Input outside
those bounds, including sparse arrays with missing indices, fails with
`NORMALIZATION_SCHEMA_UNSUPPORTED` before it is hashed or stored.

The pure normalizer:

1. requires schema version `1` and mode `aram_mayhem`;
2. trims every textual identifier and rejects an empty value;
3. rejects duplicate augment or item IDs rather than silently collapsing
   malformed input;
4. sorts augment and item IDs by code-point order because Sprint 3A models
   each list as a semantic set, not a presentation or purchase sequence;
5. creates the canonical payload:

```ts
interface CandidateSelectionPayloadV1 {
  schemaVersion: 1;
  augmentExternalIds: string[];
  itemExternalIds: string[];
}
```

6. computes:

```ts
normalizedSignature = sha256(canonicalJson(candidateSelectionPayload));

fingerprint = sha256(canonicalJson({
  patchScope: patchId,
  gameMode: gameModeExternalId,
  subjectGameEntity: subjectExternalId,
  normalizedSignature,
}));
```

The fingerprint deliberately excludes:

- `source_id`;
- `source_policy_revision_id`;
- `raw_observation_id`;
- `normalized_observation_id`;
- `origin`;
- external reference;
- adapter and normalizer versions;
- collection and observation timestamps;
- catalog revision ID.

Excluding the catalog revision allows the same semantic Candidate to survive
a catalog refresh inside one patch. The catalog binding remains explicit and
immutable on CandidateRevision. Patch remains part of the fingerprint, so
Evidence is never reused implicitly across patches.

Stable normalization reason codes are limited to:

- `NORMALIZATION_SCHEMA_UNSUPPORTED`;
- `NORMALIZATION_PATCH_KEY_REQUIRED`;
- `NORMALIZATION_SUBJECT_REQUIRED`;
- `NORMALIZATION_ENTITY_ID_REQUIRED`;
- `NORMALIZATION_DUPLICATE_ID`.

## Persistence model

Migration `0006_deterministic_candidate_registry.sql` adds four domain tables
and the minimum composite constraints required for exact catalog binding.

### `normalized_observations`

One immutable row per raw observation:

- `normalized_observation_id`;
- unique `raw_observation_id`;
- `patch_id`;
- `catalog_revision_id`;
- `game_mode_external_id`, fixed to `aram_mayhem` in V1;
- `subject_game_entity_revision_id`;
- `normalizer_version`, fixed to the application ruleset version used;
- `normalized_signature`;
- canonical selection payload;
- creation timestamp.

The subject entity revision and catalog revision use a composite foreign key.
The catalog revision and patch ID use a second composite foreign key.
PostgreSQL therefore rejects either a subject from another catalog or a
catalog from another patch even if application validation is bypassed.
The canonical payload is protected by
`is_candidate_selection_payload_v1(jsonb)`, which requires exactly
`schemaVersion`, `augmentExternalIds`, and `itemExternalIds`; schema version
1; at most 64 non-empty, trimmed identifiers of at most 128 characters in
each array; no duplicates; and strict code-point ordering.

### `candidates`

One immutable semantic identity:

- `candidate_id`;
- unique 64-character lowercase hexadecimal `fingerprint`;
- `patch_id`;
- `game_mode_external_id`;
- canonical `subject_game_entity_id`;
- creation timestamp.

Origin is not stored on this table.

### `candidate_revisions`

Immutable catalog-pinned content:

- `candidate_revision_id`;
- `candidate_id`;
- positive revision number;
- `patch_id`;
- `catalog_revision_id`;
- `normalized_signature`;
- canonical selection payload;
- creation timestamp.

`candidate_id + revision` is unique. Composite foreign keys require the
revision patch to own both its Candidate and catalog revision. The exact
combination of candidate, catalog revision, and normalized signature is also
unique. The same strict V1 PostgreSQL payload check used by normalized
observations applies to CandidateRevisions, and the application rejects a
signature whose canonical payload does not match the stored payload. A second
observation with the same fingerprint under the same catalog reuses the
revision. The same fingerprint under a newer active catalog creates the next
revision while retaining the same Candidate.

### `candidate_provenance`

One append-only link per independent normalized observation:

- `candidate_provenance_id`;
- `candidate_revision_id`;
- unique `normalized_observation_id`;
- `origin`;
- creation timestamp.

The immutable chain
`candidate_provenance → normalized_observation → raw_observation` preserves
the exact source, Source Policy revision, adapter version, content hash,
permitted reference, and collection time without duplicating governed source
data into Candidate tables.

A PostgreSQL insert trigger accepts a provenance link only when its Candidate,
CandidateRevision, and normalized observation have the same subject, patch,
game mode, catalog revision, normalized signature, and canonical payload.
Because every referenced row is immutable, the graph cannot become
inconsistent later.

All four tables reject update and delete. Candidate rows are never updated to
increment a provenance counter; counts are derived from immutable provenance
rows.

## Application boundary

`registerNormalizedObservation(pool, command)` is the public application
boundary. `registerNormalizedObservationInTransaction(client, command)` is
the internal form used by the BullMQ worker so its writes share the worker's
existing transaction.

The command supplies actor/correlation IDs, raw and normalized observation
IDs, candidate/revision/provenance IDs for deterministic tests and audit, and
the normalization snapshot.

The boundary:

1. normalizes the snapshot and computes its semantic signature before any
   write;
2. locks the immutable raw observation with `FOR UPDATE`, then reloads replay
   state so concurrent commands for one raw observation return one result;
3. resolves `patchKey` and locks the Patch row `FOR SHARE` in a standalone
   statement, then reads the latest lifecycle state and exact
   `active_catalog_revisions` row in a fresh statement that requires
   `active` and locks the pointer `FOR SHARE`;
4. validates the subject, augment, and item selection through the Sprint 2B
   validator against that exact pointer;
5. resolves the subject game entity revision in the same catalog;
6. computes the origin-independent fingerprint;
7. inserts the normalized observation;
8. inserts the canonical Candidate with
   `ON CONFLICT (fingerprint) DO NOTHING`, then locks the resulting Candidate
   row to serialize concurrent revision numbering;
9. verifies the stored Candidate identity matches the fingerprint inputs;
10. reuses or creates the immutable CandidateRevision for the exact catalog
    binding;
11. inserts one provenance row;
12. writes one audit event and one outbox event;
13. commits all writes together.

The result returns candidate and revision IDs plus:

```ts
interface RegisterNormalizedObservationResult {
  normalizedObservationId: string;
  candidateId: string;
  candidateRevisionId: string;
  candidateCreated: boolean;
  candidateRevisionCreated: boolean;
  provenanceAdded: boolean;
}
```

If `raw_observation_id` is already normalized, the boundary returns the
existing result only when the persisted semantic signature and catalog
binding match. A different payload fails with
`NORMALIZATION_REPLAY_CONFLICT`.

## Concurrency and transaction atomicity

PostgreSQL is authoritative for every race:

- Patch lifecycle append first locks the Patch row `FOR UPDATE`; registration
  takes the conflicting `FOR SHARE` lock before reading lifecycle state, so a
  withdrawal and registration serialize without a stale snapshot;
- the active catalog pointer is held with `FOR SHARE` until commit, while
  activation uses a conflicting row lock;
- an exclusive raw-observation lock serializes concurrent replay before the
  unique normalized-observation insert;
- unique fingerprint plus `ON CONFLICT` produces one Candidate under
  concurrent source observations;
- the Candidate row lock serializes CandidateRevision numbering;
- unique normalized observation and provenance constraints prevent duplicate
  effects;
- audit and outbox rows are written inside the same transaction;
- any failure after the first insert rolls back normalized observation,
  Candidate, CandidateRevision, provenance, audit, outbox, and the worker's
  `normalization_effects` reservation.

No test-only failure hook is added to production code. Rollback tests trigger
real constraint conflicts after earlier writes and verify the full
before/after database state.

## Worker integration

The existing worker already reloads the authoritative outbox event from
PostgreSQL and reserves one `normalization_effects` row. Sprint 3A changes its
normalization callback to receive the same `PoolClient` used by the worker
transaction:

```ts
interface NormalizationSourceContext {
  observationId: string;
  outboxEventId: string;
  correlationId: string;
}

normalizeObservation(
  client: PoolClient,
  source: NormalizationSourceContext,
): Promise<RegisterNormalizedObservationResult>;
```

The source context is reloaded from the immutable PostgreSQL outbox row; Redis
cannot override any of its fields. The production handler reads a bounded
`ObservationNormalizationSnapshotV1` from permitted structured observation
metadata. Source-specific fetching/parsing remains outside this sprint.

A `reference_only` policy, prohibited policy, or authoritative observation
without a stored top-level normalization snapshot is terminal
`not_normalizable`. The worker records exactly one attempt before reserving
`normalization_effects`, does not invoke the callback, and does not retry.
Only observations whose authoritative Source Policy permits structured
metadata and whose stored wrapper is exactly `{ normalizationSnapshot }`
enter the registration transaction.

A worker retry after commit observes the existing normalization effect and
returns `duplicate_noop` without adding a second normalized observation,
CandidateRevision, provenance, audit, or outbox event. If the registration
throws before commit, the reservation and all domain writes roll back
together, allowing a safe retry.

Candidate events remain in PostgreSQL. The dispatcher allowlist remains
`RawObservationIngested` only until Sprint 3B adds a specific downstream
consumer.

## Audit and outbox

Every successfully registered normalized observation writes exactly one audit
row and one outbox row in its transaction.

The event type is selected from the committed effect:

- `CandidateRegistered` when a new canonical Candidate is created;
- `CandidateRevisionRegistered` when an existing Candidate receives a new
  catalog-pinned revision;
- `CandidateProvenanceAdded` when both Candidate and CandidateRevision
  already exist.

Every payload contains only IDs, fingerprint, catalog revision, origin, and
the creation flags. It does not contain raw source text, credentials, or a
copy of external reference data.

## Error handling and security

- Unknown normalization schema and malformed identifiers fail before any
  write.
- Missing raw observation, inactive patch, missing active catalog, stale
  catalog, or invalid selection fails closed.
- Catalog reason codes from Sprint 2B are preserved rather than replaced by
  free-form text.
- A source label cannot affect fingerprinting or canonical Candidate
  identity.
- The `ai_generated` origin is provenance only; Sprint 3B/3C guards remain
  required before any future publication.
- HTTP endpoints are not added.
- Logs and errors do not expose raw blobs, source references, SQL, stack
  traces, or credentials.
- CI retains `contents: read` and has no deploy command.

## Testing strategy

All implementation is test-first.

### Pure normalization and fingerprinting

- equivalent array orders produce one signature;
- duplicate IDs and empty IDs fail with stable reason codes;
- additional fields, sparse arrays, identifiers over 128 characters, and
  lists over 64 entries fail closed;
- source, origin, reference, adapter version, and timestamps cannot change a
  fingerprint;
- patch, mode, subject, or semantic selection changes the fingerprint.

### Migration and immutability

- PostgreSQL 17 creates all four tables and composite constraints;
- normalized observations, Candidates, CandidateRevisions, and provenance
  reject update/delete;
- a subject entity revision from another catalog is rejected by PostgreSQL;
- patch/catalog/subject/mode mismatches and inconsistent provenance graph
  links are rejected by PostgreSQL;
- direct SQL cannot insert a non-canonical, unbounded, duplicate, unsorted,
  or non-V1 payload into either immutable payload column;
- migration checksums remain locked.

### Candidate registration

- a valid snapshot under the active catalog creates one complete graph;
- wrong patch/catalog or invalid selection creates zero rows;
- a real late constraint conflict rolls back every domain, audit, outbox, and
  normalization-effect row;
- the same raw observation replays without a duplicate side effect;
- concurrent commands for the same raw observation return the same result;
- a concurrent Patch withdrawal and registration serialize; if withdrawal
  wins, registration creates no Candidate, and if registration wins, the
  Candidate commits before withdrawal;
- a changed replay payload is rejected;
- two origins with the same semantic signature produce one Candidate, one
  CandidateRevision, and two provenance rows;
- two concurrent sources with the same fingerprint have the same result;
- the same fingerprint under a later catalog revision creates one Candidate
  with two immutable CandidateRevisions.

### Worker

- the callback receives the worker transaction client;
- PostgreSQL, not the Redis payload, selects the raw observation;
- callback failure rolls back the normalization reservation and registration;
- lost acknowledgement retry is `duplicate_noop`;
- reference-only or snapshot-less observations return terminal
  `not_normalizable` without callback, retry, or normalization effect;
- duplicate normalized observations, revisions, provenance, audit, outbox,
  and normalization effects remain zero.

### Regression gate

The repository gate runs PostgreSQL 17 and Redis 7 and retains:

- all frontend validation, lint, 46 tests, and GitHub Pages build;
- all 45 Sprint 2A–2B backend tests;
- new migration, normalization, fingerprint, candidate registration,
  concurrency, rollback, and worker tests;
- backend typecheck and build;
- repository cleanliness and deployment guard.

No test uses production data or an external network.

## Definition of Done

- Every accepted normalized observation pins the exact active catalog
  revision used for validation.
- Normalization and fingerprinting are deterministic.
- Candidate fingerprints exclude source and origin and remain patch-scoped.
- Same-fingerprint observations converge to one Candidate and preserve every
  provenance record.
- CandidateRevision history is immutable and catalog-pinned.
- S1 rollback leaves no partial domain, audit, outbox, or worker effect.
- S12 rejects patch/catalog mismatch before Candidate creation.
- S21 produces one Candidate, one fingerprint, and two provenance records.
- Existing frontend and Sprint 2A–2B gates remain green.
- No Evidence, HumanReview, Moderation, Eligibility, Publication, external
  fetch, credential, merge, or deploy is introduced.

## Roadmap after Sprint 3A

1. **Sprint 3B — Evidence v3 and Human Review persistence:** claims,
   associations, patch-pinned Evidence decisions, review quorum, and
   immutable decision history.
2. **Sprint 3C — Moderation and Eligibility:** no implicit `clear`, signal
   snapshot pinning, re-moderation, and stale-input guards.
3. **Sprint 4 — Publication aggregate and public read path:** immutable
   publication versions, per-item rollback, monitoring projection, and
   static snapshot export.
4. **Sprint 5 — Production readiness:** managed PostgreSQL/Redis selection,
   secrets, backup/restore rehearsal, observability, staged migration, and
   explicit deployment approval.

## Self-review

- Completeness: normalized observation, fingerprint, CandidateRevision,
  provenance, worker integration, audit/outbox, and rollback are explicit.
- Consistency: fingerprint matches Common Harness semantics and excludes
  origin; catalog revision is pinned on CandidateRevision instead.
- Scope: structured adapter input is accepted, but external collection and
  parsing remain deferred.
- Atomicity: the worker reservation and T3 writes share one PostgreSQL
  transaction.
- Integration: the Sprint 3A branch remains stacked on frozen Sprint 2B and
  does not alter the public frontend read path.
