# Sprint 8E — Durable AI Provider Execution Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add durable provider-execution/attempt authority, fail-closed crash recovery, explicit reconciliation, and traceable OpenAI request IDs so ambiguous external calls are never automatically replayed.

**Architecture:** PostgreSQL remains the authority. Sprint 8C budget reservation and Sprint 8A AI-run persistence are refactored into transaction-scoped primitives so Sprint 8E can atomically prepare and finalize provider executions. The provider path becomes one durable attempt at a time; only HTTP 429 may automatically create a next attempt. Timeout/transport/408/5xx/crash ambiguity becomes `UNCERTAIN` and can reopen only through append-only operator reconciliation.

**Tech Stack:** Node.js >=22.13.0, TypeScript 5.9.3, PostgreSQL 17, BullMQ 5.80.11, Redis 7/ioredis 5.11.1, Node test runner with `tsx`, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-08-20-ai-provider-execution-recovery-design.md`

## Global Constraints

- Implementation starts from approved design head `e8f5f13c641d0ba4546782b2469bd8dd3dd9603d`.
- `AI_DISCOVERY_SCHEDULER_ENABLED=false` stays the default.
- No production OpenAI credential, production deployment, or scheduler activation.
- Redis/BullMQ never authorizes replay/provider spend.
- One logical `aiDiscoveryRunId` -> exactly one provider execution journal.
- Max three durable provider attempts per execution.
- Lease duration exactly 120 seconds; no heartbeat/renewal in Sprint 8E.
- Provider call forbidden before durable execution + current attempt are `IN_FLIGHT` under a valid lease.
- Automatic retry class is exactly durable HTTP 429, with delays 500 ms then 1500 ms.
- Timeout, transport error without authoritative HTTP response, HTTP 408, HTTP 5xx/gateway response, process crash while `IN_FLIGHT`, or post-provider persistence ambiguity -> `UNCERTAIN`; no automatic replay.
- `UNCERTAIN` reopens only after append-only `CONFIRMED_NOT_RECEIVED` and only if current ordinal <3.
- `CONFIRMED_RECEIVED` and `ABANDONED` never authorize another provider call.
- `CONFIRMED_NOT_RECEIVED` at ordinal 3 records truth but creates no attempt 4.
- `X-Client-Request-Id`, HTTP `x-request-id`, and Responses JSON `id` are separate fields and are not provider idempotency.
- Do not persist/log API keys, Authorization headers, raw prompt/messages, raw observation payload, raw model output text, or raw HTTP body.
- Durable AI-run replay preflight occurs before new budget/journal preparation.
- Pre-8E budget reservation without durable AI run is consumed/fail-closed; never synthesize a new 8E execution under it.
- AI remains advisory: no automatic Candidate materialization, Human Review, Moderation, Eligibility, Evidence, or Publication mutation.
- First implementation commit MUST contain RED tests/contracts only.

---

## File Map

### New production files

- `backend/migrations/0017_ai_provider_execution_journal.sql`
- `backend/src/modules/ai-provider-execution/types.ts`
- `backend/src/modules/ai-provider-execution/client-request-id.ts`
- `backend/src/modules/ai-provider-execution/prepare-ai-provider-execution.ts`
- `backend/src/modules/ai-provider-execution/claim-ai-provider-execution.ts`
- `backend/src/modules/ai-provider-execution/mark-ai-provider-attempt-in-flight.ts`
- `backend/src/modules/ai-provider-execution/execute-ai-provider-attempt.ts`
- `backend/src/modules/ai-provider-execution/finalize-ai-provider-execution.ts`
- `backend/src/modules/ai-provider-execution/process-ai-provider-execution.ts`
- `backend/src/modules/ai-provider-execution/recover-stale-ai-provider-executions.ts`
- `backend/src/modules/ai-provider-execution/reconcile-ai-provider-execution.ts`
- `backend/src/modules/ai-provider-execution/read-ai-provider-execution-status.ts`
- `backend/src/ai-provider-execution-cli.ts`
- `tests/ai-provider-execution-recovery-contract.test.mjs`
- `docs/runbooks/ai-provider-execution-recovery.md`
- `.github/workflows/sprint-8e-ai-provider-execution-recovery.yml`

### Existing production files modified

- `backend/src/modules/ai-operations/reserve-ai-operations-run-budget.ts`
- `backend/src/modules/ai-discovery/record-ai-discovery-run.ts`
- `backend/src/modules/ai-provider/openai-responses-provider.ts`
- `backend/src/modules/ai-provider/execute-ai-discovery-provider-run.ts`
- `backend/src/modules/ai-operations/execute-policy-governed-ai-discovery-run.ts`
- `backend/src/modules/ai-automation/process-scheduled-ai-discovery-tick.ts`
- `backend/src/queue/ai-discovery-automation-worker.ts`
- `backend/src/ai-automation-worker.ts`
- `backend/src/modules/ai-operations/read-ai-operations-snapshot.ts`
- `backend/src/modules/ai-operations/types.ts`
- `backend/package.json`
- root `package.json`

### New backend tests

- `backend/test/ai-provider-execution-journal-migration.test.ts`
- `backend/test/ai-provider-execution-preparation.test.ts`
- `backend/test/ai-provider-execution-lease.test.ts`
- `backend/test/ai-provider-execution-attempt.test.ts`
- `backend/test/ai-provider-execution-finalization.test.ts`
- `backend/test/ai-provider-execution-recovery.test.ts`
- `backend/test/ai-provider-execution-reconciliation.test.ts`
- `backend/test/ai-provider-execution-reader.test.ts`
- `backend/test/ai-provider-execution-cli.test.ts`

### Existing tests intentionally updated

- `backend/test/openai-responses-provider.test.ts`
- `backend/test/execute-ai-discovery-provider-run.test.ts`
- `backend/test/execute-ai-discovery-provider-replay-preflight.test.ts`
- `backend/test/execute-policy-governed-ai-discovery-run.test.ts`
- `backend/test/ai-operations-budget.test.ts`
- `backend/test/record-ai-discovery-run.test.ts`
- `backend/test/ai-discovery-automation-tick.test.ts`
- `backend/test/ai-discovery-automation-queue.test.ts`
- `backend/test/ai-operations-reader.test.ts`

---

### Task 0: RED-only Sprint 8E contract baseline

**Files:** Create all nine new backend tests and root contract listed above; modify existing provider/policy tests only to express the approved future API. No production source/migration/workflow/runbook.

**Interfaces:** Tests may import future approved names. RED failures must be missing module/export/schema/workflow capability, not syntax or invalid fixtures.

- [ ] **Step 1: Write migration RED tests.** Assert `0017` will define three tables: `ai_provider_executions`, `ai_provider_execution_attempts`, `ai_provider_execution_reconciliations`; exact execution/attempt statuses `PREPARED|IN_FLIGHT|COMPLETED|FAILED|UNCERTAIN`; reconciliation decisions `CONFIRMED_NOT_RECEIVED|CONFIRMED_RECEIVED|ABANDONED`; ordinal `1..3`; unique execution/run/budget/client-request identity; one active attempt; lease consistency; append-only history; no deletes.

- [ ] **Step 2: Write preparation/lease RED tests.** Import future `prepareAiProviderExecution`, `claimAiProviderExecution`, `markAiProviderAttemptInFlight`; assert replay-first, atomic budget+journal rollback, historical consumed reservation fail-closed, 120-second lease, concurrent single winner, and no provider call before durable `IN_FLIGHT`.

- [ ] **Step 3: Write attempt/finalization RED tests.** Import `executeAiProviderAttempt`, `finalizeAiProviderExecution`, `processAiProviderExecution`; cover completed, 429 retry, attempt-3 429 terminal fail, auth/request/output terminal fail, timeout/transport/408/5xx uncertain, and provider invocation counts.

- [ ] **Step 4: Write recovery/reconciliation RED tests.** Assert expired `PREPARED` lease is safely reclaimed; stale `IN_FLIGHT -> UNCERTAIN`; recovery has no provider dependency; only `CONFIRMED_NOT_RECEIVED` may reopen; attempt 3 cannot create attempt 4; reconciliation immutable.

- [ ] **Step 5: Extend `openai-responses-provider.test.ts` RED expectations.** Outbound header must be `X-Client-Request-Id`; success result separates `providerRequestId` from HTTP `x-request-id` and `providerResponseId` from JSON `id`; HTTP error safely carries server request ID only.

- [ ] **Step 6: Write reader/CLI/security RED tests.** Status/recover/reconcile use DB/operator arguments only, never require `OPENAI_API_KEY`, never trigger provider execution, and never expose raw prompt/output/secret material. Root contract bans downstream authority mutation imports/calls.

- [ ] **Step 7: Run RED verification.**

```bash
npm --prefix backend run typecheck
cd backend && node --import tsx --test --test-concurrency=1 test/ai-provider-execution-*.test.ts test/openai-responses-provider.test.ts
cd .. && npm run test:ai-provider-execution-recovery
```

Expected: FAIL only because approved Sprint 8E artifacts/exports do not yet exist. Fix any syntax/type/fixture failures before proceeding.

- [ ] **Step 8: Commit RED only.**

```bash
git add backend/test tests/ai-provider-execution-recovery-contract.test.mjs
git commit -m "test: define Sprint 8E provider recovery contracts"
```

**Gate:** inspect diff; no `backend/src`, migration, workflow, runbook, or package-script production change in this commit.

---

### Task 1: Durable journal migration and DB transition guards

**Files:** Create `backend/migrations/0017_ai_provider_execution_journal.sql`; modify `backend/test/migration.test.ts` only if its expected migration/table list requires it; primary test `ai-provider-execution-journal-migration.test.ts`.

**Produces:** Durable schema every later task depends on.

- [ ] **Step 1: Run migration RED test alone.**

```bash
cd backend && node --import tsx --test --test-concurrency=1 test/ai-provider-execution-journal-migration.test.ts
```

Expected: FAIL because `0017` is missing.

- [ ] **Step 2: Create `ai_provider_executions`.** Required columns: execution UUID PK; unique `ai_discovery_run_id`; unique FK budget reservation; unique `run_key`; `idempotency_key`; provider/model/model_revision; prompt template key/version; SHA-256 input hash; status; current ordinal `1..3`; lease token/leased_at/expires_at; created/updated/terminal timestamps. Lease fields all-null/all-present and expires > leased.

- [ ] **Step 3: Create `ai_provider_execution_attempts`.** Required: attempt UUID PK, FK execution, ordinal `1..3`, unique client request UUID, status, failure code, provider request/response IDs, output hash, prepared/dispatch/completed timestamps. Unique `(execution_id, ordinal)` plus partial unique index allowing at most one `PREPARED|IN_FLIGHT` attempt.

- [ ] **Step 4: Create append-only reconciliations.** Unique reconciliation per attempt, same-execution FK relationship, decision enum, bounded actor/reason/evidence reference, created timestamp.

- [ ] **Step 5: Add SQL transition guards.** Delete forbidden on all three tables. Execution identity/provider/model/prompt/input/budget/run fields immutable. `COMPLETED`/`FAILED` immutable. Terminal attempts immutable. Reconciliation update/delete forbidden. `UNCERTAIN -> PREPARED` only when current uncertain attempt has `CONFIRMED_NOT_RECEIVED`, ordinal <3, and next attempt exists in same transaction. Reconciled terminal uncertainty cannot reopen.

- [ ] **Step 6: Run migration suite.**

```bash
cd backend && node --import tsx --test --test-concurrency=1 \
  test/ai-provider-execution-journal-migration.test.ts \
  test/migration.test.ts \
  test/ai-operations-migration.test.ts \
  test/ai-discovery-automation-migration.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit.**

