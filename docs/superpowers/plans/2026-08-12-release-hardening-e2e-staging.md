# Sprint 5D Release Hardening & End-to-End Staging Rehearsal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove on one exact branch head that a real Publication can be created through existing domain commands, read through the same-origin staging stack, rendered in a real browser, rolled back safely, survive backend outage/recovery, and pass backup/restore plus release-security checks before emitting `RC_READY`.

**Architecture:** Extend the Sprint 5C disposable Compose environment with a staging-only rehearsal CLI that invokes existing domain modules rather than direct Publication SQL. Add Playwright browser verification through Caddy, logical PostgreSQL backup/restore verification, and a release-security gate. The final GitHub Actions workflow explicitly checks out the immutable PR head SHA and never deploys production.

**Tech Stack:** Node.js 22.13.0, TypeScript 5.9.3, Fastify backend, PostgreSQL 17, Redis 7, Caddy 2, Docker Compose v2, Next.js 16 static export, Playwright Chromium, GitHub Actions.

## Global Constraints

- Base commit is `62e2ccaefa9bb5aa15d5a9258bd1ee923c6b14d4`.
- Work only on `feat/5d-release-hardening`.
- No merge, production deployment, registry push, cloud provisioning, DNS/TLS mutation, production secret, public mutation route, CORS expansion, browser credential, polling, automatic publication, or default worker service.
- Publication authority changes in the rehearsal path must use existing domain commands, especially `publishCandidateRevision` and `rollbackPublication`; direct Publication SQL helpers remain test-only.
- Every mutating rehearsal CLI operation requires `STAGING_REHEARSAL_ENABLED=1` and fails closed otherwise.
- `RC_READY` is valid only when the workflow checks out and verifies the immutable PR branch-head SHA and every required job step passes on that same commit.
- CI diagnostics must never print a database URL, token, private key, raw `.env` contents, or backup contents.
- Keep existing Sprint 5C regression, same-origin, fail-open, network isolation, and production-deployment guards intact.

---

## File structure

- `backend/src/rehearsal/release-rehearsal-data.ts` — deterministic IDs and staging dataset orchestration through production domain commands.
- `backend/src/rehearsal/release-rehearsal-cli.ts` — narrow `seed-v1`, `publish-v2`, `rollback-v1`, and `verify` CLI; guarded by explicit staging flag.
- `backend/test/release-rehearsal.test.ts` — domain-level RED/GREEN integration tests for guard, V1/V2/rollback, and idempotency.
- `tests/release-rehearsal-source.test.mjs` — source contracts forbidding direct Publication SQL, exposed mutation routes, worker enablement, and inexact checkout.
- `tests/release-e2e.spec.ts` — Playwright browser E2E through the real gateway.
- `playwright.config.ts` — one Chromium project, no retries, bounded timeout, no trace/video upload by default.
- `scripts/release-rehearsal-e2e.mjs` — safe orchestration helper for API/browser state verification if needed by workflow steps.
- `scripts/staging-backup-restore.mjs` — disposable logical backup/restore verifier using bounded output.
- `scripts/release-security-gate.mjs` — non-root/network/mutation/dependency/secret/runtime-surface checks.
- `deploy/staging/Dockerfile.frontend` — run final Caddy image as non-root on an unprivileged internal port if current image cannot satisfy the gate.
- `deploy/staging/Caddyfile` — listen on the unprivileged internal port while preserving same-origin proxy behavior.
- `deploy/staging/compose.yml` — map the single host port only to the non-root gateway and add no default worker.
- `package.json` / `package-lock.json` — Playwright dev dependency and release-rehearsal scripts.
- `backend/package.json` — expose the compiled rehearsal CLI script only as an internal operator command.
- `docs/runbooks/staging-environment.md` — rehearsal, rollback, backup/restore, fault injection, and `RC_READY` procedures.
- `.github/workflows/sprint-5d-release-candidate.yml` — exact-head release-candidate workflow and unconditional cleanup.

---

### Task 1: Rehearsal guard and deterministic V1 authority path

**Files:**
- Create: `backend/src/rehearsal/release-rehearsal-data.ts`
- Create: `backend/src/rehearsal/release-rehearsal-cli.ts`
- Create: `backend/test/release-rehearsal.test.ts`
- Modify: `backend/package.json`

