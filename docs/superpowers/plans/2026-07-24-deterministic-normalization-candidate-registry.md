# Sprint 3A Deterministic Normalization and Candidate Registry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist deterministic normalized observations against the exact
active catalog and converge source-independent duplicates into one immutable
Candidate history with append-only provenance.

**Architecture:** A pure normalizer canonicalizes the bounded V1 selection and
derives a source-independent fingerprint. A PostgreSQL transaction locks the
active catalog pointer, validates the selection, writes the normalized
observation, canonical Candidate, catalog-pinned CandidateRevision,
provenance, audit, and outbox, and shares the normalization worker's existing
transaction so retries cannot create partial or duplicate effects.

**Tech Stack:** Node.js 22.13+, TypeScript 5.9 strict, PostgreSQL 17,
BullMQ 5, Redis 7, Node test runner.

## Global Constraints

- Work only on stacked branch `feat/3a-deterministic-candidate-registry`
  based on Sprint 2B head
  `d1d325e847e499a88e2f246f1e1e40822d4cadc4`.
- Keep the Sprint 3A pull request based on `feat/2b-catalog-authority`.
- Do not merge or deploy.
- Keep PostgreSQL as the system of record; Redis payloads are never
  authoritative.
- Add no runtime dependency, external fetch, production credential, or
  infrastructure.
- Keep mode V1 fixed to `aram_mayhem`.
- Treat augment and item arrays as semantic sets: reject duplicates and sort
  by code-point order.
- Fingerprint only patch, mode, subject, and normalized signature; exclude
  source, origin, IDs, references, adapter versions, and timestamps.
- CandidateRevision, not Candidate, pins the catalog revision.
- Add no Claim, Evidence, HumanReview, Moderation, Eligibility, AI,
  Publication, or public API behavior.
- Every production behavior change follows RED → GREEN before refactoring.
- PostgreSQL/Redis integration evidence must come from the read-only GitHub
  Actions gate at the exact committed SHA.

---

## File map

- `backend/src/modules/candidate/types.ts`: V1 snapshot, normalized payload,
  origin, reason codes, command/result types.
- `backend/src/modules/candidate/normalize-observation.ts`: pure runtime
  validation, canonicalization, semantic signature, and fingerprint.
- `backend/migrations/0006_deterministic_candidate_registry.sql`: immutable
  normalized observations, Candidates, CandidateRevisions, provenance, and
  exact catalog foreign keys.
- `backend/src/modules/candidate/register-normalized-observation.ts`:
  transactional catalog lock, validation, deduplication, revision selection,
  replay, provenance, audit, and outbox.
- `backend/src/modules/candidate/register-stored-observation.ts`: bounded
  structured-metadata loader used by the runtime worker.
- `backend/src/modules/catalog/validate-catalog-selection.ts`: accept a
  transaction client without changing read-only behavior.
- `backend/src/modules/collector/ingest-observation.ts`: persist permitted
  aggregate metadata needed by deterministic adapters.
- `backend/src/queue/normalization-worker.ts`: pass PostgreSQL-authoritative
  source context and the existing transaction client to normalization.
- `backend/src/worker.ts`: wire the real stored-observation registrar.
- `backend/test/candidate-normalization.test.ts`: pure RED/GREEN contract.
- `backend/test/candidate-migration.test.ts`: schema, foreign-key, and
  immutability contract.
- `backend/test/candidate-registration.test.ts`: S1, S12, replay, concurrency,
  revision, and S21 contract.
- `backend/test/worker.test.ts`: transaction-client and lost-ack integration.
- `backend/test/helpers/catalog.ts`: reusable active-catalog fixture.
- `backend/test/helpers/candidate.ts`: raw observation and command fixture.
- `backend/test/migration.test.ts`: expected table list.
- `backend/test/observation.test.ts`: aggregate-storage policy regression.
- `backend/README.md`: Sprint 3A operational and safety boundary.
- `.github/workflows/backend-production-foundation.yml`: Sprint 3A gate label
  and runbook contract only; permissions and commands remain read-only.

---

### Task 1: Pure normalization and fingerprint contract

