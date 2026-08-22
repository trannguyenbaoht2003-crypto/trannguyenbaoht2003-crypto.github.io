# Sprint 8F — AI Automation Production Delivery Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the existing AI automation runtime into the production Railway delivery topology as a private, exact-SHA-deployed service that proves it is running safely with the scheduler disabled and no provider-spend authority.

**Architecture:** Reuse the existing backend Docker image and dedicated `ai-automation-worker` entrypoint. Production deployment captures the exact Railway deployment ID from `railway up --detach --json`, verifies that same deployment to terminal `SUCCESS`, and for the AI service additionally verifies an exact-deployment disabled-ready marker before the gateway is deployed. The runtime remains inert: scheduler disabled, provider factory not called, no OpenAI credential required, no public AI endpoint, and no downstream Candidate/Evidence/Publication authority.

**Tech Stack:** Node.js >=22.13.0, TypeScript 5.9.3, PostgreSQL 17, Redis 7, BullMQ 5.80.11, ioredis 5.11.1, Railway CLI 5.30.1, GitHub Actions, Node test runner.

**Spec:** `docs/superpowers/specs/2026-08-21-ai-automation-production-delivery-readiness-design.md`

## Global Constraints

- Implementation starts from approved design head `7eb0f3a776c60bc3198476317f1c96988b6831b5`.
- `AI_DISCOVERY_SCHEDULER_ENABLED=false` remains the production default throughout Sprint 8F.
- No production `OPENAI_API_KEY`, production model configuration, provider endpoint override, scheduler activation, or AI-operations policy activation is added.
- No real OpenAI request is made by implementation or CI.
- No real Railway production deployment is run by implementation or CI.
- `ai-automation` is a private Railway service with no public domain and no HTTP health/status endpoint.
- `ai-automation` reuses `backend/Dockerfile`; do not create a dedicated AI Dockerfile/image/package/repository.
- AI runtime start command is exactly `node dist/src/ai-automation-worker.js`.
- Disabled-ready marker is exactly `AI_AUTOMATION_DISABLED_READY scheduler_enabled=false provider_configured=false`.
- The marker is emitted only after stale 8E recovery, scheduler reconciliation to disabled, and BullMQ worker readiness.
- Disabled mode must not construct a provider even if dummy provider-related environment variables are present.
- Railway CLI stays pinned to `@railway/cli@5.30.1`.
- Deployment creation uses `railway up --detach --json`; deployment identity comes only from returned `deploymentId`.
- Never infer a deployment by `latest`, timestamps, sleep-and-select, or list ordering.
- Exact deployment polling interval is 5 seconds; per-deployment timeout is 900 seconds.
- Exact AI marker polling interval is 5 seconds; marker timeout is 120 seconds.
- Production deploy job timeout is exactly 90 minutes.
- Release order is backend -> core worker -> collector -> ai-automation -> gateway; each deployment must verify `SUCCESS` before the next deployment is created.
- `gateway` remains the only public Railway service and remains the final application deployment step.
- Missing `RAILWAY_AI_AUTOMATION_SERVICE` fails before the first Railway mutation.
- Production workflow must not contain an AI activation input or reference OpenAI credentials.
- Public production smoke remains unchanged; do not add `/api/ai/*`, `/health/ai-*`, or public operator endpoints.
- Existing 8E recovery semantics remain unchanged; unresolved `UNCERTAIN` history is an activation warning, not an inert-deployment blocker.
- No Candidate, Human Review, Moderation, Eligibility, Evidence, or Publication authority is added to the AI delivery path.
- Repository completion marker is `AI_AUTOMATION_PRODUCTION_REPO_READY`; do not emit `AI_AUTOMATION_DISABLED_DELIVERY_READY` without a separately authorized real Railway production deployment.
- First implementation commit MUST contain RED tests/contracts only.

---

## File Map

### New production/release files

- `backend/railway.ai-automation.toml` — Railway config for the private AI automation service, reusing the backend Dockerfile.
- `scripts/verify-railway-deployment.mjs` — read-only exact-deployment status and marker verifier used by the production release gate.
- `.github/workflows/sprint-8f-ai-automation-production-delivery.yml` — repository-only Sprint 8F CI gate; never deploys Railway or calls OpenAI.

### New test files

- `tests/ai-automation-production-delivery-contract.test.mjs` — static production-topology/authority contract for Sprint 8F.
- `tests/verify-railway-deployment.test.mjs` — verifier behavior tests using a fake `railway` executable in `PATH`.
- `backend/integration/ai-automation-disabled-runtime.test.ts` — compiled-runtime integration: real Postgres/Redis, stale scheduler cleanup, READY marker, process liveness, graceful SIGTERM.

### Existing application/config files modified

- `backend/src/ai-automation-worker.ts` — provider-construction boundary, `worker.waitUntilReady()`, disabled-ready marker.
- `backend/test/ai-discovery-automation-queue.test.ts` — provider-factory zero-call and enabled one-call unit regression.
- `deploy/production/production.env.example` — document `AI_DISCOVERY_SCHEDULER_ENABLED=false`; no provider placeholders.

### Existing release/test files modified

- `.github/workflows/production-release-gate.yml` — exact deployment IDs, per-service verification, AI service binding, AI marker verification, 90-minute deploy job.
- `tests/production-delivery.test.mjs` — replace `railway up --ci` assumptions with exact-ID/readiness semantics.
- `package.json` — add `test:ai-automation-production-delivery` and wire it into root regression before production/release contracts.

### Existing docs modified

- `docs/runbooks/production-delivery.md` — seventh service, bootstrap, exact deployment verification, release order, rollback/evidence states.
- `docs/runbooks/ai-discovery-automation.md` — production-disabled delivery and correct 8E retry semantics.
- `docs/runbooks/ai-provider-execution-recovery.md` — production-inert deployment compatibility while preserving recovery/history boundaries.

