# Sprint 2A Production Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first production-shaped Hải Đấu backend foundation with tested Fastify health contracts, PostgreSQL migrations, source-policy guarded ingestion, audit/outbox/idempotency guarantees, and retry-safe BullMQ delivery.

**Architecture:** Add an isolated `backend/` TypeScript package to the existing repository. HTTP and worker processes share application contracts in a modular monolith; PostgreSQL is the source of truth, Redis/BullMQ is replaceable delivery infrastructure, and the existing static frontend remains independently buildable.

**Tech Stack:** Node.js 22.13+, TypeScript 5.9.3, Fastify 5.10.0, PostgreSQL 17, `pg` 8.22.0, BullMQ 5.80.11, ioredis 5.11.1, `tsx` 4.23.1, Node test runner.

## Global Constraints

- Architecture Baseline v0.2 and Data Model Domain Spec v0.2 are normative.
- ADR-0002 selects Node/Fastify + PostgreSQL + BullMQ/Redis.
- Use a modular monolith with asynchronous workers.
- PostgreSQL is the system of record; Redis/BullMQ is delivery infrastructure.
- Do not import production code from either spike.
- Do not add AI, publication, external crawling, production credentials, infrastructure provisioning, merge, or deployment.
- Source Policy → Patch Registry → Catalog Revision → Rules Validation is the dependency direction.
- Raw blobs are stored only when the active source-policy revision permits them.
- Mutations create audit and outbox records atomically.
- Retries create no duplicate logical side effects.
- Existing frontend lint, tests, and canonical build must remain green.

---

### Task 1: Backend package, configuration, and health contracts

**Files:**
- Create: `backend/package.json`
- Create: `backend/package-lock.json`
- Create: `backend/tsconfig.json`
- Create: `backend/src/config.ts`
- Create: `backend/src/resources.ts`
- Create: `backend/src/app.ts`
- Create: `backend/src/server.ts`
- Create: `backend/test/config.test.ts`
- Create: `backend/test/health.test.ts`

**Interfaces:**
- Produces: `parseConfig(env: NodeJS.ProcessEnv): AppConfig`
- Produces: `buildApp(options: { resources: ResourceHealth; logger?: boolean }): FastifyInstance`
- Produces: `ResourceHealth.checkPostgres(): Promise<boolean>`
- Produces: `ResourceHealth.checkRedis(): Promise<boolean>`

- [ ] **Step 1: Create the package manifest and TypeScript configuration**

Use exact runtime dependencies:

```json
{
  "name": "@hai-dau/backend",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22.13.0" },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "tsx --test test/**/*.test.ts",
    "start": "node dist/server.js"
  },
  "dependencies": {
    "bullmq": "5.80.11",
    "fastify": "5.10.0",
    "ioredis": "5.11.1",
    "pg": "8.22.0"
  },
  "devDependencies": {
    "@types/node": "22.19.19",
    "@types/pg": "8.20.0",
    "tsx": "4.23.1",
    "typescript": "5.9.3"
  }
}
```

Configure `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `module: NodeNext`, `moduleResolution: NodeNext`, `rootDir: "."`, and `outDir: "dist"`.

- [ ] **Step 2: Write failing configuration tests**

```ts
test('production configuration requires database and redis URLs', () => {
  assert.throws(() => parseConfig({ NODE_ENV: 'production' }), /DATABASE_URL/);
});

test('configuration rejects non-integer ports', () => {
  assert.throws(
    () => parseConfig({ DATABASE_URL: 'postgres://db', REDIS_URL: 'redis://cache', PORT: 'abc' }),
    /PORT/,
  );
});
```

- [ ] **Step 3: Run the configuration test and verify RED**

Run: `cd backend && npm test -- test/config.test.ts`

Expected: FAIL because `src/config.ts` does not exist.

- [ ] **Step 4: Implement minimal configuration parsing**

`AppConfig` contains `nodeEnv`, `host`, `port`, `databaseUrl`, and `redisUrl`. It defaults to `127.0.0.1:3001`, rejects an invalid port, and requires both URLs in every runtime except tests that inject resources.

- [ ] **Step 5: Run configuration tests and verify GREEN**

Run: `cd backend && npm test -- test/config.test.ts`

Expected: all configuration tests PASS.

- [ ] **Step 6: Write failing health endpoint tests**

```ts
test('live endpoint does not depend on external resources', async () => {
  const app = buildApp({ resources: failingResources, logger: false });
  const response = await app.inject({ method: 'GET', url: '/health/live' });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { status: 'live' });
});