```bash
git add backend/migrations/0017_ai_provider_execution_journal.sql backend/test/ai-provider-execution-journal-migration.test.ts backend/test/migration.test.ts
git commit -m "feat: add durable AI provider execution journal"
```

---

### Task 2: Expose transaction-scoped Sprint 8C budget reservation

**Files:** Modify `backend/src/modules/ai-operations/reserve-ai-operations-run-budget.ts`, `backend/test/ai-operations-budget.test.ts`, optionally `ai-discovery-automation-budget.test.ts` for scheduled-floor regression.

**Produces:**

```ts
export async function reserveAiOperationsRunBudgetInTransaction(
  client: PoolClient,
  input: ReserveAiOperationsRunBudgetCommand,
  options: ReserveAiOperationsRunBudgetOptions,
): Promise<ReserveAiOperationsRunBudgetResult>
```

Existing `reserveAiOperationsRunBudget()` and `reserveAiOperationsRunBudgetWithFloor()` keep signatures and wrap this primitive in `withTransaction()`.

- [ ] **Step 1: Add failing tests** proving transaction-scoped reservation participates in caller rollback while wrappers preserve existing replay/error semantics, daily budget, policy interval, scheduled floor, proposal cap snapshot, audit, UUID v4/v5 acceptance.

- [ ] **Step 2: Run RED.**

