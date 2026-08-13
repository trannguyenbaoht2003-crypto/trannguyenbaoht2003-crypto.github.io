# Sprint 6A Production Delivery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a deterministic, exact-SHA-gated Railway production delivery path for the verified same-origin application, while preserving fail-closed migrations, static fallback, private backend/database networking, and the existing Publication authority boundaries.

**Architecture:** Keep the Sprint 5C/5D topology: a public Caddy gateway serves the static Next export and proxies read-only API/health traffic to a private Fastify backend; Railway Postgres and Redis remain private. GitHub Actions performs release verification from an explicit `release_sha`, then deploys backend before gateway through Railway CLI only when binding variables/secrets are present. Repository-only CI can validate production artifacts but can never emit `PRODUCTION_DELIVERY_READY`; that marker belongs only to a real-environment smoke + rollback rehearsal.

**Tech Stack:** GitHub Actions, Node.js 22.13.0, Next.js static export, Caddy, Docker, Fastify, PostgreSQL 17, Redis 7, Railway Config-as-Code/CLI.

## Global Constraints

- Production provider: Railway.
- Only the gateway may have public HTTP exposure.
- Backend binds `HOST=0.0.0.0`, `PORT=3001` and has no public Railway domain.
- Frontend remains `NEXT_PUBLIC_PUBLIC_API_BASE_URL=same-origin`.
- No CORS expansion, browser credential, public Publication mutation route, automatic Publication, direct-SQL Publication seed, or default worker is added.
- Backend migration command remains `node dist/src/migrate-cli.js` and must fail closed before a new backend deployment can become healthy.
- Actual production deployment uses `workflow_dispatch` with explicit full `release_sha`; Railway GitHub autodeploy remains disabled for Sprint 6A.
- `RAILWAY_TOKEN` is a GitHub Actions secret only; project/environment/service identifiers must never be hard-coded as credentials.
- CI must fail if required Railway binding is absent; it must never create a project/service implicitly.
- Runtime audit threshold remains `npm audit --omit=dev --audit-level=high`.
- Repository-only validation must never emit `PRODUCTION_DELIVERY_READY`.
- `PRODUCTION_DELIVERY_READY` is allowed only after a real Railway production smoke and application rollback rehearsal succeed.

---

## File Map

- `tests/production-delivery.test.mjs` — source contracts for Railway manifests, gateway safety, exact-SHA workflow, smoke/rollback scripts, and marker exclusion.
- `deploy/production/Caddyfile` — production same-origin routing using one trusted environment-supplied backend origin.
- `deploy/production/Dockerfile.gateway` — builds the static frontend with same-origin API mode and runs Caddy as non-root on port 8080.
- `deploy/production/railway.gateway.toml` — Railway build/deploy/health settings for the gateway service.
- `deploy/production/production.env.example` — non-secret variable names and safe local examples only.
- `backend/railway.toml` — Railway backend Docker/pre-deploy/start/health settings.
- `scripts/production-smoke.mjs` — one-shot production public smoke checks with bounded safe logging.
- `scripts/production-rollback-verify.mjs` — verifies post-rollback public health/read contract and exact expected release metadata supplied by the workflow/operator.
- `.github/workflows/production-release-gate.yml` — exact-SHA verification and deploy jobs; deployment remains fail-closed when Railway binding is unavailable.
- `docs/runbooks/production-delivery.md` — one-time Railway bootstrap, release, smoke, rollback, and failure recovery instructions.
- `package.json` — focused scripts for production source contracts and smoke/rollback tooling.

---

### Task 1: Lock Production Delivery Source Contracts