### Files intentionally not modified

- `backend/Dockerfile` — same backend image is reused.
- `backend/src/server.ts` and public HTTP routes — no AI HTTP surface.
- `backend/src/worker.ts` — core worker remains provider-free.
- database migrations/domain tables — Sprint 8F adds no schema/domain authority.
- `deploy/staging/compose.yml` — 8F production delivery does not alter staging topology.

---

### Task 0: RED-only Sprint 8F contract baseline

**Files:**
- Create: `tests/ai-automation-production-delivery-contract.test.mjs`
- Create: `tests/verify-railway-deployment.test.mjs`
- Create: `backend/integration/ai-automation-disabled-runtime.test.ts`
- Modify: `tests/production-delivery.test.mjs`
- Modify: `backend/test/ai-discovery-automation-queue.test.ts`

**Interfaces:**
- Consumes current 8D/8E runtime and production-delivery surface.
- Produces failing contracts for the exact file names, marker, provider helper, verifier CLI, deployment ordering, and disabled-runtime integration implemented by later tasks.

- [ ] **Step 1: Add the Sprint 8F repository contract as a failing test.**

Create assertions equivalent to:

```js
const REQUIRED = [
  'backend/railway.ai-automation.toml',
  'scripts/verify-railway-deployment.mjs',
  '.github/workflows/sprint-8f-ai-automation-production-delivery.yml',
];

for (const path of REQUIRED) {
  assert.equal(await exists(path), true, `missing Sprint 8F artifact: ${path}`);
}

const workflow = await readFile('.github/workflows/production-release-gate.yml', 'utf8');
assert.match(workflow, /RAILWAY_AI_AUTOMATION_SERVICE/);
assert.match(workflow, /railway up --detach --json/);
assert.match(workflow, /status-and-disabled-marker/);
assert.doesNotMatch(workflow, /OPENAI_API_KEY|AI_DISCOVERY_SCHEDULER_ENABLED\s*=\s*true/);
assert.doesNotMatch(workflow, /--latest|railway logs --latest/);
```

Also assert the AI Railway config reuses `Dockerfile`, starts `node dist/src/ai-automation-worker.js`, contains no healthcheck path, and no separate `backend/Dockerfile.ai*` exists.

- [ ] **Step 2: Update production-delivery contract to express the future exact-deployment semantics.**

Replace the old assertion that merely requires `railway up --ci` with assertions requiring:

```js
assert.match(workflow, /railway up --detach --json/);
assert.match(workflow, /RAILWAY_AI_AUTOMATION_SERVICE/);
assert.match(workflow, /verify-railway-deployment\.mjs/);
assert.match(workflow, /timeout-minutes:\s*90/);
assert.doesNotMatch(workflow, /railway up --ci/);
```

Require backend, worker, collector, AI, and gateway service variables, and assert first occurrence ordering:

```js
const backend = workflow.indexOf('RAILWAY_BACKEND_SERVICE');
const worker = workflow.indexOf('RAILWAY_WORKER_SERVICE', backend + 1);
const collector = workflow.indexOf('RAILWAY_COLLECTOR_SERVICE', worker + 1);
const ai = workflow.indexOf('RAILWAY_AI_AUTOMATION_SERVICE', collector + 1);
const gateway = workflow.indexOf('RAILWAY_GATEWAY_SERVICE', ai + 1);
assert.ok(backend < worker && worker < collector && collector < ai && ai < gateway);
```

Use deploy-step names or exact service-specific `railway up` blocks for the final GREEN assertion if variable declarations make this initial ordering selector ambiguous.

- [ ] **Step 3: Add provider-construction RED expectations to the existing 8D queue test.**

Import future approved names:

```ts
import {
  createAiAutomationProvider,
} from '../src/ai-automation-worker.js';
import type { AiDiscoveryProvider } from '../src/modules/ai-provider/openai-responses-provider.js';
```

Assert disabled zero-call and enabled one-call:

```ts
let calls = 0;
const fakeProvider = { providerKey: 'fake', async execute() { throw new Error('not-called'); } } satisfies AiDiscoveryProvider;
const factory = () => { calls += 1; return fakeProvider; };

const disabled = parseAiAutomationConfig({ DATABASE_URL: 'postgres://x', REDIS_URL: 'redis://x' });
assert.equal(createAiAutomationProvider(disabled, factory), undefined);
assert.equal(calls, 0);
```

For enabled config, provide dummy valid provider settings and assert returned provider identity and `calls === 1`.

- [ ] **Step 4: Add verifier RED tests using a fake Railway executable.**

Test the future CLI shape:

```bash
node scripts/verify-railway-deployment.mjs \
  --mode status-only \
  --project project-1 \
  --environment production \
  --service backend \
  --deployment-id dep-1
```

The fake executable must record argv and emit controlled JSON for `deployment list --json`. Cases: exact ID SUCCESS, BUILDING->SUCCESS, target temporarily absent->SUCCESS, FAILED/CRASHED/REMOVED/REMOVING failure, unknown status failure, malformed JSON failure, and a list containing another successful deployment while the target ID is absent.

For `status-and-disabled-marker`, fake `railway logs dep-1 --deployment --json --lines 200 ...` and test exact trimmed marker acceptance plus near-match rejection.

- [ ] **Step 5: Add the compiled-runtime integration test source.**

The test lives outside `backend/test/**/*.test.ts`, so default backend tests do not require `dist/`. It will later run only after build/migrate. Test structure:

