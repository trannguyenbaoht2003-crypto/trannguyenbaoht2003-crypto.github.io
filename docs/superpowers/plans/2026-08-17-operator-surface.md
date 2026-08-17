# Sprint 7C Operator Surface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a loopback-only, read-only operator console that combines Sprint 7A monitoring alerts and Sprint 7B feedback signals without exposing operator data through the public gateway or adding any mutation authority.

**Architecture:** A new PostgreSQL-only operator reader composes the existing monitoring and feedback read boundaries into a closed snapshot model. A dedicated Fastify runtime binds only to loopback, serves one read-only JSON snapshot plus self-contained HTML/CSS/JS assets, and is never wired into Caddy, Railway, the public Fastify app, Redis, BullMQ, or trust/Publication mutation code.

**Tech Stack:** Node.js 22.13.0, TypeScript 5.9.3, Fastify 5.10.0, PostgreSQL 17 / `pg` 8.22.0, Node test runner, GitHub Actions.

## Global Constraints

- Base is `main@5e8aa27815a3ba0fc31dcee79c6bd9d80f49327f`.
- Production delivery is out of scope.
- Operator runtime may bind only to `127.0.0.1`, `::1`, or `localhost`.
- PostgreSQL is the only runtime data dependency; no Redis/BullMQ.
- No CORS, browser credential, public operator route, Caddy route, Railway service, polling, automatic refresh, or write HTTP method.
- Operator code may read monitoring/feedback authority but may not mutate Evidence, HumanReview, Moderation, Eligibility, Publication, monitoring alerts, or feedback submissions.
- Feedback details are untrusted plain text and must be rendered with DOM `textContent`, never `innerHTML`.
- All operator HTTP responses are `Cache-Control: no-store` and carry closed security headers.

---

### Task 1: Combined operator signal reader

**Files:**
- Create: `backend/src/modules/operator/types.ts`
- Create: `backend/src/modules/operator/read-operator-publication-signals.ts`
- Create: `backend/test/operator-signal-reader.test.ts`

**Interfaces:**
- Consumes: `readOpenPublicationMonitoringAlerts(pool)` and `readPublicationFeedbackSignals(pool, options)`.
- Produces: `readOperatorPublicationSignals(pool, options?, dependencies?) -> Promise<OperatorSnapshot>` plus closed `OperatorSnapshot` / `OperatorPublicationSignal` types.

- [ ] **Step 1: Write the failing signal-reader tests**

Create test fixtures for monitoring and feedback readers and inject them through a narrow test-only dependency object. Cover exact version join, monitoring-only, feedback-only active/historical, cross-version isolation, ranking, summary and option pass-through.

```ts
const snapshot = await readOperatorPublicationSignals(fakePool, {
  sinceHours: 24,
  limit: 25,
  detailSampleLimit: 2,
  now,
}, {
  readMonitoring: async () => [criticalAlert],
  readFeedback: async (_pool, options) => {
    assert.equal(options.sinceHours, 24);
    return [matchingFeedback, historicalFeedback];
  },
});

assert.equal(snapshot.schemaVersion, 1);
assert.equal(snapshot.signals[0].priority, 'critical');
assert.equal(snapshot.signals[0].feedback?.totalCount, matchingFeedback.totalCount);
assert.equal(snapshot.signals[1].isActiveVersion, false);
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm --prefix backend test -- --test-name-pattern="operator signal"`

Expected RED: module `../src/modules/operator/read-operator-publication-signals.js` is missing.

- [ ] **Step 3: Implement closed types and the reader**

`types.ts` defines:

```ts
export type OperatorPriority = 'critical' | 'warning' | 'feedback';
export type OperatorSnapshot = {
  schemaVersion: 1;
  generatedAt: string;
  sinceHours: number;
  summary: { critical: number; warning: number; feedbackOnly: number; total: number };
  signals: OperatorPublicationSignal[];
};
```

`read-operator-publication-signals.ts` must:

```ts
const key = (publicationId: string, versionId: string) => `${publicationId}:${versionId}`;
const priorityRank = { critical: 0, warning: 1, feedback: 2 } as const;
```

Call the two existing readers, join only exact `(publicationId, publicationVersionId)`, create feedback-only rows for unmatched groups, derive `priority`, compute summary and apply deterministic sort from the spec. Default dependencies are the real 7A/7B readers; injected dependencies are accepted only as function parameters and expose no mutation surface.

- [ ] **Step 4: Run focused tests and backend typecheck**

Run:

```bash
npm --prefix backend test -- --test-name-pattern="operator signal"
npm --prefix backend run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

Commit message: `feat: combine operator monitoring and feedback signals`.

---

### Task 2: Loopback-only operator configuration

**Files:**
- Create: `backend/src/operator/config.ts`
- Create: `backend/test/operator-config.test.ts`

**Interfaces:**
- Produces: `parseOperatorConfig(env): { host; port; databaseUrl }`.

- [ ] **Step 1: Write RED configuration tests**

```ts
assert.deepEqual(parseOperatorConfig({ DATABASE_URL: 'postgres://local' }), {
  host: '127.0.0.1',
  port: 3011,
  databaseUrl: 'postgres://local',
});
for (const host of ['0.0.0.0', '192.168.1.5', 'operator.example.com']) {
  assert.throws(() => parseOperatorConfig({ DATABASE_URL: 'postgres://local', OPERATOR_HOST: host }),
    /OPERATOR_HOST must be loopback-only/);
}
```

Also accept `127.0.0.1`, `::1`, `localhost`; reject invalid port and missing database URL.

- [ ] **Step 2: Run focused test and verify RED**

Run: `npm --prefix backend test -- --test-name-pattern="operator config"`

Expected RED: missing config module.

- [ ] **Step 3: Implement strict parser**

Use an exact set:

```ts
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);
```

Default to port `3011`; require integer `1..65535`; trim and require `DATABASE_URL`. Do not parse/read Redis or any feedback secret.

- [ ] **Step 4: Run focused tests + typecheck**

Expected PASS.

- [ ] **Step 5: Commit**

Commit message: `feat: add loopback-only operator configuration`.

---

### Task 3: Read-only Fastify operator HTTP surface and safe assets

**Files:**
- Create: `backend/src/operator/assets.ts`
- Create: `backend/src/operator/http.ts`
- Create: `backend/test/operator-http.test.ts`

**Interfaces:**
- Consumes: an `OperatorSnapshotReader` dependency and PostgreSQL readiness dependency.
- Produces: `buildOperatorApp(options): FastifyInstance`.

- [ ] **Step 1: Write RED HTTP tests**

Use `app.inject()` to verify:

```ts
const response = await app.inject({ method: 'GET', url: '/api/operator/v1/snapshot?sinceHours=24&limit=10&detailSampleLimit=2' });
assert.equal(response.statusCode, 200);
assert.equal(response.headers['cache-control'], 'no-store');
```

Cover:
- malformed/non-integer/out-of-range query -> 400 before reader invocation;
- reader failure -> sanitized 503 `OPERATOR_SNAPSHOT_UNAVAILABLE`;
- ready health depends only on PostgreSQL readiness;
- POST/PUT/PATCH/DELETE to `/api/operator/v1/snapshot` -> 404;
- `/`, `/operator.js`, `/operator.css` -> 200 and security headers;
- no asset string contains `http://`, `https://`, `localStorage`, `sessionStorage`, `innerHTML`, `setInterval` or external fetch URL;
- JS source contains `textContent` and a manual refresh button handler.

- [ ] **Step 2: Run focused test and verify RED**

Run: `npm --prefix backend test -- --test-name-pattern="operator http"`

Expected RED: missing operator HTTP/assets modules.

- [ ] **Step 3: Implement assets using safe DOM APIs**

`assets.ts` exports constant `OPERATOR_HTML`, `OPERATOR_CSS`, `OPERATOR_JS`. The JS must create cards with `document.createElement`, assign community text through `node.textContent`, issue one same-origin snapshot GET on startup, and issue another only when `Làm mới` is clicked. No polling timer.

- [ ] **Step 4: Implement HTTP app**

`buildOperatorApp()` creates an isolated Fastify instance. Add an `onSend` hook for:

```txt
Cache-Control: no-store
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'
```

Strictly parse query bounds `sinceHours 1..720`, `limit 1..100`, `detailSampleLimit 0..5`, capture one `now`, call the snapshot reader and sanitize errors.

- [ ] **Step 5: Run focused tests + typecheck**

Expected PASS.

- [ ] **Step 6: Commit**

Commit message: `feat: add read-only operator console http surface`.

---

### Task 4: Compose the standalone operator runtime

**Files:**
- Create: `backend/src/operator-server.ts`
- Modify: `backend/package.json`
- Create: `backend/test/operator-runtime-source.test.ts`

**Interfaces:**
- Consumes: `parseOperatorConfig`, `buildOperatorApp`, `readOperatorPublicationSignals`, `pg.Pool`.
- Produces: standalone `operator-server.js` runtime only.

- [ ] **Step 1: Write RED source/runtime contract**

Assert `operator-server.ts` exists, imports PostgreSQL/operator modules, does not import Redis/BullMQ/public backend server, and calls `app.listen({ host: config.host, port: config.port })`.

- [ ] **Step 2: Verify RED**

Run the focused runtime test. Expected missing file/script failure.

- [ ] **Step 3: Implement runtime composition**

