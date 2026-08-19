# Sprint 8D AI Discovery Automation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add disabled-by-default hourly AI discovery automation that uses BullMQ only for scheduling/delivery, keeps PostgreSQL as scheduling/cost authority, executes only through Sprint 8C policy-governed provider execution, and stops at durable AI proposals.

**Architecture:** A dedicated `ai-automation-worker` process reconciles one BullMQ Job Scheduler (`ai-discovery-hourly-v1`) and consumes a minimal `{schemaVersion:1}` job. The processor claims a unique PostgreSQL UTC-hour tick, builds deterministic structured input from the active patch/catalog and normalized observations, derives a non-circular scheduled-content hash/run identity, then calls the existing Sprint 8C governed executor with a stricter one-hour budget floor. Redis never decides eligibility/cost and the scheduled path never imports Candidate materialization or Publication mutation authorities.

**Tech Stack:** Node.js >=22.13.0, TypeScript 5.9.3, PostgreSQL 17 in CI, BullMQ 5.80.11, ioredis 5.11.1, `node:test`, existing backend package.

**Spec:** `docs/superpowers/specs/2026-08-19-ai-discovery-automation-design.md`

## Global Constraints

- Scheduler cadence is exactly one hour; dynamic cadence configuration is out of scope.
- Scheduler identity is exactly `ai-discovery-hourly-v1`.
- Redis job payload is exactly `{ "schemaVersion": 1 }`.
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
- A scheduled content hash with an existing durable Sprint 8C budget reservation is consumed and must not auto-run again.
- Content previously blocked before reservation may be retried by a later hourly tick.
- Core API/core worker must not require provider credentials.
- Scheduled execution must not import/call `materializeAiCandidateProposal()`, Human Review mutation, Moderation mutation, Eligibility mutation, Evidence mutation, or Publication mutation.
- No production deployment, production credential provisioning, or production scheduler activation is part of this plan.
- CI uses fake/injected providers and performs zero real OpenAI requests.
- The **first implementation-stage commit is RED-only**: tests/contracts are committed before any production implementation, matching the approved spec.

## File Structure

### New production files

- `backend/migrations/0016_ai_discovery_automation.sql`
- `backend/src/modules/ai-automation/types.ts`
- `backend/src/modules/ai-automation/scheduled-run-identity.ts`
- `backend/src/modules/ai-automation/build-scheduled-ai-discovery-input.ts`
- `backend/src/modules/ai-automation/process-scheduled-ai-discovery-tick.ts`
- `backend/src/queue/ai-discovery-scheduler.ts`
- `backend/src/queue/ai-discovery-automation-worker.ts`
- `backend/src/ai-automation-config.ts`
- `backend/src/ai-automation-worker.ts`
- `backend/src/ai-automation-status-cli.ts`
- `docs/runbooks/ai-discovery-automation.md`
- `.github/workflows/sprint-8d-ai-discovery-automation.yml`

### New test/contract files

- `backend/test/ai-discovery-automation-migration.test.ts`
- `backend/test/ai-discovery-automation-budget.test.ts`
- `backend/test/ai-discovery-automation-input.test.ts`
- `backend/test/ai-discovery-automation-tick.test.ts`
- `backend/test/ai-discovery-automation-queue.test.ts`
- `backend/test/ai-discovery-automation-reader.test.ts`
- `tests/ai-discovery-automation-contract.test.mjs`

### Existing files to modify

- `backend/src/modules/ai-operations/types.ts`
- `backend/src/modules/ai-operations/reserve-ai-operations-run-budget.ts`
- `backend/src/modules/ai-operations/read-ai-operations-snapshot.ts`
- `backend/src/queue/names.ts`
- `backend/package.json`
- `package.json`
- `backend/test/migration.test.ts`

---

### Task 0: Establish the Sprint 8D RED-only contract commit

**Files:**
- Create: all seven Sprint 8D test/contract files listed above.
- No production files may be created or modified in this task.

- [ ] **Step 1: Add failing migration contract**

`backend/test/ai-discovery-automation-migration.test.ts` should call `resetDatabase()` and assert the expected new table exists. It must fail because migration `0016` does not exist yet.

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { resetDatabase } from './helpers/database.js';