```ts
const queue = new Queue(AI_DISCOVERY_AUTOMATION_QUEUE_NAME, { connection });
await queue.upsertJobScheduler(
  AI_DISCOVERY_SCHEDULER_ID,
  { every: AI_DISCOVERY_SCHEDULER_EVERY_MS },
  { name: 'scheduled-ai-discovery', data: { schemaVersion: 1 }, opts: { attempts: 1 } },
);

const child = spawn(process.execPath, ['dist/src/ai-automation-worker.js'], {
  cwd: backendRoot,
  env: {
    ...process.env,
    DATABASE_URL: testDatabaseUrl,
    REDIS_URL: testRedisUrl,
    AI_DISCOVERY_SCHEDULER_ENABLED: 'false',
    OPENAI_API_KEY: 'dummy-must-be-ignored',
  },
});
```

Wait for the exact READY line, assert the child is still alive, assert the scheduler ID is absent from `queue.getJobSchedulers(0, 100, true)`, send SIGTERM, and require clean exit.

- [ ] **Step 6: Run RED verification.**

```bash
node --test tests/ai-automation-production-delivery-contract.test.mjs tests/verify-railway-deployment.test.mjs
npm --prefix backend run typecheck
cd backend && node --import tsx --test --test-concurrency=1 test/ai-discovery-automation-queue.test.ts
```

Expected: FAIL only for missing Sprint 8F config/verifier/workflow/export/readiness capability. `backend/integration/ai-automation-disabled-runtime.test.ts` is source-only in this first RED pass because compiled runtime support has not been implemented yet.

- [ ] **Step 7: Commit RED only.**

```bash
git add \
  tests/ai-automation-production-delivery-contract.test.mjs \
  tests/verify-railway-deployment.test.mjs \
  tests/production-delivery.test.mjs \
  backend/integration/ai-automation-disabled-runtime.test.ts \
  backend/test/ai-discovery-automation-queue.test.ts
git commit -m "test: define Sprint 8F production delivery contracts"
```

**Gate:** inspect diff; this first implementation commit must contain no `backend/src`, Railway config, release workflow, package script, runbook, or verifier implementation.

---

### Task 1: Add the private Railway AI automation service contract

**Files:**
- Create: `backend/railway.ai-automation.toml`
- Modify: `deploy/production/production.env.example`
- Test: `tests/ai-automation-production-delivery-contract.test.mjs`
- Test: `tests/production-delivery.test.mjs`

**Interfaces:**
- Produces a seventh private Railway service config consumed by the production release workflow.
- Production env contract exposes only DB/Redis plus scheduler disabled default; no provider settings.

- [ ] **Step 1: Run the focused service-config RED tests.**

```bash
node --test tests/ai-automation-production-delivery-contract.test.mjs tests/production-delivery.test.mjs
```

Expected: FAIL because `backend/railway.ai-automation.toml` and scheduler-disabled production env documentation are missing.

- [ ] **Step 2: Create `backend/railway.ai-automation.toml`.**

Use exactly:

```toml
[build]
builder = "DOCKERFILE"
dockerfilePath = "Dockerfile"

[deploy]
startCommand = "node dist/src/ai-automation-worker.js"
restartPolicyType = "ON_FAILURE"
restartPolicyMaxRetries = 3
```

Do not add `healthcheckPath`, public port, pre-deploy provider logic, or a new Dockerfile.

- [ ] **Step 3: Update the production environment example.**

Add exactly:

```text
AI_DISCOVERY_SCHEDULER_ENABLED=false
```

Keep existing DB/Redis reference variables. Assert the file does not contain `OPENAI_API_KEY`, `OPENAI_MODEL`, `OPENAI_BASE_URL`, or provider endpoint placeholders.

- [ ] **Step 4: Re-run focused contracts.**

```bash
node --test tests/ai-automation-production-delivery-contract.test.mjs tests/production-delivery.test.mjs
```

Expected: service/env assertions PASS; workflow/runtime/verifier assertions may remain RED for later tasks.

- [ ] **Step 5: Commit.**

```bash
git add backend/railway.ai-automation.toml deploy/production/production.env.example tests/ai-automation-production-delivery-contract.test.mjs tests/production-delivery.test.mjs
git commit -m "feat: define private AI automation production service"
```

---

### Task 2: Make disabled runtime readiness positive and provider-free

**Files:**
- Modify: `backend/src/ai-automation-worker.ts`
- Modify: `backend/test/ai-discovery-automation-queue.test.ts`

**Interfaces:**
- Consumes `AiAutomationConfig`, `OpenAiResponsesProviderConfig`, `AiDiscoveryProvider`, and existing worker/scheduler factories.
- Produces:

```ts
export type AiAutomationProviderFactory = (
  config: OpenAiResponsesProviderConfig,
) => AiDiscoveryProvider;

export function createAiAutomationProvider(
  config: AiAutomationConfig,
  factory: AiAutomationProviderFactory,
): AiDiscoveryProvider | undefined;
```

- `startAiAutomationRuntime()` uses the helper and awaits `worker.waitUntilReady()` before returning.
- Disabled mode writes exactly one READY marker after all initialization has succeeded.

- [ ] **Step 1: Run provider-helper RED test.**

```bash
cd backend && node --import tsx --test --test-concurrency=1 test/ai-discovery-automation-queue.test.ts
```

Expected: FAIL on missing `createAiAutomationProvider` export.

- [ ] **Step 2: Implement `createAiAutomationProvider`.**

Add imports/types and exactly this control shape:

```ts
export type AiAutomationProviderFactory = (
  config: OpenAiResponsesProviderConfig,
) => AiDiscoveryProvider;

export function createAiAutomationProvider(
  config: AiAutomationConfig,
  factory: AiAutomationProviderFactory,
): AiDiscoveryProvider | undefined {
  if (!config.schedulerEnabled) return undefined;
  return factory(config.providerConfig!);
}
```

`startAiAutomationRuntime()` calls:

```ts
const provider = createAiAutomationProvider(config, createOpenAiResponsesProvider);
```