```bash
cd backend && node --import tsx --test --test-concurrency=1 test/ai-operations-budget.test.ts test/ai-discovery-automation-budget.test.ts
```

Expected: FAIL on missing export.

- [ ] **Step 3: Extract existing transactional body.** Preserve idempotency scope, advisory lock, active policy validation, UTC budget state, existing-run uniqueness, insertion, safe audit, and exact error names. Do not add a second budget table.

- [ ] **Step 4: Run GREEN plus 8C contract.**

```bash
cd backend && node --import tsx --test --test-concurrency=1 test/ai-operations-budget.test.ts test/ai-discovery-automation-budget.test.ts
cd .. && npm run test:ai-operations-policy
```

- [ ] **Step 5: Commit.**

```bash
git add backend/src/modules/ai-operations/reserve-ai-operations-run-budget.ts backend/test/ai-operations-budget.test.ts backend/test/ai-discovery-automation-budget.test.ts
git commit -m "refactor: expose transactional AI operations budget reservation"
```

---

### Task 3: Expose transaction-scoped AI discovery run persistence

**Files:** Modify `backend/src/modules/ai-discovery/record-ai-discovery-run.ts`, `backend/test/record-ai-discovery-run.test.ts`; preserve replay reader semantics.

**Produces:**

```ts
export async function recordAiDiscoveryRunInTransaction(
  client: PoolClient,
  input: RecordAiDiscoveryRunCommand,
): Promise<RecordAiDiscoveryRunResult>
```