Create `Pool({ connectionString: config.databaseUrl })`, provide PostgreSQL readiness as `select 1`, wire `readOperatorPublicationSignals`, listen only to parsed host/port, and shut down app + pool on SIGINT/SIGTERM.

Update backend scripts:

```json
"operator:dev": "node --import tsx src/operator-server.ts",
"operator": "node dist/src/operator-server.js"
```

- [ ] **Step 4: Run runtime test, typecheck and build**

Expected PASS.

- [ ] **Step 5: Commit**

Commit message: `feat: compose standalone operator runtime`.

---

### Task 5: Authority/deployment isolation, runbook and repository contract

**Files:**
- Create: `backend/test/operator-authority-isolation.test.ts`
- Create: `tests/operator-surface-contract.test.mjs`
- Create: `docs/runbooks/operator-surface.md`
- Modify: root `package.json`

**Interfaces:**
- Produces: `npm run test:operator-surface` repository gate.

- [ ] **Step 1: Write RED isolation tests and repository contract**

The backend source test scans `backend/src/operator/**`, `backend/src/operator-server.ts`, and `backend/src/modules/operator/**` for forbidden imports/tokens including publication mutation, rollback, evidence/review/moderation/eligibility mutation, monitoring evaluator, feedback submitter, Redis, BullMQ and queue modules.

The root contract must assert:

```js
assert.doesNotMatch(productionCaddy, /operator/i);
assert.doesNotMatch(stagingCaddy, /operator/i);
assert.doesNotMatch(railwayText, /operator-server|operator:dev|npm run operator/);
assert.match(operatorConfig, /127\.0\.0\.1/);
```

It also checks the runbook's exact loopback commands and verifies no public Next `app/operator` route exists.

- [ ] **Step 2: Run repository contract and verify RED**

Expected failure because runbook/root script do not yet exist.

- [ ] **Step 3: Write runbook and root scripts**

Runbook documents:

```bash
cd backend
DATABASE_URL='postgres://...' npm run operator:dev
# open http://127.0.0.1:3011
```

It explicitly warns never to set `OPERATOR_HOST=0.0.0.0`, never to expose the port through Caddy/Railway, and explains monitoring/feedback are advisory/read-only.

Add root script:

```json
"test:operator-surface": "node --test tests/operator-surface-contract.test.mjs"
```

Prepend `npm run test:operator-surface` to root `test` so inherited regression gates cannot skip 7C.

- [ ] **Step 4: Run contract + full backend verification**

Run:

```bash
npm run test:operator-surface
npm --prefix backend run typecheck
npm --prefix backend test
npm --prefix backend run build
```

Expected PASS.

- [ ] **Step 5: Commit**

Commit message: `test: harden operator authority and deployment isolation`.

---

### Task 6: Dedicated Sprint 7C CI gate and exact-head handoff

**Files:**
- Create: `.github/workflows/sprint-7c-operator-surface.yml`

**Interfaces:**
- Produces: exact-head `Sprint 7C operator surface gate`.

- [ ] **Step 1: Write the workflow**

PR path filters include all 7C production/test/docs files plus root/backend package manifests. Use Node `22.13.0`, PostgreSQL `17`, `permissions: contents: read`, root/backend `npm ci`, `npm run test:operator-surface`, backend typecheck/full tests/build, `git diff --check`, repository cleanliness and the existing deployment guard pattern. Do not add deploy commands or write permissions.

- [ ] **Step 2: Commit and open draft PR**

Commit message: `ci: gate Sprint 7C operator surface`.

Open draft PR `Sprint 7C: monitoring and feedback operator surface` against `main` with the authority/deployment boundaries and `SPRINT_7C_IMPLEMENTATION_IN_PROGRESS` marker.

- [ ] **Step 3: Verify exact-head workflows**

Require success for:

- Sprint 7C operator surface gate;
- Sprint 7B feedback intake gate if path filters trigger it;
- Sprint 7A post-publication monitoring gate if path filters trigger it;
- frontend/backend regression gate;
- staging integration gate;
- release candidate gate;
- deploy workflow dry run.

- [ ] **Step 4: Manual diff review**

Review exact `main...head` for Critical/Important findings: accidental public exposure, non-loopback binding, write method, unsafe text rendering, data persistence, trust/Publication mutation imports, Redis/BullMQ dependencies, Caddy/Railway wiring, credential leakage and error leakage.

If any issue is found, add a failing regression test before the fix, implement the fix and rerun exact-head CI.

- [ ] **Step 5: Finish and merge**

After fresh exact-head verification and zero unresolved Critical/Important blocker, update PR body to `SPRINT_7C_REPO_READY`, mark ready, recheck base/head/mergeability, merge with `expected_head_sha`, then verify `main` equals the merge commit. Do not deploy production.