Do not inspect `OPENAI_API_KEY` directly in this module.

- [ ] **Step 3: Await BullMQ worker readiness before declaring startup success.**

After creating the worker:

```ts
await worker.waitUntilReady();
```

This must occur after stale recovery and `reconcileAiDiscoveryScheduler(queue, config.schedulerEnabled)`.

- [ ] **Step 4: Emit the marker only for disabled mode and only after readiness.**

Use exactly:

```ts
if (!config.schedulerEnabled) {
  process.stdout.write(
    'AI_AUTOMATION_DISABLED_READY scheduler_enabled=false provider_configured=false\n',
  );
}
```

Place it after `await worker.waitUntilReady()`. Enabled mode emits no disabled marker.

- [ ] **Step 5: Preserve startup cleanup and shutdown behavior.**

If `waitUntilReady()` or any earlier initialization fails, the existing catch cleanup must close queue/connections/pool and no READY marker may have been written. Keep bounded `AI_AUTOMATION_START_FAILED` / `AI_AUTOMATION_SHUTDOWN_FAILED` messages.

- [ ] **Step 6: Run GREEN tests and inherited 8D/8E source contracts.**

```bash
npm --prefix backend run typecheck
cd backend && node --import tsx --test --test-concurrency=1 test/ai-discovery-automation-queue.test.ts
cd .. && npm run test:ai-discovery-automation && npm run test:ai-provider-execution-recovery
```

Expected: PASS.

- [ ] **Step 7: Commit.**

```bash
git add backend/src/ai-automation-worker.ts backend/test/ai-discovery-automation-queue.test.ts
git commit -m "feat: expose disabled AI automation readiness"
```

---

### Task 3: Implement exact Railway deployment verification

**Files:**
- Create: `scripts/verify-railway-deployment.mjs`
- Test: `tests/verify-railway-deployment.test.mjs`

**Interfaces:**
- CLI:

```text
node scripts/verify-railway-deployment.mjs \
  --mode <status-only|status-and-disabled-marker> \
  --project <bounded-id> \
  --environment <bounded-id-or-name> \
  --service <bounded-id-or-name> \
  --deployment-id <bounded-id>
```

- Export constants/functions for deterministic tests:

```js
export const STATUS_POLL_INTERVAL_MS = 5_000;
export const STATUS_TIMEOUT_MS = 900_000;
export const MARKER_POLL_INTERVAL_MS = 5_000;
export const MARKER_TIMEOUT_MS = 120_000;
export const DISABLED_READY_MARKER = 'AI_AUTOMATION_DISABLED_READY scheduler_enabled=false provider_configured=false';

export async function verifyRailwayDeployment(input, dependencies = {});
```

- Default dependencies execute Railway with argument arrays, sleep with `setTimeout`, and use `Date.now()`.

- [ ] **Step 1: Run verifier RED tests.**

```bash
node --test tests/verify-railway-deployment.test.mjs
```

Expected: FAIL because verifier script does not exist.

- [ ] **Step 2: Implement strict CLI parsing and bounded identifiers.**

Accept only the five named flags above; reject duplicates, missing values, extra positional arguments, unknown modes, blank values, and identifiers longer than 128 characters. Do not accept an arbitrary expected marker.

- [ ] **Step 3: Implement a shell-free Railway command runner.**

Use `spawn` with an argument array:

```js
spawn('railway', args, {
  env: process.env,
  stdio: ['ignore', 'pipe', 'pipe'],
  shell: false,
});
```

Bound captured stdout/stderr to 1 MiB each and reject overflow. On nonzero exit, emit only a bounded verifier error code; do not dump raw Railway output.

- [ ] **Step 4: Implement exact-ID status polling.**

Execute:

```js
[
  'deployment', 'list', '--json',
  '--project', project,
  '--environment', environment,
  '--service', service,
  '--limit', '1000',
]
```

Parse a JSON array, find only `entry.id === deploymentId`, and handle statuses:

```js
const NON_TERMINAL = new Set(['BUILDING', 'DEPLOYING', 'INITIALIZING', 'WAITING', 'QUEUED']);
const FAIL_TERMINAL = new Set(['FAILED', 'CRASHED', 'REMOVING', 'REMOVED']);
```

`SUCCESS` returns. Target absent or nonterminal sleeps 5 seconds and retries the same ID until 900-second deadline. Unknown status fails closed immediately.

- [ ] **Step 5: Implement exact-deployment marker polling.**

For `status-and-disabled-marker`, after status SUCCESS run:

```js
[
  'logs', deploymentId,
  '--deployment', '--json', '--lines', '200',
  '--project', project,
  '--environment', environment,
  '--service', service,
]
```

Parse newline-delimited JSON log records, inspect only a string `message` field, and accept only `message.trim() === DISABLED_READY_MARKER`. Retry the same deployment logs every 5 seconds for at most 120 seconds.

- [ ] **Step 6: Keep verifier output bounded.**

Success output is only:

```text
railway-deployment: SUCCESS service=<bounded-service> deployment_id=<bounded-id>
```

and, for marker mode:

```text
AI_AUTOMATION_DISABLED_DEPLOYMENT_VERIFIED deployment_id=<bounded-id>
```

Never print Railway raw JSON/logs, private hosts, env values, DB/Redis URLs, or credentials.

- [ ] **Step 7: Run GREEN verifier tests.**

```bash
node --test tests/verify-railway-deployment.test.mjs
```

Expected: PASS all success/failure/absent-ID/marker cases using the fake Railway executable.

- [ ] **Step 8: Commit.**

```bash
git add scripts/verify-railway-deployment.mjs tests/verify-railway-deployment.test.mjs
git commit -m "feat: verify exact Railway deployment readiness"
```

---

### Task 4: Upgrade the production release gate to verified exact-deployment sequencing

