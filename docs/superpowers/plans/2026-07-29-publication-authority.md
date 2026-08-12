# Sprint 4B Publication Authority Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` (recommended) or
> `superpowers:executing-plans` to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish only a fresh eligible `CandidateRevision` into immutable,
rollback-safe PublicationVersions and serve active public content independently
from workers.

**Architecture:** Add a PostgreSQL-owned Publication aggregate after the
existing Sprint 4A Eligibility boundary. Commands reconstruct structured
content and trust authority from PostgreSQL, append immutable versions and
activation history, and use narrow compare-and-swap pointers. BullMQ carries
only Publication outbox identities to a non-authoritative monitoring
projection.

**Tech Stack:** Node.js 22.13+, TypeScript 5.9, PostgreSQL 17, BullMQ 5,
Redis 7, Node test runner, Fastify 5 foundation.

## Global Constraints

- Base exact SHA:
  `7aa079babef0b16c06b58255f66ec18d1fa14421`.
- Branch: `feat/4b-publication-authority`.
- PostgreSQL is the system of record; Redis is delivery only.
- No production code before a focused test has failed for the expected reason.
- Never edit migrations `0001`–`0008`; add only migration `0009`.
- No caller-provided public content, trust outcome, policy link, or source text.
- No automatic publication or automatic retraction.
- No HTTP mutation route, identity provider, UI, frontend integration,
  external fetch, production scheduler, credential, infrastructure, merge, or
  deployment.
- PR #13 remains draft and unmerged.

---

## File map

**Create**

- `backend/src/modules/publication/types.ts` — closed command, payload, result,
  and read contracts.
- `backend/src/modules/publication/build-publication-payload.ts` — pure
  canonical payload reconstruction and hashing.
- `backend/src/modules/publication/load-publication-authority.ts` — shared
  PostgreSQL authority loader and lock protocol.
- `backend/src/modules/publication/publish-candidate-revision.ts` — atomic
  publish command.
- `backend/src/modules/publication/rollback-publication.ts` — atomic,
  item-scoped rollback.
- `backend/src/modules/publication/read-active-publications.ts` — worker-free
  public read boundary.
- `backend/src/queue/publication-projection-worker.ts` — replay-safe monitoring
  projection.
- `backend/migrations/0009_publication_authority.sql` — schema, immutable
  history, graph/currentness seals, and pointer guards.
- `backend/test/helpers/publication.ts` — deterministic eligible/publication
  fixtures.
- `backend/test/publication-payload.test.ts` — pure payload contract.
- `backend/test/publication-migration.test.ts` — schema/direct-SQL contract.
- `backend/test/publication.test.ts` — publish/replay/race behavior.
- `backend/test/publication-rollback.test.ts` — rollback and public reads.
- `backend/test/publication-projection-worker.test.ts` — Redis-untrusted
  projection.

**Modify**

- `backend/src/queue/names.ts` — Publication queue name.
- `backend/src/queue/outbox-dispatcher.ts` — closed Publication event routing.
- `backend/src/worker.ts` — third worker lifecycle.
- `backend/test/outbox.test.ts` — queue routing regression.
- `backend/test/migration.test.ts` — exact migration/table contract.
- `backend/README.md` — Sprint 4B operations and boundary.
- `.github/workflows/backend-production-foundation.yml` — Sprint 4B gate and
  runbook contract.

---

### Task 1: Closed Publication payload contract

**Files:**

- Create: `backend/src/modules/publication/types.ts`
- Create: `backend/src/modules/publication/build-publication-payload.ts`
- Create: `backend/test/publication-payload.test.ts`

**Interfaces:**

