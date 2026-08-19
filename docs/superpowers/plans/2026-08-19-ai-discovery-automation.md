# Sprint 8D AI Discovery Automation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add disabled-by-default hourly AI discovery automation that uses BullMQ only for scheduling/delivery, keeps PostgreSQL as scheduling/cost authority, executes only through Sprint 8C policy-governed provider execution, and stops at durable AI proposals.

**Architecture:** A dedicated `ai-automation-worker` process reconciles one BullMQ Job Scheduler (`ai-discovery-hourly-v1`) and consumes a minimal `{schemaVersion:1}` job. The processor claims a unique PostgreSQL UTC-hour tick, builds deterministic structured input from the active patch/catalog and normalized observations, derives a non-circular scheduled-content hash/run identity, then calls the existing Sprint 8C governed executor with a stricter one-hour budget floor. Redis never decides eligibility/cost and the scheduled path never imports Candidate materialization or Publication mutation authorities.

**Tech Stack:** Node.js >=22.13.0, TypeScript 5.9.3, PostgreSQL 17 in CI, BullMQ 5.80.11, ioredis 5.11.1, `node:test`, existing Fastify/backend package.

**Spec:** `docs/superpowers/specs/2026-08-19-ai-discovery-automation-design.md`

## Global Constraints

- Scheduler cadence is exactly one hour; dynamic cadence configuration is out of scope.
- Scheduler identity is exactly `ai-discovery-hourly-v1`.
- Redis job payload is exactly `{ "schemaVersion": 1 }`; no observation, prompt, provider, secret, catalog, Candidate, Evidence, or Publication payloads.
- BullMQ scheduled jobs use `attempts: 1`; Sprint 8B remains the only bounded provider retry owner.
- `AI_DISCOVERY_SCHEDULER_ENABLED` defaults to `false` and accepts only exact `true` / `false` strings.
- Disabled scheduler configuration must not require OpenAI credentials.
- Enabled scheduler configuration must fail closed if provider configuration is invalid.
- PostgreSQL clock owns UTC-hour identity and provider budget timing.
- Scheduled minimum provider-attempt interval is `max(activePolicy.minIntervalSeconds, 3600)`.
- AI discovery scope remains exactly `aram_mayhem`.
- Input uses only the active patch, exact active catalog revision, and normalized stored observations; `ai_generated` provenance is excluded.
- Initial input caps are 8 subjects and 4 normalized observations per subject.
- Scheduled content hash excludes `runKey`; Sprint 8B full provider-input hashing remains unchanged.
- A content hash with an existing durable Sprint 8C budget reservation is consumed and must not auto-run again.
- Content previously blocked before reservation may be retried by a later hourly tick.
- Core API/core worker must not require provider credentials.
- Scheduled execution must not import/call `materializeAiCandidateProposal()`, Human Review mutation, Moderation mutation, Eligibility mutation, or Publication mutation.
- No production deployment, production credential provisioning, or production scheduler activation is part of this plan.
- CI uses fake/injected providers and performs zero real OpenAI requests.

## File Structure

### New files

- `backend/migrations/0016_ai_discovery_automation.sql` — durable UTC-hour scheduled tick ledger.
- `backend/src/modules/ai-automation/types.ts` — automation tick/content/result types.
- `backend/src/modules/ai-automation/scheduled-run-identity.ts` — canonical scheduled-content hash and deterministic UUID/run keys.
- `backend/src/modules/ai-automation/build-scheduled-ai-discovery-input.ts` — read-only active-catalog/normalized-observation input builder.
- `backend/src/modules/ai-automation/process-scheduled-ai-discovery-tick.ts` — tick claim, no-new-input gate, governed execution, terminal outcome mapping.
- `backend/src/queue/ai-discovery-scheduler.ts` — BullMQ scheduler desired-state reconciliation.
- `backend/src/queue/ai-discovery-automation-worker.ts` — minimal-payload queue consumer with `attempts: 1` semantics and disabled no-op guard.
- `backend/src/ai-automation-config.ts` — automation-only scheduler/provider configuration parser.
- `backend/src/ai-automation-worker.ts` — dedicated process entrypoint and shutdown lifecycle.
- `backend/src/ai-automation-status-cli.ts` — private read-only scheduler/database status command.
- `backend/test/ai-discovery-automation-migration.test.ts` — migration/schema/immutability contract.
- `backend/test/ai-discovery-automation-budget.test.ts` — scheduled one-hour floor and reason mapping.
- `backend/test/ai-discovery-automation-input.test.ts` — deterministic input/ranking/serialization/hash tests.
- `backend/test/ai-discovery-automation-tick.test.ts` — tick concurrency, consumed-input, crash/replay safety.
- `backend/test/ai-discovery-automation-queue.test.ts` — scheduler/worker/config/minimal payload tests.
- `backend/test/ai-discovery-automation-reader.test.ts` — safe snapshot metadata/counters.
- `tests/ai-discovery-automation-contract.test.mjs` — repository authority/security/packaging contract.
- `docs/runbooks/ai-discovery-automation.md` — private operations/rollback/status procedure.
- `.github/workflows/sprint-8d-ai-discovery-automation.yml` — dedicated 8D gate.