**Files:**
- Modify: `.github/workflows/production-release-gate.yml`
- Modify: `tests/production-delivery.test.mjs`
- Test: `tests/ai-automation-production-delivery-contract.test.mjs`

**Interfaces:**
- Consumes `scripts/verify-railway-deployment.mjs` from Task 3.
- Adds production environment variable `RAILWAY_AI_AUTOMATION_SERVICE`.
- Each deploy step exposes exactly one `deployment_id` via `$GITHUB_OUTPUT`.
- Verifier modes: normal services `status-only`; AI service `status-and-disabled-marker`.

- [ ] **Step 1: Run production workflow RED contracts.**

```bash
node --test tests/production-delivery.test.mjs tests/ai-automation-production-delivery-contract.test.mjs
```

Expected: FAIL on old `railway up --ci`, missing AI binding, and missing exact-ID verification sequence.

- [ ] **Step 2: Add the AI service binding and fail-before-mutation validation.**

Add:

```yaml
RAILWAY_AI_AUTOMATION_SERVICE: ${{ vars.RAILWAY_AI_AUTOMATION_SERVICE }}
```

Include it in the existing pre-deploy binding loop before any Railway mutation:

```bash
for name in \
  RAILWAY_TOKEN RAILWAY_PROJECT_ID RAILWAY_ENVIRONMENT \
  RAILWAY_BACKEND_SERVICE RAILWAY_WORKER_SERVICE \
  RAILWAY_COLLECTOR_SERVICE RAILWAY_AI_AUTOMATION_SERVICE \
  RAILWAY_GATEWAY_SERVICE PRODUCTION_BASE_URL; do
  if [ -z "${!name:-}" ]; then
    echo "production-release: required Railway/GitHub binding is missing: ${name}" >&2
    exit 1
  fi
done
```

No OpenAI variable is added.

- [ ] **Step 3: Set production deploy job timeout exactly to 90 minutes.**

```yaml
timeout-minutes: 90
```

Keep `environment: production`, read-only repository permissions, exact SHA re-verification, and pinned Railway CLI `5.30.1`.

- [ ] **Step 4: Replace each `railway up --ci` block with detached exact-ID creation.**

Use this pattern for each service with a unique step id:

```yaml
- name: Deploy backend from exact tree
  id: deploy_backend
  shell: bash
  run: |
    set -euo pipefail
    payload="$(railway up --detach --json \
      --project "$RAILWAY_PROJECT_ID" \
      --environment "$RAILWAY_ENVIRONMENT" \
      --service "$RAILWAY_BACKEND_SERVICE" \
      --message "release ${RELEASE_SHA} backend")"
    deployment_id="$(printf '%s' "$payload" | node --input-type=module -e '
      let raw="";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", chunk => raw += chunk);
      process.stdin.on("end", () => {
        let value;
        try { value = JSON.parse(raw); } catch { process.exit(1); }
        const id = value?.deploymentId;
        if (typeof id !== "string" || id.length < 1 || id.length > 128 || !/^[A-Za-z0-9-]+$/.test(id)) process.exit(1);
        process.stdout.write(id);
      });
    ')"
    test -n "$deployment_id"
    echo "deployment_id=$deployment_id" >> "$GITHUB_OUTPUT"
```

Do not echo `payload` or `logsUrl`.

- [ ] **Step 5: Add a verify step immediately after each deploy step.**

Normal services:

```yaml
- name: Verify backend exact deployment
  run: >-
    node scripts/verify-railway-deployment.mjs
    --mode status-only
    --project "$RAILWAY_PROJECT_ID"
    --environment "$RAILWAY_ENVIRONMENT"
    --service "$RAILWAY_BACKEND_SERVICE"
    --deployment-id "${{ steps.deploy_backend.outputs.deployment_id }}"
```

Repeat for core worker and collector before creating the next deployment.

- [ ] **Step 6: Add AI deployment and disabled-marker verification before gateway.**

AI deploy creation uses message `release ${RELEASE_SHA} ai-automation`, then:

```yaml
- name: Verify AI automation exact disabled deployment
  run: >-
    node scripts/verify-railway-deployment.mjs
    --mode status-and-disabled-marker
    --project "$RAILWAY_PROJECT_ID"
    --environment "$RAILWAY_ENVIRONMENT"
    --service "$RAILWAY_AI_AUTOMATION_SERVICE"
    --deployment-id "${{ steps.deploy_ai_automation.outputs.deployment_id }}"
```

Only after this passes may the gateway deploy step run.

- [ ] **Step 7: Verify gateway exact deployment before public smoke.**

Gateway uses the same detached/exact-ID/status-only pattern. Keep `npm run production:smoke` and `npm run production:browser-smoke` unchanged after gateway verification.

- [ ] **Step 8: Add repository readiness evidence without claiming real delivery in CI.**

The workflow may retain the existing real-deploy completion line after actual production smoke, and add an AI-specific real-delivery line only in this actual deploy job:

```bash
echo "AI_AUTOMATION_DISABLED_DELIVERY_READY release_sha=${RELEASE_SHA}"
```

Do not place this marker in repository-only CI workflows. Keep `AI_DISCOVERY_PRODUCTION_ACTIVE` absent everywhere.

- [ ] **Step 9: Strengthen static production contracts.**

Tests must assert:

```js
assert.doesNotMatch(workflow, /railway up --ci/);
assert.doesNotMatch(workflow, /--latest|railway logs --latest/);
assert.doesNotMatch(workflow, /OPENAI_API_KEY|OPENAI_MODEL|OPENAI_BASE_URL/);
assert.doesNotMatch(workflow, /enable_ai|activate_ai|scheduler_enabled.*true/i);
assert.match(workflow, /timeout-minutes:\s*90/);
```

Assert step-name order:

```text
Deploy backend -> Verify backend -> Deploy worker -> Verify worker -> Deploy collector -> Verify collector -> Deploy AI -> Verify AI -> Deploy gateway -> Verify gateway -> Production HTTP smoke -> Production browser smoke
```

- [ ] **Step 10: Run GREEN production contracts.**

```bash
node --test \
  tests/production-delivery.test.mjs \
  tests/ai-automation-production-delivery-contract.test.mjs \
  tests/verify-railway-deployment.test.mjs
npm run test:production-pr-validation
```

Expected: PASS. PR validation must still prove no Railway deployment occurs in the normal PR foundation workflow.

- [ ] **Step 11: Commit.**

```bash
git add .github/workflows/production-release-gate.yml tests/production-delivery.test.mjs tests/ai-automation-production-delivery-contract.test.mjs
git commit -m "feat: gate production releases on exact Railway deployments"
```

---

### Task 5: Prove the compiled disabled runtime against real Postgres and Redis

**Files:**
- Test: `backend/integration/ai-automation-disabled-runtime.test.ts`
- Production source already modified by Task 2.

**Interfaces:**
- Consumes built `backend/dist/src/ai-automation-worker.js`.
- Requires `TEST_DATABASE_URL` and `TEST_REDIS_URL`.
- Produces positive evidence that the compiled process starts without provider configuration, removes a stale scheduler before READY, remains alive, and shuts down cleanly.

- [ ] **Step 1: Build and migrate before running the integration test.**

```bash
npm --prefix backend run build
DATABASE_URL="$TEST_DATABASE_URL" npm --prefix backend run migrate
```

Expected: PASS with current migrations including 8E journal.

- [ ] **Step 2: Complete the integration-test helpers.**

Use backend-installed BullMQ/ioredis and a bounded `waitForLine(child.stdout, expected, 15_000)` helper. The test must fail with captured bounded stderr if READY does not appear.

- [ ] **Step 3: Seed the exact stale scheduler.**

Use:

```ts
await queue.upsertJobScheduler(
  AI_DISCOVERY_SCHEDULER_ID,
  { every: AI_DISCOVERY_SCHEDULER_EVERY_MS },
  {
    name: 'scheduled-ai-discovery',
    data: { schemaVersion: 1 },
    opts: { attempts: 1 },
  },
);
```

Assert it exists before spawning the runtime.

- [ ] **Step 4: Spawn the compiled runtime with scheduler disabled and dummy provider noise.**

Child env must include:

```ts
DATABASE_URL: testDatabaseUrl,
REDIS_URL: testRedisUrl,
AI_DISCOVERY_SCHEDULER_ENABLED: 'false',
OPENAI_API_KEY: 'dummy-must-be-ignored',
OPENAI_MODEL: 'dummy-must-be-ignored',
```

The test succeeds only if the exact READY marker appears despite these dummy values.

- [ ] **Step 5: Verify stale scheduler is absent after READY.**

Query `queue.getJobSchedulers(0, 100, true)` and assert no entry matches `AI_DISCOVERY_SCHEDULER_ID`. This proves READY follows reconciliation, not just config parsing.

- [ ] **Step 6: Verify process liveness and graceful SIGTERM.**

Before SIGTERM:

```ts
assert.equal(child.exitCode, null);
```

Then:

```ts
child.kill('SIGTERM');
const [code, signal] = await once(child, 'close');
assert.equal(signal, null);
assert.equal(code, 0);
```

Use test cleanup to kill the child and close Queue/Redis even on assertion failure.

- [ ] **Step 7: Run the integration test.**

```bash
cd backend && node --import tsx --test --test-concurrency=1 integration/ai-automation-disabled-runtime.test.ts
```

Expected: PASS with Postgres/Redis available; no OpenAI request or provider config required.

- [ ] **Step 8: Run the focused runtime suite.**