Existing `recordAiDiscoveryRun(pool,input)` remains wrapper.

- [ ] **Step 1: Add rollback/atomicity RED test** where caller writes journal finalization after `recordAiDiscoveryRunInTransaction`; induced later error must roll back run, proposals, audit, outbox, and idempotency together.

- [ ] **Step 2: Run RED.**

```bash
cd backend && node --import tsx --test --test-concurrency=1 test/record-ai-discovery-run.test.ts test/read-ai-discovery-run-replay.test.ts
```

- [ ] **Step 3: Extract existing persistence body** preserving run-key advisory lock, idempotency scope `ai.discovery.run.record`, deterministic proposal insertion order, audit, outbox, and result shape.

- [ ] **Step 4: Run GREEN.** Same command; expected PASS.

- [ ] **Step 5: Commit.**

```bash
git add backend/src/modules/ai-discovery/record-ai-discovery-run.ts backend/test/record-ai-discovery-run.test.ts
git commit -m "refactor: expose transactional AI discovery run persistence"
```

---

### Task 4: OpenAI request tracing and one-attempt provider boundary

**Files:** Create `types.ts`, `client-request-id.ts`, `execute-ai-provider-attempt.ts` under `modules/ai-provider-execution`; modify `openai-responses-provider.ts`, `openai-responses-provider.test.ts`, `ai-provider-execution-attempt.test.ts`.

**Interfaces:**

```ts
interface AiDiscoveryProvider {
  readonly providerKey: string;
  execute(request: AiProviderRequest, options: { clientRequestId: string }): Promise<AiProviderResult>;
}

interface AiProviderResult {
  providerRequestId: string | null;   // HTTP x-request-id
  providerResponseId: string | null;  // JSON response.id
  outputText: string;
  proposals: AiProviderProposal[];
}
```

`AiProviderError` gains only safe optional metadata `{ providerRequestId?: string | null }`.

```ts
export function deterministicAiProviderClientRequestId(executionId:string, ordinal:1|2|3): string;
export async function executeAiProviderAttempt(command): Promise<AiProviderAttemptDisposition>;
```

Disposition kind exactly `COMPLETED|SAFE_RETRYABLE|SAFE_TERMINAL|UNCERTAIN`; no loop/sleep.

- [ ] **Step 1: Run provider/attempt RED tests.**

- [ ] **Step 2: Implement deterministic UUIDv5 client ID** from fixed versioned namespace + execution ID + ordinal; test RFC4122 v5 bits, stability, uniqueness by ordinal/execution.

- [ ] **Step 3: Modify OpenAI adapter.** Send `X-Client-Request-Id`; capture HTTP `x-request-id` before status handling; on success set JSON `id` as `providerResponseId`; never reuse it as request ID. Error object may carry server request ID, never body.

- [ ] **Step 4: Implement single-attempt classification.** `429 -> SAFE_RETRYABLE`; 401/403 and deterministic non-408/non-429 4xx and invalid success output/allowlist/proposal cap -> `SAFE_TERMINAL`; timeout/transport/408/5xx -> `UNCERTAIN`; valid response -> `COMPLETED`.

- [ ] **Step 5: Run GREEN.**

```bash
cd backend && node --import tsx --test --test-concurrency=1 test/openai-responses-provider.test.ts test/ai-provider-execution-attempt.test.ts
```

Assert exactly one provider invocation per `executeAiProviderAttempt()` call.

- [ ] **Step 6: Commit.**

```bash
git add backend/src/modules/ai-provider-execution backend/src/modules/ai-provider/openai-responses-provider.ts backend/test/openai-responses-provider.test.ts backend/test/ai-provider-execution-attempt.test.ts
git commit -m "feat: add traceable single-attempt AI provider execution"
```

---

### Task 5: Replay-first atomic prepare + leases + durable IN_FLIGHT

**Files:** Create `prepare-ai-provider-execution.ts`, `claim-ai-provider-execution.ts`, `mark-ai-provider-attempt-in-flight.ts`; tests `preparation` and `lease`.

**Interfaces:**

```ts
prepareAiProviderExecution(pool, command, { minimumIntervalFloorSeconds })
```

returns union:

```ts
{ kind:'REPLAYED'; run: RecordAiDiscoveryRunResult }
{ kind:'PREPARED'; executionId:string; attemptId:string; ordinal:1; clientRequestId:string; reservation:ReserveAiOperationsRunBudgetResult }
{ kind:'EXISTING'; executionId:string; status:AiProviderExecutionStatus; currentAttemptOrdinal:1|2|3 }
```

No provider call.

```ts
claimAiProviderExecution(pool,{executionId,leaseToken,leaseSeconds:120})
markAiProviderAttemptInFlight(pool,{executionId,attemptId,leaseToken})
```

