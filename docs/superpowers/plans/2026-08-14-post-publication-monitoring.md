# Sprint 7A — Post-Publication Monitoring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build deterministic, replay-safe post-publication trust monitoring for the CandidateRevision pinned by each active PublicationVersion, surfacing internal alerts without ever mutating public content automatically.

**Architecture:** PostgreSQL remains the sole authority. Canonical `CandidateEligibilityEvaluated` plus explicit `PublicationMonitoringRequested` lifecycle events are routed through a new BullMQ monitoring queue; the worker reloads current Publication and Eligibility authority from PostgreSQL, computes a closed monitoring state, persists immutable evaluation/alert history plus current alert pointers atomically, and emits terminal alert-transition outbox events. Public Publication reads remain independent from monitoring, Redis, and workers.

**Tech Stack:** Node.js 22.13.0, TypeScript 5.9.3, Fastify backend, PostgreSQL 17, BullMQ 5, Redis 7, Node test runner, GitHub Actions.

## Global Constraints

- `main` base for this sprint is `bac0e7586c22cae5ecffb16130f082379d79fdcd`; implementation branch is `feat/7a-post-publication-monitoring`.
- Monitoring version is exactly `post-publication-monitor-v1`.
- Monitoring queue name is exactly `hai-dau-monitoring-v1`.
- Alert codes are exactly `ACTIVE_PUBLICATION_REVALIDATION_REQUIRED`, `ACTIVE_PUBLICATION_NEEDS_REVIEW`, `ACTIVE_PUBLICATION_INELIGIBLE`.
- Monitoring is advisory only: never call publish/rollback and never write `publications`, `publication_versions`, `publication_activation_history`, or `active_publication_versions`.
- PostgreSQL is authority; Redis/BullMQ carry only identity/delivery envelopes.
- No AI inference, external fetch, feedback intake, notification integration, browser credential, CORS expansion, public mutation route, or Railway provisioning is part of Sprint 7A.
- Existing direct PostgreSQL public Publication reads must remain available with Redis and monitoring workers unavailable.
- Existing migrations are immutable. Add only forward migration `backend/migrations/0011_post_publication_monitoring.sql`.
- Every implementation task follows RED -> GREEN and ends in a focused commit.
- Reuse `backend/test/helpers/publication.ts`, `backend/test/helpers/gate.ts`, and `seedEligiblePublicationContext()` rather than inventing a parallel fixture model.
- Publication/monitoring concurrency must preserve established Publication lock order and be proven by tests before acceptance.
- `SPRINT_7A_REPO_READY` does not imply `PRODUCTION_DELIVERY_READY`; Issue #23 remains the separate production delivery gate.

---

## File Structure

### New production files

- `backend/migrations/0011_post_publication_monitoring.sql` — monitoring tables, foreign keys, immutability guards, and worker status extension if required.
- `backend/src/modules/monitoring/types.ts` — closed monitoring domain types and reader result types.
- `backend/src/modules/monitoring/compute-publication-monitoring.ts` — pure deterministic state computation only.
- `backend/src/modules/monitoring/evaluate-publication-monitoring.ts` — source validation, PostgreSQL authority reload, replay check, evaluation persistence, alert transitions, audit/outbox writes.
- `backend/src/modules/monitoring/read-open-publication-monitoring-alerts.ts` — internal PostgreSQL-backed current-open-alert reader.
- `backend/src/queue/monitoring-worker.ts` — BullMQ input/output event handling; queue payload never authoritative.
- `docs/runbooks/post-publication-monitoring.md` — operator semantics, replay/failure behavior, explicit no-auto-publication boundary.
- `.github/workflows/sprint-7a-post-publication-monitoring.yml` — dedicated PostgreSQL 17 / Redis 7 exact-head gate.
- `tests/post-publication-monitoring.test.mjs` — repository/source security and wiring contract.

### New backend tests

- `backend/test/publication-monitoring-compute.test.ts` — pure evaluator.
- `backend/test/publication-monitoring-migration.test.ts` — schema/immutability/relational guards.
- `backend/test/publication-monitoring.test.ts` — PostgreSQL integration for open/resolve/currentness/lifecycle/stale triggers.
- `backend/test/monitoring-worker.test.ts` — Redis/BullMQ delivery, tamper rejection, duplicate/lost-ack, terminal delivery effects, backlog behavior.
- `backend/test/publication-monitoring-concurrency.test.ts` — monitoring versus publish/rollback and stale active-version settlement.

### Existing files modified

