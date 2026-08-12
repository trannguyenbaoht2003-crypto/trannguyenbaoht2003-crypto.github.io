# Sprint 5D Release Hardening & End-to-End Staging Rehearsal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove on one exact branch head that a real Publication can be created through existing domain commands, rendered through the same-origin staging stack, advanced to V2, rolled back to V1, survive backend outage/recovery, and pass backup/restore plus release-security checks before emitting `RC_READY`.

**Architecture:** Extend the disposable Sprint 5C Compose topology with a guarded staging-only backend rehearsal CLI. The CLI creates deterministic authority state through production domain modules, while Playwright verifies the browser through Caddy. A logical PostgreSQL restore and explicit runtime-security checks complete the release-candidate gate; no public write API or production deployment is introduced.

**Tech Stack:** Node.js 22.13.0, TypeScript 5.9.3, Fastify, PostgreSQL 17, Redis 7, Caddy 2, Docker Compose v2, Next.js 16 static export, Playwright Chromium, GitHub Actions.

## Global Constraints

- Base commit: `62e2ccaefa9bb5aa15d5a9258bd1ee923c6b14d4`.
- Branch: `feat/5d-release-hardening`.
- No merge, production deployment, registry push, cloud provisioning, DNS/TLS mutation, production secret, CORS expansion, browser credential, polling, automatic publication, or default worker service.
- Rehearsal Publication mutations must call `publishCandidateRevision` and `rollbackPublication`; no rehearsal source may directly INSERT/UPDATE/DELETE Publication authority rows.
- Every mutating rehearsal CLI operation requires `STAGING_REHEARSAL_ENABLED=1` and fails closed without it.
- `verifyReleaseRehearsal()` must derive the externally visible active state through the production public-reader module, not a test helper.
- `RC_READY` may be printed only after every gate passes on the immutable PR branch-head SHA.
- CI output must never print a database URL, credential, token, private key, raw `.env`, or database dump contents.
- Existing Sprint 5C regression, same-origin, static fail-open, single-public-port, read-only HTTP, and deployment guards remain mandatory.

---

## File structure

- `backend/src/rehearsal/release-rehearsal-data.ts` — deterministic rehearsal IDs, production-domain orchestration, and public-reader verification.
- `backend/src/rehearsal/release-rehearsal-cli.ts` — guarded `seed-v1`, `publish-v2`, `rollback-v1`, `verify` CLI.
- `backend/test/release-rehearsal.test.ts` — database integration tests for guard, V1, V2, rollback, replay, and public-reader state.
- `tests/release-rehearsal-source.test.mjs` — source/workflow/runtime-boundary contracts.
- `tests/release-e2e.spec.ts` — browser verification for V1/V2/rollback/outage/recovery.
- `playwright.config.ts` — one bounded Chromium project with no retry/video/trace upload.
- `scripts/staging-backup-restore.mjs` — disposable logical backup/restore and restored public-reader comparison.
- `scripts/release-security-gate.mjs` — non-root, network, HTTP mutation, dependency, shipped-runtime, and secret checks.
- `deploy/staging/Dockerfile.frontend`, `deploy/staging/Caddyfile`, `deploy/staging/compose.yml` — non-root gateway on an unprivileged internal port while keeping one host port.
- `package.json`, `package-lock.json`, `backend/package.json` — scripts and Playwright dependency.
- `docs/runbooks/staging-environment.md` — rehearsal and operational procedure.
- `.github/workflows/sprint-5d-release-candidate.yml` — exact-head `RC_READY` workflow.

---

### Task 1: Guarded V1 rehearsal through production authority

**Files:**
- Create: `backend/src/rehearsal/release-rehearsal-data.ts`
- Create: `backend/src/rehearsal/release-rehearsal-cli.ts`
- Create: `backend/test/release-rehearsal.test.ts`
- Modify: `backend/package.json`

**Interfaces:**

```ts
export interface ReleaseRehearsalState {
  publicationId: string;
  activePublicationVersionId: string;
  activeVersionNumber: number;
  championExternalId: string;
  augmentExternalIds: readonly string[];
  itemExternalIds: readonly string[];
}

export function assertReleaseRehearsalEnabled(env: NodeJS.ProcessEnv): void;
export function seedReleaseRehearsalV1(pool: Pool): Promise<ReleaseRehearsalState>;
export function verifyReleaseRehearsal(pool: Pool): Promise<ReleaseRehearsalState>;
```