test('Sprint 8D adds durable scheduled AI discovery ticks', async () => {
  const pool = await resetDatabase();
  const result = await pool.query(
    `select to_regclass('public.scheduled_ai_discovery_ticks') as table_name`,
  );
  assert.equal(result.rows[0]?.table_name, 'scheduled_ai_discovery_ticks');
  await pool.end();
});
```

- [ ] **Step 2: Add failing module contracts**

Create the budget/input/tick/queue/reader tests with imports from their final approved module paths. The tests should express one smallest approved behavior each, for example:

```ts
import { buildScheduledAiDiscoveryInput } from '../src/modules/ai-automation/build-scheduled-ai-discovery-input.js';
```

Because the production modules do not exist yet, the focused 8D suite must fail at module resolution.

- [ ] **Step 3: Add failing root repository contract**

`tests/ai-discovery-automation-contract.test.mjs` initially asserts that the dedicated worker, workflow, runbook, package scripts, scheduler constant, and authority-isolation source files exist. It must fail before implementation.

- [ ] **Step 4: Verify the RED state**

Run:

```bash
cd backend && node --import tsx --test --test-concurrency=1 test/ai-discovery-automation-*.test.ts
cd .. && node --test tests/ai-discovery-automation-contract.test.mjs
```

Expected: FAIL for missing Sprint 8D migration/modules/runtime/workflow. The failure must be attributable to missing 8D implementation, not syntax errors in the tests.

- [ ] **Step 5: Commit RED-only tests/contracts**

```bash
git add backend/test/ai-discovery-automation-*.test.ts tests/ai-discovery-automation-contract.test.mjs
git commit -m "test: define Sprint 8D automation RED contracts"
```

**Checkpoint:** inspect `git show --stat HEAD` and confirm no file under `backend/src`, `backend/migrations`, `.github/workflows`, or `docs/runbooks` was added/modified in this first implementation commit.

### Task 1: Add the durable scheduled tick ledger

**Files:**
- Create: `backend/migrations/0016_ai_discovery_automation.sql`
- Modify: `backend/test/ai-discovery-automation-migration.test.ts`
- Modify: `backend/test/migration.test.ts`

- [ ] **Step 1: Expand migration tests before implementation**

Test exact columns, unique `(scheduler_key, utc_hour)`, UTC-hour normalization, allowed statuses, delete rejection, terminal immutability, and the single legal `PROCESSING -> terminal` transition.

- [ ] **Step 2: Verify focused migration tests still RED**

Run:

```bash
cd backend && node --import tsx --test --test-concurrency=1 test/ai-discovery-automation-migration.test.ts
```

Expected: FAIL because table/migration is absent.

- [ ] **Step 3: Implement migration `0016_ai_discovery_automation.sql`**

Create the table:

```sql
create table scheduled_ai_discovery_ticks (
  scheduled_ai_discovery_tick_id uuid primary key,
  scheduler_key text not null check (scheduler_key = 'ai-discovery-hourly-v1'),
  utc_hour timestamptz not null,
  status text not null check (status in (
    'PROCESSING', 'NO_NEW_INPUT', 'CADENCE_NOT_ELAPSED', 'POLICY_DISABLED',
    'DAILY_BUDGET_EXHAUSTED', 'POLICY_MIN_INTERVAL', 'COMPLETED',
    'PROVIDER_FAILED', 'AMBIGUOUS_FAILURE'
  )),
  scheduled_content_hash text
    check (scheduled_content_hash is null or scheduled_content_hash ~ '^[a-f0-9]{64}$'),
  ai_discovery_run_id uuid,
  ai_operations_policy_revision_id uuid
    references ai_operations_policy_revisions(ai_operations_policy_revision_id),
  ai_operations_run_budget_reservation_id uuid
    references ai_operations_run_budget_reservations(ai_operations_run_budget_reservation_id),
  created_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz,
  unique (scheduler_key, utc_hour),
  check (date_trunc('hour', utc_hour) = utc_hour),
  check (
    (status = 'PROCESSING' and completed_at is null)
    or (status <> 'PROCESSING' and completed_at is not null)
  )
);
```

Add an index on `(utc_hour desc, scheduled_ai_discovery_tick_id)`.

Define the exact transition guard; no placeholder trigger function:

```sql
create function enforce_scheduled_ai_discovery_tick_transition()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'scheduled AI discovery ticks are append/finalize only';
  end if;

  if old.status <> 'PROCESSING' then
    raise exception 'terminal scheduled AI discovery ticks are immutable';
  end if;

  if new.status = 'PROCESSING' or new.completed_at is null then
    raise exception 'scheduled AI discovery tick must finalize once';
  end if;

  if new.scheduled_ai_discovery_tick_id <> old.scheduled_ai_discovery_tick_id
     or new.scheduler_key <> old.scheduler_key
     or new.utc_hour <> old.utc_hour
     or new.created_at <> old.created_at then
    raise exception 'scheduled AI discovery tick identity is immutable';
  end if;

  return new;