**Interfaces:**
- Produces: `assertReleaseRehearsalEnabled(env: NodeJS.ProcessEnv): void`
- Produces: `seedReleaseRehearsalV1(pool: Pool): Promise<ReleaseRehearsalState>`
- Produces: `verifyReleaseRehearsal(pool: Pool): Promise<ReleaseRehearsalState>`
- `ReleaseRehearsalState` contains only non-secret IDs plus `activeVersionNumber`, `championExternalId`, `augmentExternalIds`, and `itemExternalIds`.

- [ ] **Step 1: Write the failing guard and V1 integration tests**

```ts
it('fails closed when the rehearsal flag is absent', () => {
  assert.throws(
    () => assertReleaseRehearsalEnabled({}),
    /RELEASE_REHEARSAL_DISABLED/,
  );
});

it('publishes V1 only through the domain publication command', async () => {
  const pool = await createTestPool();
  await migrate(pool);
  const state = await seedReleaseRehearsalV1(pool);
  assert.equal(state.activeVersionNumber, 1);
  assert.equal(state.championExternalId, 'samira');
  assert.ok(state.augmentExternalIds.length > 0);
  assert.ok(state.itemExternalIds.length > 0);
});
```

- [ ] **Step 2: Run the focused backend test and verify RED**

Run: `npm --prefix backend test -- release-rehearsal.test.ts`

Expected: FAIL because `backend/src/rehearsal/release-rehearsal-data.ts` and exported functions do not exist.

- [ ] **Step 3: Implement the minimal guarded V1 rehearsal path**

```ts
export function assertReleaseRehearsalEnabled(
  env: NodeJS.ProcessEnv,
): void {
  if (env.STAGING_REHEARSAL_ENABLED !== '1') {
    throw new Error('RELEASE_REHEARSAL_DISABLED');
  }
}

export interface ReleaseRehearsalState {
  publicationId: string;
  activePublicationVersionId: string;
  activeVersionNumber: number;
  championExternalId: string;
  augmentExternalIds: readonly string[];
  itemExternalIds: readonly string[];
}
```

Build prerequisites with existing catalog/candidate/trust/moderation/eligibility production modules, then call `publishCandidateRevision(...)`. Do not import from `backend/test/helpers/*` and do not execute INSERT/UPDATE/DELETE against `publications`, `publication_versions`, or `active_publication_versions`.

- [ ] **Step 4: Add the CLI entrypoint**

```ts
const operation = process.argv[2];
assertReleaseRehearsalEnabled(process.env);

switch (operation) {
  case 'seed-v1':
    await seedReleaseRehearsalV1(pool);
    break;
  case 'verify':
    console.log(JSON.stringify(await verifyReleaseRehearsal(pool)));
    break;
  default:
    throw new Error('RELEASE_REHEARSAL_OPERATION_INVALID');
}
```

The CLI may print the bounded `ReleaseRehearsalState`, never `DATABASE_URL` or environment contents.

- [ ] **Step 5: Run focused tests and backend typecheck**

Run: `npm --prefix backend test -- release-rehearsal.test.ts && npm --prefix backend run typecheck`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/src/rehearsal backend/test/release-rehearsal.test.ts backend/package.json
git commit -m "feat: add guarded release rehearsal v1"
```

---

### Task 2: V2 publish, rollback, and idempotency contract

**Files:**
- Modify: `backend/src/rehearsal/release-rehearsal-data.ts`
- Modify: `backend/src/rehearsal/release-rehearsal-cli.ts`
- Modify: `backend/test/release-rehearsal.test.ts`

**Interfaces:**
- Produces: `publishReleaseRehearsalV2(pool: Pool): Promise<ReleaseRehearsalState>`
- Produces: `rollbackReleaseRehearsalToV1(pool: Pool): Promise<ReleaseRehearsalState>`

- [ ] **Step 1: Write RED tests for V2 and rollback**

```ts
it('publishes V2 and rolls back the active pointer to immutable V1', async () => {
  await seedReleaseRehearsalV1(pool);
  const v2 = await publishReleaseRehearsalV2(pool);
  assert.equal(v2.activeVersionNumber, 2);
  assert.notDeepEqual(v2.itemExternalIds, v1.itemExternalIds);

  const rolledBack = await rollbackReleaseRehearsalToV1(pool);
  assert.equal(rolledBack.activeVersionNumber, 1);
  assert.deepEqual(rolledBack.itemExternalIds, v1.itemExternalIds);
});
```

Also assert that replaying each deterministic operation either returns the same authoritative state or fails with the documented stable idempotency/conflict error, with no third PublicationVersion created.

- [ ] **Step 2: Run focused test and verify RED**

Run: `npm --prefix backend test -- release-rehearsal.test.ts`

Expected: FAIL because V2/rollback functions are missing.

- [ ] **Step 3: Implement V2 through `publishCandidateRevision` and rollback through `rollbackPublication`**

```ts
export async function rollbackReleaseRehearsalToV1(
  pool: Pool,
): Promise<ReleaseRehearsalState> {
  await rollbackPublication(pool, rollbackCommandForV1());
  return verifyReleaseRehearsal(pool);
}
```

Use deterministic unique command IDs/idempotency keys per operation. V1 and V2 must use frontend-mappable IDs and differ visibly.

- [ ] **Step 4: Extend CLI operations**

```ts
case 'publish-v2':
  console.log(JSON.stringify(await publishReleaseRehearsalV2(pool)));
  break;
