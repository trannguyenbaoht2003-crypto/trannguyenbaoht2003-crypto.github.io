# Sprint 8A Guarded AI Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a provider-independent, immutable AI discovery run/proposal authority and safely materialize selected proposals into the existing Candidate Registry with `ai_generated` provenance without granting AI any trust or Publication authority.

**Architecture:** PostgreSQL is authoritative for AI runs, proposals and one-to-one materialization proofs. Materialization creates a governed synthetic raw observation under the reserved `ai-discovery` source, then invokes the existing `registerNormalizedObservationInTransaction()` Candidate Registry boundary; AI-specific modules never write Candidate/Trust/Publication tables directly. No provider SDK, queue, public route, secret, operator exposure or production deployment is added.

**Tech Stack:** Node.js 22.13.0, TypeScript 5.9.3, PostgreSQL 17 / `pg`, existing canonical hash + transaction + idempotency patterns, Node test runner, GitHub Actions.

## Global Constraints

- Base is `main@1892a4f9f600e3465a674446a6b36da5a3be8322`.
- Migration number is `0014_guarded_ai_discovery.sql`.
- AI output is never Evidence.
- AI modules may materialize only through `registerNormalizedObservationInTransaction()`; no direct Candidate/Trust/Publication mutation SQL.
- Materialized origin is exactly `ai_generated`.
- Reserved source is `ai-discovery`, `aggregate_only`, `collector_enabled=false`; conflicting pre-existing identity fails closed.
- No external AI provider SDK/HTTP invocation, Redis/BullMQ, public HTTP route, CORS change, browser secret, Caddy/Railway wiring, or production deployment.
- Run/proposal/materialization records are immutable.
- Proposal hash excludes UUIDs, ordinal, rationale, provider/model metadata and timestamps and includes only the canonical selection tuple from the spec.
- Existing Evidence/HumanReview/Moderation/Eligibility/Publication authority remains unchanged and mandatory.

---

### Task 1: AI discovery persistence and canonical input types

**Files:**
- Create: `backend/migrations/0014_guarded_ai_discovery.sql`
- Create: `backend/src/modules/ai-discovery/types.ts`
- Create: `backend/src/modules/ai-discovery/normalize-ai-discovery-input.ts`
- Create: `backend/test/ai-discovery-migration.test.ts`
- Create: `backend/test/ai-discovery-normalization.test.ts`

**Interfaces:**
- Produces `normalizeAiDiscoveryRunCommand(command): NormalizedAiDiscoveryRunCommand`.
- Produces `proposalHash(proposal): string` and `proposalNormalizationSnapshot(proposal): ObservationNormalizationSnapshotV1`.
- Produces persistence tables `ai_discovery_runs`, `ai_candidate_proposals`, `ai_candidate_materializations` and the reserved source policy.

- [ ] **Step 1: Write RED migration and normalization tests**

Test migration after the existing migration harness runs. Assert:

```ts
const source = await pool.query(`select s.source_key, p.storage_permission, p.collector_enabled
  from sources s
  join active_source_policies a on a.source_id=s.source_id
  join source_policy_revisions p on p.source_policy_revision_id=a.source_policy_revision_id
  where s.source_key='ai-discovery'`);
assert.deepEqual(source.rows[0], {
  source_key: 'ai-discovery',
  storage_permission: 'aggregate_only',
  collector_enabled: false,
});
```

Assert update/delete on all three AI authority tables raises immutable-change SQLSTATE and schema checks reject unsafe source-policy reuse.

Normalization tests use:

```ts
const proposal = {
  aiCandidateProposalId: randomUUID(),
  ordinal: 0,
  patchKey: '26.17',
  gameModeExternalId: 'aram_mayhem' as const,
  subjectExternalId: 'Ahri',
  augmentExternalIds: ['augment-a', 'augment-b'],
  itemExternalIds: ['item-a', 'item-b'],
  rationale: 'untrusted explanation',
};
const hashA = proposalHash(proposal);
const hashB = proposalHash({ ...proposal, aiCandidateProposalId: randomUUID(), ordinal: 7, rationale: 'different' });
assert.equal(hashA, hashB);
```

Reject duplicate/unsorted selection IDs, non-UUID identifiers, invalid SHA-256 hashes, failed runs with proposals, completed runs with failure code, and invalid timestamps.

- [ ] **Step 2: Run focused tests and verify RED**

```bash
npm --prefix backend test -- --test-name-pattern="AI discovery migration|AI discovery normalization"
```

Expected RED: migration/module missing.

