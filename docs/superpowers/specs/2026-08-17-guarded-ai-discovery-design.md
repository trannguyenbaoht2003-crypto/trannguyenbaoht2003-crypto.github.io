# Sprint 8A — Guarded AI Discovery & Proposal Authority Design

**Status:** self-approved under standing project delegation after user direction approval  
**Base:** `main@1892a4f9f600e3465a674446a6b36da5a3be8322`  
**Scope:** provider-independent AI discovery run/proposal authority and safe Candidate Registry materialization  
**Production delivery:** explicitly out of scope

## 1. Purpose

Sprint 8A adds the first AI-facing authority boundary without connecting a live LLM provider. It records deterministic, auditable AI discovery runs and candidate proposals, then allows an explicitly selected proposal to be materialized into the existing Candidate Registry with `ai_generated` provenance.

AI output is advisory data only. It is not Evidence, HumanReview, Moderation, Eligibility, or Publication authority.

The authority flow is:

`governed input fingerprint -> AI discovery run -> immutable AI proposal -> explicit materialization -> existing Candidate Registry (ai_generated provenance) -> existing Evidence/HumanReview/Moderation/Eligibility -> Publication authority`

No path in Sprint 8A may skip a stage to the right.

## 2. Locked safety principles

1. AI output is never Evidence.
2. An AI proposal cannot publish, roll back, retract, hide, moderate, change Eligibility, create Evidence, or complete HumanReview.
3. Materialization creates/reuses a CandidateRevision only through the existing deterministic Candidate Registry command.
4. AI-generated CandidateRevision provenance is `ai_generated`.
5. Existing HumanReview/Eligibility fail-closed behavior remains authoritative. A materialized AI proposal is not publication-ready merely because it exists in Candidate Registry.
6. No live provider key, browser AI token, public AI HTTP route, CORS expansion, or provider SDK is added in 8A.
7. Public read remains independent of AI discovery availability.
8. All AI run/proposal/materialization records are immutable and auditable.
9. Retries are idempotent and conflicting replays fail closed.
10. Production deployment remains separately gated by Issue #23.

## 3. Existing authority reuse

The current Candidate Registry already accepts origin `ai_generated` and enforces candidate fingerprint, active catalog validation, immutable normalized observations, CandidateRevision immutability, and provenance graph consistency.

Sprint 8A must not create a second candidate registry or insert directly into `candidates`, `candidate_revisions`, `normalized_observations`, or `candidate_provenance` from AI-specific code.

Instead, materialization creates one governed synthetic `raw_observation` and calls `registerNormalizedObservationInTransaction()` with an `ObservationNormalizationSnapshotV1` whose origin is `ai_generated`.

This preserves all existing Candidate Registry checks and event/audit behavior.

## 4. Reserved system source

Migration `0014_guarded_ai_discovery.sql` creates or reuses a reserved source:

- `source_key = 'ai-discovery'`
- display name `AI Discovery`
- status `active`

It creates source-policy revision 1 only if absent:

- `storage_permission = 'aggregate_only'`
- `collector_enabled = false`
- reason identifies the source as synthetic AI proposal materialization only
- created_by `system:migration:0014`

It activates that policy for the reserved source.

The source cannot be used as a network collector. It exists only so Candidate Registry provenance continues through the existing raw-observation graph.

## 5. Persistence model

### 5.1 `ai_discovery_runs`

Immutable row per recorded discovery execution:

- `ai_discovery_run_id uuid primary key`
- `run_key text unique`
- `provider_key text`
- `model_key text`
- `model_revision text`
- `prompt_template_key text`
- `prompt_template_version integer > 0`
- `input_hash char(64)` lowercase SHA-256
- `output_hash char(64)` lowercase SHA-256
- `status = 'completed' | 'failed'`
- `started_at timestamptz`
- `completed_at timestamptz`
- `failure_code text null`
- `created_at timestamptz`

Constraints:

- `completed_at >= started_at`;
- completed runs have no failure code;
- failed runs require a bounded failure code;
- provider/model/template identifiers are bounded printable identifiers;
- immutable update/delete trigger.

8A records already-produced provider-neutral metadata. It does not call a provider.

### 5.2 `ai_candidate_proposals`

Immutable proposal rows owned by one completed run:

- `ai_candidate_proposal_id uuid primary key`
- `ai_discovery_run_id uuid not null`
- `ordinal integer >= 0`
- `proposal_hash char(64)`
- `patch_key text`
- `game_mode_external_id = 'aram_mayhem'`
- `subject_external_id text`
- `augment_external_ids jsonb`
- `item_external_ids jsonb`
- `rationale text null`
- `created_at timestamptz`

Uniqueness:

- `(ai_discovery_run_id, ordinal)` unique;
- `(ai_discovery_run_id, proposal_hash)` unique.

Selection arrays use the same canonical constraints as CandidateSelectionPayload v1: bounded strings, unique values and canonical ascending order. Rationale is untrusted text, bounded to 2000 characters, and never used as Evidence.

### 5.3 `ai_candidate_materializations`

Immutable one-to-one proof that one proposal entered Candidate Registry:

- `ai_candidate_materialization_id uuid primary key`
- `ai_candidate_proposal_id uuid not null unique`
- `raw_observation_id uuid not null unique`
- `normalized_observation_id uuid not null unique`
- `candidate_id uuid not null`
- `candidate_revision_id uuid not null`
- `candidate_provenance_id uuid not null unique`
- `actor_id text`
- `reason text`
- `correlation_id text`
- `materialized_at timestamptz`
- `created_at timestamptz`

Composite relational guards prove the linked raw/normalized/provenance/candidate graph belongs to the exact materialization. Update/delete is rejected.

## 6. Run registration command

Add `recordAiDiscoveryRun(pool, command)`.

The command accepts:

```ts
{
  actorId: string;
  aiDiscoveryRunId: string;
  correlationId: string;
  idempotencyKey: string;
  runKey: string;
  providerKey: string;
  modelKey: string;
  modelRevision: string;
  promptTemplateKey: string;
  promptTemplateVersion: number;
  inputHash: string;
  outputHash: string;
  status: 'completed' | 'failed';
  startedAt: string;
  completedAt: string;
  failureCode: string | null;
  proposals: Array<{
    aiCandidateProposalId: string;
    ordinal: number;
    patchKey: string;
    gameModeExternalId: 'aram_mayhem';
    subjectExternalId: string;
    augmentExternalIds: string[];
    itemExternalIds: string[];
    rationale: string | null;
  }>;
}
```

Rules:

- failed runs must contain zero proposals;
- completed runs may contain zero or more proposals;
- proposal hash is computed server-side from the canonical proposal tuple, never trusted from the caller;
- `outputHash` remains provider/output provenance and is not used as Evidence;
- input validation occurs before transaction work;
- idempotency scope is `ai.discovery.run.record`;
- same idempotency key + same canonical input returns replay;
- same key/runKey with conflicting content fails closed;
- run + proposals + audit + outbox are atomic.

Output event: `AiDiscoveryRunRecorded` with IDs/hashes/count/status only. No rationale or provider raw output is placed in outbox/audit payloads.

## 7. Proposal materialization command

Add `materializeAiCandidateProposal(pool, command)`.

Command:

```ts
{
  actorId: string;
  aiCandidateMaterializationId: string;
  aiCandidateProposalId: string;
  candidateId: string;
  candidateRevisionId: string;
  candidateProvenanceId: string;
  correlationId: string;
  idempotencyKey: string;
  normalizedObservationId: string;
  rawObservationId: string;
  reason: string;
  materializedAt: string;
}
```

Transaction rules:

1. lock the proposal and parent run;
2. require parent run status `completed`;
3. replay an existing materialization only if it refers to the same proposal and canonical proposal content;
4. load reserved `ai-discovery` source + active policy and require `collector_enabled=false` and `storage_permission='aggregate_only'`;
5. insert synthetic raw observation:
   - `adapter_version='ai-discovery-proposal-v1'`;
   - `external_reference={ schemaVersion:1, aiDiscoveryRunId, aiCandidateProposalId }`;
   - `aggregate_metadata={ normalizationSnapshot:{ schemaVersion:1, patchKey, gameModeExternalId:'aram_mayhem', origin:'ai_generated', subjectExternalId, augmentExternalIds, itemExternalIds } }`;
   - `content_hash=proposal_hash`;
   - `raw_blob=null`;
   - `patch_hint=patchKey`;
   - `observed_at=parent completed_at`;
   - `collected_at=materializedAt`;
6. invoke `registerNormalizedObservationInTransaction()` with the exact same normalization snapshot;
7. require resulting provenance row to have origin `ai_generated` and exact normalized observation ID;
8. insert immutable materialization linkage;
9. add AI-specific audit event and `AiCandidateProposalMaterialized` outbox event containing only IDs/hashes;
10. commit atomically.

If catalog/patch/entity compatibility is invalid, the existing Candidate Registry fails closed and the entire transaction rolls back.

## 8. Read boundary

Add `readAiDiscoveryProposals(pool, options)` for internal use only.

It returns field-by-field models with:

- run/provider/model/template metadata;
- proposal selection and bounded rationale;
- proposal hash;
- materialization state and candidate/revision IDs when present.

Options:

- `limit 1..100`, default 50;
- `materialization = 'all' | 'pending' | 'materialized'`, default `pending`;
- deterministic order newest run first, proposal ordinal ascending.

No public Fastify/Next route is added in 8A. Operator UI integration is deferred.

## 9. HumanReview and publication safety

Materialization is not approval. It only makes the proposal a CandidateRevision with `ai_generated` provenance.

Existing trust pipeline remains mandatory:

- claim set must be defined and sealed;
- required Evidence decisions must come from the existing Evidence authority;
- HumanReview quorum must be current and satisfied;
- Moderation must be current and non-blocking;
- Eligibility must be current and eligible;
- Publication authority remains the only publication mutation path.

8A adds regression coverage proving a materialized AI CandidateRevision cannot become eligible merely from AI run/proposal/materialization records and that AI modules have no imports/calls into Evidence, HumanReview completion, Moderation, Eligibility mutation, publish or rollback commands.