end;
$$;

create trigger scheduled_ai_discovery_ticks_transition_guard
before update or delete on scheduled_ai_discovery_ticks
for each row execute function enforce_scheduled_ai_discovery_tick_transition();
```

This permits exactly one finalization update while preventing terminal mutation/deletion.

- [ ] **Step 4: Update inherited migration table expectation**

Add only `scheduled_ai_discovery_ticks` to the expected table set in `backend/test/migration.test.ts`.

- [ ] **Step 5: Run migration tests GREEN**

```bash
cd backend && node --import tsx --test --test-concurrency=1 test/ai-discovery-automation-migration.test.ts test/migration.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit Task 1**

```bash
git add backend/migrations/0016_ai_discovery_automation.sql backend/test/ai-discovery-automation-migration.test.ts backend/test/migration.test.ts
git commit -m "feat: add durable AI automation tick ledger"
```

### Task 2: Extend Sprint 8C budget authority with a scheduled interval floor

**Files:**
- Modify: `backend/src/modules/ai-operations/types.ts`
- Modify: `backend/src/modules/ai-operations/reserve-ai-operations-run-budget.ts`
- Modify: `backend/test/ai-discovery-automation-budget.test.ts`
- Test unchanged regression: `backend/test/ai-operations-budget.test.ts`
- Test unchanged regression: `backend/test/execute-policy-governed-ai-discovery-run.test.ts`

- [ ] **Step 1: Expand RED tests**

Add cases proving:
- active policy interval `0`, prior reservation <3600 seconds => `AI_OPERATIONS_SCHEDULED_CADENCE_NOT_ELAPSED`;
- active policy interval `7200`, prior reservation <7200 seconds => existing `AI_OPERATIONS_MIN_INTERVAL_NOT_ELAPSED`;
- concurrent scheduled calls share the existing advisory lock and cannot both reserve;
- manual 8C callers remain unchanged.

- [ ] **Step 2: Verify RED**

```bash
cd backend && node --import tsx --test --test-concurrency=1 test/ai-discovery-automation-budget.test.ts
```

Expected: FAIL because floor-aware reservation does not exist.

- [ ] **Step 3: Extract a shared floor-aware reservation implementation**

Add:

```ts
export interface ReserveAiOperationsRunBudgetOptions {
  minimumIntervalFloorSeconds: number;
}

export async function reserveAiOperationsRunBudgetWithFloor(
  pool: Pool,
  input: ReserveAiOperationsRunBudgetCommand,
  options: ReserveAiOperationsRunBudgetOptions,
): Promise<ReserveAiOperationsRunBudgetResult>;
```

Keep existing public behavior by delegating:

```ts
export async function reserveAiOperationsRunBudget(pool, input) {
  return reserveAiOperationsRunBudgetWithFloor(pool, input, {
    minimumIntervalFloorSeconds: 0,
  });
}
```

Within the same existing transaction/advisory lock:
1. preserve replay/idempotency handling;
2. load exactly one active policy;
3. enforce disabled and UTC daily budget exactly as 8C does now;
4. calculate elapsed seconds from the newest reservation across revisions;
5. if elapsed < `policy.min_interval_seconds`, throw `AI_OPERATIONS_MIN_INTERVAL_NOT_ELAPSED`;
6. otherwise if elapsed < `max(policy.min_interval_seconds, floor)`, throw `AI_OPERATIONS_SCHEDULED_CADENCE_NOT_ELAPSED`;
7. insert the same `ai_operations_run_budget_reservations` row/audit event.