- [ ] **Step 3: Implement migration**

Migration requirements:

```sql
-- create/reserve source when absent
insert into sources (source_id, source_key, display_name, status)
select gen_random_uuid(), 'ai-discovery', 'AI Discovery', 'active'
where not exists (select 1 from sources where source_key='ai-discovery');
```

Use guarded `DO $$ ... $$` blocks to raise if an existing `ai-discovery` source, revision 1 or active policy conflicts with the exact safe identity. Create policy revision 1 when absent and activate it only when exact. Create the three tables with bounded checks, FKs and `reject_immutable_change()` triggers. Add relational FKs from materialization to proposal/raw observation/normalized observation/candidate revision/provenance where the existing schema supports exact tuple checks.

- [ ] **Step 4: Implement types + canonical normalizer**

`types.ts` defines `AiDiscoveryRunStatus`, `AiCandidateProposalInput`, `RecordAiDiscoveryRunCommand/Result`, `MaterializeAiCandidateProposalCommand/Result`, and read models.

`proposalHash()` calls the existing canonical JSON hash helper with exactly:

```ts
{
  schemaVersion: 1,
  patchKey,
  gameModeExternalId: 'aram_mayhem',
  subjectExternalId,
  augmentExternalIds,
  itemExternalIds,
}
```

`proposalNormalizationSnapshot()` returns the same selection plus `origin: 'ai_generated'`.

- [ ] **Step 5: Run focused tests, backend typecheck and commit**

```bash
npm --prefix backend test -- --test-name-pattern="AI discovery migration|AI discovery normalization"
npm --prefix backend run typecheck
```

Commit: `feat: add guarded AI discovery authority schema`.

---

### Task 2: Atomic run and proposal recording

**Files:**
- Create: `backend/src/modules/ai-discovery/record-ai-discovery-run.ts`
- Create: `backend/test/record-ai-discovery-run.test.ts`

**Interfaces:**
- Consumes `normalizeAiDiscoveryRunCommand()` and existing `withTransaction`, canonical hashing and `idempotency_records` table.
- Produces `recordAiDiscoveryRun(pool, command): Promise<RecordAiDiscoveryRunResult>`.

- [ ] **Step 1: Write RED run-recording tests**

Cover completed run with two proposals, failed run with zero proposals, exact idempotent replay, run-key conflict, idempotency conflict, atomic rollback, and audit/outbox privacy.

Privacy assertion:

```ts
const events = await pool.query(`select payload::text from outbox_events where event_type='AiDiscoveryRunRecorded'`);
assert.doesNotMatch(events.rows[0].payload, /rationale text|raw provider/i);
```

- [ ] **Step 2: Verify RED**

```bash
npm --prefix backend test -- --test-name-pattern="record AI discovery run"
```

- [ ] **Step 3: Implement command**

Pre-normalize outside the transaction. Inside `withTransaction`:

1. claim/check idempotency scope `ai.discovery.run.record` using the same payload-hash/state semantics as existing commands;
2. if completed replay, reconstruct result from persisted run/proposals and verify canonical payload hash;
3. lock `run_key` conflict candidate when present and fail `AI_DISCOVERY_RUN_CONFLICT` on mismatch;
4. insert immutable run;
5. insert each proposal with server-computed proposal hash;
6. insert audit action `ai.discovery.run.recorded` with IDs/hashes/count/status only;
7. insert outbox event `AiDiscoveryRunRecorded` with `{schemaVersion:1, aiDiscoveryRunId, runKey, inputHash, outputHash, status, proposalCount}`;
8. complete idempotency with result.

Use deterministic domain errors and never persist provider raw output.

- [ ] **Step 4: Run focused + typecheck**

```bash
npm --prefix backend test -- --test-name-pattern="record AI discovery run"
npm --prefix backend run typecheck
```

- [ ] **Step 5: Commit**

Commit: `feat: record immutable AI discovery runs`.

---

### Task 3: Safe proposal materialization through Candidate Registry

**Files:**
- Create: `backend/src/modules/ai-discovery/materialize-ai-candidate-proposal.ts`
- Create: `backend/test/materialize-ai-candidate-proposal.test.ts`

**Interfaces:**
- Consumes `proposalNormalizationSnapshot()`, existing `registerNormalizedObservationInTransaction()` and PostgreSQL transaction/idempotency helpers.
- Produces `materializeAiCandidateProposal(pool, command): Promise<MaterializeAiCandidateProposalResult>`.

- [ ] **Step 1: Write RED materialization tests**