case 'rollback-v1':
  console.log(JSON.stringify(await rollbackReleaseRehearsalToV1(pool)));
  break;
```

- [ ] **Step 5: Run focused and full backend tests**

Run: `npm --prefix backend test -- release-rehearsal.test.ts && npm --prefix backend test`

Expected: PASS with all inherited Publication hardening tests still green.

- [ ] **Step 6: Commit**

```bash
git add backend/src/rehearsal backend/test/release-rehearsal.test.ts
git commit -m "feat: rehearse publication v2 and rollback"
```

---

### Task 3: Source contracts and browser E2E

**Files:**
- Create: `tests/release-rehearsal-source.test.mjs`
- Create: `tests/release-e2e.spec.ts`
- Create: `playwright.config.ts`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify minimally: `app/page.tsx` only if stable semantic/test IDs are needed.

**Interfaces:**
- Consumes gateway origin from `RELEASE_E2E_BASE_URL`, default `http://127.0.0.1:8080`.
- Produces scripts `test:release-source` and `test:release-e2e`.

- [ ] **Step 1: Add RED source contracts before installing/using Playwright**

Assertions must prove:

```js
assert.doesNotMatch(rehearsalSource, /insert\s+into\s+publications/i);
assert.doesNotMatch(rehearsalSource, /update\s+active_publication_versions/i);
assert.doesNotMatch(rehearsalSource, /delete\s+from\s+publication/i);
assert.doesNotMatch(composeSource, /^\s*worker:/m);
```

Also require explicit rehearsal guard and no new POST/PUT/PATCH/DELETE Publication Fastify route.

- [ ] **Step 2: Run source test and verify RED where the browser/workflow contract is still absent**

Run: `node --test tests/release-rehearsal-source.test.mjs`

Expected: FAIL on missing release-E2E/workflow artifacts, not on inherited 5C invariants.

- [ ] **Step 3: Add Playwright dependency and one Chromium configuration**

```ts
export default defineConfig({
  testDir: './tests',
  testMatch: 'release-e2e.spec.ts',
  retries: 0,
  timeout: 30_000,
  use: {
    baseURL: process.env.RELEASE_E2E_BASE_URL ?? 'http://127.0.0.1:8080',
    trace: 'off',
    video: 'off',
    screenshot: 'only-on-failure',
  },
});
```

- [ ] **Step 4: Write browser tests for the current externally orchestrated state**

```ts
test('renders the active rehearsal publication without raw IDs', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('Samira', { exact: true })).toBeVisible();
  await page.getByText('Samira', { exact: true }).click();
  await expect(page.getByText('Bản đã xuất bản')).toBeVisible();
  await expect(page.locator('body')).not.toContainText('77000000-');
});
```

The workflow will change V1/V2/rollback state between E2E invocations. Add stable `data-testid` attributes only where accessible labels are insufficient.

- [ ] **Step 5: Add outage assertion**

When invoked with `RELEASE_E2E_EXPECT=backend-down`, a fresh page load must still render the static champion UI and the existing API-unavailable status while no published badge is required.

- [ ] **Step 6: Run source/unit tests locally available without stack**

Run: `npm run lint && npm run test:release-source`

Expected: PASS. Full browser test remains for the Compose workflow.

- [ ] **Step 7: Commit**