**Files:**

- Create: `backend/src/modules/candidate/types.ts`
- Create: `backend/src/modules/candidate/normalize-observation.ts`
- Create: `backend/test/candidate-normalization.test.ts`

**Interfaces:**

- Produces:
  `normalizeObservationSnapshot(value: unknown): NormalizedObservationSnapshot`
- Produces:
  `fingerprintCandidate(input: CandidateFingerprintInput): string`
- Produces origin union:
  `collector_detected | community_submitted | editorial | ai_generated`
- Consumes existing `hashCanonicalJson(value: unknown): string`

- [ ] **Step 1: Write the failing pure tests**

Create `backend/test/candidate-normalization.test.ts` with tests that:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  fingerprintCandidate,
  normalizeObservationSnapshot,
} from '../src/modules/candidate/normalize-observation.js';

function snapshot() {
  return {
    schemaVersion: 1,
    patchKey: '26.15',
    gameModeExternalId: 'aram_mayhem',
    origin: 'collector_detected',
    subjectExternalId: 'samira',
    augmentExternalIds: ['1194', '2001'],
    itemExternalIds: ['6672', '3006'],
  };
}

test('equivalent set order produces one normalized signature', () => {
  const left = normalizeObservationSnapshot(snapshot());
  const right = normalizeObservationSnapshot({
    ...snapshot(),
    augmentExternalIds: ['2001', '1194'],
    itemExternalIds: ['3006', '6672'],
  });
  assert.equal(left.normalizedSignature, right.normalizedSignature);
  assert.deepEqual(left.payload.augmentExternalIds, ['1194', '2001']);
  assert.deepEqual(left.payload.itemExternalIds, ['3006', '6672']);
});

test('duplicate and empty identifiers fail with stable codes', () => {
  assert.throws(
    () => normalizeObservationSnapshot({
      ...snapshot(),
      itemExternalIds: ['3006', ' 3006 '],
    }),
    /NORMALIZATION_DUPLICATE_ID/,
  );
  assert.throws(
    () => normalizeObservationSnapshot({
      ...snapshot(),
      augmentExternalIds: [' '],
    }),
    /NORMALIZATION_ENTITY_ID_REQUIRED/,
  );
});

test('origin and source-adjacent fields do not affect fingerprint', () => {
  const normalized = normalizeObservationSnapshot(snapshot());
  const base = {
    gameModeExternalId: normalized.snapshot.gameModeExternalId,
    normalizedSignature: normalized.normalizedSignature,
    patchId: '40000000-0000-4000-8000-000000000003',
    subjectExternalId: normalized.snapshot.subjectExternalId,
  };
  assert.equal(
    fingerprintCandidate(base),
    fingerprintCandidate({
      ...base,
      origin: 'ai_generated',
      sourceId: 'different-source',
    }),
  );
});