test('ready endpoint fails closed when one resource is unavailable', async () => {
  const app = buildApp({ resources: failingResources, logger: false });
  const response = await app.inject({ method: 'GET', url: '/health/ready' });
  assert.equal(response.statusCode, 503);
  assert.deepEqual(response.json(), { status: 'not_ready' });
  assert.doesNotMatch(response.body, /postgres:|redis:|password/i);
});
```

- [ ] **Step 7: Run health tests and verify RED**

Run: `cd backend && npm test -- test/health.test.ts`

Expected: FAIL because `buildApp` is not defined.

- [ ] **Step 8: Implement the Fastify app and resource health boundary**

`/health/live` returns `{status:"live"}`. `/health/ready` checks PostgreSQL and Redis concurrently and returns only `{status:"ready"}` or `{status:"not_ready"}`. Configure logger redaction for:

```ts
[
  'req.headers.authorization',
  'req.headers.cookie',
  'databaseUrl',
  'redisUrl',
  '*.apiKey',
  '*.token',
]
```

- [ ] **Step 9: Run Task 1 gates**

Run:

```bash
cd backend
npm install --package-lock-only
npm ci
npm run typecheck
npm test
npm run build
```

Expected: every command exits 0.

- [ ] **Step 10: Commit Task 1**

```bash
git add backend/package.json backend/package-lock.json backend/tsconfig.json backend/src backend/test
git commit -m "feat(backend): add runtime and health foundation"
```

---

### Task 2: PostgreSQL migration and database test harness

**Files:**
- Create: `backend/migrations/0001_production_foundation.sql`
- Create: `backend/src/database/pool.ts`
- Create: `backend/src/database/migrate.ts`
- Create: `backend/src/database/transaction.ts`
- Create: `backend/test/helpers/database.ts`
- Create: `backend/test/migration.test.ts`
- Modify: `backend/package.json`

**Interfaces:**
- Produces: `createPool(connectionString: string): Pool`
- Produces: `migrate(pool: Pool): Promise<void>`
- Produces: `withTransaction<T>(pool: Pool, operation: (client: PoolClient) => Promise<T>): Promise<T>`

- [ ] **Step 1: Write a failing empty-database migration test**

The test must drop and recreate a unique schema, run `migrate`, and assert these tables exist:

```ts
const expected = [
  'sources',
  'source_policy_revisions',
  'active_source_policies',
  'patches',
  'patch_lifecycle_events',
  'catalog_revisions',
  'game_entities',
  'game_entity_revisions',
  'compatibility_rules',
  'raw_observations',
  'audit_events',
  'idempotency_records',
  'outbox_events',
];
```

- [ ] **Step 2: Run the migration test and verify RED**

Run: `cd backend && TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/hai_dau_test npm test -- test/migration.test.ts`

Expected: FAIL because the migration runner and SQL file do not exist.

- [ ] **Step 3: Write the migration**

The migration must:

- enable `pgcrypto`;
- use UUID primary keys;
- store every revision/history record with `created_at timestamptz not null`;
- enforce one active source-policy pointer per source;
- bind each catalog revision to one patch;
- bind each raw observation to a source and source-policy revision;
- constrain `storage_permission` to `blob_allowed`, `reference_only`, `aggregate_only`, or `prohibited`;
- constrain outbox delivery state to `pending`, `delivered`, `retryable_failed`, or `terminal_failed`;
- use unique `(scope, idempotency_key)` for idempotency records;
- use immutable payload columns for audit and outbox records.

Add database functions and triggers that reject `UPDATE` and `DELETE` on:

```sql
source_policy_revisions,
patch_lifecycle_events,
catalog_revisions,
game_entity_revisions,
compatibility_rules,
raw_observations,
audit_events
```

Outbox delivery columns and active pointer tables remain mutable projections.

- [ ] **Step 4: Implement migration and transaction helpers**

The migration runner applies files in lexical order inside one transaction and records the SHA-256 of each file in `schema_migrations`. A previously applied version with a different checksum must fail.

- [ ] **Step 5: Add failing immutability and rollback tests**

```ts
test('append-only history rejects update and delete', async () => {
  await assert.rejects(client.query('update audit_events set action = $1', ['changed']), /immutable/);
});

