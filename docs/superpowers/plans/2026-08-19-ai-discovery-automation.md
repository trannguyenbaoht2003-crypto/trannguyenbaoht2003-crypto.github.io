# Sprint 8D AI Discovery Automation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add disabled-by-default hourly AI discovery automation that uses BullMQ only for scheduling/delivery, keeps PostgreSQL as scheduling/cost authority, executes only through Sprint 8C policy-governed provider execution, and stops at durable AI proposals.

**Architecture:** A dedicated `ai-automation-worker` process reconciles one BullMQ Job Scheduler (`ai-discovery-hourly-v1`) and consumes a minimal `{schemaVersion:1}` job. The processor claims a unique PostgreSQL UTC-hour tick, builds deterministic structured input from the active patch/catalog and normalized observations, derives a non-circular scheduled-content hash/run identity, then calls the existing Sprint 8C governed executor with a stricter one-hour budget floor. Redis never decides eligibility/cost and the scheduled path never imports Candidate materialization or Publication mutation authorities.

**Tech Stack:** Node.js >=22.13.0, TypeScript 5.9.3, PostgreSQL 17 in CI, BullMQ 5.80.11, ioredis 5.11.1, `node:test`, existing backend package.

**Spec:** `docs/superpowers/specs/2026-08-19-ai-discovery-automation-design.md`

## Global constraints

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
- The **first implementation-stage commit is RED-only**: tests/contracts are committed before any production implementation.

## File structure

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

## Task 0: Establish the Sprint 8D RED-only contract commit

**Files:** Create all seven Sprint 8D test/contract files listed above. No production file is changed in this task.

- [ ] Add the migration RED test:

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

- [ ] Create budget/input/tick/queue/reader tests importing their final approved module paths. Each contains at least one smallest approved behavioral assertion. Missing production modules must make these tests RED by module resolution, not by syntax error.

- [ ] Create `tests/ai-discovery-automation-contract.test.mjs` asserting the future dedicated worker, workflow, runbook, package scripts, scheduler constant, and authority-isolation files exist.

- [ ] Run:

```bash
cd backend && node --import tsx --test --test-concurrency=1 test/ai-discovery-automation-*.test.ts
cd .. && node --test tests/ai-discovery-automation-contract.test.mjs
```

Expected: FAIL only because Sprint 8D production artifacts do not exist yet.

- [ ] Commit tests only:

```bash
git add backend/test/ai-discovery-automation-*.test.ts tests/ai-discovery-automation-contract.test.mjs
git commit -m "test: define Sprint 8D automation RED contracts"
```

- [ ] Verify `git show --stat HEAD` contains no `backend/src`, `backend/migrations`, `.github/workflows`, or `docs/runbooks` production change.

## Task 1: Add the durable scheduled tick ledger

**Files:**
- Create `backend/migrations/0016_ai_discovery_automation.sql`
- Modify `backend/test/ai-discovery-automation-migration.test.ts`
- Modify `backend/test/migration.test.ts`

- [ ] Expand RED tests for exact columns, unique `(scheduler_key, utc_hour)`, UTC-hour normalization, status vocabulary, controlled `PROCESSING` metadata enrichment, terminal finalization, delete rejection, and terminal immutability.

- [ ] Verify RED:

```bash
cd backend && node --import tsx --test --test-concurrency=1 test/ai-discovery-automation-migration.test.ts
```

- [ ] Create the table:

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

create index scheduled_ai_discovery_ticks_recent_idx
  on scheduled_ai_discovery_ticks (utc_hour desc, scheduled_ai_discovery_tick_id);