**Files:**
- Create: `tests/production-delivery.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces: root script `test:production-delivery` executing `node --test tests/production-delivery.test.mjs`.
- Later tasks must satisfy the source contract; Task 1 must not create production manifests or deployment workflow.

- [ ] **Step 1: Write the failing source-contract test**

Create `tests/production-delivery.test.mjs` with focused assertions that:

```js
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function text(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

async function missing(path) {
  try {
    await text(path);
    return false;
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    throw error;
  }
}

test("production delivery artifacts are explicit and fail closed", async () => {
  assert.equal(await missing("deploy/production/Caddyfile"), false, "production Caddyfile must exist");
  assert.equal(await missing("deploy/production/Dockerfile.gateway"), false, "production gateway Dockerfile must exist");
  assert.equal(await missing("deploy/production/railway.gateway.toml"), false, "gateway Railway config must exist");
  assert.equal(await missing("backend/railway.toml"), false, "backend Railway config must exist");
});

test("production workflow is exact-SHA gated and cannot claim real readiness in CI", async () => {
  const workflow = await text(".github/workflows/production-release-gate.yml");
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /release_sha/);
  assert.match(workflow, /RAILWAY_TOKEN/);
  assert.doesNotMatch(workflow, /PRODUCTION_DELIVERY_READY/);
  assert.doesNotMatch(workflow, /contents:\s*write|pages:\s*write|id-token:\s*write/);
});

test("production scripts and runbook exist", async () => {
  for (const path of [
    "scripts/production-smoke.mjs",
    "scripts/production-rollback-verify.mjs",
    "docs/runbooks/production-delivery.md",
  ]) {
    assert.equal(await missing(path), false, `${path} must exist`);
  }
});
```

Add to `package.json`:

```json
"test:production-delivery": "node --test tests/production-delivery.test.mjs"
```

and include `npm run test:production-delivery` in the root `test` chain before the static build.

- [ ] **Step 2: Run RED**

Run:

```bash
npm run test:production-delivery
```

Expected: FAIL only because production artifacts/workflow/scripts do not yet exist. Existing package JSON must remain valid.

- [ ] **Step 3: Commit RED**

```bash
git add tests/production-delivery.test.mjs package.json
git commit -m "test: define production delivery contracts"
```

---

### Task 2: Add Railway Gateway and Backend Production Manifests

**Files:**
- Create: `deploy/production/Caddyfile`
- Create: `deploy/production/Dockerfile.gateway`
- Create: `deploy/production/railway.gateway.toml`
- Create: `deploy/production/production.env.example`
- Create: `backend/railway.toml`
- Modify: `tests/production-delivery.test.mjs`

**Interfaces:**
- Consumes: existing `backend/Dockerfile`, `deploy/staging/Dockerfile.frontend`, static `out/` contract, backend health endpoints.
- Produces: gateway runtime environment variable `BACKEND_ORIGIN`; deterministic Railway configs for gateway/backend.

- [ ] **Step 1: Strengthen the failing tests before implementation**

Add assertions that require:

```js
const caddy = await text("deploy/production/Caddyfile");
assert.match(caddy, /\{env\.BACKEND_ORIGIN\}/);
assert.match(caddy, /handle \/api\/v1\/\*/);
assert.match(caddy, /header Cache-Control "no-store"/);
assert.doesNotMatch(caddy, /header Access-Control-Allow-Origin|Authorization/);

const gatewayDockerfile = await text("deploy/production/Dockerfile.gateway");
assert.match(gatewayDockerfile, /NEXT_PUBLIC_PUBLIC_API_BASE_URL=same-origin/);
assert.match(gatewayDockerfile, /USER caddy/);
assert.match(gatewayDockerfile, /EXPOSE 8080/);

const backendRailway = await text("backend/railway.toml");
assert.match(backendRailway, /preDeployCommand\s*=\s*"node dist\/src\/migrate-cli\.js"/);
assert.match(backendRailway, /healthcheckPath\s*=\s*"\/health\/ready"/);