test('patch, subject, or semantic selection changes fingerprint', () => {
  const first = normalizeObservationSnapshot(snapshot());
  const second = normalizeObservationSnapshot({
    ...snapshot(),
    itemExternalIds: ['3006'],
  });
  const common = {
    gameModeExternalId: 'aram_mayhem' as const,
    patchId: '40000000-0000-4000-8000-000000000003',
    subjectExternalId: 'samira',
  };
  const fingerprint = fingerprintCandidate({
    ...common,
    normalizedSignature: first.normalizedSignature,
  });
  assert.notEqual(fingerprint, fingerprintCandidate({
    ...common,
    patchId: '50000000-0000-4000-8000-000000000003',
    normalizedSignature: first.normalizedSignature,
  }));
  assert.notEqual(fingerprint, fingerprintCandidate({
    ...common,
    subjectExternalId: 'jinx',
    normalizedSignature: first.normalizedSignature,
  }));
  assert.notEqual(fingerprint, fingerprintCandidate({
    ...common,
    normalizedSignature: second.normalizedSignature,
  }));
});
```

- [ ] **Step 2: Run RED**

Run:

```bash
cd backend
node --import tsx --test test/candidate-normalization.test.ts
```

Expected: FAIL with module-not-found for
`src/modules/candidate/normalize-observation.ts`.

- [ ] **Step 3: Implement types and pure normalizer**

Create `types.ts` with the exact V1 unions/interfaces from the design and
`NormalizedObservationSnapshot`:

```ts
export interface NormalizedObservationSnapshot {
  normalizedSignature: string;
  payload: CandidateSelectionPayloadV1;
  snapshot: ObservationNormalizationSnapshotV1;
}
```

Create `normalize-observation.ts`. Runtime-validate `unknown`, trim strings,
sort with:

```ts
const compareText = (left: string, right: string): number => (
  left < right ? -1 : left > right ? 1 : 0
);
```

Reject duplicates after trimming. Require exactly the seven V1 snapshot keys
and a one-key aggregate wrapper, cap identifiers at 128 characters, and cap
each selection array at 64 entries. Compute `normalizedSignature` only from
the canonical selection payload. Implement `fingerprintCandidate` by
explicitly constructing:

```ts
{
  patchScope: input.patchId,
  gameMode: input.gameModeExternalId,
  subjectGameEntity: input.subjectExternalId,
  normalizedSignature: input.normalizedSignature,
}
```

Do not spread the input into the hash object.

- [ ] **Step 4: Run GREEN**

Run the Task 1 test plus backend typecheck. Expected: all Task 1 tests PASS and
typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add backend/src/modules/candidate backend/test/candidate-normalization.test.ts
git commit -m "feat(3a): define deterministic candidate fingerprint"
```

---

### Task 2: Immutable Candidate Registry migration

**Files:**

- Create: `backend/migrations/0006_deterministic_candidate_registry.sql`
- Create: `backend/test/candidate-migration.test.ts`
- Modify: `backend/test/migration.test.ts`

**Interfaces:**

- Produces tables:
  `normalized_observations`, `candidates`, `candidate_revisions`,
  `candidate_provenance`
- Adds unique composite key on
  `game_entity_revisions(game_entity_revision_id, catalog_revision_id)`

- [ ] **Step 1: Write the failing migration tests**

Add the four table names to `expectedTables`. Create tests that migrate a
fresh database, use the existing active catalog fixture, and assert:

```ts
for (const table of [
  'normalized_observations',
  'candidates',
  'candidate_revisions',
  'candidate_provenance',
]) {
  await assert.rejects(
    pool.query(`update ${table} set created_at = clock_timestamp()`),
    /immutable/,
  );
  await assert.rejects(pool.query(`delete from ${table}`), /immutable/);
}
```

Seed a normalized row whose subject revision belongs to another catalog and
assert the insert is rejected by the composite foreign key.
Also reject a catalog from another patch, a CandidateRevision whose patch
does not own both Candidate and catalog, and a provenance link whose revision
and observation differ by catalog, signature, or canonical payload.

- [ ] **Step 2: Run RED**

Run:

```bash
cd backend
node --import tsx --test --test-concurrency=1 \
  test/migration.test.ts test/candidate-migration.test.ts
```

Expected: FAIL because migration `0006` and its four tables do not exist.

- [ ] **Step 3: Add migration `0006`**

The migration must:

```sql
alter table game_entity_revisions
  add constraint game_entity_revisions_revision_catalog_unique
  unique (game_entity_revision_id, catalog_revision_id);

create table normalized_observations (
  normalized_observation_id uuid primary key,
  raw_observation_id uuid not null unique
    references raw_observations(raw_observation_id),
  patch_id uuid not null references patches(patch_id),
  catalog_revision_id uuid not null
    references catalog_revision_seals(catalog_revision_id),
  game_mode_external_id text not null
    check (game_mode_external_id = 'aram_mayhem'),
  subject_game_entity_revision_id uuid not null,
  normalizer_version text not null
    check (length(btrim(normalizer_version)) > 0),
  normalized_signature text not null
    check (normalized_signature ~ '^[a-f0-9]{64}$'),
  canonical_payload jsonb not null
    check (jsonb_typeof(canonical_payload) = 'object'),
  created_at timestamptz not null default clock_timestamp(),
  foreign key (subject_game_entity_revision_id, catalog_revision_id)
    references game_entity_revisions(
      game_entity_revision_id,
      catalog_revision_id
    ),
  foreign key (catalog_revision_id, patch_id)
    references catalog_revisions(
      catalog_revision_id,
      patch_id
    )
);

create table candidates (
  candidate_id uuid primary key,
  fingerprint text not null unique
    check (fingerprint ~ '^[a-f0-9]{64}$'),
  patch_id uuid not null references patches(patch_id),
  game_mode_external_id text not null
    check (game_mode_external_id = 'aram_mayhem'),
  subject_game_entity_id uuid not null references game_entities(game_entity_id),
  created_at timestamptz not null default clock_timestamp(),
  unique (candidate_id, patch_id)
);

create table candidate_revisions (
  candidate_revision_id uuid primary key,
  candidate_id uuid not null,
  revision integer not null check (revision > 0),
  patch_id uuid not null,
  catalog_revision_id uuid not null
    references catalog_revision_seals(catalog_revision_id),
  normalized_signature text not null
    check (normalized_signature ~ '^[a-f0-9]{64}$'),
  canonical_payload jsonb not null
    check (jsonb_typeof(canonical_payload) = 'object'),
  created_at timestamptz not null default clock_timestamp(),
  unique (candidate_id, revision),
  unique (candidate_id, catalog_revision_id, normalized_signature),
  foreign key (candidate_id, patch_id)
    references candidates(candidate_id, patch_id),
  foreign key (catalog_revision_id, patch_id)
    references catalog_revisions(catalog_revision_id, patch_id)
);

create table candidate_provenance (
  candidate_provenance_id uuid primary key,
  candidate_revision_id uuid not null
    references candidate_revisions(candidate_revision_id),
  normalized_observation_id uuid not null unique
    references normalized_observations(normalized_observation_id),
  origin text not null
    check (
      origin in (
        'collector_detected',
        'community_submitted',
        'editorial',
        'ai_generated'
      )
    ),
  created_at timestamptz not null default clock_timestamp()
);
```

Add indexes for revision and provenance lookup, then attach
`reject_immutable_change()` triggers to all four tables.
Add patch/catalog composite foreign keys to normalized observations and
CandidateRevisions, store `patch_id` on CandidateRevision, and add a
provenance insert trigger that verifies catalog, signature, and canonical
payload equality across the immutable graph.

- [ ] **Step 4: Run GREEN**

Run the two migration test files. Expected: all tests PASS and migration
checksum replay remains valid.

- [ ] **Step 5: Commit**

```bash
git add backend/migrations/0006_deterministic_candidate_registry.sql \
  backend/test/candidate-migration.test.ts backend/test/migration.test.ts
git commit -m "feat(3a): add immutable candidate registry schema"
```

---

### Task 3: Atomic normalized-observation registration

**Files:**

- Create: `backend/src/modules/candidate/register-normalized-observation.ts`
- Create: `backend/test/helpers/candidate.ts`
- Create: `backend/test/candidate-registration.test.ts`
- Modify: `backend/test/helpers/catalog.ts`
- Modify: `backend/src/modules/catalog/validate-catalog-selection.ts`

**Interfaces:**

- Produces:
  `registerNormalizedObservation(pool, command): Promise<Result>`
- Produces:
  `registerNormalizedObservationInTransaction(client, command): Promise<Result>`
- Changes catalog validator input dependency from `Pool` to
  `Pool | PoolClient`; behavior remains read-only.

- [ ] **Step 1: Export the reusable active-catalog fixture**

Move the existing import → validate → activate sequence from
`catalog-selection.test.ts` into:

```ts
export async function seedActiveCatalog(
  pool: Pool,
  snapshot: CatalogSnapshotV1 = validCatalogSnapshot(),
): Promise<void>
```

The helper must retain the exact IDs in `CATALOG_IDS` and assert validation
result `passed`.

- [ ] **Step 2: Write RED tests for success, S12, replay, and rollback**