```

- [ ] Add the exact transition guard. It must permit **one-way enrichment while still `PROCESSING`** because the approved design persists `scheduled_content_hash` + `ai_discovery_run_id` before provider orchestration; it must then permit terminal finalization and reject later changes.

```sql
create function enforce_scheduled_ai_discovery_tick_transition()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'scheduled AI discovery ticks cannot be deleted';
  end if;

  if old.status <> 'PROCESSING' then
    raise exception 'terminal scheduled AI discovery ticks are immutable';
  end if;

  if new.scheduled_ai_discovery_tick_id <> old.scheduled_ai_discovery_tick_id
     or new.scheduler_key <> old.scheduler_key
     or new.utc_hour <> old.utc_hour
     or new.created_at <> old.created_at then
    raise exception 'scheduled AI discovery tick identity is immutable';
  end if;

  if old.scheduled_content_hash is not null
     and new.scheduled_content_hash is distinct from old.scheduled_content_hash then
    raise exception 'scheduled content hash cannot change once set';
  end if;

  if old.ai_discovery_run_id is not null
     and new.ai_discovery_run_id is distinct from old.ai_discovery_run_id then
    raise exception 'AI discovery run id cannot change once set';
  end if;

  if old.ai_operations_policy_revision_id is not null
     and new.ai_operations_policy_revision_id is distinct from old.ai_operations_policy_revision_id then
    raise exception 'policy revision id cannot change once set';
  end if;

  if old.ai_operations_run_budget_reservation_id is not null
     and new.ai_operations_run_budget_reservation_id is distinct from old.ai_operations_run_budget_reservation_id then
    raise exception 'budget reservation id cannot change once set';
  end if;

  if new.status = 'PROCESSING' then
    if new.completed_at is not null then
      raise exception 'processing tick cannot have completed_at';
    end if;
    return new;
  end if;

  if new.completed_at is null then
    raise exception 'terminal tick requires completed_at';
  end if;

  return new;
end;
$$;

create trigger scheduled_ai_discovery_ticks_transition_guard
before update or delete on scheduled_ai_discovery_ticks
for each row execute function enforce_scheduled_ai_discovery_tick_transition();
```

This allows `PROCESSING(null ids) -> PROCESSING(hash/run id) -> terminal`, while every non-null durable linkage becomes one-way and every terminal row becomes immutable.

- [ ] Add only `scheduled_ai_discovery_ticks` to `backend/test/migration.test.ts` expected tables.

- [ ] Run GREEN:

```bash
cd backend && node --import tsx --test --test-concurrency=1 test/ai-discovery-automation-migration.test.ts test/migration.test.ts
```

- [ ] Commit:

```bash
git add backend/migrations/0016_ai_discovery_automation.sql backend/test/ai-discovery-automation-migration.test.ts backend/test/migration.test.ts
git commit -m "feat: add durable AI automation tick ledger"
```

## Task 2: Extend Sprint 8C budget authority with a scheduled interval floor

**Files:**
- Modify `backend/src/modules/ai-operations/types.ts`
- Modify `backend/src/modules/ai-operations/reserve-ai-operations-run-budget.ts`
- Modify `backend/test/ai-discovery-automation-budget.test.ts`
- Regression: `backend/test/ai-operations-budget.test.ts`
- Regression: `backend/test/execute-policy-governed-ai-discovery-run.test.ts`

- [ ] Add RED cases:
  - policy interval `0`, previous reservation <3600s => `AI_OPERATIONS_SCHEDULED_CADENCE_NOT_ELAPSED`;
  - policy interval `7200`, previous reservation <7200s => existing `AI_OPERATIONS_MIN_INTERVAL_NOT_ELAPSED`;
  - concurrent scheduled calls cannot bypass shared advisory lock;
  - manual/private 8C behavior remains unchanged.

- [ ] Verify RED:

```bash
cd backend && node --import tsx --test --test-concurrency=1 test/ai-discovery-automation-budget.test.ts
```

- [ ] Add:

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

Preserve existing caller behavior:

```ts
export async function reserveAiOperationsRunBudget(pool, input) {
  return reserveAiOperationsRunBudgetWithFloor(pool, input, {
    minimumIntervalFloorSeconds: 0,
  });
}
```

Inside the existing transaction and `ai_operations_provider_budget:v1` advisory lock:
1. preserve replay/idempotency;
2. load exactly one active policy;
3. preserve disabled + UTC-day cap checks;
4. calculate elapsed seconds from latest reservation across policy revisions;
5. if elapsed < policy interval, throw existing policy interval error;
6. otherwise if elapsed < `max(policy interval, floor)`, throw scheduled cadence error;
7. insert the same reservation row and same safe audit event.

No second budget table and no Redis cost state.

- [ ] Run GREEN regressions:

```bash
cd backend && node --import tsx --test --test-concurrency=1 \
  test/ai-discovery-automation-budget.test.ts \
  test/ai-operations-budget.test.ts \
  test/execute-policy-governed-ai-discovery-run.test.ts