```bash
cd backend && node --import tsx --test --test-concurrency=1 \
  test/ai-discovery-automation-queue.test.ts \
  integration/ai-automation-disabled-runtime.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit integration test completion.**

```bash
git add backend/integration/ai-automation-disabled-runtime.test.ts
git commit -m "test: verify disabled AI automation runtime readiness"
```

---

### Task 6: Wire Sprint 8F contracts into the root regression

**Files:**
- Modify: `package.json`
- Modify: `tests/ai-automation-production-delivery-contract.test.mjs`
- Modify: `tests/production-delivery.test.mjs`
- Modify: `tests/ai-discovery-automation-contract.test.mjs` only to lock corrected runbook semantics added in Task 7; do not change its existing prefix-order assertion before Task 7.

**Interfaces:**
- Produces root script:

```json
"test:ai-automation-production-delivery": "node --test tests/ai-automation-production-delivery-contract.test.mjs tests/verify-railway-deployment.test.mjs"
```

- Root `npm test` invokes it before `test:production-contract` and `test:release-source` while preserving the existing 8E->8D prefix required by the 8D contract.

- [ ] **Step 1: Add the package-script RED assertion.**

In the 8F contract assert:

```js
const packageJson = JSON.parse(await readFile('package.json', 'utf8'));
assert.equal(
  packageJson.scripts['test:ai-automation-production-delivery'],
  'node --test tests/ai-automation-production-delivery-contract.test.mjs tests/verify-railway-deployment.test.mjs',
);
assert.match(packageJson.scripts.test, /npm run test:ai-automation-production-delivery/);
```

Run:

```bash
node --test tests/ai-automation-production-delivery-contract.test.mjs
```

Expected: FAIL on missing package script.

- [ ] **Step 2: Add the root script without breaking inherited ordering.**

Add the exact script above. In root `test`, place:

```text
... test:public-data
&& npm run test:ai-automation-production-delivery
&& npm run test:staging-contract
&& npm run test:release-source
&& npm run test:production-contract
...
```

Do not change the beginning:

```text
npm run test:ai-provider-execution-recovery && npm run test:ai-discovery-automation && ...
```

- [ ] **Step 3: Run root contract subset.**

```bash
npm run test:ai-automation-production-delivery
npm run test:ai-discovery-automation
npm run test:production-contract
npm run test:production-pr-validation
```

Expected: PASS.

- [ ] **Step 4: Commit.**

```bash
git add package.json tests/ai-automation-production-delivery-contract.test.mjs tests/production-delivery.test.mjs
git commit -m "test: wire Sprint 8F delivery contracts into regression"
```

---

### Task 7: Update production and AI operational runbooks

**Files:**
- Modify: `docs/runbooks/production-delivery.md`
- Modify: `docs/runbooks/ai-discovery-automation.md`
- Modify: `docs/runbooks/ai-provider-execution-recovery.md`
- Modify: `tests/ai-discovery-automation-contract.test.mjs`
- Modify: `tests/ai-automation-production-delivery-contract.test.mjs`

**Interfaces:**
- Documents repository-ready vs real inert-delivery vs future activation states.
- Locks correct post-8E retry semantics and production rollback boundaries.

- [ ] **Step 1: Add failing runbook assertions before changing docs.**

Require production runbook phrases/contracts:

```text
ai-automation
RAILWAY_AI_AUTOMATION_SERVICE
AI_AUTOMATION_PRODUCTION_REPO_READY
AI_AUTOMATION_DISABLED_DELIVERY_READY
AI_DISCOVERY_SCHEDULER_ENABLED=false
exact deployment ID
```

Require 8D runbook to describe:

```text
HTTP 429
UNCERTAIN
no automatic replay
```

and no longer describe generic provider-internal transient retry.

- [ ] **Step 2: Run RED docs contracts.**

```bash
npm run test:ai-automation-production-delivery
npm run test:ai-discovery-automation
```

Expected: FAIL on missing/new runbook semantics.

- [ ] **Step 3: Update `production-delivery.md`.**

Document seven services, only gateway public, external AI service bootstrap, disabled env, no GitHub autodeploy, exact-SHA + exact-deployment-ID sequence, 90-minute bounded release workflow, marker verification, missing-binding fail closed, gateway-last behavior, public smoke unchanged, rollback including AI runtime, and explicit separate authorization for real production deployment.

Clarify repository marker:

```text
AI_AUTOMATION_PRODUCTION_REPO_READY
```

and real deployment marker:

```text
AI_AUTOMATION_DISABLED_DELIVERY_READY
```

The latter cannot be claimed by CI-only validation.

- [ ] **Step 4: Correct `ai-discovery-automation.md`.**

Replace obsolete transient-retry wording with:

```text
HTTP 429 -> durable bounded retry, maximum three attempts total.
timeout / transport ambiguity / HTTP 408 / HTTP 5xx -> UNCERTAIN, no automatic replay.
```

Document that 8F may deploy the runtime inert with scheduler false, but activation still requires separate explicit authorization and provider credentials.

- [ ] **Step 5: Update `ai-provider-execution-recovery.md`.**

Remove the historical wording that Sprint 8E itself has no production deployment in a way that would conflict with 8F. State instead that 8F may deploy the 8E-capable runtime in disabled mode; all execution/reconciliation history remains immutable and no uncertain execution is replayed during deploy/rollback.

- [ ] **Step 6: Run docs/contracts GREEN.**

```bash
npm run test:ai-automation-production-delivery
npm run test:ai-discovery-automation
npm run test:ai-provider-execution-recovery
npm run test:production-contract
```

Expected: PASS.

- [ ] **Step 7: Commit.**

```bash
git add \
  docs/runbooks/production-delivery.md \
  docs/runbooks/ai-discovery-automation.md \
  docs/runbooks/ai-provider-execution-recovery.md \
  tests/ai-discovery-automation-contract.test.mjs \
  tests/ai-automation-production-delivery-contract.test.mjs
git commit -m "docs: define inert AI automation production delivery"
```

---

### Task 8: Add the dedicated Sprint 8F repository-only CI gate

**Files:**
- Create: `.github/workflows/sprint-8f-ai-automation-production-delivery.yml`
- Modify: `tests/ai-automation-production-delivery-contract.test.mjs`

**Interfaces:**
- PR/workflow-dispatch validation only.
- Uses Postgres 17, Redis 7, Node 22.13.0.
- No Railway token, no `railway up`, no OpenAI secret, no scheduler activation.

- [ ] **Step 1: Add RED workflow assertions.**

Require the new workflow file and assert:

```js
assert.match(workflow, /postgres:17/);
assert.match(workflow, /redis:7/);
assert.match(workflow, /node-version:\s*22\.13\.0/);
assert.match(workflow, /test:ai-automation-production-delivery/);
assert.match(workflow, /integration\/ai-automation-disabled-runtime\.test\.ts/);
assert.doesNotMatch(workflow, /RAILWAY_TOKEN|railway\s+up|OPENAI_API_KEY/);
assert.doesNotMatch(workflow, /(contents|packages|pages|id-token):\s*write/);
```

- [ ] **Step 2: Run RED.**

```bash
npm run test:ai-automation-production-delivery
```

Expected: FAIL because dedicated 8F workflow is missing.

- [ ] **Step 3: Create workflow triggers and read-only authority.**

Use `workflow_dispatch` plus `pull_request` path filters covering all 8F files. Set:

```yaml
permissions:
  contents: read