- [ ] **Step 1: Confirm RED tests** for mandatory replay preflight before budget uniqueness, historical consumed reservation fail-closed, atomic budget+execution+attempt rollback, deterministic attempt-1 ID, identity mismatch fail-closed.

- [ ] **Step 2: Implement replay-first ordering.** Normalize input/hash; call `readAiDiscoveryRunReplay()` first. Only if null inspect 8E execution/historical consumed authorization. Completed replay -> zero budget/journal/provider.

- [ ] **Step 3: Implement atomic new prepare.** One `withTransaction`: call transaction-scoped 8C reservation, insert execution `PREPARED`, insert attempt #1 `PREPARED`. Any insert/identity failure rolls all back.

- [ ] **Step 4: Implement lease claim.** DB clock; valid lease blocks competitor; claim only `PREPARED`; token and timestamps persisted consistently.

- [ ] **Step 5: Implement durable in-flight transition.** Transaction verifies lease token + non-expired lease + current attempt; both execution and attempt transition to `IN_FLIGHT` and attempt gets DB `dispatch_started_at` before returning permission to call provider.

- [ ] **Step 6: Run GREEN.**

```bash
cd backend && node --import tsx --test --test-concurrency=1 \
  test/ai-provider-execution-preparation.test.ts \
  test/ai-provider-execution-lease.test.ts \
  test/ai-operations-budget.test.ts \
  test/read-ai-discovery-run-replay.test.ts
```

- [ ] **Step 7: Commit.**

```bash
git add backend/src/modules/ai-provider-execution backend/test/ai-provider-execution-preparation.test.ts backend/test/ai-provider-execution-lease.test.ts
git commit -m "feat: add atomic provider execution preparation and leases"
```

---

### Task 6: Atomic finalization + durable 429 retry orchestration

**Files:** Create `finalize-ai-provider-execution.ts`, `process-ai-provider-execution.ts`; modify `execute-ai-discovery-provider-run.ts`; update provider-run/replay tests and `ai-provider-execution-finalization.test.ts`.

**Interfaces:** `finalizeAiProviderExecution()` owns one transaction for each outcome:

- COMPLETED: `recordAiDiscoveryRunInTransaction` + proposals/audit/outbox/idempotency + attempt/execution `COMPLETED` + tracing IDs/output hash.
- SAFE_TERMINAL: final failed AI run + attempt/execution `FAILED`.
- SAFE_RETRYABLE 429 ordinal <3: current attempt `FAILED`, deterministic next attempt `PREPARED`, increment ordinal, execution `PREPARED`; same reservation; no final AI run.
- 429 ordinal 3: final failed AI run + terminal `FAILED`; no attempt 4.
- UNCERTAIN: attempt/execution `UNCERTAIN`, clear lease, no AI run.

`processAiProviderExecution()` coordinates prepare/existing state -> claim -> durable in-flight -> one attempt -> finalize. It may sleep only after a durable 429 transition, using `[500,1500]`.

- [ ] **Step 1: Run finalization RED tests.** Include injected failure after AI-run insertion but before journal update; transaction must leave neither side committed.

- [ ] **Step 2: Implement completed/safe-terminal atomic finalization.** Verify run/provider/model/prompt/input/output identity before terminal commit.

- [ ] **Step 3: Implement durable 429 retry.** Commit next prepared attempt before sleeping/calling again; preserve lease only if still valid; otherwise next loop must reclaim. No attempt 4.

- [ ] **Step 4: Implement uncertain finalization.** Best-effort persist safe request IDs/failure code, set both states `UNCERTAIN`, clear lease, never synthesize failed AI run.

- [ ] **Step 5: Replace 8B opaque retry loop.** `executeAiDiscoveryProviderRun()` delegates to durable 8E orchestration/compatibility result. Remove process-local `for (attempt < 3)` provider retry ownership.

- [ ] **Step 6: Run GREEN.**

```bash
cd backend && node --import tsx --test --test-concurrency=1 \
  test/ai-provider-execution-finalization.test.ts \
  test/execute-ai-discovery-provider-run.test.ts \
  test/execute-ai-discovery-provider-replay-preflight.test.ts \
  test/openai-responses-provider.test.ts
```

Assertions: 429 provider count <=3; timeout/transport/408/5xx provider count exactly 1.

- [ ] **Step 7: Commit.**

```bash
git add backend/src/modules/ai-provider-execution backend/src/modules/ai-provider/execute-ai-discovery-provider-run.ts backend/test/ai-provider-execution-finalization.test.ts backend/test/execute-ai-discovery-provider-run.test.ts backend/test/execute-ai-discovery-provider-replay-preflight.test.ts
git commit -m "feat: persist provider attempt outcomes durably"
```

---

### Task 7: Fail-closed stale recovery

**Files:** Create `recover-stale-ai-provider-executions.ts`; test `ai-provider-execution-recovery.test.ts`.