Do not create a second budget table or Redis cost state.

- [ ] **Step 4: Run new and inherited tests GREEN**

```bash
cd backend && node --import tsx --test --test-concurrency=1 \
  test/ai-discovery-automation-budget.test.ts \
  test/ai-operations-budget.test.ts \
  test/execute-policy-governed-ai-discovery-run.test.ts
```

Expected: PASS.

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
- Modify: `backend/test/ai-discovery-automation-input.test.ts`
- Regression test: `backend/test/normalize-provider-execution-input.test.ts`

- [ ] **Step 1: Expand deterministic builder tests**

Seed exact active patch/catalog data plus eligible `collector_detected`, `community_submitted`, `editorial`, and excluded `ai_generated` provenance. Test:
- active patch/exact catalog only;
- 8 subjects max;
- 4 observations/subject max;
- subject order by newest eligible observation desc then ASCII external ID;
- observation order by `created_at desc, normalized_observation_id asc`;
- deterministic structured JSON only;
- allow-lists equal the sorted union of selected observed IDs and revalidate against the exact catalog;
- invalid/oversized serialization is skipped, never truncated;
- identical selected content => identical hash/run identity.

- [ ] **Step 2: Verify RED**

```bash
cd backend && node --import tsx --test --test-concurrency=1 test/ai-discovery-automation-input.test.ts
```

Expected: FAIL because builder/identity modules are absent.

- [ ] **Step 3: Implement scheduled content types and structured serialization**

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
```

Serialize each eligible normalized observation with fixed key insertion order:

```ts
JSON.stringify({
  schemaVersion: 1,
  origin,
  augmentExternalIds: payload.augmentExternalIds,
  itemExternalIds: payload.itemExternalIds,
});
```

Never include source URL/blob, raw text, usernames, prompts, Evidence, or Publication state.

- [ ] **Step 4: Query and rank deterministic PostgreSQL authorities**

The builder must read one active `aram_mayhem` catalog authority and join:

```text
normalized_observations
  -> candidate_provenance
  -> game_entity_revisions
  -> game_entities
```

Exclude `candidate_provenance.origin = 'ai_generated'`. Fail closed if active authority is unavailable/ambiguous. Revalidate the selected IDs against the exact active catalog revision before provider normalization.

- [ ] **Step 5: Implement exact non-circular hash and UUIDv5-style identity**

Use:

```ts
scheduledContentHash = hashCanonicalJson({ patchKey, gameModeExternalId, subjects });
runKey = `scheduled:v1:${scheduledContentHash}`;
idempotencyKey = `ai-discovery-scheduled:v1:${scheduledContentHash}`;
```

Lock the Sprint 8D namespace UUID to:

```text
3d0f4c4e-5b7a-5c4d-8f5e-7cc2f6968d01
```

Implement deterministic UUID with exact RFC-4122-v5 bit semantics:
1. parse namespace UUID to 16 raw bytes;
2. SHA-1 over `namespaceBytes || utf8(scheduledContentHash)`;
3. take first 16 digest bytes;
4. set byte 6: `(byte6 & 0x0f) | 0x50`;
5. set byte 8: `(byte8 & 0x3f) | 0x80`;
6. format lowercase UUID string.

This removes implementation ambiguity while remaining repository-local and deterministic.

- [ ] **Step 6: Normalize final provider input through existing Sprint 8B validation**

```ts
const input = normalizeAiProviderExecutionInput({
  ...content,
  runKey: identity.runKey,
});
```

Do not change Sprint 8B hashing/validation semantics.

- [ ] **Step 7: Run Task 3 GREEN**

```bash
cd backend && node --import tsx --test --test-concurrency=1 \
  test/ai-discovery-automation-input.test.ts \
  test/normalize-provider-execution-input.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit Task 3**

```bash
git add backend/src/modules/ai-automation backend/test/ai-discovery-automation-input.test.ts
git commit -m "feat: build deterministic scheduled AI discovery input"
```

### Task 4: Add PostgreSQL-owned scheduled tick execution

**Files:**
- Create: `backend/src/modules/ai-automation/process-scheduled-ai-discovery-tick.ts`
- Modify: `backend/test/ai-discovery-automation-tick.test.ts`
- Regression test: `backend/test/execute-policy-governed-ai-discovery-run.test.ts`
- Regression test: `backend/test/execute-ai-discovery-provider-run.test.ts`