```

- [ ] Commit:

```bash
git add backend/src/modules/ai-operations/types.ts backend/src/modules/ai-operations/reserve-ai-operations-run-budget.ts backend/test/ai-discovery-automation-budget.test.ts
git commit -m "refactor: add scheduled AI budget interval floor"
```

## Task 3: Build deterministic scheduled content and run identity

**Files:**
- Create `backend/src/modules/ai-automation/types.ts`
- Create `backend/src/modules/ai-automation/build-scheduled-ai-discovery-input.ts`
- Create `backend/src/modules/ai-automation/scheduled-run-identity.ts`
- Modify `backend/test/ai-discovery-automation-input.test.ts`
- Regression: `backend/test/normalize-provider-execution-input.test.ts`

- [ ] Add RED fixtures for active patch/catalog, eligible origins (`collector_detected`, `community_submitted`, `editorial`), excluded `ai_generated`, deterministic time/UUID ties, caps, mismatched catalog IDs, structured serialization, and identical/changed content identity.

- [ ] Verify RED:

```bash
cd backend && node --import tsx --test --test-concurrency=1 test/ai-discovery-automation-input.test.ts
```

- [ ] Define:

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

- [ ] Serialize observations using fixed key insertion order:

```ts
JSON.stringify({
  schemaVersion: 1,
  origin,
  augmentExternalIds: payload.augmentExternalIds,
  itemExternalIds: payload.itemExternalIds,
});
```

Never include source URLs/blobs, raw/free-form text, usernames, prompts, Evidence, or Publication state.

- [ ] Query exactly one active `aram_mayhem` catalog authority and join:

```text
normalized_observations
  -> candidate_provenance
  -> game_entity_revisions
  -> game_entities
```

Exclude `ai_generated`; fail closed for missing/ambiguous active authority. Rank subjects by newest eligible observation descending then ASCII subject external ID. Rank observations by `created_at desc, normalized_observation_id asc`. Select max 8 subjects × 4 observations. Revalidate selected IDs against the exact active catalog revision; allow-lists are the ASCII-sorted union of IDs from selected observations only.

- [ ] Use existing Sprint 8B observation validation. Invalid/oversized structured serialization is skipped, never truncated.

- [ ] Implement non-circular hash:

```ts
scheduledContentHash = hashCanonicalJson({ patchKey, gameModeExternalId, subjects });
runKey = `scheduled:v1:${scheduledContentHash}`;
idempotencyKey = `ai-discovery-scheduled:v1:${scheduledContentHash}`;
```

- [ ] Lock namespace UUID:

```text
3d0f4c4e-5b7a-5c4d-8f5e-7cc2f6968d01
```

Implement deterministic UUID with exact v5 semantics:
1. parse namespace UUID into 16 bytes;
2. SHA-1 over `namespaceBytes || utf8(scheduledContentHash)`;
3. take first 16 digest bytes;
4. byte 6 = `(byte6 & 0x0f) | 0x50`;
5. byte 8 = `(byte8 & 0x3f) | 0x80`;
6. lowercase UUID formatting.

- [ ] Normalize final provider input with existing `normalizeAiProviderExecutionInput({ ...content, runKey })`; do not change Sprint 8B full provider-input hashing semantics.

- [ ] Run GREEN:

```bash
cd backend && node --import tsx --test --test-concurrency=1 \
  test/ai-discovery-automation-input.test.ts \
  test/normalize-provider-execution-input.test.ts
```

- [ ] Commit:

```bash
git add backend/src/modules/ai-automation backend/test/ai-discovery-automation-input.test.ts
git commit -m "feat: build deterministic scheduled AI discovery input"
```

## Task 4: Add PostgreSQL-owned scheduled tick execution

**Files:**
- Create `backend/src/modules/ai-automation/process-scheduled-ai-discovery-tick.ts`
- Modify `backend/test/ai-discovery-automation-tick.test.ts`
- Regression: `backend/test/execute-policy-governed-ai-discovery-run.test.ts`
- Regression: `backend/test/execute-ai-discovery-provider-run.test.ts`

- [ ] Add RED tests for two simultaneous processors in same DB UTC hour, one owner/provider path only, consumed same hash, pre-reservation-blocked same hash, provider failure, and crash after reservation.

- [ ] Verify RED:

```bash
cd backend && node --import tsx --test --test-concurrency=1 test/ai-discovery-automation-tick.test.ts
```

- [ ] Claim using PostgreSQL clock:

```sql
insert into scheduled_ai_discovery_ticks
  (scheduled_ai_discovery_tick_id, scheduler_key, utc_hour, status)