### Existing files to modify

- `backend/src/modules/ai-operations/types.ts` — add internal reservation floor/outcome typing and automation snapshot shape.
- `backend/src/modules/ai-operations/reserve-ai-operations-run-budget.ts` — extract shared atomic reservation primitive while preserving current manual behavior.
- `backend/src/modules/ai-operations/execute-policy-governed-ai-discovery-run.ts` — keep dependency injection compatible with scheduled reservation wrapper.
- `backend/src/modules/ai-operations/read-ai-operations-snapshot.ts` — add safe automation section/counters.
- `backend/src/queue/names.ts` — add AI automation queue name/data type.
- `backend/package.json` — add `start:ai-automation` and `ai-automation:status` scripts.
- `package.json` — add `test:ai-discovery-automation` to repository test chain.
- `backend/test/migration.test.ts` — include the new table in the expected migration schema.

---

### Task 1: Add the durable scheduled tick ledger

**Files:**
- Create: `backend/migrations/0016_ai_discovery_automation.sql`
- Create: `backend/test/ai-discovery-automation-migration.test.ts`
- Modify: `backend/test/migration.test.ts`

**Interfaces:**
- Produces table `scheduled_ai_discovery_ticks` with unique `(scheduler_key, utc_hour)` and one non-terminal state `PROCESSING`.
- Later tasks rely on columns `scheduled_ai_discovery_tick_id`, `scheduler_key`, `utc_hour`, `status`, `scheduled_content_hash`, `ai_discovery_run_id`, `ai_operations_policy_revision_id`, `ai_operations_run_budget_reservation_id`, `created_at`, `completed_at`.

- [ ] **Step 1: Write failing migration tests**

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { resetDatabase } from './helpers/database.js';

test('0016 creates one immutable scheduled tick per scheduler UTC hour', async () => {
  const pool = await resetDatabase();
  const columns = await pool.query(`select column_name from information_schema.columns where table_name = 'scheduled_ai_discovery_ticks' order by ordinal_position`);
  assert.deepEqual(columns.rows.map((row) => row.column_name), [
    'scheduled_ai_discovery_tick_id','scheduler_key','utc_hour','status',
    'scheduled_content_hash','ai_discovery_run_id','ai_operations_policy_revision_id',
    'ai_operations_run_budget_reservation_id','created_at','completed_at',
  ]);
  await pool.end();
});
```

Add tests that duplicate `(scheduler_key, utc_hour)` fails, invalid status fails, and update/delete is rejected.

- [ ] **Step 2: Run the migration tests and verify RED**

Run: `cd backend && node --import tsx --test --test-concurrency=1 test/ai-discovery-automation-migration.test.ts`

Expected: FAIL because migration/table does not exist.

- [ ] **Step 3: Implement migration 0016**

```sql
create table scheduled_ai_discovery_ticks (
  scheduled_ai_discovery_tick_id uuid primary key,
  scheduler_key text not null check (scheduler_key = 'ai-discovery-hourly-v1'),
  utc_hour timestamptz not null,
  status text not null check (status in (
    'PROCESSING','NO_NEW_INPUT','CADENCE_NOT_ELAPSED','POLICY_DISABLED',
    'DAILY_BUDGET_EXHAUSTED','POLICY_MIN_INTERVAL','COMPLETED',
    'PROVIDER_FAILED','AMBIGUOUS_FAILURE'
  )),
  scheduled_content_hash text check (scheduled_content_hash is null or scheduled_content_hash ~ '^[a-f0-9]{64}$'),
  ai_discovery_run_id uuid,
  ai_operations_policy_revision_id uuid references ai_operations_policy_revisions(ai_operations_policy_revision_id),
  ai_operations_run_budget_reservation_id uuid references ai_operations_run_budget_reservations(ai_operations_run_budget_reservation_id),
  created_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz,
  unique (scheduler_key, utc_hour),
  check (date_trunc('hour', utc_hour) = utc_hour),
  check ((status = 'PROCESSING' and completed_at is null) or (status <> 'PROCESSING' and completed_at is not null))
);

create index scheduled_ai_discovery_ticks_recent_idx
  on scheduled_ai_discovery_ticks (utc_hour desc, scheduled_ai_discovery_tick_id);

