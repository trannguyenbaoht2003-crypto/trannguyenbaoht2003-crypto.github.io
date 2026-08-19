# Sprint 8C — AI Operations Policy and Budget Controls Design

Base: `main@9eb5e082297b24e884af3cee1b0b0a88c9d8a2ec`.

## Goal

Add a fail-closed operational control plane around the private Sprint 8B AI provider execution path so provider runs are allowed only by an explicit active policy and bounded PostgreSQL budget, while Candidate materialization remains an explicit operator action.

## Locked authority boundary

- PostgreSQL remains the durable authority for policy, budget reservations, AI runs/proposals, Candidate materialization, Human Review, Moderation, Eligibility, and Publication.
- Sprint 8B `executeAiDiscoveryProviderRun()` remains the only provider execution orchestration used by Sprint 8C.
- Sprint 8A `recordAiDiscoveryRun()` remains the only durable AI run/proposal recording authority.
- Sprint 8A `materializeAiCandidateProposal()` remains the only AI proposal → Candidate materialization authority.
- AI output is advisory and never Evidence.
- AI materialization creates `ai_generated` provenance only; it does not complete Human Review, Moderation, Eligibility, or Publication.
- No public HTTP mutation route, no operator-browser mutation, no CORS/Caddy exposure, no production credential provisioning, and no production deployment are authorized by Sprint 8C.
- No recurring scheduler or BullMQ AI provider queue is introduced. The scheduling primitive is a private, externally invoked tick command guarded by policy and budget.

## 1. Policy authority

Create migration `0015_ai_operations_policy.sql` with three durable structures.

### `ai_operations_policy_revisions`

Append-only policy revisions:

- `ai_operations_policy_revision_id uuid primary key`
- `revision integer unique`, positive
- `enabled boolean`
- `max_runs_per_utc_day integer`, `0..64`; an enabled policy requires at least `1`
- `min_interval_seconds integer`, `0..86400`
- `max_proposals_per_run integer`, `1..64`
- `game_mode_external_id text`, fixed to `aram_mayhem`
- `reason text`, trimmed, `1..1024`
- `created_by text`, trimmed, `1..256`
- `created_at timestamptz default clock_timestamp()`

Migration creates revision 1 as disabled, `max_runs_per_utc_day=0`, `min_interval_seconds=3600`, `max_proposals_per_run=16`, reason `disabled by default; explicit activation required`, created by `system:migration:0015`.

### `active_ai_operations_policy_revision`

Singleton mutable pointer:

- `scope text primary key`, fixed to `ai_discovery_provider`
- `ai_operations_policy_revision_id uuid references ai_operations_policy_revisions`
- `updated_at timestamptz`

Migration points the active policy to disabled revision 1. Activation uses an expected-current revision ID to prevent lost updates.

### `ai_operations_run_budget_reservations`

Append-only budget ledger:

- `ai_operations_run_budget_reservation_id uuid primary key`
- `ai_discovery_run_id uuid unique`
- `run_key text`
- `ai_operations_policy_revision_id uuid references ai_operations_policy_revisions`
- `budget_date date` derived from PostgreSQL UTC clock at reservation time
- `max_proposals_per_run integer` snapshot copied from the active policy
- `actor_id`, `correlation_id`
- `reserved_at timestamptz default clock_timestamp()`

A reservation is a consumed provider-run budget unit. It is not refunded when provider execution fails or the process exits after reservation. This intentionally favors cost safety and fail-closed behavior.

Policy revision and budget reservation rows are immutable by database triggers. The active pointer is mutable only through the activation authority module.

## 2. Policy commands

Module: `backend/src/modules/ai-operations/**`.

### Register policy revision

`registerAiOperationsPolicyRevision(pool, command)`:

- exact-key input validation;
- idempotent command scope `ai.operations.policy.register`;
- immutable insert;
- audit event `ai.operations.policy_revision_registered`;
- no outbox event, because Sprint 8C creates no AI queue consumer.

### Activate policy revision

`activateAiOperationsPolicyRevision(pool, command)`:

- exact-key input validation;
- idempotent scope `ai.operations.policy.activate`;
- PostgreSQL advisory lock on singleton active pointer;
- target revision must exist;
- expected-current pointer must match exactly;
- audit event `ai.operations.policy_revision_activated`.

A private stdin policy CLI exposes only these two command types. It requires `DATABASE_URL`, accepts no positional arguments, and emits sanitized JSON or `AI_OPERATIONS_POLICY_FAILED`.

## 3. Atomic budget reservation

`reserveAiOperationsRunBudget(pool, command)` is the only way the 8C tick may obtain permission to invoke a provider.

Inside one PostgreSQL transaction it:

1. starts idempotent scope `ai.operations.run.reserve`;
2. acquires a global advisory transaction lock for AI provider budget;
3. loads the active policy and fails if missing or disabled;
4. requires `gameModeExternalId === 'aram_mayhem'`;
5. counts all reservations for the current PostgreSQL UTC date across all policy revisions;
6. rejects when the active `max_runs_per_utc_day` is exhausted;
7. checks the newest reservation across all policy revisions and rejects if `min_interval_seconds` has not elapsed;
8. inserts exactly one reservation for `aiDiscoveryRunId` and snapshots `max_proposals_per_run`;
9. writes audit event `ai.operations.run_budget_reserved` without prompt, observation, provider body, API key, or raw provider error data;
10. completes the idempotent command.

Counting reservations across policy revisions prevents policy rotation from resetting same-day usage or the minimum interval.

The same idempotency key and payload replays the same reservation and does not consume quota twice. A different command attempting to reserve the same `aiDiscoveryRunId` fails closed.

## 4. Policy-governed provider tick

`executePolicyGovernedAiDiscoveryRun(pool, command)` composes existing authorities; it does not create a new run/proposal persistence path.

Flow:

1. normalize Sprint 8B provider input;
2. reserve budget through `reserveAiOperationsRunBudget()`;
3. wrap the injected `AiDiscoveryProvider` with a result-cap guard using the reservation snapshot `maxProposalsPerRun`;
4. delegate to Sprint 8B `executeAiDiscoveryProviderRun()` using the same actor/correlation/idempotency/run ID/model/start time/input;
5. if provider output contains more than the policy cap, throw `AiProviderError('AI_OPERATIONS_PROPOSAL_CAP_EXCEEDED', false, 'PROVIDER_RESPONSE_INVALID')`; Sprint 8B records the run as failed using its existing safe failure authority;
6. return the Sprint 8B durable result plus budget reservation metadata.

A completed Sprint 8B replay and a replayed budget reservation result in zero additional quota consumption and Sprint 8B performs zero provider calls.

## 5. Private tick CLI

Create `backend/src/ai-operations-tick-cli.ts`.

Configuration is the same private provider configuration used by Sprint 8B:

- `DATABASE_URL`
- `AI_DISCOVERY_PROVIDER=openai`
- `OPENAI_API_KEY`
- `AI_DISCOVERY_OPENAI_MODEL`
- optional bounded `AI_DISCOVERY_TIMEOUT_MS`
- optional non-production `AI_DISCOVERY_OPENAI_ENDPOINT`

Input is stdin-only and bounded to 256 KiB. It reuses Sprint 8B canonical provider input and adds no scheduling data that can bypass PostgreSQL clock-based budget controls.

Success stdout contains only:

- `runId`
- `status`
- `proposalCount`
- `replay`
- `budgetReservationId`
- `budgetReplay`
- `policyRevisionId`

All failure output is the single sanitized line `AI_OPERATIONS_TICK_FAILED`.

## 6. Explicit materialization CLI

Create `backend/src/ai-discovery-materialize-cli.ts`.

The CLI:

- requires only `DATABASE_URL`;
- accepts one exact stdin JSON command for one proposal;
- requires explicit `actorId`, `reason`, `correlationId`, `idempotencyKey`, `aiCandidateMaterializationId`, `aiCandidateProposalId`, and `materializedAt`;
- calls existing `materializeAiCandidateProposal()` directly;
- never enumerates and bulk-materializes proposals;
- emits only IDs and replay status;
- emits `AI_DISCOVERY_MATERIALIZE_FAILED` on all failures.

No scheduled/tick code calls this CLI or materialization authority.

## 7. Read-only operations snapshot

`readAiOperationsSnapshot(pool)` returns only safe operational metadata:

- active policy revision fields;
- current PostgreSQL UTC budget date;
- reservations used today and remaining budget;
- last reservation timestamp;
- pending and materialized AI proposal counts.

It does not return provider prompts, raw observations, API secrets, request/response bodies, or Evidence/Publication mutation capability.

Sprint 8C does not add this snapshot to public Fastify routes or the browser operator surface. A later sprint may consume the read model after a separate security/design review.

## 8. Security and secrets

- No provider request/response body, prompt, observation text, `OPENAI_API_KEY`, Authorization header, DB URL, or raw provider error body is written to policy, budget, audit, CLI stdout/stderr, or repository files.
- Workflow permissions remain `contents: read`.
- Tests use injected fake providers; no real provider call.
- No Railway/Caddy/Cloudflare/Kubernetes/Terraform/Pulumi deployment commands.

## 9. Verification

TDD requires RED before production implementation. The first code commit after this design/plan contains failing migration/authority/orchestration/CLI/contract tests only. GitHub Actions on the draft PR is the executable RED environment because this conversation runtime has no repository checkout.

The final Sprint 8C exact-head gate must include:

- Sprint 8C repository contract;
- Sprint 8B AI provider execution contract;
- Sprint 8A guarded AI discovery contract;
- frontend lint;
- backend typecheck;
- full backend tests;
- backend build;
- repository cleanliness;
- deployment/secret guard.

Before merge, all existing Sprint 7A/7B/7C, 5C regression/staging, 5D RC, and deploy dry-run workflows triggered by the PR must also be green. Production delivery remains separately gated.