**Interface:**

```ts
recoverStaleAiProviderExecutions(
  pool: Pool,
  options?: { limit?: number },
): Promise<{ preparedRecovered:number; inFlightMarkedUncertain:number }>
```

No provider/Redis/config dependency.

- [ ] **Step 1: Run RED.**

- [ ] **Step 2: Implement bounded DB-clock recovery.** Expired `PREPARED`: clear lease, stay prepared. Expired `IN_FLIGHT`: current attempt + execution -> `UNCERTAIN`, clear lease. Never create next attempt/budget/run or call provider.

- [ ] **Step 3: Test concurrency/idempotency.** Two recoverers converge; valid lease ignored; terminal/reconciled rows ignored; default bounded batch.

- [ ] **Step 4: Run GREEN.**

```bash
cd backend && node --import tsx --test --test-concurrency=1 test/ai-provider-execution-recovery.test.ts test/ai-provider-execution-lease.test.ts
```

- [ ] **Step 5: Commit.**

```bash
git add backend/src/modules/ai-provider-execution/recover-stale-ai-provider-executions.ts backend/test/ai-provider-execution-recovery.test.ts
git commit -m "feat: recover stale AI provider executions fail closed"
```

---

### Task 8: Append-only reconciliation + safe status + DB-only CLI

**Files:** Create `reconcile-ai-provider-execution.ts`, `read-ai-provider-execution-status.ts`, `backend/src/ai-provider-execution-cli.ts`; tests reconciliation/reader/cli; modify `backend/package.json`.

**Interfaces:**

```ts
reconcileAiProviderExecution(pool, {
  actorId, correlationId, attemptId,
  decision:'CONFIRMED_NOT_RECEIVED'|'CONFIRMED_RECEIVED'|'ABANDONED',
  reasonCode, evidenceReference
})
```

Rules: target must be current uncertain attempt; one decision only; safe bounded metadata; audit event. `CONFIRMED_NOT_RECEIVED` ordinal <3 atomically inserts reconciliation + next `PREPARED` attempt + execution reopen; ordinal 3 records decision then terminal uncertainty, no attempt 4. Other decisions remain terminal uncertainty.

CLI:

```text
ai-provider-execution status [--execution-id <uuid>|--run-id <uuid>]
ai-provider-execution recover [--limit <n>]
ai-provider-execution reconcile --attempt <uuid> --decision <...> --reason-code <text> --evidence-reference <text>
```

Only `DATABASE_URL` required; no OpenAI config parsing.

- [ ] **Step 1: Run RED tests.**

- [ ] **Step 2: Implement reconciliation transaction and immutable audit.** No force-retry flag.

- [ ] **Step 3: Implement safe status reader.** May return execution/attempt/reconciliation IDs, statuses, timestamps, failure code, `clientRequestId`, `providerRequestId`, `providerResponseId`; no prompt/output/secret.

- [ ] **Step 4: Implement CLI parser/output and backend script.** Add:

```json
"ai-provider-execution": "node dist/src/ai-provider-execution-cli.js"
```

`recover` invokes Task 7 only; `reconcile` records authority only; neither calls provider.

- [ ] **Step 5: Run GREEN/typecheck.**

```bash
cd backend && node --import tsx --test --test-concurrency=1 \
  test/ai-provider-execution-reconciliation.test.ts \
  test/ai-provider-execution-reader.test.ts \
  test/ai-provider-execution-cli.test.ts
cd .. && npm --prefix backend run typecheck
```

- [ ] **Step 6: Commit.**

```bash
git add backend/src/modules/ai-provider-execution backend/src/ai-provider-execution-cli.ts backend/test/ai-provider-execution-*.test.ts backend/package.json
git commit -m "feat: add private provider execution reconciliation authority"
```

---

### Task 9: Integrate policy-governed + scheduled runtime without weakening 8D

**Files:** Modify `execute-policy-governed-ai-discovery-run.ts`, `process-scheduled-ai-discovery-tick.ts`, `ai-discovery-automation-worker.ts`, `ai-automation-worker.ts`; update associated tests.

**Interfaces:** Policy-governed execution routes through 8E and supplies floor `0` for private/manual or `3600` for scheduled. Proposal cap remains tied to the budget reservation snapshot. Scheduled mapping stays: replay/completed -> `COMPLETED`; safe final failed -> `PROVIDER_FAILED`; uncertainty -> `AMBIGUOUS_FAILURE`; policy/cadence outcomes unchanged.

- [ ] **Step 1: Update RED integration tests.** Assert replay before new reservation, scheduled floor exactly 3600, no-new-input zero provider, duplicate job zero second provider, uncertain -> `AMBIGUOUS_FAILURE`, recovery call order.

- [ ] **Step 2: Run RED.**