values
  ($1, 'ai-discovery-hourly-v1', date_trunc('hour', clock_timestamp()), 'PROCESSING')
on conflict (scheduler_key, utc_hour) do nothing
returning scheduled_ai_discovery_tick_id, utc_hour;
```

Zero rows => duplicate/no-op before input/provider work.

- [ ] Build content, derive identity, then perform the legal controlled `PROCESSING -> PROCESSING` enrichment setting `scheduled_content_hash` and `ai_discovery_run_id` before budget/provider execution.

- [ ] Consumed-input query:

```sql
select 1
  from scheduled_ai_discovery_ticks tick
  join ai_operations_run_budget_reservations reservation
    on reservation.ai_discovery_run_id = tick.ai_discovery_run_id
 where tick.scheduled_content_hash = $1
   and tick.scheduled_ai_discovery_tick_id <> $2
 limit 1;
```

Prior reservation => current tick `NO_NEW_INPUT`, zero new reservation/provider call. Prior tick without reservation does not consume content.

- [ ] Call existing Sprint 8C executor via existing `reserveBudget` dependency:

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

Map only known budget errors to approved safe terminal outcomes. Unknown/ambiguous errors do not generate automatic retry instructions.

- [ ] Terminal finalization writes only status, safe policy/budget linkage, and `completed_at`. Never persist provider request/response, structured observations, prompt, rationale, or secret.

- [ ] Run GREEN:

```bash
cd backend && node --import tsx --test --test-concurrency=1 \
  test/ai-discovery-automation-tick.test.ts \
  test/execute-policy-governed-ai-discovery-run.test.ts \
  test/execute-ai-discovery-provider-run.test.ts