```ts
export interface PublicationPayloadV1 {
  schemaVersion: 1;
  mode: 'aram_mayhem';
  patchKey: string;
  catalogRevisionId: string;
  championExternalId: string;
  augmentExternalIds: readonly string[];
  itemExternalIds: readonly string[];
}

export interface PublicationPayloadAuthority {
  candidateId: string;
  candidateRevisionId: string;
  patchKey: string;
  catalogRevisionId: string;
  gameModeExternalId: 'aram_mayhem';
  championExternalId: string;
  canonicalPayload: {
    schemaVersion: 1;
    augmentExternalIds: readonly string[];
    itemExternalIds: readonly string[];
  };
}

export interface BuiltPublicationPayload {
  payload: PublicationPayloadV1;
  payloadHash: string;
}

export function buildPublicationPayload(
  authority: PublicationPayloadAuthority,
): BuiltPublicationPayload;
```

- [ ] **Step 1: Write pure RED tests**

Use literal expected objects and hashes. Tests must catch:

- accepting an unsupported mode;
- accepting additional object keys;
- changing canonical augment/item order;
- accepting empty/duplicate/invalid external IDs;
- copying a caller-supplied title/source/reviewer field;
- producing a non-deterministic payload hash.

Representative test:

```ts
test('Publication payload rejects the mutation that accepts caller-authored content', () => {
  assert.throws(
    () => buildPublicationPayload({
      ...authority,
      title: 'untrusted',
    } as never),
    /PUBLICATION_PAYLOAD_INVALID/,
  );
});
```

- [ ] **Step 2: Verify and commit RED**

Run:

```bash
npm --prefix backend test -- --test-name-pattern='Publication payload'
```

Expected: typecheck/test fails only because Publication payload modules do not
exist.

Commit:

```text
test(4b): define publication payload
```

- [ ] **Step 3: Implement minimal GREEN**

Use a closed-key check, existing printable non-space ASCII/C-collation
semantics, and `hashCanonicalTupleV1`:

```ts
const payloadHash = hashCanonicalTupleV1([
  'PublicationTupleV1',
  'PublicationPayloadV1',
  authority.candidateId,
  authority.candidateRevisionId,
  payload.patchKey,
  payload.catalogRevisionId,
  payload.mode,
  payload.championExternalId,
  String(payload.augmentExternalIds.length),
  ...payload.augmentExternalIds,
  String(payload.itemExternalIds.length),
  ...payload.itemExternalIds,
]);
```

Do not accept public content as a second argument.

- [ ] **Step 4: Run GREEN and commit**

Run:

```bash
npm --prefix backend test -- --test-name-pattern='Publication payload'
npm --prefix backend run typecheck
```

Expected: all payload tests and typecheck pass.

Commit:

```text
feat(4b): build canonical publication payload
```

---

### Task 2: Publication schema and PostgreSQL seals

**Files:**

- Create: `backend/migrations/0009_publication_authority.sql`
- Create: `backend/test/publication-migration.test.ts`
- Modify: `backend/test/migration.test.ts`

**Interfaces:** Six new tables and deferred commit-time validation.

```sql
create table publications (...);
create table publication_versions (...);
create table publication_version_input_required_claims (...);
create table publication_activation_history (...);
create table active_publication_versions (...);
create table publication_projection_effects (...);
```

- [ ] **Step 1: Write schema RED**

Assert the exact 4B table list, primary/unique/composite foreign keys, two
history sequences, and immutable triggers. Add direct SQL tests proving:

- update/delete of PublicationVersion or activation history is rejected;
- one Candidate cannot own two Publications;
- a version cannot cross Publication, Candidate, CandidateRevision, Patch, or
  Catalog;
- a public payload cannot differ from CandidateRevision;
- version 2 cannot exist without version 1 for the same Publication;
- active pointer cannot reference another Publication's version.

Expected table contract:

```ts
const TABLES_4B = [
  'publications',
  'publication_versions',
  'publication_version_input_required_claims',
  'publication_activation_history',
  'active_publication_versions',
  'publication_projection_effects',
];
```

- [ ] **Step 2: Run and commit RED**

Run:

```bash
npm --prefix backend test -- --test-name-pattern='Publication schema|publication migration'
```

Expected: only missing table/trigger assertions fail; all Sprint 4A migration
tests still pass.

Commit:

```text
test(4b): require publication authority schema
```

- [ ] **Step 3: Add base tables and graph keys**

`publications`:

```sql
publication_id uuid primary key,
candidate_id uuid not null unique references candidates(candidate_id),
created_by text not null,
created_at timestamptz not null default clock_timestamp()
```

`publication_versions` pins all spec fields and adds:

```sql
version_sequence bigint generated always as identity unique,
version_number integer not null check (version_number > 0),
publication_payload jsonb not null,
payload_hash text not null check (payload_hash ~ '^[a-f0-9]{64}$'),
unique (publication_id, version_number),
unique (publication_version_id, publication_id, candidate_id)
```

Add composite foreign keys to `candidate_revisions`,
`candidate_eligibility_evaluations`, `moderation_decisions`, and
`eligibility_policy_revisions`.

- [ ] **Step 4: Add membership, activation, and immutability**

`publication_version_input_required_claims` stores exact required Claim,
current Evidence decision, state, policy, and ordinal.

`publication_activation_history`:

```sql
activation_kind text check (
  activation_kind in ('published', 'rolled_back')
),
from_publication_version_id uuid,
to_publication_version_id uuid not null,
activation_sequence bigint generated always as identity unique
```

`active_publication_versions` stores the latest activation history ID and
active version.

Attach `reject_immutable_change()` to every history/member table and
`publications`.

- [ ] **Step 5: Add deferred seal functions**

Add constraints executed at COMMIT:

- `enforce_publication_version_seal`;
- `enforce_publication_required_claim_graph`;
- `enforce_publication_activation_transition`;
- `enforce_active_publication_pointer`.

The version seal independently reconstructs CandidateRevision payload,
required-Claim membership, active policy, current evaluation input hash and
`eligible` result, and current `clear` Moderation. It must reject a transaction
whose trust authority becomes stale before COMMIT.

- [ ] **Step 6: Run GREEN and commit**

Run:

```bash
npm --prefix backend test -- --test-name-pattern='Publication schema|publication migration|migration'
npm --prefix backend run typecheck
```

Expected: migrations from empty PostgreSQL 17 pass and the checksum list gains
only `0009`.

Commit:

```text
feat(4b): seal publication authority schema
```

---

### Task 3: Atomic publish command

**Files:**

- Create: `backend/src/modules/publication/load-publication-authority.ts`
- Create: `backend/src/modules/publication/publish-candidate-revision.ts`
- Expand: `backend/src/modules/publication/types.ts`
- Create: `backend/test/helpers/publication.ts`
- Create: `backend/test/publication.test.ts`

**Interfaces:**

```ts
export interface PublicationAuthorizationContext {
  actorId: string;
  permissions: readonly 'publisher'[];
}

export interface PublishCandidateRevisionCommand {
  publicationId: string;
  publicationVersionId: string;
  activationId: string;
  candidateRevisionId: string;
  expectedActiveEligibilityPolicyRevisionId: string;
  expectedEligibilityEvaluationId: string;
  expectedModerationDecisionId: string;
  expectedActivePublicationVersionId: string | null;
  authorization: PublicationAuthorizationContext;
  auditId: string;
  outboxEventId: string;
  correlationId: string;
  idempotencyKey: string;
  occurredAt: string;
}

export interface PublishCandidateRevisionResult {
  publicationId: string;
  publicationVersionId: string;
  candidateId: string;
  candidateRevisionId: string;
  versionNumber: number;
  activePublicationVersionId: string;
  replayed: boolean;
}

export async function publishCandidateRevision(
  pool: Pool,
  command: PublishCandidateRevisionCommand,
): Promise<PublishCandidateRevisionResult>;
```