create trigger scheduled_ai_discovery_ticks_immutable_terminal
before update or delete on scheduled_ai_discovery_ticks
for each row execute function reject_terminal_scheduled_ai_tick_change();
```

Implement the trigger function so only `PROCESSING -> terminal` may update safe metadata once; terminal rows cannot change/delete.

- [ ] **Step 4: Update the inherited migration table expectation**

Add `scheduled_ai_discovery_ticks` to `backend/test/migration.test.ts` without changing unrelated expected tables.

- [ ] **Step 5: Run migration tests GREEN**

Run: `cd backend && node --import tsx --test --test-concurrency=1 test/ai-discovery-automation-migration.test.ts test/migration.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit Task 1**

```bash
git add backend/migrations/0016_ai_discovery_automation.sql backend/test/ai-discovery-automation-migration.test.ts backend/test/migration.test.ts
git commit -m "feat: add durable AI automation tick ledger"
```

### Task 2: Refactor Sprint 8C budget reservation to support a scheduled interval floor

**Files:**
- Modify: `backend/src/modules/ai-operations/types.ts`
- Modify: `backend/src/modules/ai-operations/reserve-ai-operations-run-budget.ts`
- Create: `backend/test/ai-discovery-automation-budget.test.ts`
- Test: `backend/test/ai-operations-budget.test.ts`

**Interfaces:**
- Preserve `reserveAiOperationsRunBudget(pool, command)` behavior exactly for manual/private 8C callers.
- Produce `reserveAiOperationsRunBudgetWithFloor(pool, command, { minimumIntervalFloorSeconds })`.
- Scheduled denial code must distinguish `AI_OPERATIONS_MIN_INTERVAL_NOT_ELAPSED` from `AI_OPERATIONS_SCHEDULED_CADENCE_NOT_ELAPSED`.

- [ ] **Step 1: Write failing scheduled-floor tests**

```ts
await activateEnabledPolicy(pool, { maxRunsPerUtcDay: 8, minIntervalSeconds: 0 });
await reserveAiOperationsRunBudget(pool, reserveCommand());
await assert.rejects(
  reserveAiOperationsRunBudgetWithFloor(pool, reserveCommand(), { minimumIntervalFloorSeconds: 3600 }),
  /AI_OPERATIONS_SCHEDULED_CADENCE_NOT_ELAPSED/,
);
```

Also test policy interval 7200 returns `AI_OPERATIONS_MIN_INTERVAL_NOT_ELAPSED`, and two concurrent scheduled reservations cannot bypass the shared advisory lock.

- [ ] **Step 2: Verify RED**

Run: `cd backend && node --import tsx --test --test-concurrency=1 test/ai-discovery-automation-budget.test.ts`

Expected: FAIL because the floor-aware function is absent.

- [ ] **Step 3: Extract the private shared reservation primitive**

```ts
interface ReserveBudgetOptions {
  minimumIntervalFloorSeconds: number;
}

export async function reserveAiOperationsRunBudgetWithFloor(
  pool: Pool,
  input: ReserveAiOperationsRunBudgetCommand,
  options: ReserveBudgetOptions,
): Promise<ReserveAiOperationsRunBudgetResult> {
  // normalize input, begin idempotency, acquire the existing
  // ai_operations_provider_budget:v1 advisory lock, load policy,
  // check daily budget and both interval boundaries, insert the same ledger row.
}

export async function reserveAiOperationsRunBudget(pool: Pool, input: ReserveAiOperationsRunBudgetCommand) {
  return reserveAiOperationsRunBudgetWithFloor(pool, input, { minimumIntervalFloorSeconds: 0 });
}
```

Inside the same transaction, compare `secondsSinceLast` first with `policy.min_interval_seconds`, then with `Math.max(policy.min_interval_seconds, floor)` so reason mapping remains deterministic.

- [ ] **Step 4: Run new and inherited budget tests**

Run: `cd backend && node --import tsx --test --test-concurrency=1 test/ai-discovery-automation-budget.test.ts test/ai-operations-budget.test.ts test/execute-policy-governed-ai-discovery-run.test.ts`

Expected: PASS with no behavior change to existing 8C callers.

- [ ] **Step 5: Commit Task 2**

```bash
git add backend/src/modules/ai-operations/types.ts backend/src/modules/ai-operations/reserve-ai-operations-run-budget.ts backend/test/ai-discovery-automation-budget.test.ts
git commit -m "refactor: add scheduled AI budget interval floor"
```

### Task 3: Build deterministic scheduled content and run identity