```bash
cd backend && node --import tsx --test --test-concurrency=1 \
  test/execute-policy-governed-ai-discovery-run.test.ts \
  test/ai-discovery-automation-tick.test.ts \
  test/ai-discovery-automation-queue.test.ts
```

- [ ] **Step 3: Replace old separate reserve-then-provider composition** with replay-first 8E execution while preserving policy error names and proposal cap.

- [ ] **Step 4: Add recovery hooks.** Runtime startup performs one DB-only sweep before scheduler reconciliation/worker processing. Enabled job path sweeps before scheduled processing. Disabled stale job still no-ops before tick/provider and does not require provider secret.

- [ ] **Step 5: Run GREEN + inherited AI contracts.**

```bash
cd backend && node --import tsx --test --test-concurrency=1 \
  test/execute-policy-governed-ai-discovery-run.test.ts \
  test/ai-discovery-automation-tick.test.ts \
  test/ai-discovery-automation-queue.test.ts
cd ..
npm run test:ai-discovery-automation
npm run test:ai-operations-policy
npm run test:ai-provider-execution
npm run test:guarded-ai-discovery
```

Inherited contract edits are allowed only when they encode the intentionally replaced opaque retry loop; preserve the original safety property in narrower 8E-compatible form.

- [ ] **Step 6: Commit.**

```bash
git add backend/src/modules/ai-operations backend/src/modules/ai-automation backend/src/queue/ai-discovery-automation-worker.ts backend/src/ai-automation-worker.ts backend/test
git commit -m "feat: route guarded AI execution through durable recovery authority"
```

---

### Task 10: Snapshot, repository authority contract, scripts, runbook

**Files:** Modify `ai-operations/types.ts`, `read-ai-operations-snapshot.ts`, reader tests; complete root contract; modify root package; create runbook.

**Snapshot field:**

```ts
providerExecution: {
  prepared:number;
  inFlight:number;
  completed:number;
  failed:number;
  uncertain:number;
  stalePrepared:number;
  staleInFlight:number;
  attemptsToday:number;
  safeRetriesToday:number;
  uncertainExecutions:number;
  unreconciledUncertain:number;
  lastExecutionAt:string|null;
}
```

Root script:

```json
"test:ai-provider-execution-recovery": "node --test tests/ai-provider-execution-recovery-contract.test.mjs"
```

Prepend this to root `test` before 8D/8C/8B gates.

- [ ] **Step 1: Run reader/contract RED.**

- [ ] **Step 2: Extend snapshot using aggregate safe SQL only.** `unreconciledUncertain` = uncertain attempts with no reconciliation. No raw data/tracing list in aggregate snapshot.

- [ ] **Step 3: Complete repository contract.** Assert no downstream mutation imports/calls from 8E graph; CLI has no provider secret parse; migration has no raw prompt/output columns; no new public Fastify mutation; scheduler default false; max attempts 3; lease 120; retry class only 429; workflow exists and contains no deploy/provider secret.

- [ ] **Step 4: Write runbook.** Explain states, tracing IDs, stale recovery, all three decisions, why only 429 auto-retries, how to inspect uncertain executions, rollback, and explicit no production activation/deploy/credential in Sprint 8E.

- [ ] **Step 5: Run GREEN.**

```bash
cd backend && node --import tsx --test --test-concurrency=1 test/ai-operations-reader.test.ts test/ai-provider-execution-reader.test.ts
cd .. && npm run test:ai-provider-execution-recovery
```

- [ ] **Step 6: Commit.**

```bash
git add backend/src/modules/ai-operations backend/test/ai-operations-reader.test.ts tests/ai-provider-execution-recovery-contract.test.mjs docs/runbooks/ai-provider-execution-recovery.md package.json
git commit -m "docs: add provider recovery observability and authority contract"
```

---

### Task 11: Dedicated Sprint 8E GitHub Actions gate

**Files:** Create `.github/workflows/sprint-8e-ai-provider-execution-recovery.yml`; update contract only to exact workflow path/name.

**CI:** PostgreSQL 17 + Redis 7. Env only `NODE_ENV=test`, `TEST_DATABASE_URL`, `TEST_REDIS_URL`. No `OPENAI_API_KEY`.

- [ ] **Step 1: Confirm contract RED because workflow missing.**

- [ ] **Step 2: Create workflow patterned on 8D.** `permissions: contents: read`, 45-minute timeout, checkout with `persist-credentials:false`, Node 22.13.0, frontend/backend npm ci.

- [ ] **Step 3: Add ordered steps:**
  1. 8E root contract
  2. backend typecheck
  3. focused `ai-provider-execution-*.test.ts` + `openai-responses-provider.test.ts`
  4. backend full tests
  5. 8D contract
  6. 8C contract
  7. 8B contract
  8. 8A contract
  9. relevant 7A/7B/7C root gates
  10. frontend lint
  11. backend build
  12. repository cleanliness
  13. deployment/secret guard.