- [ ] **Step 1: Write the RED guard/V1 test**

```ts
it('fails closed without the explicit rehearsal flag', () => {
  assert.throws(
    () => assertReleaseRehearsalEnabled({}),
    /RELEASE_REHEARSAL_DISABLED/,
  );
});

it('publishes deterministic V1 visible through the public reader', async () => {
  const state = await seedReleaseRehearsalV1(pool);
  assert.equal(state.activeVersionNumber, 1);
  assert.equal(state.championExternalId, 'samira');
  assert.deepEqual(await verifyReleaseRehearsal(pool), state);
});
```

- [ ] **Step 2: Verify RED**

Run: `npm --prefix backend test -- release-rehearsal.test.ts`

Expected: FAIL because the rehearsal module does not exist.

- [ ] **Step 3: Implement the guard and deterministic prerequisites**

```ts
export function assertReleaseRehearsalEnabled(env: NodeJS.ProcessEnv): void {
  if (env.STAGING_REHEARSAL_ENABLED !== '1') {
    throw new Error('RELEASE_REHEARSAL_DISABLED');
  }
}
```

Create the minimum patch/catalog/candidate/evidence/review/moderation/eligibility graph with production modules. Use frontend-mappable Samira augment/item IDs. Publish only by calling `publishCandidateRevision(...)`.

- [ ] **Step 4: Implement `verifyReleaseRehearsal()` through the production public reader**

Call the existing active Publication reader, select the deterministic publication, and return only the bounded `ReleaseRehearsalState`; do not log connection configuration.

- [ ] **Step 5: Implement the guarded CLI**

```ts
assertReleaseRehearsalEnabled(process.env);
const operation = process.argv[2];
if (operation === 'seed-v1') console.log(JSON.stringify(await seedReleaseRehearsalV1(pool)));
else if (operation === 'verify') console.log(JSON.stringify(await verifyReleaseRehearsal(pool)));
else throw new Error('RELEASE_REHEARSAL_OPERATION_INVALID');
```

- [ ] **Step 6: Verify GREEN and commit**

Run: `npm --prefix backend test -- release-rehearsal.test.ts && npm --prefix backend run typecheck`

Expected: PASS.

Commit: `feat: add guarded release rehearsal v1`

---

### Task 2: V2, rollback, and deterministic replay

**Files:**
- Modify: `backend/src/rehearsal/release-rehearsal-data.ts`
- Modify: `backend/src/rehearsal/release-rehearsal-cli.ts`
- Modify: `backend/test/release-rehearsal.test.ts`

**Interfaces:**

```ts
export function publishReleaseRehearsalV2(pool: Pool): Promise<ReleaseRehearsalState>;
export function rollbackReleaseRehearsalToV1(pool: Pool): Promise<ReleaseRehearsalState>;
```

- [ ] **Step 1: Write the RED V2/rollback test**

```ts
const v1 = await seedReleaseRehearsalV1(pool);
const v2 = await publishReleaseRehearsalV2(pool);
assert.equal(v2.activeVersionNumber, 2);
assert.notDeepEqual(v2.itemExternalIds, v1.itemExternalIds);

const rolledBack = await rollbackReleaseRehearsalToV1(pool);
assert.equal(rolledBack.activeVersionNumber, 1);
assert.deepEqual(rolledBack.itemExternalIds, v1.itemExternalIds);
```

Add a row-count assertion proving the aggregate still has exactly two immutable PublicationVersions after deterministic replay attempts.

- [ ] **Step 2: Verify RED**

Run: `npm --prefix backend test -- release-rehearsal.test.ts`

Expected: FAIL because the V2/rollback functions do not exist.

- [ ] **Step 3: Implement V2 and rollback**

Build the second eligible CandidateRevision through production trust/moderation/eligibility modules, then call `publishCandidateRevision(...)`. Roll back only with:

```ts
await rollbackPublication(pool, rollbackCommandForV1());
return verifyReleaseRehearsal(pool);
```

Use deterministic command IDs and idempotency keys. Do not create a third version during replay.

- [ ] **Step 4: Extend CLI operations**

Add exactly `publish-v2` and `rollback-v1`; keep all four operations behind `STAGING_REHEARSAL_ENABLED=1`.

- [ ] **Step 5: Verify GREEN and commit**