test('withTransaction rolls back all writes after an error', async () => {
  await assert.rejects(withTransaction(pool, async (client) => {
    await client.query(insertSourceSql, values);
    throw new Error('boom');
  }));
  assert.equal(await count(pool, 'sources'), 0);
});
```

- [ ] **Step 6: Run migration tests and verify GREEN**

Run: `cd backend && TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/hai_dau_test npm test -- test/migration.test.ts`

Expected: migration, checksum, immutability, and rollback tests PASS.

- [ ] **Step 7: Commit Task 2**

```bash
git add backend/migrations backend/src/database backend/test/helpers backend/test/migration.test.ts backend/package.json backend/package-lock.json
git commit -m "feat(backend): add production foundation migration"
```

---

### Task 3: Source policy, patch, and observation commands

**Files:**
- Create: `backend/src/shared/ids.ts`
- Create: `backend/src/shared/hash.ts`
- Create: `backend/src/shared/errors.ts`
- Create: `backend/src/modules/source-policy/activate-source-policy.ts`
- Create: `backend/src/modules/patch/register-patch-event.ts`
- Create: `backend/src/modules/collector/ingest-observation.ts`
- Create: `backend/test/source-policy.test.ts`
- Create: `backend/test/patch.test.ts`
- Create: `backend/test/observation.test.ts`

**Interfaces:**
- Produces: `activateSourcePolicy(client, command): Promise<{ revisionId: string }>`
- Produces: `registerPatchEvent(client, command): Promise<{ eventId: string }>`
- Produces: `ingestObservation(client, command): Promise<{ observationId: string; replayed: boolean; blobStored: boolean }>`

- [ ] **Step 1: Write failing source-policy transaction tests**

Prove a successful activation creates one revision, one current pointer, one audit event, and one outbox event. Inject a duplicate revision and prove all four counts remain unchanged.

- [ ] **Step 2: Run source-policy tests and verify RED**

Run: `cd backend && TEST_DATABASE_URL=... npm test -- test/source-policy.test.ts`

Expected: FAIL because `activateSourcePolicy` does not exist.

- [ ] **Step 3: Implement source registration and policy activation**

Activation accepts:

```ts
interface ActivateSourcePolicyCommand {
  commandId: string;
  actorId: string;
  sourceId: string;
  revisionId: string;
  storagePermission: 'blob_allowed' | 'reference_only' | 'aggregate_only' | 'prohibited';
  collectorEnabled: boolean;
  reason: string;
  occurredAt: Date;
}
```

The mutation, pointer replacement, audit row, and outbox row execute in one transaction.

- [ ] **Step 4: Run source-policy tests and verify GREEN**

Run: `cd backend && TEST_DATABASE_URL=... npm test -- test/source-policy.test.ts`

Expected: PASS.

- [ ] **Step 5: Write failing patch lifecycle tests**

Prove patch identity is owned by the Patch module, lifecycle events are append-only, and the audit/outbox records share the command correlation ID.

- [ ] **Step 6: Implement patch registration and verify GREEN**

Run: `cd backend && TEST_DATABASE_URL=... npm test -- test/patch.test.ts`

Expected: PASS.

- [ ] **Step 7: Write failing observation storage and idempotency tests**

Cover all four storage permissions:

- `blob_allowed`: reference and blob may be stored;
- `reference_only`: reference stored, blob forced to null;
- `aggregate_only`: raw reference and blob forced to null, permitted aggregate metadata stored;
- `prohibited`: command rejected with no observation, audit, outbox, or completed idempotency side effect.

Also prove:

- same key + same payload returns the original result with `replayed: true`;
- same key + different payload throws `IDEMPOTENCY_PAYLOAD_CONFLICT`;
- suspended/disabled policy rejects ingest;
- transaction failure creates no partial observation, audit, outbox, or completed idempotency row.

- [ ] **Step 8: Run observation tests and verify RED**

Run: `cd backend && TEST_DATABASE_URL=... npm test -- test/observation.test.ts`

Expected: FAIL because `ingestObservation` does not exist.

- [ ] **Step 9: Implement idempotent observation ingest**

Hash a canonical JSON payload with SHA-256. Lock the idempotency row and active source-policy pointer. Use database time for stored timestamps. Create `RawObservationIngested` in the outbox only after policy enforcement succeeds.

- [ ] **Step 10: Run Task 3 tests and verify GREEN**

Run:

```bash
cd backend
TEST_DATABASE_URL=... npm test -- test/source-policy.test.ts test/patch.test.ts test/observation.test.ts
npm run typecheck
```

Expected: all tests and typecheck PASS.

- [ ] **Step 11: Commit Task 3**

```bash
git add backend/src/shared backend/src/modules backend/test/source-policy.test.ts backend/test/patch.test.ts backend/test/observation.test.ts
git commit -m "feat(backend): enforce governed collection intake"
```

---

### Task 4: Retry-safe outbox dispatcher and BullMQ worker boundary

**Files:**
- Create: `backend/src/queue/names.ts`
- Create: `backend/src/queue/connection.ts`
- Create: `backend/src/queue/outbox-dispatcher.ts`
- Create: `backend/src/queue/normalization-worker.ts`
- Create: `backend/src/worker.ts`
- Create: `backend/test/outbox.test.ts`
- Create: `backend/test/worker.test.ts`
- Modify: `backend/package.json`

**Interfaces:**
- Produces: `dispatchOutbox(options): Promise<{ claimed: number; delivered: number; failed: number }>`
- Produces: `createNormalizationWorker(options): Worker`
- Consumes: outbox event ID as BullMQ `jobId`

- [ ] **Step 1: Write a failing dispatcher retry test**

Seed one pending outbox event, dispatch twice, and assert Redis contains one logical job whose ID equals the outbox event ID. Assert the database delivery projection is `delivered`.

- [ ] **Step 2: Run dispatcher test and verify RED**

Run: `cd backend && TEST_DATABASE_URL=... TEST_REDIS_URL=redis://127.0.0.1:6379 npm test -- test/outbox.test.ts`