**Files:**
- Create: `backend/src/modules/ai-automation/types.ts`
- Create: `backend/src/modules/ai-automation/build-scheduled-ai-discovery-input.ts`
- Create: `backend/src/modules/ai-automation/scheduled-run-identity.ts`
- Create: `backend/test/ai-discovery-automation-input.test.ts`

**Interfaces:**
- Produce `buildScheduledAiDiscoveryInput(pool): Promise<ScheduledAiDiscoveryContentV1 | null>`.
- Produce `hashScheduledAiDiscoveryContent(content): string`.
- Produce `deriveScheduledAiDiscoveryIdentity(hash)` returning `{ runKey, idempotencyKey, aiDiscoveryRunId }`.

- [ ] **Step 1: Write failing input-builder tests using database fixtures**

```ts
const content = await buildScheduledAiDiscoveryInput(pool);
assert.equal(content?.gameModeExternalId, 'aram_mayhem');
assert.ok((content?.subjects.length ?? 0) <= 8);
assert.ok(content?.subjects.every((subject) => subject.observations.length <= 4));
assert.ok(content?.subjects.every((subject) =>
  subject.observations.every((text) => !text.includes('http://') && !text.includes('https://'))
));
```

Seed eligible `collector_detected`, `community_submitted`, `editorial`, and `ai_generated` provenance and assert `ai_generated` never appears. Add deterministic timestamp/UUID tie-break cases and catalog mismatch cases.

- [ ] **Step 2: Verify RED**

Run: `cd backend && node --import tsx --test --test-concurrency=1 test/ai-discovery-automation-input.test.ts`

Expected: FAIL because builder/identity modules do not exist.

- [ ] **Step 3: Implement deterministic database selection and structured serialization**

```ts
export interface ScheduledAiDiscoveryContentV1 {
  patchKey: string;
  gameModeExternalId: 'aram_mayhem';
  subjects: Array<{
    subjectExternalId: string;
    allowedAugmentExternalIds: string[];
    allowedItemExternalIds: string[];
    observations: string[];
  }>;
}

function serializeObservation(origin: AllowedOrigin, payload: CandidateSelectionPayloadV1): string {
  return JSON.stringify({
    schemaVersion: 1,
    origin,
    augmentExternalIds: payload.augmentExternalIds,
    itemExternalIds: payload.itemExternalIds,
  });
}
```

Query exactly one active `aram_mayhem` catalog authority; fail closed if zero or multiple active authorities. Join `normalized_observations -> candidate_provenance -> game_entity_revisions -> game_entities`, exclude `ai_generated`, rank subjects by newest eligible observation descending then ASCII subject ID, rank observations by `created_at desc, normalized_observation_id asc`, select 8×4, and revalidate selected IDs against the exact catalog before forming allow-lists.

- [ ] **Step 4: Implement non-circular hash and deterministic UUID**

```ts
export function hashScheduledAiDiscoveryContent(content: ScheduledAiDiscoveryContentV1): string {
  return hashCanonicalJson(content);
}

export function deriveScheduledAiDiscoveryIdentity(scheduledContentHash: string) {
  return {
    runKey: `scheduled:v1:${scheduledContentHash}`,
    idempotencyKey: `ai-discovery-scheduled:v1:${scheduledContentHash}`,
    aiDiscoveryRunId: deterministicUuid(SPRINT_8D_NAMESPACE, scheduledContentHash),
  };
}
```

Implement `deterministicUuid()` locally with Node `createHash`, fixed versioned namespace bytes, RFC UUID variant/version bits, and tests that same hash => same UUID while changed hash => changed UUID.

- [ ] **Step 5: Normalize the final provider input through Sprint 8B validation**

```ts
const input = normalizeAiProviderExecutionInput({
  ...content,
  runKey: identity.runKey,
});
```

If a structured observation fails Sprint 8B observation validation, skip that observation; do not truncate it.

- [ ] **Step 6: Run Task 3 tests GREEN**