Run: `npm --prefix backend test -- release-rehearsal.test.ts && npm --prefix backend test`

Expected: focused test and full inherited backend suite PASS.

Commit: `feat: rehearse publication v2 and rollback`

---

### Task 3: Source contracts and real browser E2E

**Files:**
- Create: `tests/release-rehearsal-source.test.mjs`
- Create: `tests/release-e2e.spec.ts`
- Create: `playwright.config.ts`
- Modify: `package.json`, `package-lock.json`
- Modify: `app/page.tsx` only if an existing accessible label cannot provide a stable selector.

**Interfaces:**
- `RELEASE_E2E_BASE_URL`, default `http://127.0.0.1:8080`.
- `RELEASE_E2E_EXPECT` is one of `v1 | v2 | backend-down | recovered-v1`.
- Scripts: `test:release-source`, `test:release-e2e`.

- [ ] **Step 1: Write RED source contracts**

```js
assert.doesNotMatch(rehearsalSource, /insert\s+into\s+publications/i);
assert.doesNotMatch(rehearsalSource, /update\s+active_publication_versions/i);
assert.doesNotMatch(rehearsalSource, /delete\s+from\s+publication/i);
assert.doesNotMatch(composeSource, /^\s*worker:/m);
assert.match(rehearsalSource, /STAGING_REHEARSAL_ENABLED/);
```

Also require Playwright config/test files and preserve absence of public Publication POST/PUT/PATCH/DELETE routes.

- [ ] **Step 2: Verify RED**

Run: `node --test tests/release-rehearsal-source.test.mjs`

Expected: FAIL because Playwright release artifacts are missing.

- [ ] **Step 3: Add Playwright and configuration**

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

Use one Chromium project and install only Chromium in CI.

- [ ] **Step 4: Implement externally orchestrated browser assertions**

For V1/V2/recovered-V1: load `/`, open Samira, require the published badge, require the expected localized build labels/assets, and reject raw deterministic UUID/external-ID fallback text. V2 expected items must differ from V1.

For `backend-down`: a fresh page load must keep champion browsing usable and show the existing API-unavailable fallback state.

Capture request methods during the test and assert the app issues no Publication write method and no Authorization header/cookie credential.

- [ ] **Step 5: Verify source/lint GREEN and commit**

Run: `npm run lint && npm run test:release-source`

Expected: PASS; live browser execution occurs in the Compose workflow.

Commit: `test: add release browser rehearsal`

---

### Task 4: Backup/restore and release-security gates

**Files:**
- Create: `scripts/staging-backup-restore.mjs`
- Create: `scripts/release-security-gate.mjs`
- Modify: `deploy/staging/Dockerfile.frontend`, `deploy/staging/Caddyfile`, `deploy/staging/compose.yml`
- Modify: `tests/release-rehearsal-source.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Scripts: `staging:backup-restore`, `release:security-gate`.
- Restore verification runs the same compiled `release-rehearsal-cli.js verify` command against a temporary restored database, so the comparison uses the production public-reader path.

- [ ] **Step 1: Add RED backup/security contracts**

Require backup cleanup in `finally`, explicit frontend `USER`, backend `USER node`, only one published-port service named `gateway`, no default worker, and no secret-output primitives.

- [ ] **Step 2: Verify RED**

Run: `npm run test:release-source`

Expected: FAIL because backup/security scripts are absent and the current Caddy final image has no explicit non-root `USER`.

- [ ] **Step 3: Implement backup/restore**

Use a temporary custom-format `pg_dump`, create a temporary restore DB, `pg_restore` into it, then run:

```text
STAGING_REHEARSAL_ENABLED=1 DATABASE_URL=<temporary-restore-url> node dist/src/rehearsal/release-rehearsal-cli.js verify
```

Compare the bounded restored state with source `verify`. Assert exactly two immutable versions and V1 active after rollback. In `finally`, drop the restore DB and delete the dump. Never print either database URL or dump content.

- [ ] **Step 4: Make the gateway non-root**

Configure the final Caddy container with an explicit non-root user and unprivileged internal port `8080`; keep Compose host mapping only on `gateway` as `${STAGING_PORT:-8080}:8080`. Preserve existing same-origin routes and static fail-open behavior.

- [ ] **Step 5: Implement the security gate**

Verify final backend/gateway container users are non-root; only gateway publishes a host port; worker is absent; Publication POST/PUT/PATCH/DELETE remain unavailable; no browser credential is introduced; backend shipped production dependencies have no untriaged high/critical runtime finding; gateway final image ships static files+Caddy rather than Node/Next runtime; bounded repository secret-pattern checks pass. Do not run `npm audit fix --force`.

- [ ] **Step 6: Verify GREEN and commit**

Run: `npm run test:release-source && npm run staging:config`

Expected: PASS.

Commit: `chore: harden staging release runtime`

---

### Task 5: Runbook and exact-head `RC_READY` workflow

**Files:**
- Modify: `docs/runbooks/staging-environment.md`
- Create: `.github/workflows/sprint-5d-release-candidate.yml`
- Modify: `tests/release-rehearsal-source.test.mjs`

**Interfaces:**
- Workflow name: `Sprint 5D release candidate gate`.
- Final success marker: exact line `RC_READY`.

- [ ] **Step 1: Add RED workflow/runbook contracts**

Require `permissions: contents: read`, no deploy/registry/cloud command, and PR checkout using the immutable head:

```yaml
- uses: actions/checkout@v4
  with:
    ref: ${{ github.event.pull_request.head.sha }}