const gatewayRailway = await text("deploy/production/railway.gateway.toml");
assert.match(gatewayRailway, /healthcheckPath\s*=\s*"\/"/);
```

Run `npm run test:production-delivery` and confirm the intended new assertions fail.

- [ ] **Step 2: Implement production Caddy routing**

Create `deploy/production/Caddyfile`:

```caddy
:8080 {
  root * /srv
  encode zstd gzip

  handle /api/v1/* {
    header Cache-Control "no-store"
    reverse_proxy {env.BACKEND_ORIGIN}
  }

  handle /health/* {
    header Cache-Control "no-store"
    reverse_proxy {env.BACKEND_ORIGIN}
  }

  handle {
    try_files {path} {path}/ /index.html
    file_server
  }

  handle_errors {
    respond "Service temporarily unavailable" {http.error.status_code}
  }
}
```

`BACKEND_ORIGIN` is a trusted Railway service variable such as `http://backend.railway.internal:3001`; it is never accepted from a browser request.

- [ ] **Step 3: Implement non-root gateway image**

Create `deploy/production/Dockerfile.gateway` based on the proven staging frontend image, with:

```dockerfile
FROM node:22.13.0-bookworm-slim AS build
WORKDIR /app
ARG NEXT_PUBLIC_PUBLIC_API_BASE_URL=same-origin
ENV NEXT_PUBLIC_PUBLIC_API_BASE_URL=${NEXT_PUBLIC_PUBLIC_API_BASE_URL}
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build:pages

FROM caddy:2-alpine
COPY deploy/production/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/out /srv
USER caddy
EXPOSE 8080
```

Do not copy `.env`, credentials, backend source artifacts, or node_modules into the runtime image.

- [ ] **Step 4: Implement Railway Config-as-Code**

Create `backend/railway.toml`:

```toml
[build]
builder = "DOCKERFILE"
dockerfilePath = "Dockerfile"

[deploy]
preDeployCommand = "node dist/src/migrate-cli.js"
startCommand = "node dist/src/server.js"
healthcheckPath = "/health/ready"
healthcheckTimeout = 120
restartPolicyType = "ON_FAILURE"
restartPolicyMaxRetries = 3
```

Create `deploy/production/railway.gateway.toml`:

```toml
[build]
builder = "DOCKERFILE"
dockerfilePath = "deploy/production/Dockerfile.gateway"

[deploy]
healthcheckPath = "/"
healthcheckTimeout = 120
restartPolicyType = "ON_FAILURE"
restartPolicyMaxRetries = 3
```

Create `deploy/production/production.env.example` containing names/examples only:

```dotenv
# Non-secret shape only. Real values live in Railway/GitHub environment configuration.
NODE_ENV=production
HOST=0.0.0.0
PORT=3001
BACKEND_ORIGIN=http://backend.railway.internal:3001
NEXT_PUBLIC_PUBLIC_API_BASE_URL=same-origin
```

Do not include `DATABASE_URL`, `REDIS_URL`, project tokens, passwords, or public production hostnames with real values.

- [ ] **Step 5: Run GREEN contracts and image builds**

Run:

```bash
npm run test:production-delivery
docker build -f backend/Dockerfile backend
docker build -f deploy/production/Dockerfile.gateway .
```

Expected: production manifest contract PASS and both images build successfully.

- [ ] **Step 6: Commit**

```bash
git add deploy/production backend/railway.toml tests/production-delivery.test.mjs
git commit -m "feat: add Railway production manifests"
```

---

### Task 3: Add Safe Production Smoke and Rollback Verification

**Files:**
- Create: `scripts/production-smoke.mjs`
- Create: `scripts/production-rollback-verify.mjs`
- Modify: `package.json`
- Modify: `tests/production-delivery.test.mjs`

**Interfaces:**
- `production-smoke.mjs` consumes `PRODUCTION_BASE_URL` and optional `EXPECTED_RELEASE_SHA`.
- `production-rollback-verify.mjs` consumes `PRODUCTION_BASE_URL` and `EXPECTED_ROLLBACK_SHA`.
- Both produce bounded stdout status lines and non-zero exit on mismatch; neither retries or polls.

- [ ] **Step 1: Add failing script source contracts**

Require the scripts to contain no timer/retry/auth behavior and to check the read-only boundary:

```js
for (const path of ["scripts/production-smoke.mjs", "scripts/production-rollback-verify.mjs"]) {
  const source = await text(path);
  assert.doesNotMatch(source, /setTimeout|setInterval|Authorization|Bearer|process\.env\.(DATABASE_URL|REDIS_URL|RAILWAY_TOKEN)/);
}
const smoke = await text("scripts/production-smoke.mjs");
assert.match(smoke, /\/api\/v1\/publications/);
assert.match(smoke, /method:\s*"POST"/);
```

Run `npm run test:production-delivery` and confirm RED because scripts are absent.

- [ ] **Step 2: Implement one-shot production smoke**

`production-smoke.mjs` must:

1. validate `PRODUCTION_BASE_URL` is an `https:` URL except when `ALLOW_HTTP_PRODUCTION_SMOKE=1` is explicitly set for controlled rehearsal;
2. perform exactly one request each to `/`, `/health/live`, `/health/ready`, GET `/api/v1/publications`, and POST `/api/v1/publications`;
3. require root/live/ready/list = 200 and POST = 404 or 405;
4. parse list JSON and require `{ schemaVersion: 1, publications: Array }` with no unknown top-level contract assumption beyond the closed expected envelope;
5. print only route class and HTTP status, never environment dumps or response bodies;
6. if `EXPECTED_RELEASE_SHA` is set, validate it only against a safe release metadata endpoint/header if implemented by the workflow/deployment platform; otherwise record the SHA in workflow evidence rather than inventing an application endpoint.

Export no reusable credential or request-header facility.

- [ ] **Step 3: Implement post-rollback verifier**

`production-rollback-verify.mjs` repeats the safe root/live/ready/list/mutation checks after an operator or Railway rollback action. It requires `EXPECTED_ROLLBACK_SHA` to be a 40-hex SHA and prints:

```text
rollback expected-sha <first12>
rollback root 200
rollback live 200
rollback ready 200
rollback publications 200
rollback mutation-probe 404
ROLLBACK_VERIFIED
```

The script does not perform the Railway rollback itself; it verifies the real environment after the rollback action so the application does not gain a Railway credential-bearing control plane.

- [ ] **Step 4: Add package scripts and run GREEN**

Add:

```json
"production:smoke": "node scripts/production-smoke.mjs",
"production:rollback-verify": "node scripts/production-rollback-verify.mjs"
```

Run:

```bash
npm run test:production-delivery
```

Expected: PASS for script source contracts without requiring a live environment.

- [ ] **Step 5: Commit**

```bash
git add scripts/production-smoke.mjs scripts/production-rollback-verify.mjs package.json tests/production-delivery.test.mjs
git commit -m "feat: add production smoke and rollback verification"
```

---

### Task 4: Add Exact-SHA Production Release Workflow

**Files:**
- Create: `.github/workflows/production-release-gate.yml`
- Modify: `tests/production-delivery.test.mjs`

**Interfaces:**
- Workflow input: `release_sha` (required, 40-hex SHA).
- GitHub environment variables: `RAILWAY_PROJECT_ID`, `RAILWAY_ENVIRONMENT`, `RAILWAY_BACKEND_SERVICE`, `RAILWAY_GATEWAY_SERVICE`, `PRODUCTION_BASE_URL`.
- GitHub environment secret: `RAILWAY_TOKEN`.
- Produces deployment evidence only; never emits `PRODUCTION_DELIVERY_READY`.

- [ ] **Step 1: Add failing workflow contracts**

Require:

```js
const workflow = await text(".github/workflows/production-release-gate.yml");
for (const token of [
  "workflow_dispatch:",
  "release_sha:",
  "RAILWAY_PROJECT_ID",
  "RAILWAY_ENVIRONMENT",
  "RAILWAY_BACKEND_SERVICE",
  "RAILWAY_GATEWAY_SERVICE",
  "RAILWAY_TOKEN",
  "npm run test:production-delivery",
  "npm run release:security-gate",
  "npm run production:smoke",
]) assert.ok(workflow.includes(token), `workflow missing ${token}`);
assert.match(workflow, /git merge-base --is-ancestor/);
assert.match(workflow, /railway up --ci/);
assert.doesNotMatch(workflow, /railway init|railway add|railway link|PRODUCTION_DELIVERY_READY/);
assert.doesNotMatch(workflow, /(contents|packages|pages|id-token):\s*write/);
```

Run RED before creating the workflow.

- [ ] **Step 2: Implement exact-SHA verification job**

Create `.github/workflows/production-release-gate.yml` with:

```yaml
name: Production release gate

on:
  workflow_dispatch:
    inputs:
      release_sha:
        description: Full 40-character main commit SHA to release
        required: true
        type: string

permissions:
  contents: read

jobs:
  verify:
    runs-on: ubuntu-latest
    timeout-minutes: 60
    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${{ inputs.release_sha }}
          fetch-depth: 0
      - name: Verify exact main SHA
        shell: bash
        run: |
          set -euo pipefail
          release_sha='${{ inputs.release_sha }}'
          [[ "$release_sha" =~ ^[0-9a-f]{40}$ ]]
          test "$(git rev-parse HEAD)" = "$release_sha"
          git fetch origin main --no-tags
          git merge-base --is-ancestor "$release_sha" origin/main
```

Then install Node 22.13.0, run root/backend `npm ci`, community validation, lint, public/staging/release/production source tests, full root test/static build, backend typecheck/tests/build, runtime audit, and both Docker builds. Keep repository cleanliness and secret/deployment guard checks.

- [ ] **Step 3: Implement fail-closed deploy job**

`deploy` must depend on `verify`, use a protected GitHub `environment: production`, and first validate that all binding values exist without printing them:

```bash
for name in RAILWAY_PROJECT_ID RAILWAY_ENVIRONMENT RAILWAY_BACKEND_SERVICE RAILWAY_GATEWAY_SERVICE PRODUCTION_BASE_URL RAILWAY_TOKEN; do
  test -n "${!name:-}" || { echo "missing required production binding: $name" >&2; exit 1; }
done
```

Install a pinned Railway CLI version selected from current official documentation/release availability during implementation. Do not use `latest` implicitly.

Deploy from the exact checkout with explicit target flags, backend first and gateway second, using the current supported equivalent of:

```bash
railway up --ci --project "$RAILWAY_PROJECT_ID" --environment "$RAILWAY_ENVIRONMENT" --service "$RAILWAY_BACKEND_SERVICE"
railway up --ci --project "$RAILWAY_PROJECT_ID" --environment "$RAILWAY_ENVIRONMENT" --service "$RAILWAY_GATEWAY_SERVICE"
```

If current CLI syntax differs, update both workflow and source test to the documented current syntax; do not introduce `railway init`, implicit project creation, or auto-link behavior.

Run `npm run production:smoke` with `PRODUCTION_BASE_URL` only after both deploy commands succeed.

- [ ] **Step 4: Verify workflow source contract GREEN**

Run:

```bash
npm run test:production-delivery
npm test
```

Expected: all source tests and inherited regression tests PASS. The deploy job is expected to remain unexecuted in PR CI because this workflow is `workflow_dispatch` only.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/production-release-gate.yml tests/production-delivery.test.mjs
git commit -m "ci: add exact-SHA Railway production release gate"
```

---

### Task 5: Production Runbook, Regression Gate, and Release Handoff

**Files:**
- Create: `docs/runbooks/production-delivery.md`
- Modify: `tests/production-delivery.test.mjs`
- Modify: `.github/workflows/backend-production-foundation.yml` only if needed to include production source-contract regression without adding deploy capability.

**Interfaces:**
- Runbook is the authoritative one-time Railway bootstrap/release/rollback procedure.
- Repository completion marker for this task is `PRODUCTION_REPOSITORY_READY`, not `PRODUCTION_DELIVERY_READY`.

- [ ] **Step 1: Add failing runbook contract**

Require the runbook to include all exact phrases/concepts:

```js
const runbook = await text("docs/runbooks/production-delivery.md");
for (const token of [
  "Railway project",
  "gateway",
  "backend",
  "PostgreSQL",
  "Redis",
  "GitHub environment",
  "RAILWAY_TOKEN",
  "workflow_dispatch",
  "release_sha",
  "GitHub autodeploy disabled",
  "production:smoke",
  "production:rollback-verify",
  "PRODUCTION_DELIVERY_READY",
  "Sprint 6B",
]) assert.ok(runbook.includes(token), `runbook missing ${token}`);
```

The runbook must explicitly state that repository completion does not equal real production completion.

- [ ] **Step 2: Write one-time bootstrap procedure**

Document exact operator steps:

1. create/select one Railway production project;
2. create gateway and backend services from the GitHub repo;
3. add Railway PostgreSQL and Redis services;
4. set gateway Config-as-Code path `/deploy/production/railway.gateway.toml` and backend path `/backend/railway.toml`;
5. disable GitHub autodeploy on both application services;
6. bind `DATABASE_URL` and `REDIS_URL` as Railway reference variables for backend;
7. bind `BACKEND_ORIGIN=http://<backend-private-domain>:3001` as a Railway private reference-derived value for gateway;
8. expose a public domain only on gateway;
9. create GitHub protected environment `production` with non-secret variables plus secret `RAILWAY_TOKEN`;
10. run production workflow with exact `main` SHA.

Do not document copying tokens into local files or source control.

- [ ] **Step 3: Write release and rollback procedure**

Release section:

```text
main exact SHA -> workflow_dispatch(release_sha) -> verify -> backend deploy/pre-deploy migration -> gateway deploy -> production smoke
```

Rollback section:

1. use Railway dashboard/control plane to roll backend/gateway back to the previously verified application deployment;
2. do not perform database down migration;
3. run `EXPECTED_ROLLBACK_SHA=<40hex> PRODUCTION_BASE_URL=https://... npm run production:rollback-verify` from a trusted operator/CI environment;
4. record Railway deployment identifiers and exact Git SHA in release evidence;
5. emit `PRODUCTION_DELIVERY_READY` only after first real smoke plus rollback rehearsal both succeed.

- [ ] **Step 4: Fresh full verification**

Run from exact branch head:

```bash
npm ci
npm --prefix backend ci
npm run validate:community
npm run lint
npm run test:public-data
npm run test:staging-contract
npm run test:release-source
npm run test:production-delivery
npm test
npm run backend:typecheck
npm run backend:test
npm run backend:build
npm run release:security-gate
docker build -f backend/Dockerfile backend
docker build -f deploy/production/Dockerfile.gateway .
git diff --check
```

Expected: all PASS. No real-production readiness marker is emitted.

- [ ] **Step 5: Independent review**

Review exact range from `512baaaa730c39b20d22ec5faa1bca727cae6283` to final Sprint 6A repository head for:

- unintended public backend exposure;
- CORS/browser credential expansion;
- Publication mutation/auto-publication;
- Railway implicit project creation;
- leaked token/project secret;
- deployment from non-main/non-exact SHA;
- workflow write permissions;
- retry/polling loops;
- `PRODUCTION_DELIVERY_READY` emitted by CI or repository-only code.

Fix every Critical/Important issue before completion.

- [ ] **Step 6: Commit and open draft PR**

```bash
git add docs/runbooks/production-delivery.md tests/production-delivery.test.mjs .github/workflows/backend-production-foundation.yml
git commit -m "docs: add production delivery operations runbook"
```

Open a draft PR to `main` with exact-head evidence. Do not merge until the repository gate is green and review is clean.

- [ ] **Step 7: Repository handoff state**

After exact-head repository verification, record:

```text
PRODUCTION_REPOSITORY_READY
```

This means manifests/workflows/runbook are ready for the external one-time Railway binding. It is explicitly **not** `PRODUCTION_DELIVERY_READY`.

The real completion sequence after repository merge is:

```text
Railway account bootstrap
-> production workflow on exact main SHA
-> real public smoke
-> deploy next compatible revision / rollback to prior revision
-> rollback verification
-> PRODUCTION_DELIVERY_READY
```