Fixture establishes an active patch/catalog and a completed AI run proposal. Assert successful materialization creates exactly one raw observation, normalized observation, candidate provenance and immutable linkage, with:

```ts
assert.equal(provenance.origin, 'ai_generated');
assert.equal(raw.adapter_version, 'ai-discovery-proposal-v1');
assert.equal(raw.raw_blob, null);
assert.equal(raw.content_hash, proposal.proposal_hash);
```

Also cover:

- failed parent run rejected;
- unsafe/missing reserved source policy rejected;
- invalid patch/entity/catalog selection rolls back all attempted rows;
- exact retry returns replay and adds no duplicate raw/normalized/provenance row;
- materializing two proposals with the same canonical selection reuses Candidate Registry deterministic identity while each proposal retains its own valid materialization linkage/provenance path;
- conflicting idempotency payload fails closed.

- [ ] **Step 2: Verify RED**

```bash
npm --prefix backend test -- --test-name-pattern="materialize AI candidate proposal"
```

- [ ] **Step 3: Implement materialization command**

Prevalidate IDs/reason/timestamp. In one transaction:

1. claim/check idempotency scope `ai.candidate.proposal.materialize`;
2. lock proposal + run;
3. require run `completed`;
4. return verified existing materialization on replay;
5. load reserved source and active policy with `FOR SHARE`; require exact safe policy;
6. insert raw observation with adapter/external-reference/aggregate-metadata/content-hash values from the spec;
7. call:

```ts
const registered = await registerNormalizedObservationInTransaction(client, {
  actorId: command.actorId,
  candidateId: command.candidateId,
  candidateRevisionId: command.candidateRevisionId,
  correlationId: command.correlationId,
  normalizedObservationId: command.normalizedObservationId,
  provenanceId: command.candidateProvenanceId,
  rawObservationId: command.rawObservationId,
  snapshot: proposalNormalizationSnapshot(proposal),
});
```

8. query/verify exact provenance origin + normalized observation link;
9. insert materialization row using the actual candidate/revision IDs returned by Candidate Registry;
10. insert `ai.candidate.proposal.materialized` audit and `AiCandidateProposalMaterialized` outbox with IDs/hash only;
11. complete idempotency.

Do not issue SQL against `candidates`, `candidate_revisions`, `normalized_observations` or `candidate_provenance` except read verification queries after the Candidate Registry call.

- [ ] **Step 4: Run focused + backend typecheck**

```bash
npm --prefix backend test -- --test-name-pattern="materialize AI candidate proposal"
npm --prefix backend run typecheck
```

- [ ] **Step 5: Commit**

Commit: `feat: materialize AI proposals through candidate registry`.

---

### Task 4: Internal read boundary and trust/authority safety regression

**Files:**
- Create: `backend/src/modules/ai-discovery/read-ai-discovery-proposals.ts`
- Create: `backend/test/read-ai-discovery-proposals.test.ts`
- Create: `backend/test/ai-discovery-authority-isolation.test.ts`
- Create: `backend/test/ai-discovery-eligibility-safety.test.ts`

**Interfaces:**
- Produces `readAiDiscoveryProposals(database, options): Promise<AiDiscoveryProposalReadModel[]>`.
- No HTTP route.

- [ ] **Step 1: Write RED reader tests**

Assert default pending filter, explicit all/materialized filters, limit bounds and deterministic `run.created_at desc, proposal.ordinal asc` order. Map rows field-by-field; never spread DB rows.

- [ ] **Step 2: Write RED authority-isolation tests**

Scan `backend/src/modules/ai-discovery/**` and reject imports/tokens for:

```txt
record-claim-evidence-decision
complete-human-review
moderation/
eligibility/
publish-candidate-revision
rollback-publication
evaluate-publication-monitoring
submit-publication-feedback
ioredis
bullmq
queue/
openai
anthropic
@google/generative-ai
fetch(
axios
undici
```

Allow only the Candidate Registry materialization import explicitly.

- [ ] **Step 3: Write eligibility safety regression**

After materializing an AI proposal, run the existing eligibility authority with no claim/review/moderation setup and assert it cannot produce `eligible`; the expected path is fail-closed missing claims or `needs_review` once required claim fixtures exist without review quorum. Then establish ordinary trust fixtures to prove eligibility can become eligible only through existing Evidence/HumanReview/Moderation authority, not by adding AI records.

- [ ] **Step 4: Implement reader**

Accept:

```ts
{ limit?: number; materialization?: 'all' | 'pending' | 'materialized' }
```