```

Use a ref-scoped concurrency group and `cancel-in-progress: true`.

- [ ] **Step 4: Add Postgres/Redis services and exact test env.**

Use PostgreSQL 17 with `hai_dau_test`, Redis 7, and:

```yaml
NODE_ENV: test
TEST_DATABASE_URL: postgres://postgres:postgres@127.0.0.1:5432/hai_dau_test
TEST_REDIS_URL: redis://127.0.0.1:6379
```

- [ ] **Step 5: Add repository and backend validation steps.**

Required sequence:

```text
install root/backend dependencies
Sprint 8F repository contract
production delivery contract
backend typecheck
backend focused 8D/8E automation tests
backend full tests
backend build
migrate test DB
compiled disabled-runtime integration
8E contract
8D contract
8C contract
8B contract
8A contract
production PR validation
release source contract
frontend lint
repository cleanliness
deployment/secret guard
```

Run migration before the compiled integration with:

```bash
DATABASE_URL="$TEST_DATABASE_URL" npm --prefix backend run migrate
```

Run integration with:

```bash
cd backend && node --import tsx --test --test-concurrency=1 integration/ai-automation-disabled-runtime.test.ts
```

- [ ] **Step 6: Add a deployment/secret guard that cannot match its own forbidden literals accidentally.**

Follow the 8E pattern: inspect only workflow content before the guard step, split forbidden token literals, and reject write permissions, Railway deployment, OpenAI credential name, and scheduler-true activation. The guard must itself remain repository-only.

- [ ] **Step 7: Run static GREEN contracts.**

```bash
npm run test:ai-automation-production-delivery
npm run test:production-contract
```

Expected: PASS.

- [ ] **Step 8: Commit.**

```bash
git add .github/workflows/sprint-8f-ai-automation-production-delivery.yml tests/ai-automation-production-delivery-contract.test.mjs
git commit -m "ci: add Sprint 8F production delivery gate"
```

---

### Task 9: Full regression, security review, and draft PR handoff

**Files:** No planned production changes. Fix only defects exposed by verification using RED regression tests before production fixes.

**Interfaces:** Produces exact-head evidence for review. Does not merge, deploy production, bootstrap Railway infrastructure, provision provider credentials, or activate the scheduler.

- [ ] **Step 1: Run focused Sprint 8F validation locally/CI-equivalent.**

```bash
npm run test:ai-automation-production-delivery
npm run test:production-contract
npm --prefix backend run typecheck
npm --prefix backend test
npm --prefix backend run build
DATABASE_URL="$TEST_DATABASE_URL" npm --prefix backend run migrate
cd backend && node --import tsx --test --test-concurrency=1 integration/ai-automation-disabled-runtime.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run inherited AI authority gates.**

```bash
npm run test:ai-provider-execution-recovery
npm run test:ai-discovery-automation
npm run test:ai-operations-policy
npm run test:ai-provider-execution
npm run test:guarded-ai-discovery
```

Expected: PASS.

- [ ] **Step 3: Run release/public regression sources.**

```bash
npm run test:staging-contract
npm run test:release-source
npm run test:production-pr-validation
npm run test:public-data
npm run test:post-publication-monitoring
npm run test:feedback-intake
npm run test:operator-surface
```

Expected: PASS.

- [ ] **Step 4: Run full root regression and builds.**

```bash
npm test
npm run lint
npm run build:pages
npm --prefix backend run build
npm --prefix backend audit --omit=dev --audit-level=high
```

Expected: PASS and no generated checkout drift.

- [ ] **Step 5: Verify repository cleanliness.**

```bash
git diff --check
git status --short
```

Expected: no unintended generated files or whitespace errors.

- [ ] **Step 6: Inspect exact diff against approved design base.**

```bash
git diff --stat 7eb0f3a776c60bc3198476317f1c96988b6831b5...HEAD
git diff 7eb0f3a776c60bc3198476317f1c96988b6831b5...HEAD -- \
  backend/src/ai-automation-worker.ts \
  backend/railway.ai-automation.toml \
  scripts/verify-railway-deployment.mjs \
  .github/workflows/production-release-gate.yml
```

Review specifically for: accidental `OPENAI_API_KEY` production wiring, scheduler activation, public endpoint creation, `latest` deployment selection, raw Railway output/secret logging, shell interpolation in verifier, gateway-before-AI ordering, or downstream content-authority imports.

- [ ] **Step 7: Run exact-head GitHub workflows and require terminal success.**

Before final review, require the dedicated 8F workflow plus inherited 8E/8D/8C/8B/8A, Sprint 5C staging/regression, Sprint 5D release candidate, backend-production-foundation/deploy-dry-run gates triggered by the PR to be terminal `SUCCESS` on the exact PR head. If a workflow fails, use systematic-debugging and add RED regression coverage for genuine code defects before fixing.

- [ ] **Step 8: Request code review.**

Use `superpowers:requesting-code-review`. Review the exact PR diff against the approved 8F spec, with emphasis on deployment identity, disabled runtime authority, secret isolation, release sequencing, and no downstream/public AI authority.

- [ ] **Step 9: Create/update a draft PR only after focused GREEN.**

PR title:

```text
Sprint 8F: wire inert AI automation production delivery
```

PR body records:

```text
- approved spec + plan paths
- exact base/head SHAs
- RED/GREEN evidence
- exact deployment-ID design
- disabled-ready marker semantics
- no production deploy
- no OpenAI credential
- scheduler remains false
- no downstream authority
- inherited workflow status
```

Keep `draft=true`.

- [ ] **Step 10: Stop before merge/deploy.**

Do not mark the PR ready, merge, bootstrap Railway service, run `production-release-gate.yml`, provision OpenAI credentials, or set `AI_DISCOVERY_SCHEDULER_ENABLED=true` without separate explicit authorization.

**Completion statement allowed at this point:**

```text
AI_AUTOMATION_PRODUCTION_REPO_READY
```

Only after exact-head verification proves it. Do not claim `AI_AUTOMATION_DISABLED_DELIVERY_READY`.