- [ ] **Step 4: Add deployment/secret guard** rejecting write permissions, `OPENAI_API_KEY`, Railway deploy, Wrangler deploy, Docker push, kubectl, Terraform, Pulumi, or production scheduler activation command.

- [ ] **Step 5: Run root contract/static inspection.** Expected PASS.

- [ ] **Step 6: Commit.**

```bash
git add .github/workflows/sprint-8e-ai-provider-execution-recovery.yml tests/ai-provider-execution-recovery-contract.test.mjs
git commit -m "ci: add Sprint 8E provider recovery gate"
```

---

### Task 12: Final verification, debugging, code review, draft PR handoff

**Files:** No feature additions unless evidence finds a concrete defect. Behavioral fixes require RED regression first.

- [ ] **Step 1: Fresh focused verification on exact head.**

```bash
npm run test:ai-provider-execution-recovery
npm --prefix backend run typecheck
cd backend && node --import tsx --test --test-concurrency=1 test/ai-provider-execution-*.test.ts test/openai-responses-provider.test.ts
cd ..
```

- [ ] **Step 2: Full inherited AI/backend gates.**

```bash
npm run test:ai-discovery-automation
npm run test:ai-operations-policy
npm run test:ai-provider-execution
npm run test:guarded-ai-discovery
npm --prefix backend test
npm --prefix backend run build
```

- [ ] **Step 3: Release regressions.** Run at minimum `test:post-publication-monitoring`, `test:feedback-intake`, `test:operator-surface`, `test:staging-contract`, `test:release-source`, `test:production-contract`, `test:production-pr-validation`, frontend `lint`, and `build:pages` where CI covers them. Do not deploy.

- [ ] **Step 4: Cleanliness/security.**

```bash
git diff --check
git status --short
```

Re-run source contract proving no forbidden downstream authority imports, no secret/raw persistence, no public mutation, no provider secret in CI.

- [ ] **Step 5: On any failure, invoke `superpowers:systematic-debugging` before patching.** Diagnose first failing step/log. Never loosen a safety test just to make it green.

- [ ] **Step 6: Invoke `superpowers:verification-before-completion`.** Re-run fresh exact-head gates after final fix.

- [ ] **Step 7: Invoke `superpowers:requesting-code-review`.** Review migration transitions, atomicity, crash boundary, retry classification, reconciliation authority, tracing semantics, leak surface, and downstream authority isolation. New behavioral bug -> add RED regression before fix.

- [ ] **Step 8: Open draft PR to `main` only after CI-representative gates pass.** PR body includes exact head SHA, RED-first commit, verification results, non-goals, and explicit scheduler false/no production credential/deploy/activation.

- [ ] **Step 9: STOP.** Do not mark ready, merge, deploy, provision production credentials, or enable scheduler without separate explicit authorization.

---

## Required implementation commit order

1. RED-only tests/contracts.
2. Migration `0017`.
3. Transaction-scoped 8C budget primitive.
4. Transaction-scoped AI-run persistence.
5. OpenAI tracing + single-attempt boundary.
6. Atomic prepare + lease + durable `IN_FLIGHT`.
7. Atomic finalization + safe 429 orchestration.
8. Fail-closed stale recovery.
9. Reconciliation + DB-only CLI.
10. 8C/8D runtime integration.
11. Snapshot + authority contract + runbook/scripts.
12. Dedicated CI.
13. Verification-only fixes if evidence requires them.

## Final Acceptance Checklist

Sprint 8E is ready for review only when exact-head evidence shows:

- one logical run -> exactly one execution journal;
- max three durable attempts;
- replay preflight before new budget/journal preparation;
- budget + first execution/attempt `PREPARED` in one PostgreSQL transaction;
- provider only after durable valid-lease `IN_FLIGHT`;
- success/safe-final-failure AI run + proposals + journal finalization atomic;
- only 429 auto-retries, never beyond attempt 3;
- timeout/transport/408/5xx/crash ambiguity -> `UNCERTAIN`, provider call count 1;
- stale `PREPARED` recoverable; stale `IN_FLIGHT` only becomes `UNCERTAIN`;
- `UNCERTAIN` cannot reopen without append-only `CONFIRMED_NOT_RECEIVED`;
- attempt-3 reconciliation creates no attempt 4;
- `CONFIRMED_RECEIVED`/`ABANDONED` never authorize spend;
- tracing IDs separated correctly and not treated as idempotency;
- status/recover/reconcile require no provider secret and do not call provider;
- no raw prompt/output/API key/Authorization persistence or logs;
- no automatic Candidate/HumanReview/Moderation/Eligibility/Evidence/Publication mutation;
- scheduler default false;
- focused 8E, 8D/8C/8B/8A, backend full test/typecheck/build, authority/security, and release regression gates green;
- draft PR only; no merge/deploy/credential provisioning/scheduler activation.