- `backend/src/modules/publication/publish-candidate-revision.ts` — append `PublicationMonitoringRequested` in the existing publish transaction.
- `backend/src/modules/publication/rollback-publication.ts` — append `PublicationMonitoringRequested` in the existing rollback transaction.
- `backend/src/queue/names.ts` — add monitoring queue constant.
- `backend/src/queue/outbox-dispatcher.ts` — route monitoring input/output event types to the new queue.
- `backend/src/worker.ts` — compose one monitoring consumer and one monitoring producer queue using existing connection/shutdown policy.
- `package.json` — add `test:post-publication-monitoring` and include it in root `test`.
- `.github/workflows/backend-production-foundation.yml` — extend root/runbook contract checks only where required; retain current regression behavior.
- `backend/README.md` — reference monitoring authority/runbook and alert semantics.

---

### Task 1: Add the monitoring persistence model and database invariants

**Files:**
- Create: `backend/migrations/0011_post_publication_monitoring.sql`
- Create: `backend/test/publication-monitoring-migration.test.ts`
- Modify: `backend/test/helpers/database.ts` only if the helper has an explicit expected migration list/count.

**Interfaces:**
- Consumes: existing `publications`, `publication_versions`, `active_publication_versions`, `candidate_eligibility_evaluations`, `audit_events`, `outbox_events`.
- Produces tables: `publication_monitoring_evaluations`, `publication_monitoring_alert_events`, `current_publication_monitoring_alerts`, `publication_monitoring_effects`, `publication_monitoring_delivery_effects`.

- [ ] **Step 1: Write the failing migration contract test**

Create tests that reset the database and assert all five tables exist, plus the closed enum/check domains. Use SQL-level assertions rather than string matching only.

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { resetDatabase } from './helpers/database.js';