```

Require a subsequent comparison of `git rev-parse HEAD` to the same SHA before any release evidence runs.

- [ ] **Step 2: Verify RED**

Run: `npm run test:release-source`

Expected: FAIL because the 5D workflow/runbook contract is missing.

- [ ] **Step 3: Implement workflow in this order**

```text
exact-head checkout/verification
-> installs + inherited lint/tests/build
-> compose config + fresh stack
-> seed V1 -> API/browser V1
-> publish V2 -> API/browser V2
-> rollback V1 -> API/browser V1
-> backend stop -> browser fail-open
-> backend recovery -> browser recovered V1
-> backup/restore
-> security gate
-> cleanliness + deployment guard
-> echo RC_READY
-> bounded diagnostics on failure
-> teardown with if: always()
```

Install Playwright Chromium before browser steps. No artifact contains a DB dump or secret.

- [ ] **Step 4: Update runbook**

Document guarded V1/V2/rollback/verify commands, browser expectations, backup/restore rehearsal, backend/PostgreSQL/Redis restart checks, bounded logs (`--tail=100`), and that `RC_READY` authorizes only planning for real staging—not merge or production deployment.

- [ ] **Step 5: Verify source contract and commit**

Run: `npm run test:release-source`

Expected: PASS.

Commit: `ci: add Sprint 5D release candidate gate`

- [ ] **Step 6: Open a draft PR**

Open `feat/5d-release-hardening` -> `main` as draft. Do not mark ready, merge, or deploy.

---

### Task 6: Exact-head verification and review

**Files:**
- Modify only files implicated by verified failures from Tasks 1-5.
- Update the draft PR body after the final exact-head verification.

- [ ] **Step 1: Run the exact-head workflow**

Required evidence: inherited frontend/backend regression, clean migration, V1/V2/rollback API+browser E2E, backend fail-open/recovery, restored public-reader equivalence, non-root/network/read-only/dependency/secret gates, cleanliness, deployment guard, and unconditional teardown.

- [ ] **Step 2: Debug only verified root causes**

For each new defect, preserve the RED evidence, identify the root cause, make the minimum fix, and rerun on the new exact head. Never weaken an invariant simply to obtain green CI.

- [ ] **Step 3: Review the range `62e2ccae... -> <exact 5D head>`**

Reject any direct Publication SQL in rehearsal code, public mutation route, credential/CORS expansion, timer/polling, default worker, secret leakage, root runtime, extra public port, deploy command, premature `RC_READY`, or synthetic merge-ref release evidence.

- [ ] **Step 4: Re-run all exact-head evidence after review fixes**

Old green runs are invalid after any head change.

- [ ] **Step 5: Update draft PR evidence**

Record base/head SHA, TDD RED/GREEN runs, exact-head workflow run IDs and test counts, V1/V2/rollback/outage/recovery results, backup/restore result, security result, review findings/fixes, and explicit `draft / unmerged / undeployed` state.

- [ ] **Step 6: Completion condition**

Sprint 5D is complete only when the latest immutable branch head has fresh successful gates and the release-candidate workflow prints `RC_READY`. `RC_READY` does not authorize merge or production deployment.