- [ ] **Step 1: Build the deterministic eligible fixture**

`seedEligiblePublicationContext(pool)` must call existing public commands:

1. `seedActivatedGateContext`;
2. `recordCandidateModerationDecision`;
3. `seedSatisfiedReviewQuorum`;
4. `evaluateCandidateEligibility`.

It returns literal IDs and never inserts a trust decision with direct SQL.

- [ ] **Step 2: Write publish RED**

Tests use PostgreSQL and catch:

- default/empty permission being treated as publisher;
- caller command accepting extra `content`, `eligibilityOutcome`, or policy
  fields;
- first publish not producing version 1;
- another CandidateRevision being substituted;
- missing, `needs_review`, `ineligible`, stale, or wrong-policy Eligibility
  being accepted;
- Moderation superseded to `blocked` after evaluation;
- wrong expected active version;
- replay duplicate version/audit/outbox effects;
- same key with changed payload;
- late audit failure committing a partial Publication.

Representative assertion:

```ts
await assert.rejects(
  publishCandidateRevision(pool, {
    ...publishCommand(),
    authorization: { actorId: 'reader', permissions: [] },
  }),
  /PUBLISHER_PERMISSION_REQUIRED/,
);
assert.equal(await tableCount(pool, 'publication_versions'), 0);
```

- [ ] **Step 3: Run and commit RED**

Run:

```bash
npm --prefix backend test -- --test-name-pattern='Publication publish'
```

Expected: module-not-found only; fixtures and existing trust setup pass.

Commit:

```text
test(4b): define fail-closed publication
```

- [ ] **Step 4: Implement authority loading**

`loadPublicationAuthority(client, candidateRevisionId, { lock })`:

1. resolves Candidate ID from CandidateRevision;
2. calls `loadEligibilityAuthority`;
3. loads current persisted Eligibility evaluation and ordered reasons;
4. proves active policy/evaluation/input hash/outcome match live authority;
5. proves Moderation decision matches and remains `clear`;
6. resolves Patch key and champion external ID from catalog authority;
7. calls `buildPublicationPayload`;
8. loads or initializes Publication under an advisory Candidate lock;
9. locks the active pointer.

Return typed authority only. Never return governed source text.

- [ ] **Step 5: Implement the transaction**

Normalize a closed command before connecting. Hash all semantic input,
including expected IDs and authorization actor.

Inside `withTransaction`:

```ts
const replay = await beginIdempotentCommand<Result>(
  client,
  'publication_publish',
  command.idempotencyKey,
  commandHash,
);
```

Then validate permission and authority, append the version and required-Claim
members, append `published` activation, upsert the active pointer using the
expected prior ID, insert caller-supplied `auditId` and `outboxEventId`, and
complete idempotency.

Audit action: `publication.version_published`.
Outbox event: `PublicationPublished`.

- [ ] **Step 6: Add stale-at-COMMIT RED**

Use two PostgreSQL clients:

1. begin publish and construct a valid version;
2. before publish COMMIT, append/supersede a Moderation, Evidence, provenance,
   Review, or active Eligibility policy input in the other transaction;
3. assert publication COMMIT rejects with `PUBLICATION_INPUT_STALE`;
4. assert zero version/activation/audit/outbox/idempotency rows.

Do not use a test-only production hook. Coordinate at SQL lock boundaries.

- [ ] **Step 7: Run GREEN and commit**

Run:

```bash
npm --prefix backend test -- --test-name-pattern='Publication publish'
npm --prefix backend run typecheck
```

Expected: publish matrix, replay, rollback-on-failure, and stale-at-COMMIT pass.

Commit:

```text
feat(4b): publish fresh eligible revisions
```

---

### Task 4: Rollback and worker-independent public reads

**Files:**

- Create: `backend/src/modules/publication/rollback-publication.ts`
- Create: `backend/src/modules/publication/read-active-publications.ts`
- Expand: `backend/src/modules/publication/types.ts`
- Create: `backend/test/publication-rollback.test.ts`