test('monitoring migration creates closed authority tables', async () => {
  const pool = await resetDatabase();
  for (const table of [
    'publication_monitoring_evaluations',
    'publication_monitoring_alert_events',
    'current_publication_monitoring_alerts',
    'publication_monitoring_effects',
    'publication_monitoring_delivery_effects',
  ]) {
    const result = await pool.query(
      `select to_regclass($1) as name`,
      [`public.${table}`],
    );
    assert.equal(result.rows[0]?.name, table);
  }
  await pool.end();
});
```

Add RED tests that later prove direct UPDATE/DELETE of an evaluation and alert event are rejected, mismatched Publication/PublicationVersion references are rejected, a current alert pointer cannot point to another Publication or alert code, and a delivery effect cannot represent an unrelated alert event.

- [ ] **Step 2: Run the focused test and confirm RED**

Run:

```bash
npm --prefix backend exec -- node --import tsx --test --test-concurrency=1 test/publication-monitoring-migration.test.ts
```

Expected: FAIL because `0011_post_publication_monitoring.sql` and the monitoring tables do not exist.

- [ ] **Step 3: Add the forward-only migration**

Create the schema with these exact domains:

```sql
create table publication_monitoring_evaluations (
  publication_monitoring_evaluation_id uuid primary key,
  trigger_outbox_event_id uuid not null unique references outbox_events(outbox_event_id),
  publication_id uuid not null,
  publication_version_id uuid not null,
  candidate_id uuid not null,
  candidate_revision_id uuid not null,
  candidate_eligibility_evaluation_id uuid,
  eligibility_policy_revision_id uuid,
  eligibility_input_hash text check (
    eligibility_input_hash is null or eligibility_input_hash ~ '^[a-f0-9]{64}$'
  ),
  monitoring_version text not null check (monitoring_version = 'post-publication-monitor-v1'),
  outcome text not null check (outcome in ('healthy', 'warning', 'critical')),
  reason_code text check (
    reason_code is null or reason_code in (
      'ACTIVE_PUBLICATION_REVALIDATION_REQUIRED',
      'ACTIVE_PUBLICATION_NEEDS_REVIEW',
      'ACTIVE_PUBLICATION_INELIGIBLE'
    )
  ),
  evaluated_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp(),
  foreign key (publication_version_id, publication_id, candidate_id, candidate_revision_id)
    references publication_versions(
      publication_version_id,
      publication_id,
      candidate_id,
      candidate_revision_id
    )
);
```

Add the remaining tables with the exact fields from the approved spec. Important constraints:

```sql
check (severity in ('warning', 'critical'));
check (state in ('open', 'resolved'));
check (effect_outcome in ('evaluated', 'not_applicable'));
check (event_type in (
  'PublicationMonitoringAlertOpened',
  'PublicationMonitoringAlertResolved'
));
```

Use composite uniqueness/foreign keys so current pointers and alert events cannot cross Publication, PublicationVersion, or alert-code ownership. Add append-only UPDATE/DELETE guard triggers for `publication_monitoring_evaluations` and `publication_monitoring_alert_events` following the existing immutable-history database pattern.

- [ ] **Step 4: Run focused migration tests to GREEN**

Run the same focused test. Expected: PASS including relational tamper and immutability cases.

- [ ] **Step 5: Run migration regression subset**

```bash
npm --prefix backend exec -- node --import tsx --test --test-concurrency=1 \
  test/*migration.test.ts
```

Expected: all existing migrations plus `0011` pass.

- [ ] **Step 6: Commit**

```bash
git add backend/migrations/0011_post_publication_monitoring.sql \
        backend/test/publication-monitoring-migration.test.ts \
        backend/test/helpers/database.ts
git commit -m "feat: add post-publication monitoring schema"
```

---

### Task 2: Implement the pure deterministic monitoring computation

**Files:**
- Create: `backend/src/modules/monitoring/types.ts`
- Create: `backend/src/modules/monitoring/compute-publication-monitoring.ts`
- Create: `backend/test/publication-monitoring-compute.test.ts`

**Interfaces:**
- Produces:

```ts
export type PublicationMonitoringAlertCode =
  | 'ACTIVE_PUBLICATION_REVALIDATION_REQUIRED'
  | 'ACTIVE_PUBLICATION_NEEDS_REVIEW'
  | 'ACTIVE_PUBLICATION_INELIGIBLE';

export type PublicationMonitoringSeverity = 'warning' | 'critical';
export type PublicationMonitoringOutcome = 'healthy' | 'warning' | 'critical' | 'not_applicable';

export interface PublicationMonitoringComputationInput {
  sourceKind: 'eligibility' | 'lifecycle';
  activeVersionMatchesEligibilitySource: boolean;
  hasActivePublication: boolean;
  eligibilityCurrent: boolean;
  eligibilityOutcome: 'eligible' | 'needs_review' | 'ineligible' | null;
}

export interface PublicationMonitoringComputation {
  outcome: PublicationMonitoringOutcome;
  alertCode: PublicationMonitoringAlertCode | null;
  severity: PublicationMonitoringSeverity | null;
}

export function computePublicationMonitoring(
  input: PublicationMonitoringComputationInput,
): PublicationMonitoringComputation;
```

- [ ] **Step 1: Write RED truth-table tests**

Cover exactly:

```ts
assert.deepEqual(computePublicationMonitoring({
  sourceKind: 'lifecycle',
  activeVersionMatchesEligibilitySource: true,
  hasActivePublication: true,
  eligibilityCurrent: false,
  eligibilityOutcome: null,
}), {
  outcome: 'warning',
  alertCode: 'ACTIVE_PUBLICATION_REVALIDATION_REQUIRED',
  severity: 'warning',
});
```

Also assert:
- lifecycle/current `eligible` -> healthy;
- current `needs_review` -> warning/needs-review;
- current `ineligible` -> critical/ineligible;
- eligibility trigger whose source revision is no longer active -> not_applicable;
- eligibility trigger with active revision but stale currentness -> revalidation warning;
- no active Publication -> not_applicable.

- [ ] **Step 2: Run and confirm RED**

```bash
npm --prefix backend exec -- node --import tsx --test \
  test/publication-monitoring-compute.test.ts
```

Expected: FAIL with missing monitoring module/export.

- [ ] **Step 3: Implement the closed pure function**

Use this decision order:

```ts
if (!input.hasActivePublication) return NOT_APPLICABLE;
if (
  input.sourceKind === 'eligibility'
  && !input.activeVersionMatchesEligibilitySource
) return NOT_APPLICABLE;
if (!input.eligibilityCurrent || input.eligibilityOutcome === null) {
  return REVALIDATION_WARNING;
}
if (input.eligibilityOutcome === 'ineligible') return INELIGIBLE_CRITICAL;
if (input.eligibilityOutcome === 'needs_review') return NEEDS_REVIEW_WARNING;
return HEALTHY;
```

Export frozen constants for the four canonical results so later worker/transaction code cannot drift in strings.

- [ ] **Step 4: Run focused tests to GREEN and typecheck**

```bash
npm --prefix backend exec -- node --import tsx --test test/publication-monitoring-compute.test.ts
npm --prefix backend run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/modules/monitoring/types.ts \
        backend/src/modules/monitoring/compute-publication-monitoring.ts \
        backend/test/publication-monitoring-compute.test.ts
git commit -m "feat: compute deterministic publication monitoring state"
```

---

### Task 3: Implement PostgreSQL monitoring evaluation and atomic alert transitions

**Files:**
- Create: `backend/src/modules/monitoring/evaluate-publication-monitoring.ts`
- Create: `backend/test/publication-monitoring.test.ts`
- Reuse: `backend/src/modules/eligibility/read-candidate-eligibility-status.ts` semantics, but do not call it in a nested transaction; reproduce its currentness logic through an internal `PoolClient` helper in the monitoring module.
- Reuse: `backend/test/helpers/publication.ts`, `backend/test/helpers/gate.ts`.

**Interfaces:**
- Produces:

```ts
export interface EvaluatePublicationMonitoringInput {
  sourceOutboxEventId: string;
  expectedEventType:
    | 'CandidateEligibilityEvaluated'
    | 'PublicationMonitoringRequested';
}

export interface EvaluatePublicationMonitoringResult {
  outcome: 'evaluated' | 'not_applicable' | 'duplicate_noop';
  publicationId: string | null;
  publicationVersionId: string | null;
  alertCode: PublicationMonitoringAlertCode | null;
}

export async function evaluatePublicationMonitoring(
  pool: Pool,
  input: EvaluatePublicationMonitoringInput,
): Promise<EvaluatePublicationMonitoringResult>;
```

- [ ] **Step 1: Write RED integration tests for trust drift**

Using `seedEligiblePublicationContext()` and `publishCandidateRevision()`:
1. publish active eligible version;
2. create a newer canonical Eligibility evaluation for the same pinned revision with `needs_review` authority;
3. call `evaluatePublicationMonitoring()` using the persisted `CandidateEligibilityEvaluated` outbox ID;
4. assert exactly one warning pointer/event/audit/output-outbox transition.

Then add RED tests for:
- duplicate source -> `duplicate_noop`, no second evaluation/alert/audit/output event;
- warning -> ineligible resolves warning and opens critical atomically;
- critical -> eligible resolves critical and leaves no open alert;
- source revision no longer active -> `not_applicable` only in effects;
- stale currentness after an older Eligibility event -> revalidation warning, never queued old outcome.

- [ ] **Step 2: Run focused tests and confirm RED**

```bash
npm --prefix backend exec -- node --import tsx --test --test-concurrency=1 \
  test/publication-monitoring.test.ts
```

Expected: FAIL with missing evaluator.

- [ ] **Step 3: Implement fail-closed persisted source validation**

For `CandidateEligibilityEvaluated`, require persisted event type and aggregate relation, then load `candidateId` / `candidateRevisionId` from persisted PostgreSQL relationships. Do not trust queued payload.

For `PublicationMonitoringRequested`, require exact payload keys:

```ts
const expectedKeys = [
  'activationId',
  'publicationId',
  'requestedReason',
  'schemaVersion',
].sort();
```

Require `schemaVersion === 1`, reason in `published | rolled_back`, aggregate type exactly `publication`, aggregate ID equal persisted `publicationId`, and activation belonging to that Publication.

Return stable non-secret errors such as `INVALID_PUBLICATION_MONITORING_SOURCE_EVENT` for persisted relationship violations.

- [ ] **Step 4: Load current active authority with consistent locks**

For lifecycle source:

```sql
select publication_id
  from publications
 where publication_id = $1
 for update;

select publication_version_id
  from active_publication_versions
 where publication_id = $1
 for update;
```

Then load the active version's Candidate/CandidateRevision and canonical Eligibility currentness using the same `input_hash === current authority input_hash` rule as `readCandidateEligibilityStatus()`.

For Eligibility source, first resolve Candidate -> Publication; after locking Publication/current pointer, require active version pins the same CandidateRevision or record `not_applicable`.

- [ ] **Step 5: Persist evaluation and minimal transitions atomically**

Inside the same transaction:
- replay-check `publication_monitoring_effects` first;
- insert one evaluation only for applicable active Publication state;
- lock current monitoring pointers;
- resolve every open pointer referencing an obsolete PublicationVersion;
- apply exactly one desired alert for the current active version, or none for healthy;
- for each actual transition insert alert event + audit + output outbox + current pointer update;
- insert source effect last.

Use exact actor `post-publication-monitor-v1` and actions:

```text
monitoring.publication_alert_opened
monitoring.publication_alert_resolved
```

Output outbox aggregate contract:

```ts
{
  aggregateType: 'publication_monitoring_alert',
  aggregateId: publicationMonitoringAlertEventId,
  payload: {
    schemaVersion: 1,
    publicationMonitoringAlertEventId,
    publicationId,
    alertCode,
    state,
  },
}
```

- [ ] **Step 6: Add same-code/new-active-version RED then GREEN case**

Publish/activate Version A with warning, change active pointer to Version B that also wants the same warning, evaluate lifecycle source, and assert:
- A warning gets a resolved event;
- B warning gets a new open event;
- current pointer references B only;
- both transitions share the source correlation lineage but have distinct immutable alert event IDs.

- [ ] **Step 7: Run focused tests to GREEN**

```bash
npm --prefix backend exec -- node --import tsx --test --test-concurrency=1 \
  test/publication-monitoring.test.ts
npm --prefix backend run typecheck
```

- [ ] **Step 8: Commit**

```bash
git add backend/src/modules/monitoring/evaluate-publication-monitoring.ts \
        backend/test/publication-monitoring.test.ts
git commit -m "feat: persist publication monitoring transitions"
```

---

### Task 4: Emit lifecycle monitoring requests from publish and rollback

**Files:**
- Modify: `backend/src/modules/publication/publish-candidate-revision.ts`
- Modify: `backend/src/modules/publication/rollback-publication.ts`
- Modify: `backend/test/publication.test.ts`
- Modify: rollback-focused publication test file if rollback tests live separately; otherwise keep in `publication.test.ts`.

**Interfaces:**
- Produces persisted event:

```ts
{
  eventType: 'PublicationMonitoringRequested',
  aggregateType: 'publication',
  aggregateId: publicationId,
  payload: {
    schemaVersion: 1,
    publicationId,
    activationId,
    requestedReason: 'published' | 'rolled_back',
  },
}
```

- [ ] **Step 1: Add RED publish and rollback assertions**

After successful publish, query:

```sql
select aggregate_type, aggregate_id, event_type, payload, correlation_id
  from outbox_events
 where event_type = 'PublicationMonitoringRequested';
```

Assert exactly one lifecycle request with `requestedReason='published'` and the exact activation/publication IDs. Add the corresponding rollback assertion with `requestedReason='rolled_back'`.

Also assert failed publish/rollback and idempotent replay do not add extra lifecycle requests.

- [ ] **Step 2: Run publication tests and confirm RED**

```bash
npm --prefix backend exec -- node --import tsx --test --test-concurrency=1 \
  test/publication.test.ts
```

Expected: lifecycle request assertions fail because the event does not exist.

- [ ] **Step 3: Insert lifecycle outbox event in the existing transaction**

Generate a new internal `randomUUID()` outbox ID after the activation row exists, keeping the user-command `PublicationPublished` / `PublicationRolledBack` outbox event unchanged.

Publish payload:

```ts
const monitoringPayload = {
  activationId: command.activationId,
  publicationId: command.publicationId,
  requestedReason: 'published' as const,
  schemaVersion: 1 as const,
};
```

Rollback uses the same shape with `rolled_back`.

Use aggregate type lower-case exactly `publication` for the new monitoring event even though legacy Publication outbox events use their existing aggregate spelling.

- [ ] **Step 4: Run publication + monitoring integration tests**

```bash
npm --prefix backend exec -- node --import tsx --test --test-concurrency=1 \
  test/publication.test.ts test/publication-monitoring.test.ts
```

Expected: PASS, including lifecycle revalidation warning on missing/non-current Eligibility and later resolution when current eligible authority appears.

- [ ] **Step 5: Commit**

```bash
git add backend/src/modules/publication/publish-candidate-revision.ts \
        backend/src/modules/publication/rollback-publication.ts \
        backend/test/publication.test.ts
git commit -m "feat: request monitoring after publication activation"
```

---

### Task 5: Route monitoring events and implement the replay-safe monitoring worker

**Files:**
- Modify: `backend/src/queue/names.ts`
- Modify: `backend/src/queue/outbox-dispatcher.ts`
- Create: `backend/src/queue/monitoring-worker.ts`
- Create: `backend/test/monitoring-worker.test.ts`
- Modify migration `0011` only if `worker_job_attempts` closed status constraint requires new statuses; do not change earlier migrations.

**Interfaces:**
- Add:

```ts
export const MONITORING_QUEUE_NAME = 'hai-dau-monitoring-v1';
```

- Extend routed queues:

```ts
export interface RoutedOutboxQueues {
  eligibility: OutboxQueue;
  monitoring: OutboxQueue;
  normalization: OutboxQueue;
  publication: OutboxQueue;
}
```

- Monitoring event set is exactly:

```ts
const MONITORING_EVENT_TYPES = [
  'CandidateEligibilityEvaluated',
  'PublicationMonitoringRequested',
  'PublicationMonitoringAlertOpened',
  'PublicationMonitoringAlertResolved',
] as const;
```

- [ ] **Step 1: Write RED dispatcher routing tests**

Extend the outbox dispatcher test so `CandidateEligibilityEvaluated` and all three monitoring-specific event types enqueue only to the monitoring queue, while existing event routing remains unchanged.

The test must assert `jobId === outboxEventId`, `attempts === 3`, and no event is delivered to two queues.

- [ ] **Step 2: Write RED worker envelope/tamper tests**

Create tests for:
- `job.id` missing -> stable error;
- `job.data.outboxEventId !== job.id` -> `OUTBOX_JOB_ID_MISMATCH`;
- job name differs from persisted outbox event -> reject;
- tampered payload outcome/reason/Candidate IDs with valid outbox ID -> evaluator reloads PostgreSQL and produces authority-derived state;
- duplicate source delivery -> `duplicate_noop`;
- terminal alert-output delivery writes one `publication_monitoring_delivery_effects` row;
- duplicate terminal output -> `duplicate_noop` and no second effect.

- [ ] **Step 3: Run focused queue tests and confirm RED**

```bash
npm --prefix backend exec -- node --import tsx --test --test-concurrency=1 \
  test/monitoring-worker.test.ts
```

Expected: missing monitoring queue/worker failures.

- [ ] **Step 4: Implement queue routing**

In `dispatchOutbox()`, include monitoring event types in `claimEvents()` and route them only to `queues.monitoring`. Preserve all existing leasing, retry, and delivered-state semantics.

- [ ] **Step 5: Implement `createMonitoringWorker()`**

Signature:

```ts
export interface CreateMonitoringWorkerOptions {
  concurrency?: number;
  connection: Redis;
  pool: Pool;
}

export function createMonitoringWorker(
  options: CreateMonitoringWorkerOptions,
): Worker<OutboxJobData>;
```

Input job path:

```ts
if (
  job.name === 'CandidateEligibilityEvaluated'
  || job.name === 'PublicationMonitoringRequested'
) {
  return evaluatePublicationMonitoring(options.pool, {
    sourceOutboxEventId: outboxEventId,
    expectedEventType: job.name,
  });
}
```

Output job path reloads persisted outbox event and matching `publication_monitoring_alert_events`, validates exact event/publication/alert-code/state relation, then inserts one terminal delivery effect. It emits no audit and no outbox event.

- [ ] **Step 6: Add historical backlog test**

Insert a bounded synthetic set of pending historical `CandidateEligibilityEvaluated` outbox rows before routing. Dispatch in the existing default batch size and assert:
- stale/non-active revisions settle `not_applicable`;
- active revision uses current PostgreSQL authority;
- no Publication pointer changes;
- no destructive migration/delete is used to suppress backlog.

- [ ] **Step 7: Run queue tests to GREEN**

```bash
npm --prefix backend exec -- node --import tsx --test --test-concurrency=1 \
  test/monitoring-worker.test.ts
npm --prefix backend run typecheck
```

- [ ] **Step 8: Commit**

```bash
git add backend/src/queue/names.ts \
        backend/src/queue/outbox-dispatcher.ts \
        backend/src/queue/monitoring-worker.ts \
        backend/test/monitoring-worker.test.ts \
        backend/migrations/0011_post_publication_monitoring.sql
git commit -m "feat: route and process publication monitoring events"
```

---

### Task 6: Compose monitoring into the private worker and add the internal open-alert reader

**Files:**
- Modify: `backend/src/worker.ts`
- Create: `backend/src/modules/monitoring/read-open-publication-monitoring-alerts.ts`
- Modify: `backend/src/modules/monitoring/types.ts`
- Add/modify: `backend/test/publication-monitoring.test.ts`
- Add/modify worker source-contract test if an existing `worker-runtime.test.*` file exists; otherwise put composition contract in `tests/post-publication-monitoring.test.mjs` in Task 8.

**Interfaces:**
- Reader:

```ts
export interface OpenPublicationMonitoringAlert {
  publicationId: string;
  publicationVersionId: string;
  candidateRevisionId: string;
  alertCode: PublicationMonitoringAlertCode;
  severity: PublicationMonitoringSeverity;
  evaluatedAt: string;
  eligibilityOutcome: 'eligible' | 'needs_review' | 'ineligible' | null;
  eligibilityReason: string | null;
}

export async function readOpenPublicationMonitoringAlerts(
  pool: Pool,
): Promise<OpenPublicationMonitoringAlert[]>;
```

- [ ] **Step 1: Write RED reader tests**

Seed several alerts and assert deterministic ordering:
1. critical before warning;
2. then oldest open transition;
3. then Publication ID.

Also deliberately corrupt/open a pointer whose `publication_version_id` no longer equals `active_publication_versions.publication_version_id` using a fixture transaction permitted by tests, and assert reader fails closed with `PUBLICATION_MONITORING_POINTER_STALE` rather than returning misleading data.

- [ ] **Step 2: Implement the PostgreSQL-backed reader**

Join current open pointers -> immutable alert event -> monitoring evaluation -> current active Publication pointer. Do not query Redis/BullMQ. Return only bounded structured fields.

- [ ] **Step 3: Write RED worker composition assertions**

Assert source contains:
- one `createWorkerConnection()` for monitoring consumer;
- one `createQueueConnection()` for monitoring producer;
- one `createMonitoringWorker()`;
- one `new Queue(MONITORING_QUEUE_NAME, ...)`;
- dispatcher receives `monitoring: monitoringQueue`;
- shutdown closes monitoring worker before queue, then Redis connections before pool.

- [ ] **Step 4: Modify `backend/src/worker.ts` minimally**

Follow existing Sprint 6B pattern exactly:

```ts
const monitoringConnection = createWorkerConnection(config.redisUrl);
const monitoringQueueConnection = createQueueConnection(config.redisUrl);
const monitoringWorker = createMonitoringWorker({ connection: monitoringConnection, pool });
const monitoringQueue = new Queue(MONITORING_QUEUE_NAME, {
  connection: monitoringQueueConnection,
});
```

Add monitoring entries to dispatcher and the existing shutdown `Promise.all()` groups; do not introduce a new process/service.

- [ ] **Step 5: Re-prove public read independence**

Run/add a test that closes monitoring worker/Redis or supplies unavailable Redis while reading active Publications directly from PostgreSQL. Expected: Publication reader still returns active immutable payload.

- [ ] **Step 6: Run focused tests to GREEN**

```bash
npm --prefix backend exec -- node --import tsx --test --test-concurrency=1 \
  test/publication-monitoring.test.ts test/publication-public-read.test.ts
npm --prefix backend run typecheck
```

If the existing public-read test filename differs, use the repository's actual Publication read test discovered during implementation; do not create a duplicate public-read authority suite solely for naming.

- [ ] **Step 7: Commit**

```bash
git add backend/src/worker.ts \
        backend/src/modules/monitoring/read-open-publication-monitoring-alerts.ts \
        backend/src/modules/monitoring/types.ts \
        backend/test/publication-monitoring.test.ts
git commit -m "feat: expose internal publication monitoring state"
```

---

### Task 7: Prove concurrency, stale-event settlement, and no-public-mutation invariants

**Files:**
- Create: `backend/test/publication-monitoring-concurrency.test.ts`
- Modify: `backend/test/publication-monitoring.test.ts` if a shared helper is needed.
- Never add production synchronization solely to make the test pass without first demonstrating the race/deadlock.

**Interfaces:**
- Consumes existing `publishCandidateRevision()`, `rollbackPublication()`, `evaluatePublicationMonitoring()`.
- Produces no new public API.

- [ ] **Step 1: Write RED/behavior-lock tests for monitoring versus rollback**

Run monitoring and rollback concurrently using `Promise.allSettled()` with bounded statement timeout. Assert after both settle:
- no `40P01` deadlock;
- active pointer is valid;
- any open alert references the final active PublicationVersion only;
- alert history for obsolete version is resolved;
- PublicationVersion history remains immutable.

- [ ] **Step 2: Add monitoring versus publish test**

Because publish additionally locks Candidate authority/advisory lock before Publication, prove no final stale alert survives even if monitoring observes the old active version first. If an unavoidable lock-order deadlock is reproduced, fix by matching existing Publication lock discipline in the smallest possible shared helper; do not weaken isolation or remove locks.

- [ ] **Step 3: Add no-public-mutation assertion**

Snapshot counts/pointers before and after monitoring failure/tampered event processing:

```ts
const before = await pool.query(
  `select publication_id, publication_version_id
     from active_publication_versions
    order by publication_id`,
);
// trigger monitoring error
const after = await pool.query(/* same query */);
assert.deepEqual(after.rows, before.rows);
```

Also assert monitoring source files contain no imports of `publish-candidate-revision` or `rollback-publication`.

- [ ] **Step 4: Run concurrency suite repeatedly**

```bash
for i in 1 2 3 4 5; do
  npm --prefix backend exec -- node --import tsx --test --test-concurrency=1 \
    test/publication-monitoring-concurrency.test.ts || exit 1