Bound limit to 1..100, default 50; default materialization `pending`. Return run/provider/model/template fields, proposal selection/rationale/hash and optional materialization candidate IDs.

- [ ] **Step 5: Run focused + full backend suite**

```bash
npm --prefix backend test -- --test-name-pattern="AI discovery proposals|AI discovery authority|AI discovery eligibility"
npm --prefix backend run typecheck
npm --prefix backend test
npm --prefix backend run build
```

- [ ] **Step 6: Commit**

Commit: `test: enforce AI discovery authority isolation`.

---

### Task 5: Repository contract, runbook and root orchestration

**Files:**
- Create: `tests/guarded-ai-discovery-contract.test.mjs`
- Create: `docs/runbooks/guarded-ai-discovery.md`
- Modify: `package.json`

**Interfaces:**
- Produces root `npm run test:guarded-ai-discovery` and makes root `test` inherit it.

- [ ] **Step 1: Write RED repository contract**

Contract verifies:

- migration/module/test/runbook paths exist;
- `CandidateOrigin` still contains `ai_generated`;
- AI module source contains the Candidate Registry registration boundary and not direct mutation SQL for candidate/trust/publication tables;
- no `app/**` AI route and no backend public route registration for AI discovery;
- production/staging Caddy files contain no AI/operator route additions;
- Railway configs contain no AI provider/service command;
- package dependencies do not add provider SDKs;
- runbook states provider invocation and production delivery are out of scope.

- [ ] **Step 2: Verify RED**

```bash
node --test tests/guarded-ai-discovery-contract.test.mjs
```

Expected failure until script/runbook exist.

- [ ] **Step 3: Add runbook**

Document provider-neutral example usage as TypeScript/internal command semantics only; do not include real secrets. State that an external provider integration must be a later sprint and that materialization is not Evidence/approval/publication.

- [ ] **Step 4: Update root package**

Add:

```json
"test:guarded-ai-discovery": "node --test tests/guarded-ai-discovery-contract.test.mjs"
```

Prepend/inherit it in root `test` after the existing 7C contract so inherited regression cannot skip 8A.

- [ ] **Step 5: Verify repository + full backend**

```bash
npm run test:guarded-ai-discovery
npm --prefix backend run typecheck
npm --prefix backend test
npm --prefix backend run build
```

- [ ] **Step 6: Commit**

Commit: `docs: add guarded AI discovery runbook and contract`.

---

### Task 6: Dedicated CI, PR, exact-head review and merge

**Files:**
- Create: `.github/workflows/sprint-8a-guarded-ai-discovery.yml`

**Interfaces:**
- Produces exact-head workflow `Sprint 8A guarded AI discovery gate`.

- [ ] **Step 1: Add dedicated workflow**

Use `pull_request` path filters for 8A files plus root/backend package manifests, Node 22.13.0, PostgreSQL 17, `permissions: contents: read`, root/backend `npm ci`, root 8A contract, backend typecheck/full tests/build, `git diff --check`, cleanliness and deployment guard. Do not add provider secrets, deploy commands or write permissions.

- [ ] **Step 2: Open draft PR**

Title: `Sprint 8A: guarded AI discovery authority`.

Body records base SHA, authority boundaries, provider/production exclusions and `SPRINT_8A_IMPLEMENTATION_IN_PROGRESS`.

- [ ] **Step 3: Exact-head verification**

Require all triggered runs to complete success:

- Sprint 8A guarded AI discovery gate;
- Sprint 7C operator surface gate if triggered;
- Sprint 7B feedback intake gate if triggered;
- Sprint 7A monitoring gate if triggered;
- full frontend/backend regression;
- staging integration;
- release candidate;
- deploy workflow dry run.

- [ ] **Step 4: Manual diff review**

Review exact `main...head` for Critical/Important findings: direct trust/publication mutation, direct candidate table mutation, unsafe source policy adoption, proposal hash ambiguity, raw provider output/rationale leakage, provider SDK/network call, secrets, public route/CORS, Redis/queue, Caddy/Railway wiring, replay duplication and partial transaction writes.

Fix every Critical/Important issue with a regression test and rerun exact-head CI.

- [ ] **Step 5: Ready + merge under standing delegation**

After fresh exact-head verification, no unresolved review blocker and unchanged verified base, update PR body to `SPRINT_8A_REPO_READY`, mark ready, recheck base/head/mergeability, and merge with `expected_head_sha`. Verify `main` equals the merge commit. Do not deploy production.