Create a candidate helper that seeds a raw observation under a dedicated
`aggregate_only` Source Policy revision and returns a command using stable
UUIDs. Tests must
assert:

1. valid input creates counts `1/1/1/1` for the four new tables and exactly
   one candidate audit/outbox event;
2. wrong patch or catalog-invalid selection creates zero new rows;
3. the same raw observation and same semantic payload returns the existing
   result with `provenanceAdded: false`;
4. the same raw observation with changed semantic payload throws
   `NORMALIZATION_REPLAY_CONFLICT`;
5. a pre-seeded conflicting provenance UUID causes a real late constraint
   error and leaves all before/after table, audit, and outbox counts equal.
6. two concurrent commands for the same raw observation return the same
   normalized observation and create one registry effect.

- [ ] **Step 3: Run RED**

Run:

```bash
cd backend
node --import tsx --test --test-concurrency=1 \
  test/candidate-registration.test.ts
```

Expected: FAIL with module-not-found for
`register-normalized-observation.ts`.

- [ ] **Step 4: Generalize the read-only catalog validator**

Change only its dependency type:

```ts
export async function validateCatalogSelection(
  pool: Pool | PoolClient,
  input: CatalogSelectionInput,
): Promise<CatalogSelectionResult>
```

Do not add a write or change reason-code ordering.

- [ ] **Step 5: Implement registration**

Implement the ordered transaction from the design:

1. normalize before opening the public transaction;
2. exclusively lock the raw observation;
3. query the normalized observation for replay after acquiring the lock;
4. resolve active patch/catalog and `FOR SHARE OF acr`;
5. call `validateCatalogSelection(client, ...)`;
6. resolve subject entity and revision;
7. insert normalized observation;
8. insert Candidate `ON CONFLICT (fingerprint) DO NOTHING`;
9. select Candidate `FOR UPDATE` and verify patch/mode/subject;
10. select exact revision; otherwise allocate `max(revision) + 1`;
11. insert provenance;
12. insert exactly one audit and one outbox row based on creation flags.

Use caller-provided IDs only for rows that this command actually creates.
When an `ON CONFLICT` loses a race, return the stored Candidate or
CandidateRevision ID.

Replay comparison must include patch key, mode, subject external ID,
normalized signature, and canonical payload. It must not require the old
catalog revision to remain active.

- [ ] **Step 6: Run GREEN**

Run candidate normalization, migration, registration, catalog selection, and
the backend typecheck. Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add backend/src/modules/catalog/validate-catalog-selection.ts \
  backend/src/modules/candidate/register-normalized-observation.ts \
  backend/test/helpers/catalog.ts backend/test/helpers/candidate.ts \
  backend/test/candidate-registration.test.ts
git commit -m "feat(3a): register normalized observations atomically"
```

---

### Task 4: Source-independent convergence, concurrency, and revisions

**Files:**

- Modify: `backend/test/candidate-registration.test.ts`
- Modify: `backend/src/modules/candidate/register-normalized-observation.ts`

**Interfaces:**

- Reuses Task 3 command/result.
- Produces no new public interface.

- [ ] **Step 1: Add RED scenario S21**

Seed two immutable raw observations with identical snapshot semantics and
origins `collector_detected` and `ai_generated`. Register both and assert:

```ts
assert.equal(await tableCount(pool, 'candidates'), 1);
assert.equal(await tableCount(pool, 'candidate_revisions'), 1);
assert.equal(await tableCount(pool, 'normalized_observations'), 2);
assert.equal(await tableCount(pool, 'candidate_provenance'), 2);
assert.equal(first.candidateId, second.candidateId);
assert.equal(first.candidateRevisionId, second.candidateRevisionId);
```

Query the provenance origins and assert both values remain present.

- [ ] **Step 2: Add RED concurrent convergence**

Register two source observations with the same fingerprint using
`Promise.all`. Assert one Candidate, one CandidateRevision, two provenance,
and no unique violation.

- [ ] **Step 3: Add RED catalog-revision history**

Import, validate, and activate a second catalog revision for the same patch
with changed catalog content. Register the same semantic snapshot again and
assert one Candidate, two CandidateRevisions numbered `1, 2`, and two
provenance rows.

- [ ] **Step 4: Run RED**

Expected failures must identify either unique-race handling or revision reuse;
fixture/setup errors do not count as RED.

- [ ] **Step 5: Implement minimal locking/race fixes**

Use the canonical Candidate row as the serialization lock. After
`ON CONFLICT`, always load it `FOR UPDATE`. Under that lock:

- verify its identity fields;
- query the exact catalog/signature revision;
- allocate the next integer only when absent;
- on an unlikely revision unique conflict, reload the exact revision and
  verify its payload rather than creating another semantic revision.

- [ ] **Step 6: Run GREEN**

Run the complete candidate registration test repeatedly three times against
PostgreSQL 17 in Actions. Every run must show one Candidate and zero duplicate
effects.

- [ ] **Step 7: Commit**

```bash
git add backend/src/modules/candidate/register-normalized-observation.ts \
  backend/test/candidate-registration.test.ts