## 10. Provider and secret boundary

8A deliberately contains no:

- OpenAI/Anthropic/Gemini/other provider SDK;
- HTTP client for model invocation;
- AI API secret/env configuration;
- background AI queue/worker;
- browser token;
- public AI endpoint;
- prompt execution engine.

A later Sprint 8B may implement provider execution against `recordAiDiscoveryRun()` after this authority layer is verified.

## 11. Failure behavior

- invalid command input -> deterministic domain error before writes;
- idempotency conflict -> fail closed;
- failed run -> persisted with zero proposals and bounded failure code;
- proposal references invalid patch/catalog/entity/selection -> materialization transaction rolls back;
- reserved AI source/policy missing or unsafe -> materialization fails closed;
- Candidate Registry replay -> materialization resolves to the same candidate revision and never duplicates provenance;
- database failure -> no partial run/proposal/materialization graph;
- AI subsystem failure has no effect on public read availability.

## 12. Authority isolation contracts

Production files under `backend/src/modules/ai-discovery/**` may import:

- PostgreSQL transaction/query types;
- canonical hash/normalization helpers;
- Candidate Registry normalization/registration read-write boundary for materialization only.

They must not import or call:

- `record-claim-evidence-decision`;
- `complete-human-review`;
- moderation decision/evaluator commands;
- eligibility evaluator/policy mutation commands;
- publication publish/rollback commands;
- monitoring evaluator/transition commands;
- feedback submission authority;
- Redis/BullMQ/queue modules;
- external AI provider SDKs or HTTP clients.

Dedicated source scans and runtime tests enforce this boundary.

## 13. Files

Create:

- `backend/migrations/0014_guarded_ai_discovery.sql`
- `backend/src/modules/ai-discovery/types.ts`
- `backend/src/modules/ai-discovery/normalize-ai-discovery-input.ts`
- `backend/src/modules/ai-discovery/record-ai-discovery-run.ts`
- `backend/src/modules/ai-discovery/materialize-ai-candidate-proposal.ts`
- `backend/src/modules/ai-discovery/read-ai-discovery-proposals.ts`
- backend tests for migration, run recording, materialization, replay/conflict, eligibility safety and authority isolation
- `tests/guarded-ai-discovery-contract.test.mjs`
- `docs/runbooks/guarded-ai-discovery.md`
- `.github/workflows/sprint-8a-guarded-ai-discovery.yml`

Modify:

- root `package.json` to add `test:guarded-ai-discovery` and inherit it from root `test`;
- only narrowly required shared interfaces if compile-time reuse needs them.

No public frontend route, operator route, Caddy/Railway configuration or production deployment file is modified.

## 14. Required tests

1. migration creates immutable run/proposal/materialization authority and reserved safe AI source;
2. completed run with canonical proposals records atomically;
3. failed run rejects proposals;
4. proposal hashes are deterministic and independent of UUIDs/rationale ordering noise;
5. exact replay is duplicate-noop;
6. idempotency/run-key conflict fails closed;
7. proposal selection arrays reject duplicates/non-canonical order/invalid bounds;
8. materialization requires completed parent run;
9. materialization requires reserved AI source policy to be aggregate-only and collector-disabled;
10. materialization uses existing Candidate Registry and yields origin `ai_generated`;
11. invalid catalog/patch/entity selection rolls back raw observation and linkage;
12. materialization replay does not duplicate raw observation, normalized observation or provenance;
13. same normalized proposal can reuse deterministic candidate/revision behavior while preserving proposal linkage;
14. AI run/proposal/materialization records alone do not satisfy Evidence/HumanReview/Moderation/Eligibility;
15. read boundary returns pending/materialized filters deterministically;
16. audit/outbox payloads exclude rationale/raw provider output/secrets;
17. source scan proves no trust/publication mutation bypass imports;
18. source scan proves no Redis/BullMQ/provider SDK/network invocation;
19. root contract proves no public/Caddy/Railway/operator exposure added;
20. backend typecheck/full tests/build and inherited Sprint 7A/7B/7C, regression, staging, release and deploy dry-run gates remain green.

## 15. CI completion gate

Add `Sprint 8A guarded AI discovery gate` using:

- Node 22.13.0;
- PostgreSQL 17;
- root/backend `npm ci`;
- `npm run test:guarded-ai-discovery`;
- backend typecheck;
- full backend tests;
- backend build;
- `git diff --check` and repository cleanliness;
- deployment guard with read-only permissions and no deploy commands/secrets.

Sprint 8A is repository-ready only when its exact head passes the dedicated gate plus all triggered inherited 7A/7B/7C, full regression, staging integration, release candidate and deploy dry-run workflows, and manual review finds no Critical/Important authority or secret/exposure blocker.

## 16. Completion boundary

A merged Sprint 8A means the repository has a guarded, provider-independent AI discovery proposal authority and a safe path into Candidate Registry.

It does **not** mean:

- a live LLM/provider is connected;
- AI creates Evidence;
- AI can approve HumanReview/Moderation/Eligibility;
- AI can publish or roll back;
- production AI credentials exist;
- production has been deployed.
