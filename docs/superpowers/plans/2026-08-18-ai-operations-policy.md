# Sprint 8C AI Operations Policy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add fail-closed policy, UTC daily budget, minimum run interval, proposal-cap enforcement, private tick/policy/materialization CLIs, and a read-only operations snapshot around the existing Sprint 8B AI provider execution path.

**Architecture:** PostgreSQL owns immutable policy revisions and budget reservations. A private tick must reserve budget before calling Sprint 8B provider execution; the tick wraps the provider only to enforce the active policy proposal cap and otherwise delegates all durable run/proposal writes to Sprint 8A/8B. Materialization remains a separate explicit CLI calling the existing Sprint 8A materialization authority.

**Tech Stack:** Node.js 22.13+, TypeScript 5.9, PostgreSQL 17, `pg`, existing OpenAI Responses adapter via built-in/injected `fetch`, Node `test`, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-08-18-ai-operations-policy-design.md`

## Global Constraints

- Base exact commit is `main@9eb5e082297b24e884af3cee1b0b0a88c9d8a2ec`.
- No public HTTP mutation route.
- No browser operator mutation.
- No recurring scheduler and no BullMQ AI provider queue.
- No automatic Candidate materialization.
- AI output is never Evidence.
- No HumanReview/Moderation/Eligibility/Publication mutation authority is added.
- No production credentials or production deployment.
- No provider body, prompt, observations, API keys, Authorization headers, database URLs, or raw provider error bodies may be persisted or logged.
- Tests use injected fake providers only.
- TDD: test commit must be observed RED before production code is added.

---

### Task 1: RED migration and policy authority tests

**Files:**
- Create: `backend/test/ai-operations-migration.test.ts`
- Create: `backend/test/ai-operations-policy.test.ts`

**Interfaces:**
- Produces the expected database schema and public TypeScript command behavior for Tasks 2–3.

- [ ] **Step 1: Write migration tests** asserting that migration `0015_ai_operations_policy.sql` creates an active disabled revision 1 with `max_runs_per_utc_day=0`, `min_interval_seconds=3600`, `max_proposals_per_run=16`, `game_mode_external_id='aram_mayhem'`, and immutable policy/budget tables.
- [ ] **Step 2: Write policy command tests** importing the not-yet-existing `registerAiOperationsPolicyRevision()` and `activateAiOperationsPolicyRevision()` functions. Cover registration success, registration idempotency replay, enabled-policy `maxRunsPerUtcDay=0` rejection, expected-current activation conflict, activation replay, and audit-event creation.
- [ ] **Step 3: Commit only the tests** with `test: define Sprint 8C policy authority`.
- [ ] **Step 4: Open/update the draft PR and verify RED**. Expected failure: missing `ai-operations` modules and/or missing `0015` schema objects. Do not write production code until the failure is confirmed.

### Task 2: Migration, types, register and activate policy authority

**Files:**
- Create: `backend/migrations/0015_ai_operations_policy.sql`
- Create: `backend/src/modules/ai-operations/types.ts`
- Create: `backend/src/modules/ai-operations/register-ai-operations-policy-revision.ts`
- Create: `backend/src/modules/ai-operations/activate-ai-operations-policy-revision.ts`

**Interfaces:**
- Produces:
  - `registerAiOperationsPolicyRevision(pool, command)`
  - `activateAiOperationsPolicyRevision(pool, command)`
  - shared policy command/result types.

- [ ] **Step 1: Implement migration** with append-only triggers for `ai_operations_policy_revisions` and `ai_operations_run_budget_reservations`, singleton active pointer, and disabled revision 1 created by `system:migration:0015`.
- [ ] **Step 2: Implement exact-key normalization** for register command fields: `actorId`, `correlationId`, `idempotencyKey`, `aiOperationsPolicyRevisionId`, `revision`, `enabled`, `maxRunsPerUtcDay`, `minIntervalSeconds`, `maxProposalsPerRun`, `reason`.
- [ ] **Step 3: Implement registration** using `beginIdempotentCommand` scope `ai.operations.policy.register`, immutable insert, safe audit event, and `completeIdempotentCommand`.
- [ ] **Step 4: Implement activation** using expected-current pointer comparison, advisory transaction lock, idempotent scope `ai.operations.policy.activate`, safe audit event, and no outbox write.
- [ ] **Step 5: Run Task 1 tests**. Expected: PASS.
- [ ] **Step 6: Commit** `feat: add AI operations policy authority`.

### Task 3: RED budget reservation and operations reader tests

**Files:**
- Create: `backend/test/ai-operations-budget.test.ts`
- Create: `backend/test/ai-operations-reader.test.ts`

**Interfaces:**
- Consumes policy authority from Task 2.
- Produces expected behavior for `reserveAiOperationsRunBudget()` and `readAiOperationsSnapshot()`.

- [ ] **Step 1: Write budget RED tests** covering disabled fail-closed, first reservation success, same-idempotency replay without second row, same run ID with different command rejection, UTC daily quota exhaustion, minimum interval rejection across policy revisions, and concurrent reservations where the quota permits only one winner.
- [ ] **Step 2: Write reader RED test** asserting safe active-policy fields, current UTC usage, remaining budget, last reservation time, pending proposal count, and materialized proposal count; assert no prompt/body/secret fields exist in returned data.
- [ ] **Step 3: Run targeted tests and confirm RED** because modules do not exist.
- [ ] **Step 4: Commit** `test: define AI operations budget controls`.

### Task 4: Atomic budget reservation and safe read model

**Files:**
- Create: `backend/src/modules/ai-operations/reserve-ai-operations-run-budget.ts`
- Create: `backend/src/modules/ai-operations/read-ai-operations-snapshot.ts`
- Modify: `backend/src/modules/ai-operations/types.ts`

**Interfaces:**
- Produces:
  - `reserveAiOperationsRunBudget(pool, command): Promise<ReserveAiOperationsRunBudgetResult>`
  - `readAiOperationsSnapshot(pool): Promise<AiOperationsSnapshot>`

- [ ] **Step 1: Normalize reserve command** with exact fields `actorId`, `correlationId`, `idempotencyKey`, `aiDiscoveryRunId`, `runKey`, `gameModeExternalId` and validate UUID/text bounds.
- [ ] **Step 2: Implement reservation transaction** with idempotency scope `ai.operations.run.reserve`, global advisory lock, active-policy load, disabled check, UTC-date usage count across all revisions, latest-reservation interval check across all revisions, unique run reservation insert, proposal-cap snapshot, safe audit event, and idempotent completion.
- [ ] **Step 3: Map duplicate run reservation to `AI_OPERATIONS_RUN_ALREADY_RESERVED`; map disabled/quota/interval conditions to `AI_OPERATIONS_DISABLED`, `AI_OPERATIONS_DAILY_BUDGET_EXHAUSTED`, and `AI_OPERATIONS_MIN_INTERVAL_NOT_ELAPSED`.
- [ ] **Step 4: Implement read model** using PostgreSQL clock for UTC date and safe aggregate counts only.
- [ ] **Step 5: Run Tasks 1–3 tests**. Expected: PASS.
- [ ] **Step 6: Commit** `feat: enforce AI operations budget reservations`.

### Task 5: RED policy-governed provider orchestration tests

**Files:**
- Create: `backend/test/execute-policy-governed-ai-discovery-run.test.ts`

**Interfaces:**
- Consumes `reserveAiOperationsRunBudget()` and Sprint 8B `executeAiDiscoveryProviderRun()`.
- Produces desired API for Task 6.

- [ ] **Step 1: Write test** proving disabled policy yields zero provider calls and zero `ai_discovery_runs` rows.
- [ ] **Step 2: Write test** proving enabled policy reserves exactly one budget unit, delegates to Sprint 8B, and returns durable completed run metadata.
- [ ] **Step 3: Write test** proving same command replay does not add a second budget reservation and Sprint 8B replay produces zero additional provider calls.
- [ ] **Step 4: Write test** proving provider output above `maxProposalsPerRun` is converted to safe `PROVIDER_RESPONSE_INVALID` failure and no proposal rows are stored.
- [ ] **Step 5: Confirm RED** because the orchestrator does not exist.
- [ ] **Step 6: Commit** `test: define policy-governed AI provider execution`.

### Task 6: Policy-governed provider execution

**Files:**
- Create: `backend/src/modules/ai-operations/execute-policy-governed-ai-discovery-run.ts`
- Modify: `backend/src/modules/ai-operations/types.ts`

**Interfaces:**
- Produces `executePolicyGovernedAiDiscoveryRun(pool, command, dependencies?)`.

- [ ] **Step 1: Validate/normalize the Sprint 8B input** using `normalizeAiProviderExecutionInput()` before reserve.
- [ ] **Step 2: Reserve budget** using the canonical `runKey` and fixed `aram_mayhem` game mode.
- [ ] **Step 3: Wrap the provider** preserving `providerKey`; reject raw provider results whose `proposals.length` exceeds the reservation snapshot with `new AiProviderError('AI_OPERATIONS_PROPOSAL_CAP_EXCEEDED', false, 'PROVIDER_RESPONSE_INVALID')`.
- [ ] **Step 4: Delegate unchanged durable fields** to `executeAiDiscoveryProviderRun()`.
- [ ] **Step 5: Return durable run result plus `budgetReservationId`, `budgetReplayed`, and `policyRevisionId`.
- [ ] **Step 6: Run Task 5 and Sprint 8B provider tests**. Expected: PASS.
- [ ] **Step 7: Commit** `feat: gate AI provider runs by operations policy`.

### Task 7: RED private CLI tests

**Files:**
- Create: `backend/test/ai-operations-policy-cli.test.ts`
- Create: `backend/test/ai-operations-tick-cli.test.ts`
- Create: `backend/test/ai-discovery-materialize-cli.test.ts`

**Interfaces:**
- Defines exact stdin/env/output boundaries for Task 8.

- [ ] **Step 1: Policy CLI tests** cover register and activate stdin shapes, missing `DATABASE_URL`, extra keys, sanitized failure, and safe success JSON.
- [ ] **Step 2: Tick CLI tests** cover 256 KiB bound, no positional args, provider/env validation identical to Sprint 8B, sanitized failure, and safe success JSON including budget metadata.
- [ ] **Step 3: Materialize CLI tests** cover exact one-proposal command, missing DB URL, malformed UUID/timestamp, injected materialization authority call, safe success JSON, and sanitized failure.
- [ ] **Step 4: Confirm RED** because CLI files do not exist.
- [ ] **Step 5: Commit** `test: define private Sprint 8C operator CLIs`.

### Task 8: Private policy, tick and materialization CLIs

**Files:**
- Create: `backend/src/ai-operations-policy-cli.ts`
- Create: `backend/src/ai-operations-tick-cli.ts`
- Create: `backend/src/ai-discovery-materialize-cli.ts`
- Modify: `backend/package.json`

**Interfaces:**
- Adds backend scripts:
  - `ai-operations:policy`
  - `ai-operations:tick`
  - `ai-discovery:materialize`

- [ ] **Step 1: Implement policy CLI** stdin-only, exact register/activate unions, DB-only env, dependency injection for tests, no raw error output.
- [ ] **Step 2: Implement tick CLI** by reusing Sprint 8B provider configuration semantics and `executePolicyGovernedAiDiscoveryRun()`; stdout only the approved run/budget metadata.
- [ ] **Step 3: Implement materialization CLI** calling existing `materializeAiCandidateProposal()` once per input command; no list/bulk behavior.
- [ ] **Step 4: Add package scripts** without new dependencies.
- [ ] **Step 5: Run Task 7 tests and full backend typecheck/tests/build**. Expected: PASS.
- [ ] **Step 6: Commit** `feat: add private Sprint 8C operation CLIs`.

### Task 9: RED repository contract, runbook and CI coverage

**Files:**
- Create: `tests/ai-operations-policy-contract.test.mjs`

**Interfaces:**
- Defines repository-level authority/exposure/deployment constraints for Task 10.

- [ ] **Step 1: Write repository contract RED tests** asserting the required migration/modules/CLIs exist, no AI operations public route is registered, no AI queue/worker is added, no automatic materialization call appears in tick/orchestrator files, package scripts point only to private backend CLIs, and the dedicated workflow includes all new test/module/doc paths.
- [ ] **Step 2: Add assertions** that workflow permissions are read-only and the workflow contains no deployment commands or credential literals.
- [ ] **Step 3: Run `node --test tests/ai-operations-policy-contract.test.mjs` and confirm RED** because workflow/runbook/root script are missing.
- [ ] **Step 4: Commit** `test: lock Sprint 8C repository authority boundary`.

### Task 10: Runbook, root script and dedicated Sprint 8C gate

**Files:**
- Create: `docs/runbooks/ai-operations-policy.md`
- Create: `.github/workflows/sprint-8c-ai-operations-policy.yml`
- Modify: `package.json`

**Interfaces:**
- Adds root script `test:ai-operations-policy`.

- [ ] **Step 1: Write runbook** documenting default-disabled state, safe register/activate sequence, tick invocation, budget semantics, explicit one-proposal materialization, rollback by activating a disabled revision, and secret handling.
- [ ] **Step 2: Add root script** `test:ai-operations-policy` running `node --test tests/ai-operations-policy-contract.test.mjs` and include it near the start of root `test`.
- [ ] **Step 3: Create dedicated workflow** with PostgreSQL 17 and Redis 7 services, Node 22.13, frontend/backend installs, Sprint 8C contract, 8B contract, 8A contract, frontend lint, backend typecheck, full backend tests, backend build, cleanliness, and deployment/secret guard.
- [ ] **Step 4: Ensure workflow path filters include migration, all `ai-operations/**`, all three CLIs/tests, package files, design/plan/runbook, root contract, and the workflow itself.
- [ ] **Step 5: Run repository contract and full available CI**. Expected: PASS.
- [ ] **Step 6: Commit** `ci: add Sprint 8C AI operations gate`.

### Task 11: Exact-head verification and PR completion

**Files:**
- No production file changes unless verification finds a defect.

- [ ] **Step 1: Run/fetch exact-head Sprint 8C workflow** and verify success.
- [ ] **Step 2: Verify Sprint 8B, 8A, 7A, 7B, 7C, 5C regression, 5C staging, 5D RC, and deploy dry-run workflows associated with the exact PR head are successful when triggered.
- [ ] **Step 3: Inspect PR diff for authority leakage**: no public mutation route, no AI queue, no production deploy/credential files, no automatic materialization, no Evidence/HumanReview/Moderation/Eligibility/Publication writes from AI operations modules.
- [ ] **Step 4: Inspect review threads/comments** and resolve any Critical/Important issue before merge.
- [ ] **Step 5: Update PR body with exact base/head SHAs, delivered behavior, safety boundaries, test evidence, and status `SPRINT_8C_REPO_READY` only if all gates are green.
- [ ] **Step 6: Use `superpowers:verification-before-completion` and `superpowers:finishing-a-development-branch` before making completion/merge claims. Production deployment remains out of scope.