```

- [ ] Commit:

```bash
git add backend/src/modules/ai-automation/process-scheduled-ai-discovery-tick.ts backend/test/ai-discovery-automation-tick.test.ts
git commit -m "feat: execute guarded scheduled AI discovery ticks"
```

## Task 5: Add BullMQ scheduler reconciliation, queue consumer, and automation-only config

**Files:**
- Modify `backend/src/queue/names.ts`
- Create `backend/src/queue/ai-discovery-scheduler.ts`
- Create `backend/src/queue/ai-discovery-automation-worker.ts`
- Create `backend/src/ai-automation-config.ts`
- Modify `backend/test/ai-discovery-automation-queue.test.ts`

- [ ] RED tests cover queue name `hai-dau-ai-discovery-automation-v1`, scheduler ID, one-hour interval `3_600_000`, exact payload, `attempts:1`, enabled upsert, disabled removal, idempotent reconciliation, stale disabled no-op, disabled config without OpenAI credentials, enabled config fail-closed.

- [ ] Verify RED:

```bash
cd backend && node --import tsx --test --test-concurrency=1 test/ai-discovery-automation-queue.test.ts
```

- [ ] Define runtime config:

```ts
export interface AiAutomationConfig {
  databaseUrl: string;
  redisUrl: string;
  schedulerEnabled: boolean;
  providerConfig?: OpenAiResponsesProviderConfig & { model: string };
}
```

Undefined scheduler flag => false. Enabled path applies the same provider/model/timeout/custom-endpoint restrictions as existing private 8B execution; production custom endpoint remains prohibited.

- [ ] Enabled scheduler reconciliation:

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

- [ ] Queue worker concurrency = 1. Validate exact job-data keys. If desired state is disabled, return `SCHEDULER_DISABLED` before tick creation. Worker source must not import lifecycle mutation authorities.

- [ ] Run GREEN:

```bash
cd backend && node --import tsx --test --test-concurrency=1 test/ai-discovery-automation-queue.test.ts
```

- [ ] Commit:

```bash
git add backend/src/queue/names.ts backend/src/queue/ai-discovery-scheduler.ts backend/src/queue/ai-discovery-automation-worker.ts backend/src/ai-automation-config.ts backend/test/ai-discovery-automation-queue.test.ts
git commit -m "feat: add private hourly AI automation queue"
```

## Task 6: Add the dedicated AI automation process lifecycle

**Files:**
- Create `backend/src/ai-automation-worker.ts`
- Modify `backend/package.json`
- Modify `backend/test/ai-discovery-automation-queue.test.ts`

- [ ] Add RED lifecycle assertions: package script exists, dedicated entrypoint owns provider construction, existing `backend/src/worker.ts` remains provider-free.

- [ ] Entry lifecycle:
1. parse automation runtime config;
2. create PostgreSQL pool and dedicated Redis queue/worker connections;
3. instantiate queue;
4. reconcile scheduler desired state;
5. enabled => construct provider and worker;
6. disabled => construct no-provider stale-job-draining worker;
7. SIGINT/SIGTERM closes worker, queue, Redis connections, pool exactly once.

- [ ] Add:

```json
"start:ai-automation": "node dist/src/ai-automation-worker.js"
```

Do not alter public `start` or core `start:worker` to require OpenAI settings.

- [ ] Run:

```bash
npm --prefix backend run typecheck
npm --prefix backend run build
cd backend && node --import tsx --test --test-concurrency=1 test/ai-discovery-automation-queue.test.ts
```

- [ ] Commit:

```bash
git add backend/src/ai-automation-worker.ts backend/package.json backend/test/ai-discovery-automation-queue.test.ts
git commit -m "feat: add dedicated AI automation runtime"
```

## Task 7: Extend safe read-only observability and status inspection

**Files:**
- Modify `backend/src/modules/ai-operations/types.ts`
- Modify `backend/src/modules/ai-operations/read-ai-operations-snapshot.ts`
- Create `backend/src/ai-automation-status-cli.ts`
- Modify `backend/package.json`
- Modify `backend/test/ai-discovery-automation-reader.test.ts`
- Regression: `backend/test/ai-operations-reader.test.ts`

- [ ] RED reader tests require safe `snapshot.automation` fields: last completed tick time/outcome/hash/run ID/budget reservation time and bounded counters for total/no-new-input/policy-cadence blocked/completed/provider-failed-ambiguous/incomplete-processing. Serialized snapshot must not contain prompt, observation body, provider response, auth header, or API key.

- [ ] Verify RED:

```bash
cd backend && node --import tsx --test --test-concurrency=1 test/ai-discovery-automation-reader.test.ts
```

- [ ] Extend `readAiOperationsSnapshot()` by querying only safe tick columns and `ai_operations_run_budget_reservations.reserved_at`. Preserve existing `activePolicy`, `budget`, and `proposals` behavior and add `automation`.

- [ ] Add a **separate read-only status config parser** requiring only `DATABASE_URL`, `REDIS_URL`, and exact/defaulted `AI_DISCOVERY_SCHEDULER_ENABLED`. Even when desired state is enabled, `ai-automation:status` must not require or read `OPENAI_API_KEY` because inspection itself never executes the provider.

- [ ] `ai-automation-status-cli.ts` may read BullMQ scheduler inventory and DB snapshot only. It must not call `upsertJobScheduler`, `removeJobScheduler`, provider execution, materialization, or publication. Output only scheduler ID/cadence/next-run style metadata plus safe DB automation snapshot.

- [ ] Add:

```json
"ai-automation:status": "node dist/src/ai-automation-status-cli.js"
```

- [ ] Run GREEN:

```bash
cd backend && node --import tsx --test --test-concurrency=1 \
  test/ai-discovery-automation-reader.test.ts \
  test/ai-operations-reader.test.ts