Expected: FAIL because the dispatcher does not exist.

- [ ] **Step 3: Implement the dispatcher**

Claim rows with `FOR UPDATE SKIP LOCKED`, set a lease timestamp, enqueue with deterministic `jobId`, then mark delivery. A Redis error records `retryable_failed` and preserves the immutable payload.

- [ ] **Step 4: Run dispatcher test and verify GREEN**

Run the command from Step 2.

Expected: PASS with one logical job.

- [ ] **Step 5: Write failing worker acknowledgement tests**

Prove:

- worker success records one job attempt;
- retrying the same BullMQ job does not duplicate the effect;
- a database failure causes BullMQ retry and does not mark the attempt successful;
- the worker boundary cannot call publication commands because no publication dependency exists.

- [ ] **Step 6: Implement the normalization worker boundary**

The worker records an attempt and calls an injected `normalizeObservation(observationId)` application port. Sprint 2A supplies a no-op implementation that records `accepted_for_normalization`; Sprint 3 replaces the port implementation.

- [ ] **Step 7: Run Task 4 gates**

Run:

```bash
cd backend
TEST_DATABASE_URL=... TEST_REDIS_URL=redis://127.0.0.1:6379 npm test -- test/outbox.test.ts test/worker.test.ts
npm run typecheck
npm run build
```

Expected: all commands exit 0.

- [ ] **Step 8: Commit Task 4**