Run: `cd backend && node --import tsx --test --test-concurrency=1 test/ai-discovery-automation-input.test.ts test/ai-provider-normalization.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit Task 3**

```bash
git add backend/src/modules/ai-automation backend/test/ai-discovery-automation-input.test.ts
git commit -m "feat: build deterministic scheduled AI discovery input"
```

### Task 4: Add PostgreSQL-owned scheduled tick execution

**Files:**
- Create: `backend/src/modules/ai-automation/process-scheduled-ai-discovery-tick.ts`
- Modify: `backend/src/modules/ai-operations/execute-policy-governed-ai-discovery-run.ts`
- Create: `backend/test/ai-discovery-automation-tick.test.ts`

**Interfaces:**
- Produce `processScheduledAiDiscoveryTick(pool, command, dependencies): Promise<ScheduledAiDiscoveryTickResult>`.
- `command` contains only actor/correlation/provider/model metadata; no Redis-derived hour/input payload.
- Dependency injection includes `buildInput`, `reserveBudget`, and `executeGovernedRun` for fake-provider tests.

- [ ] **Step 1: Write failing concurrency/no-new-input tests**

```ts
const outcomes = await Promise.all([
  processScheduledAiDiscoveryTick(pool, command, deps),
  processScheduledAiDiscoveryTick(pool, command, deps),
]);
assert.equal(outcomes.filter((x) => x.owner).length, 1);
assert.equal(providerCalls, 1);
```

Add tests for PostgreSQL UTC hour, `PROCESSING` first state, deterministic run ID written before provider orchestration, prior consumed hash => `NO_NEW_INPUT`, prior policy-blocked hash => later eligible, provider failure => `PROVIDER_FAILED`, and crash after reservation remains discoverable through `ai_discovery_run_id` join.

- [ ] **Step 2: Verify RED**

Run: `cd backend && node --import tsx --test --test-concurrency=1 test/ai-discovery-automation-tick.test.ts`

Expected: FAIL because tick processor is absent.

- [ ] **Step 3: Implement atomic tick claim using PostgreSQL clock**

```sql
insert into scheduled_ai_discovery_ticks
  (scheduled_ai_discovery_tick_id, scheduler_key, utc_hour, status)
values
  ($1, 'ai-discovery-hourly-v1', date_trunc('hour', clock_timestamp()), 'PROCESSING')
on conflict (scheduler_key, utc_hour) do nothing
returning scheduled_ai_discovery_tick_id, utc_hour;
```

If insert returns zero rows, return duplicate/no-op before building input or touching provider execution.

- [ ] **Step 4: Implement consumed-input gate and deterministic identity persistence**

```sql
select 1
  from scheduled_ai_discovery_ticks tick
  join ai_operations_run_budget_reservations reservation
    on reservation.ai_discovery_run_id = tick.ai_discovery_run_id
 where tick.scheduled_content_hash = $1
 limit 1;
```

Persist `scheduled_content_hash` and deterministic `ai_discovery_run_id` on the owned `PROCESSING` tick before calling governed execution.

- [ ] **Step 5: Inject the 3600-second floor through the existing governed executor**

Use the existing `reserveBudget` dependency point:

```ts
const result = await executePolicyGovernedAiDiscoveryRun(pool, command, {
  reserveBudget: (pool, budgetCommand) =>
    reserveAiOperationsRunBudgetWithFloor(pool, budgetCommand, { minimumIntervalFloorSeconds: 3600 }),
});
```

Map exact budget errors to `POLICY_DISABLED`, `DAILY_BUDGET_EXHAUSTED`, `POLICY_MIN_INTERVAL`, `CADENCE_NOT_ELAPSED` with zero provider calls.

- [ ] **Step 6: Finalize the tick with safe metadata only**

```sql
update scheduled_ai_discovery_ticks
   set status = $2,
       ai_operations_policy_revision_id = $3,
       ai_operations_run_budget_reservation_id = $4,
       completed_at = clock_timestamp()
 where scheduled_ai_discovery_tick_id = $1
   and status = 'PROCESSING';