npm run typecheck
```

- [ ] Commit:

```bash
git add backend/src/modules/ai-operations/types.ts backend/src/modules/ai-operations/read-ai-operations-snapshot.ts backend/src/ai-automation-status-cli.ts backend/package.json backend/test/ai-discovery-automation-reader.test.ts
git commit -m "feat: expose safe AI automation operations status"
```

## Task 8: Complete repository authority/security contract and runbook

**Files:**
- Modify `tests/ai-discovery-automation-contract.test.mjs`
- Modify `package.json`
- Create `docs/runbooks/ai-discovery-automation.md`

- [ ] Root contract statically verifies scheduled source graph has no Candidate materialization/HumanReview/Moderation/Eligibility/Evidence/Publication mutation call path; exact queue/scheduler constants; disabled default; dedicated process/status scripts; read-only workflow permissions/no deploy or production secret; runbook exists.

- [ ] Verify contract RED before root wiring:

```bash
node --test tests/ai-discovery-automation-contract.test.mjs
```

- [ ] Add root script:

```json
"test:ai-discovery-automation": "node --test tests/ai-discovery-automation-contract.test.mjs"
```

Add it to root `test` chain without removing inherited tests.

- [ ] Runbook prerequisites/disabled startup:

```bash
test -n "$DATABASE_URL"
test -n "$REDIS_URL"
AI_DISCOVERY_SCHEDULER_ENABLED=false npm --prefix backend run start:ai-automation
AI_DISCOVERY_SCHEDULER_ENABLED=false npm --prefix backend run ai-automation:status
```

Activation instructions must explicitly state separate authorization is required. Rollback: set false -> restart/reconcile -> status confirms scheduler absent -> preserve PostgreSQL history.

- [ ] Run root contract. At this point only the not-yet-created Task 9 workflow assertion may remain RED; document that exact expected failure.

- [ ] Commit:

```bash
git add tests/ai-discovery-automation-contract.test.mjs package.json docs/runbooks/ai-discovery-automation.md
git commit -m "test: lock Sprint 8D automation authority boundaries"
```

## Task 9: Add the dedicated Sprint 8D GitHub Actions gate

**File:** Create `.github/workflows/sprint-8d-ai-discovery-automation.yml`

- [ ] Path filters cover migration 0016, `backend/src/modules/ai-automation/**`, `backend/src/queue/ai-discovery-*`, `backend/src/ai-automation-*`, touched AI-operations files, 8D tests/contract, package files, runbook/spec/plan, and workflow itself.

- [ ] Runtime: PostgreSQL 17, Redis 7, Node 22.13.0, `permissions: contents: read`, root/backend `npm ci`, no provider secret env.

- [ ] Focused/inherited steps:

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

- [ ] Add repository cleanliness + deployment/secret guards following established 8C pattern. Explicitly reject deployment commands and secret material. Do not add `OPENAI_API_KEY`.

- [ ] Run:

```bash
npm run test:ai-discovery-automation
git diff --check
```

Expected: PASS.

- [ ] Commit:

```bash
git add .github/workflows/sprint-8d-ai-discovery-automation.yml
git commit -m "ci: add Sprint 8D AI automation gate"
```

## Task 10: Full regression and authority audit

- [ ] Focused 8D:

```bash
npm run test:ai-discovery-automation
npm --prefix backend run typecheck
cd backend && node --import tsx --test --test-concurrency=1 test/ai-discovery-automation-*.test.ts
cd ..
```

- [ ] Inherited/full:

```bash
npm run test:guarded-ai-discovery
npm run test:ai-provider-execution
npm run test:ai-operations-policy
npm --prefix backend test
npm --prefix backend run build
npm run lint
```

- [ ] Cleanliness:

```bash
git diff --check
git status --short
```

Expected: all PASS and clean worktree.

- [ ] Manual diff audit confirms exact minimal Redis data, no downstream content-authority mutation path, provider credentials only in dedicated automation runtime/config, core worker/public API provider-secret independence, and no production deployment/provisioning command.

- [ ] Any failure is handled via systematic debugging/TDD. Do not weaken tests to pass gates.

## Task 11: Draft PR and exact-head verification handoff

- [ ] Push implementation feature branch created from approved spec/plan, never commit implementation directly to `main`.

- [ ] Open draft PR titled:

```text
Sprint 8D: guarded hourly AI discovery automation
```

PR body states: hourly disabled by default; PostgreSQL owns ticks/budget; Redis/BullMQ only schedules/delivers; AI stops at durable proposals; no auto-materialize/publish; no production secrets/deploy; fake provider CI only.

- [ ] Verify exact-head green set:
  - Sprint 8D dedicated gate;
  - Sprint 8C policy/budget;
  - Sprint 8B provider execution;
  - Sprint 8A guarded AI discovery;
  - Sprint 7A/7B/7C;
  - Sprint 5C frontend/backend regression + staging integration;
  - Sprint 5D release candidate;
  - deployment workflow dry-run;
  - every additional inherited required check triggered by diff.

- [ ] Review PR comments/threads; only technically valid actionable feedback is applied through TDD/systematic debugging, then exact-head gates rerun.

- [ ] Stop before merge and production activation. Report exact feature-head SHA, PR number, changed-file summary, test/workflow status, review status. **Do not merge, deploy, provision provider credentials, or enable production scheduler.** Those remain separate explicit authorization gates.