- [ ] **Step 1: Expand RED concurrency/no-new-input tests**

Test two simultaneous processors in the same DB UTC hour: exactly one owns the tick and only the owner may reach provider execution. Add cases for consumed same hash, policy-blocked same hash, provider failure, and crash after reservation.

- [ ] **Step 2: Verify RED**

```bash
cd backend && node --import tsx --test --test-concurrency=1 test/ai-discovery-automation-tick.test.ts
```

Expected: FAIL because processor is absent.

- [ ] **Step 3: Claim one DB-owned UTC-hour tick**

Use PostgreSQL clock, not job timestamp:

```sql
insert into scheduled_ai_discovery_ticks
  (scheduled_ai_discovery_tick_id, scheduler_key, utc_hour, status)
values
  ($1, 'ai-discovery-hourly-v1', date_trunc('hour', clock_timestamp()), 'PROCESSING')
on conflict (scheduler_key, utc_hour) do nothing
returning scheduled_ai_discovery_tick_id, utc_hour;
```

Zero returned rows => duplicate/no-op before building input or calling provider authority.

- [ ] **Step 4: Persist deterministic hash/run ID before provider orchestration**

After building content and deriving identity, update the owned `PROCESSING` row with `scheduled_content_hash` and `ai_discovery_run_id` before budget/provider execution.

- [ ] **Step 5: Enforce authoritative consumed-input gate**

Use the approved crash-safe join:

```sql
select 1
  from scheduled_ai_discovery_ticks tick
  join ai_operations_run_budget_reservations reservation
    on reservation.ai_discovery_run_id = tick.ai_discovery_run_id
 where tick.scheduled_content_hash = $1
   and tick.scheduled_ai_discovery_tick_id <> $2
 limit 1;
```

Existing reservation => finalize current tick `NO_NEW_INPUT`, with zero new reservation/provider call. A prior tick without reservation does not consume the content.

- [ ] **Step 6: Call existing Sprint 8C governed execution with floor-aware reservation dependency**

```ts
await executePolicyGovernedAiDiscoveryRun(pool, command, {
  reserveBudget: (budgetPool, budgetCommand) =>
    reserveAiOperationsRunBudgetWithFloor(
      budgetPool,
      budgetCommand,
      { minimumIntervalFloorSeconds: 3600 },
    ),
});
```

Map exact known budget errors to approved safe terminal outcomes. Unknown/ambiguous errors must not be converted into an automatic retry instruction.

- [ ] **Step 7: Finalize safe metadata only**

Terminal update may write only status, policy revision ID, budget reservation ID, and `completed_at`; provider input/output/prompt/rationale/secrets are never written to the tick ledger.

- [ ] **Step 8: Run Task 4 GREEN**