**Interfaces:**

```ts
export interface RollbackPublicationCommand {
  publicationId: string;
  targetPublicationVersionId: string;
  activationId: string;
  expectedActivePublicationVersionId: string;
  authorization: PublicationAuthorizationContext;
  auditId: string;
  outboxEventId: string;
  correlationId: string;
  idempotencyKey: string;
  occurredAt: string;
}

export interface RollbackPublicationResult {
  publicationId: string;
  previousActivePublicationVersionId: string;
  activePublicationVersionId: string;
  replayed: boolean;
}

export async function rollbackPublication(
  pool: Pool,
  command: RollbackPublicationCommand,
): Promise<RollbackPublicationResult>;

export async function readActivePublications(
  pool: Pool,
): Promise<ActivePublicationRead[]>;

export async function readActivePublicationById(
  pool: Pool,
  publicationId: string,
): Promise<ActivePublicationRead | null>;
```

- [ ] **Step 1: Write rollback/read RED**

Prove:

- v1 → v2 → rollback v1 preserves both version rows;
- only v1 becomes active;
- same rollback replay creates one activation/audit/outbox;
- changed replay payload conflicts;
- non-publisher fails without effects;
- stale expected pointer fails;
- another Publication's version cannot be the target;
- a new command targeting the already active version fails;
- rolling item A does not change item B;
- unpublished Candidates and inactive versions are absent from reads;
- reads succeed with Redis unavailable and workers not started.

- [ ] **Step 2: Run and commit RED**

Run:

```bash
npm --prefix backend test -- --test-name-pattern='Publication rollback|public read'
```

Expected: only missing rollback/read modules fail.

Commit:

```text
test(4b): define publication rollback and read
```

- [ ] **Step 3: Implement rollback**

Use scope `publication_rollback`. Lock the Publication and active pointer,
validate expected/target ownership, append only activation history, update the
pointer with CAS, audit `publication.version_rolled_back`, emit
`PublicationRolledBack`, and complete idempotency. Never update a version row.

- [ ] **Step 4: Implement reads**

Join:

```sql
publications
join active_publication_versions
join publication_versions
```

Order deterministically by Publication ID. Parse only the sealed
`PublicationPayloadV1`. Do not join Candidate provenance, reviews, audit,
outbox, Redis state, or projection state.

- [ ] **Step 5: Run GREEN and commit**

Run:

```bash
npm --prefix backend test -- --test-name-pattern='Publication rollback|public read|Publication publish'
npm --prefix backend run typecheck
```

Expected: full publish/rollback/read suite passes.

Commit:

```text
feat(4b): rollback and read active publications
```

---

### Task 5: Publication event routing and monitoring projection

**Files:**

- Modify: `backend/src/queue/names.ts`
- Modify: `backend/src/queue/outbox-dispatcher.ts`
- Create: `backend/src/queue/publication-projection-worker.ts`
- Modify: `backend/src/worker.ts`
- Modify: `backend/test/outbox.test.ts`
- Create: `backend/test/publication-projection-worker.test.ts`

**Interfaces:**

```ts
export const PUBLICATION_QUEUE_NAME = 'hai-dau-publication-v1';

export interface RoutedOutboxQueues {
  normalization: OutboxQueue;
  eligibility: OutboxQueue;
  publication: OutboxQueue;
}

export interface PublicationProjectionWorkerResult {
  outboxEventId: string;
  outcome: 'projected' | 'duplicate_noop';
}
```

- [ ] **Step 1: Write routing RED**

Seed one raw, one trust, and one Publication event. Assert each is routed only
to its named queue with `jobId = outboxEventId`. Unsupported events stay
pending. A failure in Publication queue delivery does not mutate the other
event payloads or delivery states.

- [ ] **Step 2: Write worker RED**