```

Do not persist provider request/response, structured observation strings, prompts, proposal rationale, or secrets.

- [ ] **Step 7: Run Task 4 plus inherited 8B/8C execution tests**

Run: `cd backend && node --import tsx --test --test-concurrency=1 test/ai-discovery-automation-tick.test.ts test/execute-policy-governed-ai-discovery-run.test.ts test/execute-ai-discovery-provider-run.test.ts`

Expected: PASS.

- [ ] **Step 8: Commit Task 4**

```bash
git add backend/src/modules/ai-automation/process-scheduled-ai-discovery-tick.ts backend/src/modules/ai-operations/execute-policy-governed-ai-discovery-run.ts backend/test/ai-discovery-automation-tick.test.ts
git commit -m "feat: execute guarded scheduled AI discovery ticks"
```

### Task 5: Add BullMQ scheduler reconciliation, queue consumer, and automation-only config

**Files:**
- Modify: `backend/src/queue/names.ts`
- Create: `backend/src/queue/ai-discovery-scheduler.ts`
- Create: `backend/src/queue/ai-discovery-automation-worker.ts`
- Create: `backend/src/ai-automation-config.ts`
- Create: `backend/test/ai-discovery-automation-queue.test.ts`

**Interfaces:**
- `AI_DISCOVERY_AUTOMATION_QUEUE_NAME = 'hai-dau-ai-discovery-automation-v1'`.
- `AI_DISCOVERY_SCHEDULER_ID = 'ai-discovery-hourly-v1'`.
- `reconcileAiDiscoveryScheduler(queue, enabled)` upserts/removes desired state.
- `createAiDiscoveryAutomationWorker(...)` uses concurrency 1 and validates exact minimal job data.

- [ ] **Step 1: Write failing scheduler/config/worker tests**

```ts
assert.deepEqual(parseAiAutomationConfig({ DATABASE_URL:'postgres://x', REDIS_URL:'redis://x' }), {
  databaseUrl: 'postgres://x',
  redisUrl: 'redis://x',
  schedulerEnabled: false,
});
```

Add fake queue tests asserting enabled calls `upsertJobScheduler('ai-discovery-hourly-v1', { every: 3_600_000 }, ...)`, disabled calls `removeJobScheduler`, repeated reconciliation is idempotent, template data is exactly `{schemaVersion:1}`, and worker options imply one attempt/no BullMQ retry.

- [ ] **Step 2: Verify RED**

Run: `cd backend && node --import tsx --test --test-concurrency=1 test/ai-discovery-automation-queue.test.ts`

Expected: FAIL because scheduler/config/worker modules are absent.

- [ ] **Step 3: Implement exact configuration parsing**

```ts
export interface AiAutomationConfig {
  databaseUrl: string;
  redisUrl: string;
  schedulerEnabled: boolean;
  provider?: 'openai';
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
  endpoint?: string;
}
```

When disabled, require only `DATABASE_URL` and `REDIS_URL`. When enabled, reuse the same provider restrictions as `parseAiDiscoveryRunCliConfig`, including production endpoint prohibition.

- [ ] **Step 4: Implement desired-state reconciliation**

```ts
await queue.upsertJobScheduler(
  AI_DISCOVERY_SCHEDULER_ID,
  { every: 3_600_000 },
  { name: 'scheduled-ai-discovery', data: { schemaVersion: 1 }, opts: { attempts: 1 } },
);
```

Disabled path must call `removeJobScheduler(AI_DISCOVERY_SCHEDULER_ID)`.

- [ ] **Step 5: Implement stale-job disabled no-op guard before tick creation**

```ts
if (!schedulerEnabled) return { outcome: 'SCHEDULER_DISABLED' as const };
if (!isExactJobData(job.data)) throw new Error('AI_AUTOMATION_JOB_INVALID');
return processScheduledAiDiscoveryTick(pool, command, dependencies);
```

Worker concurrency is `1`. Do not import materialization/publication modules.

- [ ] **Step 6: Run Task 5 GREEN**

Run: `cd backend && node --import tsx --test --test-concurrency=1 test/ai-discovery-automation-queue.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit Task 5**

```bash
git add backend/src/queue/names.ts backend/src/queue/ai-discovery-scheduler.ts backend/src/queue/ai-discovery-automation-worker.ts backend/src/ai-automation-config.ts backend/test/ai-discovery-automation-queue.test.ts
git commit -m "feat: add private hourly AI automation queue"
```

### Task 6: Add the dedicated AI automation process lifecycle

**Files:**
- Create: `backend/src/ai-automation-worker.ts`
- Modify: `backend/package.json`
- Test: `backend/test/ai-discovery-automation-queue.test.ts`

**Interfaces:**
- New process script `npm --prefix backend run start:ai-automation` -> `node dist/src/ai-automation-worker.js`.
- Public API `start` and core `start:worker` remain unchanged and provider-secret-free.

- [ ] **Step 1: Add a failing lifecycle contract test**

Assert package scripts contain `start:ai-automation` and that `backend/src/worker.ts` is not modified to import OpenAI/provider modules.

- [ ] **Step 2: Implement the process entrypoint**

```ts
const config = parseAiAutomationConfig(process.env);
const pool = createPool(config.databaseUrl);
const queueConnection = createQueueConnection(config.redisUrl);
const workerConnection = createWorkerConnection(config.redisUrl);
const queue = new Queue(AI_DISCOVERY_AUTOMATION_QUEUE_NAME, { connection: queueConnection });
await reconcileAiDiscoveryScheduler(queue, config.schedulerEnabled);
const worker = createAiDiscoveryAutomationWorker({ pool, connection: workerConnection, config });
```

Build the provider only when `schedulerEnabled === true`. On SIGINT/SIGTERM close worker, queue, Redis connections, and pool. Sanitize startup/shutdown errors to stable codes.

- [ ] **Step 3: Add package script**

```json
"start:ai-automation": "node dist/src/ai-automation-worker.js"
```

- [ ] **Step 4: Run typecheck/build and lifecycle tests**