done
```

Expected: 5/5 clean runs, no deadlocks, no stale current alerts.

- [ ] **Step 5: Run full backend tests**

```bash
npm --prefix backend test
npm --prefix backend run typecheck
npm --prefix backend run build
```

Expected: all existing and new tests pass.

- [ ] **Step 6: Commit**

```bash
git add backend/test/publication-monitoring-concurrency.test.ts \
        backend/src/modules/monitoring
git commit -m "test: harden publication monitoring concurrency"
```

---

### Task 8: Add runbook, source-security contract, dedicated CI gate, and exact-head readiness evidence

**Files:**
- Create: `docs/runbooks/post-publication-monitoring.md`
- Modify: `backend/README.md`
- Create: `tests/post-publication-monitoring.test.mjs`
- Modify: `package.json`
- Create: `.github/workflows/sprint-7a-post-publication-monitoring.yml`
- Modify: `.github/workflows/backend-production-foundation.yml` only for contract discovery/reference if necessary.

**Interfaces:**
- Root script:

```json
"test:post-publication-monitoring": "node --test tests/post-publication-monitoring.test.mjs"
```

Add it to root `test` before `build:pages`.

- [ ] **Step 1: Write RED repository/source contract**

`tests/post-publication-monitoring.test.mjs` must assert:
- plan/runbook mentions all three alert codes;
- `backend/src/queue/names.ts` exports `hai-dau-monitoring-v1`;
- `worker.ts` composes monitoring queue/worker;
- no new public route registers `POST|PUT|PATCH|DELETE` for monitoring/Publications;
- monitoring production modules do not import publish/rollback commands;
- no `RAILWAY_TOKEN`, notification token, webhook secret, browser write token, or production connection string is committed by Sprint 7A;
- `0011_post_publication_monitoring.sql` exists and earlier migrations remain byte-identical relative to base when checked in PR review.

- [ ] **Step 2: Run contract and confirm RED before docs/workflow**

```bash
node --test tests/post-publication-monitoring.test.mjs
```

Expected: FAIL because runbook/workflow/root script do not yet exist.

- [ ] **Step 3: Write the runbook**

Required sections:
- purpose and advisory-only boundary;
- alert code table with severity/operator meaning;
- trigger flow `Eligibility -> monitoring` and `Publication activation -> monitoring`;
- replay/lost-ack behavior;
- historical backlog behavior;
- Redis outage delays monitoring but not public reads;
- PostgreSQL outage is retryable and commits no partial alert state;
- no automatic rollback/publish/hide;
- internal reader usage;
- `SPRINT_7A_REPO_READY` versus separate production Issue #23.

- [ ] **Step 4: Add dedicated GitHub Actions gate**

Workflow name:

```yaml
name: Sprint 7A post-publication monitoring gate
```

Trigger on PR paths covering `backend/**`, monitoring runbook/spec/plan, root monitoring source contract, and the workflow itself. Use Node `22.13.0`, PostgreSQL `17`, Redis `7`, `contents: read`, and no deployment permissions.

Required steps:

```yaml
- run: npm ci
- run: npm --prefix backend ci
- run: npm run test:post-publication-monitoring
- run: npm --prefix backend run typecheck
- run: npm --prefix backend test
- run: npm --prefix backend run build
- run: npm run test:public-data
- run: npm run test:staging-contract
- run: npm run test:release-source
- run: npm run test:production-contract
- run: npm run test:community-backend-pipeline
- run: git diff --check
```

Also run the existing security/deployment guard used by current regression workflows; do not add Railway CLI or any deploy step.

- [ ] **Step 5: Run local/root regression commands to GREEN**

```bash
npm run test:post-publication-monitoring
npm --prefix backend run typecheck
npm --prefix backend test
npm --prefix backend run build
npm run test:public-data
npm run test:staging-contract
npm run test:release-source
npm run test:production-contract
npm run test:production-pr-validation
npm run test:community-backend-pipeline
npm run lint
git diff --check
```

Expected: all pass.

- [ ] **Step 6: Commit docs/workflow/contracts**

```bash
git add docs/runbooks/post-publication-monitoring.md \
        backend/README.md \
        tests/post-publication-monitoring.test.mjs \
        package.json \
        .github/workflows/sprint-7a-post-publication-monitoring.yml \
        .github/workflows/backend-production-foundation.yml
git commit -m "docs: add Sprint 7A monitoring gate and runbook"
```

- [ ] **Step 7: Push/open draft PR and collect exact-head CI evidence**

Open a draft PR titled:

```text
Sprint 7A: add post-publication monitoring
```

PR body must state:
- exact base SHA;
- exact head SHA;
- no production deployment;
- no automatic Publication mutation;
- all alert codes;
- dedicated 7A gate run IDs/conclusions;
- existing regression gate conclusions;
- final review result.

- [ ] **Step 8: Perform exact-range review before readiness claim**

Review `bac0e7586c22cae5ecffb16130f082379d79fdcd..HEAD` specifically for:
- any monitoring path writing Publication authority tables;
- queue payload trust;
- missing replay boundary;
- alert pointer/version mismatch;
- output event recursion;
- deadlock/lock-order issues;
- public mutation/CORS/browser credential expansion;
- raw community payload leakage;
- production secret/deploy capability.

Fix every Critical or Important finding and rerun exact-head CI.

- [ ] **Step 9: Record repository readiness only after fresh verification**

Only after the exact head has green dedicated + regression checks and no Critical/Important review findings, update the PR body with:

```text
SPRINT_7A_REPO_READY
PRODUCTION_DELIVERY_READY = NO
```

Do not merge or deploy merely because this marker exists; integration follows the project's separate branch-finish decision and Issue #23 remains the production gate.

---

## Plan Self-Review Checklist

Before implementation begins, verify:

- [ ] Every approved spec section 1–20 maps to at least one task above.
- [ ] No placeholder/TBD/TODO remains in the plan.
- [ ] Queue constant/event names are identical in Tasks 4–8.
- [ ] `PublicationMonitoringRequested` aggregate type is lower-case `publication` exactly.
- [ ] Alert-output aggregate type is exactly `publication_monitoring_alert`.
- [ ] `publication_monitoring_effects.effect_outcome` contains only `evaluated | not_applicable`; `duplicate_noop` is a returned replay result, never a second stored effect.
- [ ] Old-version alert resolution happens before applying desired alert state for the new active version.
- [ ] Public reads remain independent from Redis/monitoring worker.
- [ ] No task introduces feedback intake, operator mutation UI, notification delivery, AI monitoring, or Railway provisioning.
- [ ] Dedicated CI uses PostgreSQL 17 / Redis 7 and read-only GitHub permissions.
- [ ] Repository readiness marker remains distinct from production delivery readiness.