With real Redis/BullMQ and PostgreSQL, prove:

- worker reloads the outbox row by job ID;
- tampered Redis Candidate/Publication/version IDs are ignored;
- `PublicationPublished` creates one monitoring transition;
- `PublicationRolledBack` updates only projection metadata;
- duplicate/lost-ack delivery is `duplicate_noop`;
- malformed authoritative event fails
  `INVALID_PUBLICATION_SOURCE_EVENT`;
- an Eligibility event is rejected as `UNSUPPORTED_PUBLICATION_EVENT`;
- active public read works before the projection job is consumed.

- [ ] **Step 3: Run and commit RED**

Run:

```bash
npm --prefix backend test -- --test-name-pattern='publication queue|Publication projection'
```

Expected: queue name, routed API, and worker module are the only production
gaps.

Commit:

```text
test(4b): require publication projection queue
```

- [ ] **Step 4: Implement routing**

Add:

```ts
const PUBLICATION_EVENT_TYPES = [
  'PublicationPublished',
  'PublicationRolledBack',
] as const;
```

Require the three-queue object for routed operation. Preserve leases, retries,
immutable payload, and deterministic BullMQ job IDs.

- [ ] **Step 5: Implement projection worker**

The worker validates only the closed event set and requires
`job.data.outboxEventId === job.id`. It reloads `outbox_events`, validates
aggregate/payload identity against Publication tables, inserts one
`publication_projection_effect`, and performs the idempotent monitoring
transition. It never reads or changes the active Publication pointer.

- [ ] **Step 6: Wire lifecycle**

Start a third Worker and Redis connection. Shutdown closes three workers,
three connections, and PostgreSQL exactly once. Do not add a dispatcher loop.

- [ ] **Step 7: Run GREEN and commit**

Run:

```bash
npm --prefix backend test -- --test-name-pattern='outbox|Publication projection|Eligibility worker|normalization worker'
npm --prefix backend run typecheck
```

Expected: all three queues/workers pass with Redis 7.

Commit:

```text
feat(4b): project publication events safely
```

---

### Task 6: Direct-SQL, concurrency, and mutation hardening

**Files:**

- Expand: `backend/test/publication-migration.test.ts`
- Expand: `backend/test/publication.test.ts`
- Expand: `backend/test/publication-rollback.test.ts`
- Expand: `backend/test/publication-projection-worker.test.ts`
- Modify production only when a focused RED proves a gap.

**Interfaces:** No new public interface.

- [ ] **Step 1: Add one RED per mutation**

Each test names the break it catches:

```ts
test('PostgreSQL rejects Publication when a required Claim member is omitted', ...);
test('PostgreSQL rejects Publication when payload differs from CandidateRevision', ...);
test('PostgreSQL rejects Publication with a stale Eligibility input hash', ...);
test('PostgreSQL rejects Publication after Moderation is superseded before COMMIT', ...);
test('PostgreSQL rejects publish activation targeting an older version', ...);
test('PostgreSQL rejects rollback activation targeting another Publication', ...);
test('PostgreSQL rejects active pointer without matching activation history', ...);
```

Run each test before any production fix. Accept RED only when the intended
mutation commits incorrectly; fixture/type errors do not count.

- [ ] **Step 2: Harden proven gaps only**

For each valid RED:

1. add the smallest deferred trigger, FK, lock, or CAS fix;
2. run the focused test to GREEN;
3. run all publication tests;
4. commit one root cause.

Example commits:

```text
fix(4b): seal publication claim membership
fix(4b): recheck publication authority at commit
fix(4b): enforce publication activation transitions
```

- [ ] **Step 3: Add real concurrency schedules**

Use two `pg` clients, bounded `lock_timeout`/`statement_timeout`, and prove:

- two first publishes for one Candidate create one aggregate and one valid
  version 1 winner;