```bash
cd backend && node --import tsx --test --test-concurrency=1 \
  test/ai-discovery-automation-tick.test.ts \
  test/execute-policy-governed-ai-discovery-run.test.ts \
  test/execute-ai-discovery-provider-run.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit Task 4**

```bash
git add backend/src/modules/ai-automation/process-scheduled-ai-discovery-tick.ts backend/test/ai-discovery-automation-tick.test.ts
git commit -m "feat: execute guarded scheduled AI discovery ticks"
```

### Task 5: Add BullMQ scheduler reconciliation, queue consumer, and automation-only config

**Files:**
- Modify: `backend/src/queue/names.ts`
- Create: `backend/src/queue/ai-discovery-scheduler.ts`
- Create: `backend/src/queue/ai-discovery-automation-worker.ts`
- Create: `backend/src/ai-automation-config.ts`
- Modify: `backend/test/ai-discovery-automation-queue.test.ts`

- [ ] **Step 1: Expand RED scheduler/config tests**

Test:
- queue name `hai-dau-ai-discovery-automation-v1`;
- scheduler ID `ai-discovery-hourly-v1`;
- one-hour repeat interval `3_600_000` ms;
- job template data exactly `{schemaVersion:1}`;
- job options `attempts:1`;
- disabled startup removes stale scheduler;
- stale delivered job while disabled returns no-op before tick creation;
- disabled config requires only `DATABASE_URL` + `REDIS_URL`;
- enabled config requires valid provider settings.

- [ ] **Step 2: Verify RED**

```bash
cd backend && node --import tsx --test --test-concurrency=1 test/ai-discovery-automation-queue.test.ts
```

Expected: FAIL because scheduler/config/worker modules are absent.

- [ ] **Step 3: Implement exact config parser**

```ts
export interface AiAutomationConfig {
  databaseUrl: string;
  redisUrl: string;
  schedulerEnabled: boolean;
  providerConfig?: OpenAiResponsesProviderConfig & { model: string };
}
```

`AI_DISCOVERY_SCHEDULER_ENABLED` undefined => false; only exact `true`/`false` accepted. Enabled path reuses the same OpenAI model/timeout/endpoint restrictions as the existing private 8B CLI; production custom endpoint remains prohibited.

- [ ] **Step 4: Reconcile scheduler desired state**

Enabled:

```ts
await queue.upsertJobScheduler(
  AI_DISCOVERY_SCHEDULER_ID,
  { every: 3_600_000 },
  {
    name: 'scheduled-ai-discovery',
    data: { schemaVersion: 1 },
    opts: { attempts: 1 },
  },
);
```

Disabled:

```ts
await queue.removeJobScheduler(AI_DISCOVERY_SCHEDULER_ID);
```

- [ ] **Step 5: Implement queue worker with disabled no-op guard and concurrency 1**

Validate exact job data keys before execution. If local desired state is disabled, return `SCHEDULER_DISABLED` without creating a tick/provider run. The worker module must not import any materialization/review/moderation/eligibility/publication mutation module.

- [ ] **Step 6: Run Task 5 GREEN**

```bash
cd backend && node --import tsx --test --test-concurrency=1 test/ai-discovery-automation-queue.test.ts
```

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
- Modify: `backend/test/ai-discovery-automation-queue.test.ts`

- [ ] **Step 1: Add RED lifecycle assertions**

Assert package script `start:ai-automation` exists and the dedicated entrypoint owns provider construction. Assert existing `backend/src/worker.ts` remains provider-free.

- [ ] **Step 2: Implement process entrypoint**

Lifecycle:
1. parse automation config;
2. create PostgreSQL pool and dedicated Redis queue/worker connections;
3. instantiate queue;
4. reconcile scheduler desired state;
5. if enabled, construct provider and AI automation worker;
6. if disabled, still run a no-provider worker capable of draining stale jobs as no-ops;
7. SIGINT/SIGTERM closes worker, queue, Redis connections, pool exactly once.

Sanitize process-level errors to stable operational codes; do not print secrets/provider bodies.

- [ ] **Step 3: Add package script**

```json
"start:ai-automation": "node dist/src/ai-automation-worker.js"
```

Do not alter `start` or `start:worker` to require OpenAI environment variables.

- [ ] **Step 4: Run typecheck/build/lifecycle tests**

```bash
npm --prefix backend run typecheck
npm --prefix backend run build
cd backend && node --import tsx --test --test-concurrency=1 test/ai-discovery-automation-queue.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit Task 6**

```bash
git add backend/src/ai-automation-worker.ts backend/package.json backend/test/ai-discovery-automation-queue.test.ts
git commit -m "feat: add dedicated AI automation runtime"
```

### Task 7: Extend safe read-only observability and status inspection

**Files:**
- Modify: `backend/src/modules/ai-operations/types.ts`
- Modify: `backend/src/modules/ai-operations/read-ai-operations-snapshot.ts`
- Create: `backend/src/ai-automation-status-cli.ts`
- Modify: `backend/package.json`
- Modify: `backend/test/ai-discovery-automation-reader.test.ts`
- Regression test: `backend/test/ai-operations-reader.test.ts`

- [ ] **Step 1: Expand RED reader/status tests**

Require `snapshot.automation` to expose only:
- last completed tick time;
- last outcome;
- last scheduled content hash;
- last AI discovery run ID;
- last budget reservation time;
- bounded counters for ticks/no-new-input/policy-cadence blocked/completed/provider-failed-ambiguous/incomplete-processing.

Assert serialized snapshot contains no prompt, observation body, provider response, authorization header, or API key.

- [ ] **Step 2: Verify RED**