```bash
git add backend/src/queue backend/src/worker.ts backend/test/outbox.test.ts backend/test/worker.test.ts backend/package.json backend/package-lock.json
git commit -m "feat(backend): add retry-safe outbox delivery"
```

---

### Task 5: Repository integration and CI quality gate

**Files:**
- Create: `.github/workflows/backend-production-foundation.yml`
- Create: `backend/README.md`
- Modify: `package.json`
- Modify: `README.md`
- Test: existing frontend and moderation suites

**Interfaces:**
- Produces root scripts: `backend:typecheck`, `backend:test`, `backend:build`
- Produces a CI gate with PostgreSQL 17 and Redis 7

- [ ] **Step 1: Add root orchestration scripts**

```json
{
  "backend:typecheck": "npm --prefix backend run typecheck",
  "backend:test": "npm --prefix backend test",
  "backend:build": "npm --prefix backend run build"
}
```

Do not change the meaning of root `build`; it remains the canonical frontend Pages build.

- [ ] **Step 2: Add the CI workflow**

The workflow:

- runs on pull requests that change `backend/**`, the workflow, root package manifests, or project architecture docs;
- uses repository permission `contents: read`;
- starts `postgres:17` and `redis:7`;
- installs root and backend dependencies with `npm ci`;
- sets only CI-local test URLs;
- runs backend typecheck, tests, and build;
- runs root `validate:community`, `lint`, `test`, and `build`;
- checks `git status --short`;
- contains no deploy command and no write permission.

- [ ] **Step 3: Document local development and safety boundaries**

`backend/README.md` must describe:

- PostgreSQL 17 and Redis 7 prerequisites;
- test-only environment variables;
- migration and test commands;
- Source Policy storage-permission behavior;
- no AI, publication, production credentials, or deployment in Sprint 2A;
- Redis loss recovery from PostgreSQL outbox state.

- [ ] **Step 4: Run the complete local gate**

Run:

```bash
npm ci --cache /tmp/aram-root-npm-cache
npm run validate:community
npm run lint
npm test
npm run build
npm --prefix backend ci --cache /tmp/aram-backend-npm-cache
npm run backend:typecheck
TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/hai_dau_test \
TEST_REDIS_URL=redis://127.0.0.1:6379 \
npm run backend:test
npm run backend:build
git diff --check
git status --short
```

Expected: every executable gate exits 0; `git status` lists only intended Sprint 2A files.

- [ ] **Step 5: Self-review architecture and security**

Verify explicitly:

- no spike import;
- no production URL or credential;
- no workflow write permission or deploy command;
- no AI-to-publication path;
- immutable tables reject update/delete;
- source policy governs every observation representation;
- outbox payload remains durable when Redis fails;
- frontend root build contract is unchanged.

- [ ] **Step 6: Commit Task 5**

```bash
git add .github/workflows/backend-production-foundation.yml backend/README.md package.json README.md
git commit -m "ci(backend): verify production foundation"
```

- [ ] **Step 7: Push the feature branch and open a draft PR**

Branch: `feat/2a-production-foundation`

Draft PR title: `feat(backend): establish production foundation`

The PR must target `main`, remain draft, and state that no merge or deployment is authorized.

- [ ] **Step 8: Verify GitHub Actions**

Wait for every required workflow at the durable head SHA. Download and inspect failing logs if any. Fix ordinary code, test, lint, build, or CI errors within scope. Do not weaken an invariant or test to obtain green status.

## Plan self-review

- Spec coverage: runtime, configuration, migrations, source policy, patch, governed ingest, audit, idempotency, outbox, BullMQ, security, and CI each have an implementation task.
- Placeholder scan: no `TBD`, `TODO`, “implement later,” or undefined neighboring interface remains.
- Type consistency: Task 1 resource ports are consumed by runtime; Task 2 transaction helpers are consumed by Tasks 3–4; Task 3 outbox rows are consumed by Task 4; Task 5 invokes the exact scripts introduced in Tasks 1 and 4.
- Scope check: normalization, candidate, Evidence, AI, review, publication, infrastructure, and deployment are explicitly deferred.