- concurrent publish and Moderation supersede cannot publish stale authority;
- concurrent publish and Evidence/Review/provenance change have no deadlock;
- concurrent v2 publish and rollback have one CAS winner;
- rollbacks of different items proceed independently;
- duplicate projection delivery creates one effect.

Assert no `40P01` deadlock and no orphan version/history/pointer.

- [ ] **Step 4: Run hardening GREEN**

Run:

```bash
npm --prefix backend test -- --test-name-pattern='Publication|concurrent|PostgreSQL|replay|rollback'
npm --prefix backend test
npm --prefix backend run typecheck
npm --prefix backend run build
```

Expected: all backend tests pass with no unhandled handle or new warning.

---

### Task 7: Runbook, workflow, final review, and draft PR

**Files:**

- Modify: `backend/README.md`
- Modify: `.github/workflows/backend-production-foundation.yml`
- Modify: `backend/test/migration.test.ts`
- No other production file unless review proves a bug through RED.

**Interfaces:** CI/runbook and GitHub checkpoint.

- [ ] **Step 1: Write runbook/workflow RED**

The workflow contract must require these operational statements:

```text
PublicationVersion immutable
Publisher permission required
Fresh Eligibility rechecked at commit
Publication activation history
Item-level rollback
Public read independent from workers
PostgreSQL remains Publication authority
No automatic publication
No HTTP mutation route
No UI
No merge
No deploy
```

Rename workflow/concurrency group to Sprint 4B. Keep:

```yaml
permissions:
  contents: read
```

and the deployment-command/credential scan.

- [ ] **Step 2: Run and commit RED**

Run the workflow contract locally. Expected: only missing Sprint 4B runbook
phrases fail.

Commit:

```text
test(4b): require publication runbook
```

- [ ] **Step 3: Document operations**

Add:

- publication authority and payload;
- permission boundary without auth provider;
- publish, replay, CAS conflict, and stale-input recovery;
- rollback and item isolation;
- public read worker independence;
- projection replay;
- explicit exclusions.

Do not document a production scheduler, migration CLI, HTTP mutation route,
automatic publication, or deployment.

- [ ] **Step 4: Run the exact-head gate**

On one immutable SHA run:

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

Require PostgreSQL 17 and Redis 7 services. Run the deployment dry-run on the
same SHA and confirm no write permission or deploy command.

- [ ] **Step 5: Review exact range**

Verify:

```text
base: 7aa079babef0b16c06b58255f66ec18d1fa14421
head: <exact final Sprint 4B SHA>
branch: feat/4b-publication-authority
```

Review every migration, command, pointer, read query, worker, and test against
the design. For each Critical/Important finding, reproduce RED, implement the
minimal GREEN, rerun the full gate, and review the new exact head.

- [ ] **Step 6: Open/update draft PR**

Use:

```text
Title: Sprint 4B: add Publication authority and public read
Base: main
Head: feat/4b-publication-authority
State: draft
```

Body must list exact head, tests, PostgreSQL/Redis versions, immutable
PublicationVersion, fresh publish gate, rollback/read/projection behavior, and
locked exclusions. Note that the diff is stacked on unmerged PR #13.

- [ ] **Step 7: Stop at the boundary**

Leave PR #13 and the new PR open, draft, and unmerged. Do not deploy. Report
exact SHA, test counts, Actions/dry-run links, and review verdict.

---

## Plan self-review

- **Spec coverage:** Tasks 1–7 cover all design sections and Definition of
  Done.
- **No placeholders:** every production unit has exact paths, interfaces,
  failure behavior, RED command, GREEN command, and commit boundary.
- **Type consistency:** payload, authorization, publish, rollback, read, and
  worker names match across tasks.
- **Isolation:** Publication cannot write trust history; projection cannot own
  public truth.
- **TDD:** no production change precedes an observed focused RED.
- **Safety:** stacked branch only; no merge, deploy, UI, auth provider,
  automatic publication/retraction, scheduler, or credentials.