git commit -m "feat(3a): converge candidate provenance across sources"
```

---

### Task 5: Share worker transaction and wire stored snapshots

**Files:**

- Create: `backend/src/modules/candidate/register-stored-observation.ts`
- Modify: `backend/src/modules/collector/ingest-observation.ts`
- Modify: `backend/src/queue/normalization-worker.ts`
- Modify: `backend/src/worker.ts`
- Modify: `backend/test/observation.test.ts`
- Modify: `backend/test/worker.test.ts`

**Interfaces:**

- Produces:

```ts
export interface NormalizationSourceContext {
  observationId: string;
  outboxEventId: string;
  correlationId: string;
}
```

- Worker callback becomes:

```ts
(
  client: PoolClient,
  source: NormalizationSourceContext,
) => Promise<RegisterNormalizedObservationResult | void>
```

- [ ] **Step 1: Write RED worker tests**

Update existing callbacks to accept `(client, source)` and assert:

- `source.observationId` and `source.correlationId` come from PostgreSQL even
  when Redis job data is altered;
- the callback can query through the supplied client;
- a real registration followed by `beforeCommit` failure leaves zero rows in
  `normalization_effects`, `normalized_observations`, `candidates`,
  `candidate_revisions`, `candidate_provenance`, candidate audit, and
  Candidate outbox;
- retry succeeds once;
- lost acknowledgement produces `duplicate_noop` and does not duplicate any
  Candidate Registry row.

- [ ] **Step 2: Run RED**

Expected: typecheck or worker tests fail because the callback has the old
signature and runtime handler is still a no-op.

- [ ] **Step 3: Extend governed observation metadata**

Add optional `aggregateMetadata?: unknown`, validate it as the closed,
bounded V1 wrapper from Task 1, and persist it only when storage permission is
`blob_allowed` or `aggregate_only`.
`reference_only` forces it to `null`; `aggregate_only` also forces external
reference and raw blob to `null`. Add policy tests for both behaviors without
changing prohibited-policy atomicity.

- [ ] **Step 4: Implement the stored-observation handler**

Load `aggregate_metadata -> 'normalizationSnapshot'` from the immutable raw
observation. Reject a missing value with
`NORMALIZATION_SNAPSHOT_UNAVAILABLE`. Pass the bounded unknown value to Task
1 runtime validation, generate row IDs with `randomUUID()`, use actor
`normalization-worker`, and retain the PostgreSQL outbox correlation ID.

- [ ] **Step 5: Refactor the worker transaction**

Change the authoritative outbox query to return aggregate ID, type, event
type, payload observation ID, and correlation ID. Pass its context and the
same transaction client to the callback after the normalization reservation.
Do not use any Redis payload field beyond validating `job.id` against
`outboxEventId`.

- [ ] **Step 6: Wire runtime**

Replace the no-op in `backend/src/worker.ts` with
`registerStoredObservationInTransaction`. Do not add an HTTP endpoint or a
downstream Candidate queue consumer.

- [ ] **Step 7: Run GREEN**

Run observation tests, worker tests with PostgreSQL/Redis, candidate tests,
typecheck, and build. Expected: all PASS; duplicate Candidate Registry effects
are zero.

- [ ] **Step 8: Commit**

```bash
git add backend/src/modules/candidate/register-stored-observation.ts \
  backend/src/modules/collector/ingest-observation.ts \
  backend/src/queue/normalization-worker.ts backend/src/worker.ts \
  backend/test/observation.test.ts backend/test/worker.test.ts