Run: `npm --prefix backend run typecheck && npm --prefix backend run build && cd backend && node --import tsx --test --test-concurrency=1 test/ai-discovery-automation-queue.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit Task 6**

```bash
git add backend/src/ai-automation-worker.ts backend/package.json backend/test/ai-discovery-automation-queue.test.ts
git commit -m "feat: add dedicated AI automation runtime"
```

### Task 7: Extend safe read-only observability and private status inspection

**Files:**
- Modify: `backend/src/modules/ai-operations/types.ts`
- Modify: `backend/src/modules/ai-operations/read-ai-operations-snapshot.ts`
- Create: `backend/src/ai-automation-status-cli.ts`
- Modify: `backend/package.json`
- Create: `backend/test/ai-discovery-automation-reader.test.ts`

**Interfaces:**
- `AiOperationsSnapshot.automation` exposes only safe IDs/hashes/timestamps/outcomes/counters.
- Private `ai-automation:status` compares configured desired state with BullMQ Job Scheduler inventory without mutation.

- [ ] **Step 1: Write failing reader/status tests**

```ts
const snapshot = await readAiOperationsSnapshot(pool);
assert.deepEqual(Object.keys(snapshot.automation).sort(), [
  'counters','lastAiDiscoveryRunId','lastBudgetReservedAt','lastCompletedAt',
  'lastOutcome','lastScheduledContentHash',
].sort());
assert.doesNotMatch(JSON.stringify(snapshot), /api[_-]?key|authorization|observations|prompt|response/iu);
```

- [ ] **Step 2: Verify RED**

Run: `cd backend && node --import tsx --test --test-concurrency=1 test/ai-discovery-automation-reader.test.ts`

Expected: FAIL because automation snapshot/status command is absent.

- [ ] **Step 3: Extend snapshot queries with bounded durable metadata**

Use `scheduled_ai_discovery_ticks` for last terminal tick and bounded recent counters, and join budget reservation only for `reserved_at`; never select structured input/provider payload columns because none are persisted in the tick ledger.

- [ ] **Step 4: Add read-only status CLI**

```ts
const schedulers = await queue.getJobSchedulers(0, 20, true);
const actual = schedulers.find((entry) => entry.key === AI_DISCOVERY_SCHEDULER_ID) ?? null;
process.stdout.write(JSON.stringify({ desiredEnabled: config.schedulerEnabled, scheduler: sanitize(actual), database: snapshot.automation }) + '\n');
```

The CLI must never call `upsertJobScheduler`, `removeJobScheduler`, provider execution, materialization, or publication.

- [ ] **Step 5: Add package script and run tests**

```json
"ai-automation:status": "node dist/src/ai-automation-status-cli.js"
```

Run: `cd backend && node --import tsx --test --test-concurrency=1 test/ai-discovery-automation-reader.test.ts test/ai-operations-reader.test.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 6: Commit Task 7**

```bash
git add backend/src/modules/ai-operations backend/src/ai-automation-status-cli.ts backend/package.json backend/test/ai-discovery-automation-reader.test.ts
git commit -m "feat: expose safe AI automation operations status"
```

### Task 8: Add repository authority/security contract and runbook

**Files:**
- Create: `tests/ai-discovery-automation-contract.test.mjs`
- Modify: `package.json`
- Create: `docs/runbooks/ai-discovery-automation.md`

**Interfaces:**
- Repository contract statically guards scope/packaging boundaries.
- Runbook documents disabled-default startup, status checks, later activation prerequisites, and rollback only; it does not perform deployment.

- [ ] **Step 1: Write failing repository contract**

```js
test('scheduled automation cannot import Candidate materialization or Publication mutation', async () => {
  const files = await readAutomationSources();
  const text = files.join('\n');
  assert.doesNotMatch(text, /materializeAiCandidateProposal|createPublication|activatePublication|completeHumanReview/);
});
```

Also assert queue payload schema/version, scheduler constant, `AI_DISCOVERY_SCHEDULER_ENABLED=false` default behavior, dedicated process script, and absence of production deploy/secret commands.

- [ ] **Step 2: Verify RED**

Run: `node --test tests/ai-discovery-automation-contract.test.mjs`

Expected: FAIL before root script/runbook/workflow are wired.

- [ ] **Step 3: Add root test script**

```json
"test:ai-discovery-automation": "node --test tests/ai-discovery-automation-contract.test.mjs"
```

Prepend it to the root `test` chain without removing inherited gates.

- [ ] **Step 4: Write the operations runbook**

Document exact commands:

```bash
AI_DISCOVERY_SCHEDULER_ENABLED=false npm --prefix backend run start:ai-automation
npm --prefix backend run ai-automation:status
```

Document later activation sequence as requiring separate authorization, and rollback as set false -> restart/reconcile -> status verify scheduler absent -> leave PostgreSQL history intact.