```bash
git add tests/release-rehearsal-source.test.mjs tests/release-e2e.spec.ts playwright.config.ts package.json package-lock.json app/page.tsx
git commit -m "test: add release browser rehearsal"
```

---

### Task 4: Backup/restore rehearsal

**Files:**
- Create: `scripts/staging-backup-restore.mjs`
- Modify: `tests/release-rehearsal-source.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces script `staging:backup-restore`.
- Consumes Compose project services `postgres` and `backend`; creates a temporary backup and temporary restore database only inside the disposable CI environment.

- [ ] **Step 1: Write RED source contract for cleanup and bounded output**

Require the script to use a generated temporary file path, delete it in `finally`, and never log `DATABASE_URL`, environment contents, or dump data.

- [ ] **Step 2: Verify RED**

Run: `npm run test:release-source`

Expected: FAIL because `scripts/staging-backup-restore.mjs` is missing.

- [ ] **Step 3: Implement logical backup and restore**

The script must execute the equivalent of:

```text
pg_dump --format=custom --file=/tmp/release-rehearsal.dump <source-db>
createdb <temporary-restore-db>
pg_restore --dbname=<temporary-restore-db> /tmp/release-rehearsal.dump
```

Then run bounded SQL checks that assert the Publication aggregate has exactly two immutable versions and that the active pointer references V1. Verify the same public-reader payload against the restore target using backend code or a temporary backend process configured only for the restore database.

- [ ] **Step 4: Ensure cleanup is unconditional**

Use `try/finally` to drop the temporary restore database and delete the dump even on assertion failure.

- [ ] **Step 5: Run source contract**

Run: `npm run test:release-source`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/staging-backup-restore.mjs tests/release-rehearsal-source.test.mjs package.json
git commit -m "test: add staging backup restore rehearsal"
```

---

### Task 5: Release security gate and non-root gateway

**Files:**
- Create: `scripts/release-security-gate.mjs`
- Modify: `deploy/staging/Dockerfile.frontend`
- Modify: `deploy/staging/Caddyfile`
- Modify: `deploy/staging/compose.yml`
- Modify: `tests/release-rehearsal-source.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces script `release:security-gate`.
- Gate accepts no secrets; it inspects source/Compose/container metadata and dependency audit JSON internally, printing only finding IDs/counts and pass/fail status.

- [ ] **Step 1: Add RED tests requiring both final images to be non-root and only gateway to publish a host port**

```js
assert.match(frontendDockerfile, /USER\s+\S+/i);
assert.match(backendDockerfile, /USER\s+node/i);
assert.equal(publishedPortServices, 1);
assert.equal(publishedPortServiceNames[0], 'gateway');
```

- [ ] **Step 2: Verify RED**

Run: `npm run test:release-source`

Expected: FAIL because the current Caddy final image has no explicit non-root `USER`.

- [ ] **Step 3: Move Caddy to an unprivileged internal port and user**

Use a non-root user in the final gateway image and listen on an unprivileged port such as `8080` inside the container. Compose continues to expose only `${STAGING_PORT:-8080}:8080` from `gateway`.

- [ ] **Step 4: Implement runtime/security inspection**

The gate must verify:

```text
backend container user != root/0
gateway container user != root/0
only gateway publishes a host port
no worker service exists by default
POST/PUT/PATCH/DELETE /api/v1/publications remain unavailable
no browser Authorization/Cookie requirement is introduced
backend production audit has no untriaged high/critical runtime finding
shipped gateway image contains no Node/Next runtime
no obvious committed secret pattern is detected
```

Do not run `npm audit fix --force`.

- [ ] **Step 5: Run source contract and Compose config**

Run: `npm run test:release-source && npm run staging:config`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/release-security-gate.mjs deploy/staging tests/release-rehearsal-source.test.mjs package.json
git commit -m "chore: harden staging release runtime"
```

---

### Task 6: Operations runbook and exact-head `RC_READY` workflow

**Files:**
- Modify: `docs/runbooks/staging-environment.md`
- Create: `.github/workflows/sprint-5d-release-candidate.yml`
- Modify: `tests/release-rehearsal-source.test.mjs`

**Interfaces:**
- Workflow name: `Sprint 5D release candidate gate`.
- Final marker: exact stdout line `RC_READY` only after all checks.

- [ ] **Step 1: Add RED workflow/runbook contracts**