git commit -m "feat(3a): execute candidate registration in worker transaction"
```

---

### Task 6: Runbook, quality gate, review, and draft PR

**Files:**

- Modify: `backend/README.md`
- Modify: `.github/workflows/backend-production-foundation.yml`
- Create: `docs/superpowers/plans/2026-07-24-deterministic-normalization-candidate-registry.md`

**Interfaces:**

- No runtime interface.
- Gate retains existing frontend/backend commands and read-only permissions.

- [ ] **Step 1: Add a failing runbook contract**

Require the runbook to contain:

- `ObservationNormalizationSnapshotV1`;
- fingerprint exclusions;
- Candidate versus CandidateRevision identity;
- provenance chain;
- S1/S12/S21 atomicity/rejection behavior;
- reference-only observations cannot supply stored aggregate snapshots;
- Candidate outbox events are not dispatched in Sprint 3A;
- no Evidence, AI, Publication, merge, or deploy.

Expected RED: the existing runbook lacks these sections.

- [ ] **Step 2: Update runbook and gate label**

Rename the workflow/job display text to Sprint 3A. Do not alter service
versions, workflow permissions, gate commands, deployment guard, or deploy
dry-run behavior.

- [ ] **Step 3: Run the complete quality gate**

On the exact branch head, require:

```bash
npm run validate:community
npm run lint
npm test
npm run build:pages
npm run backend:typecheck
npm run backend:test
npm run backend:build
git diff --check
git status --short
```

Read every Actions step. Record actual frontend/backend test totals,
PostgreSQL and Redis versions, build/typecheck status, cleanliness, and guard
status. Do not infer counts.

- [ ] **Step 4: Review the complete diff**

Verify:

- only Sprint 3A code/tests/docs/workflow labels changed;
- no source/origin field enters fingerprint construction;
- no Candidate mutable provenance counter exists;
- all new history tables have immutability triggers;
- normalized subject uses an exact catalog composite foreign key;
- active catalog and Candidate row locks cover races;
- worker uses PostgreSQL source context and one transaction;
- every successful T3 mutation writes audit/outbox;
- dispatcher still allowlists only `RawObservationIngested`;
- no network adapter, frontend data edit, Evidence/AI/Publication path,
  credential, write permission, merge, or deploy command exists.

- [ ] **Step 5: Open/update stacked draft PR**

Open a draft PR:

- head: `feat/3a-deterministic-candidate-registry`;
- base: `feat/2b-catalog-authority`;
- title: `feat(backend): add deterministic candidate registry`;
- body: exact SHA, implemented scope, test evidence, safety boundary, spec and
  plan links.

Keep it draft. Do not merge or deploy.

- [ ] **Step 6: Commit documentation**

```bash
git add backend/README.md \
  .github/workflows/backend-production-foundation.yml \
  docs/superpowers/plans/2026-07-24-deterministic-normalization-candidate-registry.md
git commit -m "docs(3a): document candidate registry operations"
```

---

## Plan self-review

- Spec coverage: Task 1 covers deterministic normalization/fingerprint;
  Task 2 covers immutable storage; Tasks 3–4 cover T3/S1/S12/S21 and
  provenance; Task 5 covers worker atomicity; Task 6 covers durable evidence
  and safety.
- Incomplete-marker scan: no deferred implementation marker or unspecified error
  handling remains.
- Type consistency: snapshot, origin, normalized result, command/result, and
  worker context names are stable across tasks.
- Scope: no task creates Evidence, HumanReview, Moderation, Eligibility,
  Publication, AI, external fetching, infrastructure, merge, or deployment.
- Verification: no PASS claim is permitted until the full Actions gate and
  deploy dry-run are read at the exact committed SHA.