- [ ] **Step 5: Run contract GREEN**

Run: `npm run test:ai-discovery-automation`

Expected: PASS.

- [ ] **Step 6: Commit Task 8**

```bash
git add tests/ai-discovery-automation-contract.test.mjs package.json docs/runbooks/ai-discovery-automation.md
git commit -m "test: lock Sprint 8D automation authority boundaries"
```

### Task 9: Add the dedicated Sprint 8D GitHub Actions gate

**Files:**
- Create: `.github/workflows/sprint-8d-ai-discovery-automation.yml`

**Interfaces:**
- Workflow uses PostgreSQL 17 + Redis 7, Node 22.13.0, fake providers only, read-only GitHub permissions.
- No production deploy/credential action.

- [ ] **Step 1: Create the workflow with exact path filters**

Include `backend/migrations/0016_ai_discovery_automation.sql`, `backend/src/modules/ai-automation/**`, `backend/src/queue/ai-discovery-*`, `backend/src/ai-automation-*`, AI operations files touched by 8D, 8D tests, root contract, runbook/spec/plan, package files, and the workflow itself.

- [ ] **Step 2: Add focused gate commands**

```yaml
- name: Sprint 8D repository contract
  run: npm run test:ai-discovery-automation
- name: Backend typecheck
  run: npm --prefix backend run typecheck
- name: Sprint 8D backend tests
  run: cd backend && node --import tsx --test --test-concurrency=1 test/ai-discovery-automation-*.test.ts
- name: Backend tests
  run: npm --prefix backend test
- name: Sprint 8C repository contract
  run: npm run test:ai-operations-policy
- name: Sprint 8B repository contract
  run: npm run test:ai-provider-execution
- name: Sprint 8A authority contract
  run: npm run test:guarded-ai-discovery
- name: Frontend lint
  run: npm run lint
- name: Backend build
  run: npm --prefix backend run build
```

- [ ] **Step 3: Add cleanliness/deployment/secret guards copied from the established 8C pattern**

Ensure permissions remain `contents: read`; forbid deploy commands and production secret names. Do not add `OPENAI_API_KEY` to workflow env.

- [ ] **Step 4: Validate workflow text locally/repository contract**

Run: `npm run test:ai-discovery-automation && git diff --check`

Expected: PASS.

- [ ] **Step 5: Commit Task 9**

```bash
git add .github/workflows/sprint-8d-ai-discovery-automation.yml
git commit -m "ci: add Sprint 8D AI automation gate"
```

### Task 10: Full regression, exact-head verification, and PR handoff

**Files:**
- No production code changes unless a regression exposes a real defect covered by the approved spec.

**Interfaces:**
- Produces an exact feature-head SHA with all 8D and inherited gates green before PR review.

- [ ] **Step 1: Run focused 8D checks**

```bash
npm run test:ai-discovery-automation
npm --prefix backend run typecheck
cd backend && node --import tsx --test --test-concurrency=1 test/ai-discovery-automation-*.test.ts
```

- [ ] **Step 2: Run inherited 8A/8B/8C regressions**

```bash
npm run test:guarded-ai-discovery
npm run test:ai-provider-execution
npm run test:ai-operations-policy
npm --prefix backend test
```

- [ ] **Step 3: Run build/lint/cleanliness checks**

```bash
npm --prefix backend run build
npm run lint
git diff --check
git status --short
```

Expected: all commands PASS and `git status --short` empty.

- [ ] **Step 4: Verify authority isolation manually from the final diff**

Check that the scheduled path contains no imports/calls to Candidate materialization, Human Review mutation, Moderation, Eligibility, Publication mutation, or Evidence mutation; Redis job data remains exact minimal schema; provider credentials exist only in the dedicated automation runtime/config.

- [ ] **Step 5: Push feature branch and open a draft PR**

PR title: `Sprint 8D: guarded hourly AI discovery automation`

PR body must state: hourly scheduler disabled by default; PostgreSQL owns ticks/budget; no auto-materialize/publish; no production secrets/deploy; fake provider CI only.

- [ ] **Step 6: Verify all required GitHub Actions at the exact PR head**

Required green set: Sprint 8D dedicated gate, Sprint 8C, Sprint 8B, Sprint 8A, Sprint 7A/7B/7C, Sprint 5C frontend/backend + staging integration, Sprint 5D release candidate, deployment workflow dry-run, and any inherited required checks triggered by the diff.

- [ ] **Step 7: Stop before merge**

Do not merge and do not deploy. Report exact head SHA, PR number, changed-file summary, test/workflow status, and any review comments. Merge remains a separate explicit authorization gate.