Require all of these exact semantic properties:

```yaml
permissions:
  contents: read
```

Checkout on PR must use:

```yaml
with:
  ref: ${{ github.event.pull_request.head.sha }}
```

The workflow must compare `git rev-parse HEAD` with `${{ github.event.pull_request.head.sha }}` before tests, and contain no deployment, registry-push, Pages-publish, cloud CLI, or production hostname command.

- [ ] **Step 2: Verify RED**

Run: `npm run test:release-source`

Expected: FAIL because the Sprint 5D workflow/runbook additions are not complete.

- [ ] **Step 3: Write workflow in deterministic order**

Required order:

```text
checkout exact head -> print/verify SHA -> install -> inherited lint/tests/build -> compose config -> build/start fresh stack -> seed V1 -> API/browser V1 -> publish V2 -> API/browser V2 -> rollback V1 -> API/browser rollback -> backend stop -> browser fail-open -> backend recover -> browser recovered -> backup/restore -> security gate -> cleanliness -> deployment guard -> echo RC_READY -> diagnostics on failure -> teardown always
```

Use `if: always()` for cleanup and `if: failure()` for bounded diagnostics.

- [ ] **Step 4: Update runbook**

Document these operator commands without secrets:

```bash
STAGING_REHEARSAL_ENABLED=1 docker compose ... run --rm backend node dist/src/rehearsal/release-rehearsal-cli.js seed-v1
STAGING_REHEARSAL_ENABLED=1 docker compose ... run --rm backend node dist/src/rehearsal/release-rehearsal-cli.js publish-v2
STAGING_REHEARSAL_ENABLED=1 docker compose ... run --rm backend node dist/src/rehearsal/release-rehearsal-cli.js rollback-v1
```

Also document verify, backup/restore, backend/PostgreSQL/Redis restart checks, safe `logs --tail=100`, and the exact meaning of `RC_READY`.

- [ ] **Step 5: Run source contract**

Run: `npm run test:release-source`

Expected: PASS.

- [ ] **Step 6: Commit and open draft PR**

```bash
git add .github/workflows/sprint-5d-release-candidate.yml docs/runbooks/staging-environment.md tests/release-rehearsal-source.test.mjs
git commit -m "ci: add Sprint 5D release candidate gate"
```

Open a draft PR from `feat/5d-release-hardening` to `main`; do not mark ready, merge, or deploy.

---

### Task 7: Exact-head execution, debugging, review, and completion evidence

**Files:**
- Modify only files implicated by verified failures in Tasks 1-6.
- Update draft PR body with evidence after the exact-head gate is green.

**Interfaces:**
- Consumes the exact branch head SHA after all implementation commits.
- Produces one successful `Sprint 5D release candidate gate` run ending in `RC_READY` plus inherited regression/dry-run successes.

- [ ] **Step 1: Run the full exact-head CI gate**

Expected success evidence includes frontend regression, backend full suite, clean-schema migration, V1/V2/rollback browser E2E, backend fail-open/recovery E2E, backup/restore, release-security gate, cleanliness, deployment guard, and teardown.

- [ ] **Step 2: Debug only the first real failure**

For any failure, use systematic root-cause debugging. Do not weaken an assertion simply to turn CI green. Preserve a RED commit/run when a new defect is found, then make the minimum GREEN fix.

- [ ] **Step 3: Review the range from Sprint 5C base to exact Sprint 5D head**

Review specifically for:

```text
direct Publication SQL in rehearsal code
public mutation routes
browser credentials
CORS expansion
polling/retry timers
default worker enablement
secret/log leakage
root runtime users
extra published ports
deployment/registry/cloud commands
RC_READY before all gates
synthetic merge-ref checkout
```

- [ ] **Step 4: Re-run all exact-head evidence after review fixes**

Do not cite earlier green runs if the head changed.

- [ ] **Step 5: Update draft PR**

Record base/head SHAs, RED/GREEN evidence, exact workflow run IDs, test counts, browser states, backup/restore result, security result, review findings/fixes, and explicit `draft / unmerged / undeployed` state.

- [ ] **Step 6: Completion condition**

Sprint 5D is complete only if the latest immutable head has fresh successful verification and the release-candidate workflow itself prints `RC_READY`. This marker authorizes only the next planning step for a real staging deployment; it does not authorize merge or production deployment.