```bash
cd backend && node --import tsx --test --test-concurrency=1 test/ai-discovery-automation-reader.test.ts
```

Expected: FAIL because automation read model/status CLI is absent.

- [ ] **Step 3: Extend `readAiOperationsSnapshot()`**

Query only safe tick columns and `ai_operations_run_budget_reservations.reserved_at`; do not read provider request/response data. Keep existing activePolicy/budget/proposals shape intact and add `automation`.

- [ ] **Step 4: Add private status CLI**

The CLI may read:
- parsed desired scheduler state;
- BullMQ Job Scheduler inventory;
- `readAiOperationsSnapshot()`.

It must not call scheduler mutation methods, provider execution, materialization, or publication mutation. Output only sanitized scheduler identity/cadence/next-run metadata plus safe DB snapshot.

- [ ] **Step 5: Add package script**

```json
"ai-automation:status": "node dist/src/ai-automation-status-cli.js"
```

- [ ] **Step 6: Run reader regressions GREEN**

```bash
cd backend && node --import tsx --test --test-concurrency=1 \
  test/ai-discovery-automation-reader.test.ts \
  test/ai-operations-reader.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit Task 7**

```bash
git add backend/src/modules/ai-operations/types.ts backend/src/modules/ai-operations/read-ai-operations-snapshot.ts backend/src/ai-automation-status-cli.ts backend/package.json backend/test/ai-discovery-automation-reader.test.ts
git commit -m "feat: expose safe AI automation operations status"
```

### Task 8: Complete repository authority/security contract and operations runbook

**Files:**
- Modify: `tests/ai-discovery-automation-contract.test.mjs`
- Modify: `package.json`
- Create: `docs/runbooks/ai-discovery-automation.md`

- [ ] **Step 1: Expand root authority contract before wiring scripts**

Statically assert:
- scheduled source graph does not contain `materializeAiCandidateProposal`, Human Review mutation, Moderation mutation, Eligibility mutation, Evidence mutation, Publication mutation;
- exact queue/scheduler constants exist;
- scheduler defaults disabled;
- package has dedicated automation process/status scripts;
- workflow has read-only permissions and no deployment/production-secret command;
- runbook exists and does not instruct automatic production activation.

- [ ] **Step 2: Verify contract remains RED before root wiring/runbook**

```bash
node --test tests/ai-discovery-automation-contract.test.mjs
```

Expected: FAIL until root script/runbook/workflow pieces exist.

- [ ] **Step 3: Add root test script without removing inherited gates**

```json
"test:ai-discovery-automation": "node --test tests/ai-discovery-automation-contract.test.mjs"
```

Add it to the root `test` chain while preserving every existing 8A/8B/8C and inherited regression command.

- [ ] **Step 4: Write disabled-default operations runbook**

Document prerequisites without embedding secrets:

```bash
test -n "$DATABASE_URL"
test -n "$REDIS_URL"
AI_DISCOVERY_SCHEDULER_ENABLED=false npm --prefix backend run start:ai-automation
AI_DISCOVERY_SCHEDULER_ENABLED=false npm --prefix backend run ai-automation:status
```

Document later activation as a **separate explicit authorization** sequence only. Rollback procedure: set false -> restart/reconcile -> status verifies scheduler absent -> preserve PostgreSQL history.

- [ ] **Step 5: Run root contract**

At this point it may still fail only because the dedicated workflow is Task 9. Record that exact remaining expected failure; all other assertions should pass.

- [ ] **Step 6: Commit Task 8**

```bash
git add tests/ai-discovery-automation-contract.test.mjs package.json docs/runbooks/ai-discovery-automation.md
git commit -m "test: lock Sprint 8D automation authority boundaries"
```

### Task 9: Add the dedicated Sprint 8D GitHub Actions gate

**Files:**
- Create: `.github/workflows/sprint-8d-ai-discovery-automation.yml`

- [ ] **Step 1: Create workflow with exact path filters**

Include migration 0016, `backend/src/modules/ai-automation/**`, `backend/src/queue/ai-discovery-*`, `backend/src/ai-automation-*`, touched AI operations files, 8D tests/contract, package files, runbook/spec/plan, and the workflow itself.

- [ ] **Step 2: Use established CI runtime**

- PostgreSQL 17 service;
- Redis 7 service;
- Node 22.13.0;
- `permissions: contents: read`;
- root/backend `npm ci`;
- no provider secret in workflow env.

- [ ] **Step 3: Add focused and inherited commands**

```yaml
- run: npm run test:ai-discovery-automation
- run: npm --prefix backend run typecheck
- run: cd backend && node --import tsx --test --test-concurrency=1 test/ai-discovery-automation-*.test.ts
- run: npm --prefix backend test
- run: npm run test:ai-operations-policy
- run: npm run test:ai-provider-execution
- run: npm run test:guarded-ai-discovery
- run: npm run lint
- run: npm --prefix backend run build
```

Add repository cleanliness and deployment/secret guards following the 8C pattern. Explicitly reject production deploy commands and secret material; do not add `OPENAI_API_KEY`.

- [ ] **Step 4: Run root contract GREEN**

```bash
npm run test:ai-discovery-automation
git diff --check
```

Expected: PASS.

- [ ] **Step 5: Commit Task 9**

```bash
git add .github/workflows/sprint-8d-ai-discovery-automation.yml
git commit -m "ci: add Sprint 8D AI automation gate"
```

### Task 10: Full local regression and authority audit

**Files:**
- No new files unless a verified regression defect inside approved 8D scope requires correction.

- [ ] **Step 1: Run focused 8D checks**

```bash
npm run test:ai-discovery-automation
npm --prefix backend run typecheck
cd backend && node --import tsx --test --test-concurrency=1 test/ai-discovery-automation-*.test.ts
cd ..
```

- [ ] **Step 2: Run inherited 8A/8B/8C and full backend checks**

```bash
npm run test:guarded-ai-discovery
npm run test:ai-provider-execution
npm run test:ai-operations-policy
npm --prefix backend test
npm --prefix backend run build
npm run lint
```

Expected: all PASS.

- [ ] **Step 3: Run cleanliness checks**

```bash
git diff --check
git status --short
```

Expected: no generated/uncommitted changes.

- [ ] **Step 4: Perform manual final authority audit from the diff**

Verify:
- Redis job data remains exact minimal schema;
- no automatic Candidate/HumanReview/Moderation/Eligibility/Evidence/Publication mutation path exists;
- provider credentials exist only in dedicated AI automation config/runtime;
- core `backend/src/worker.ts` and public server remain provider-secret-independent;
- no production deployment/provisioning command was introduced.

- [ ] **Step 5: Fix only verified scoped defects and rerun affected + full gates**

Use systematic debugging/TDD for any failure. Do not weaken tests to make gates pass.

### Task 11: Draft PR and exact-head verification handoff

**Files:**
- No implementation changes unless Task 10 exposes a verified defect.

- [ ] **Step 1: Push the implementation feature branch**

Use the implementation branch created from the approved plan/spec, not `main` directly.

- [ ] **Step 2: Open a draft PR**

Title:

```text
Sprint 8D: guarded hourly AI discovery automation
```

PR body must state:
- hourly scheduler disabled by default;
- PostgreSQL owns ticks/budget;
- Redis/BullMQ is schedule/delivery only;
- AI stops at durable proposals;
- no auto-materialize/publish;
- no production secrets/deploy;
- CI uses fake provider only.

- [ ] **Step 3: Verify required GitHub Actions at the exact PR head**

Required green set:
- Sprint 8D dedicated gate;
- Sprint 8C policy/budget gate;
- Sprint 8B provider execution gate;
- Sprint 8A guarded AI discovery gate;
- Sprint 7A/7B/7C gates;
- Sprint 5C frontend/backend regression + staging integration;
- Sprint 5D release-candidate gate;
- deployment workflow dry-run;
- any additional inherited required checks triggered by the diff.

- [ ] **Step 4: Review PR comments/threads**

Address only actionable, technically valid feedback through TDD/systematic debugging. Re-run exact-head gates after any change.

- [ ] **Step 5: Stop before merge and production activation**

Report:
- exact feature-head SHA;
- PR number;
- changed-file summary;
- focused/full test status;
- exact-head workflow status;
- review comment/thread status.

Do **not** merge, deploy, provision provider credentials, or enable the production scheduler. Merge and production activation remain separate explicit authorization gates.
