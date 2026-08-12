# Sprint 6A — Production Delivery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the verified Sprint 5D application as an exact-SHA-gated Railway production release with one public same-origin gateway, a private Fastify backend, fail-closed migrations, safe public smoke tests, and an explicit external bootstrap boundary.

**Architecture:** Preserve the proven Sprint 5C/5D topology. Railway hosts gateway + backend + PostgreSQL + Redis; only the gateway receives a public domain. GitHub Actions verifies an explicit `release_sha`, then deploys backend before gateway with Railway CLI 5.30.1 and runs bounded production smoke. Real-environment rollback remains a separate evidence step and `PRODUCTION_DELIVERY_READY` must never be emitted by repository-only CI.

**Tech Stack:** Next.js 16 static export, Caddy 2, Node.js 22.13, Fastify 5, PostgreSQL 17, Redis 7, Docker, Railway Config-as-Code, Railway CLI 5.30.1, GitHub Actions.

## Global Constraints

- `NEXT_PUBLIC_PUBLIC_API_BASE_URL=same-origin` in production.
- Only the gateway may be publicly exposed.
- Backend binds `HOST=0.0.0.0` and `PORT=3001`; gateway uses `PORT=8080`.
- Backend Publication HTTP routes remain GET-only.
- PostgreSQL remains Publication authority; Redis is never public-read authority.
- No CORS expansion, browser token, public mutation route, automatic Publication, or rehearsal seed in production.
- Migration command is `node dist/src/migrate-cli.js` and must fail closed before backend activation.
- Railway GitHub autodeploy is disabled for Sprint 6A.
- Actual deploy is `workflow_dispatch` with a full explicit `release_sha` reachable from `main`.
- Railway CLI is pinned to `@railway/cli@5.30.1`.
- CI deploy uses `RAILWAY_TOKEN`, `RAILWAY_PROJECT_ID`, `RAILWAY_ENVIRONMENT`, `RAILWAY_BACKEND_SERVICE`, and `RAILWAY_GATEWAY_SERVICE`; missing binding fails closed.
- No production secret or environment dump may be committed or printed.
- `PRODUCTION_DELIVERY_READY` may be recorded only after a real Railway deployment, public smoke, and real rollback rehearsal succeed.

---

## File Structure

- `tests/production-delivery.test.mjs` — closed source/config/workflow contracts for all production assets.
- `deploy/production/Caddyfile` — same-origin static gateway and fixed trusted backend upstream placeholder.
- `deploy/production/Dockerfile.gateway` — non-root static frontend image built with `same-origin`.
- `deploy/production/railway.gateway.toml` — Railway gateway build/health/restart configuration.
- `deploy/production/production.env.example` — names/reference-variable examples only; no usable secret.
- `backend/railway.toml` — Railway backend build, migration, health and restart configuration.
- `scripts/production-smoke.mjs` — bounded HTTP smoke for root, health, GET Publication envelope, and negative POST.
- `scripts/production-browser-smoke.mjs` — headless browser hydration/static-fallback smoke against a real gateway URL.
- `.github/workflows/production-release-gate.yml` — exact-SHA verification and authorized Railway deployment.
- `docs/runbooks/production-delivery.md` — external bootstrap, release, smoke and rollback procedure/evidence rules.
- `package.json` — focused production-contract/smoke scripts wired into root test only where safe.

---

### Task 1: Lock Production Source Contracts

**Files:**
- Create: `tests/production-delivery.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: Sprint 6A design spec and existing staging/release source-contract style.
- Produces: `npm run test:production-contract` and closed assertions that later tasks must satisfy.

- [ ] **Step 1: Write the failing source-contract test**

Create tests that read files as text and initially fail because production artifacts do not exist. Assert all of the following:

```js
const requiredFiles = [
  'deploy/production/Caddyfile',
  'deploy/production/Dockerfile.gateway',
  'deploy/production/railway.gateway.toml',
  'deploy/production/production.env.example',
  'backend/railway.toml',
  'scripts/production-smoke.mjs',
  'scripts/production-browser-smoke.mjs',
  '.github/workflows/production-release-gate.yml',
  'docs/runbooks/production-delivery.md',
];
```

Contract assertions must include:

```js
assert.match(gatewayCaddy, /reverse_proxy\s+\{\$BACKEND_ORIGIN\}/);
assert.doesNotMatch(gatewayCaddy, /Access-Control-Allow-Origin/i);
assert.match(gatewayDockerfile, /NEXT_PUBLIC_PUBLIC_API_BASE_URL=same-origin/);
assert.match(gatewayRailway, /builder\s*=\s*"DOCKERFILE"/);
assert.match(backendRailway, /preDeployCommand\s*=\s*\["node dist\/src\/migrate-cli\.js"\]/);
assert.match(backendRailway, /healthcheckPath\s*=\s*"\/health\/ready"/);
assert.match(workflow, /workflow_dispatch:/);
assert.match(workflow, /release_sha:/);
assert.match(workflow, /@railway\/cli@5\.30\.1/);
assert.match(workflow, /railway up --ci --project/);
assert.doesNotMatch(workflow, /railway up[^\n]*--new/);
assert.doesNotMatch(workflow, /PRODUCTION_DELIVERY_READY/);
assert.doesNotMatch(workflow, /contents:\s*write|pages:\s*write|id-token:\s*write/);
```

Also assert `package.json` exposes:

```json
"test:production-contract": "node --test tests/production-delivery.test.mjs"
```

- [ ] **Step 2: Run RED**

Run through GitHub Actions by opening a draft PR or by the existing PR-triggered regression workflow after committing the test only.

Expected: existing tests remain green until `test:production-contract`, which fails with `ENOENT` for the first missing production artifact.

- [ ] **Step 3: Commit RED**

Commit message:

```text
test: define Sprint 6A production delivery contract
```

---

### Task 2: Add Railway Production Gateway and Backend Config

**Files:**
- Create: `deploy/production/Caddyfile`
- Create: `deploy/production/Dockerfile.gateway`
- Create: `deploy/production/railway.gateway.toml`
- Create: `deploy/production/production.env.example`
- Create: `backend/railway.toml`
- Test: `tests/production-delivery.test.mjs`

**Interfaces:**
- Consumes: existing `backend/Dockerfile`, staging gateway image/Caddy routing, `migrate-cli.js` output path.
- Produces: deterministic Railway Config-as-Code for two app services and a trusted `BACKEND_ORIGIN` gateway variable.

- [ ] **Step 1: Extend RED contract for exact config values**

Require gateway TOML:

```toml
[build]
builder = "DOCKERFILE"
dockerfilePath = "deploy/production/Dockerfile.gateway"

[deploy]
healthcheckPath = "/"
healthcheckTimeout = 300
restartPolicyType = "ON_FAILURE"
restartPolicyMaxRetries = 10
```

Require backend TOML:

```toml
[build]
builder = "DOCKERFILE"
dockerfilePath = "Dockerfile"

[deploy]
preDeployCommand = ["node dist/src/migrate-cli.js"]
healthcheckPath = "/health/ready"
healthcheckTimeout = 300
restartPolicyType = "ON_FAILURE"
restartPolicyMaxRetries = 10
```

Require production example variables to contain only symbolic/reference forms such as:

```text
BACKEND_ORIGIN=http://${{backend.RAILWAY_PRIVATE_DOMAIN}}:3001
DATABASE_URL=${{Postgres.DATABASE_URL}}
REDIS_URL=${{Redis.REDIS_URL}}
```

and reject password/token/private-key literals.

- [ ] **Step 2: Implement production gateway**

Use:

```caddy
:8080 {
  root * /srv
  encode zstd gzip

  handle /api/v1/* {
    header Cache-Control "no-store"
    reverse_proxy {$BACKEND_ORIGIN}
  }

  handle /health/* {
    header Cache-Control "no-store"
    reverse_proxy {$BACKEND_ORIGIN}
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

The gateway Dockerfile mirrors the proven staging image but copies the production Caddyfile, builds with the exact sentinel, and runs non-root UID 10001.

- [ ] **Step 3: Add Railway TOML files and safe env example**

Do not add service IDs or real domains. Keep service/account bindings external.

- [ ] **Step 4: Run GREEN source contract plus image builds**

Run:

```text
npm run test:production-contract
docker build -f deploy/production/Dockerfile.gateway .
docker build -f backend/Dockerfile backend
```

Expected: all pass; neither image requires a production secret at build time.

- [ ] **Step 5: Commit**

Commit message:

```text
feat: add Railway production service configuration
```

---

### Task 3: Add Production HTTP and Browser Smoke Probes

**Files:**
- Create: `scripts/production-smoke.mjs`
- Create: `scripts/production-browser-smoke.mjs`
- Modify: `package.json`
- Test: `tests/production-delivery.test.mjs`

**Interfaces:**
- Consumes: `PRODUCTION_BASE_URL` and the existing public Publication schemaVersion 1 envelope.
- Produces: `npm run production:smoke` and `npm run production:browser-smoke`.

- [ ] **Step 1: Add RED source assertions**

Require scripts to:

- accept only an absolute `https:` URL by default; allow `http://127.0.0.1` only when `PRODUCTION_SMOKE_ALLOW_LOCAL=1` for tests;
- never print the full base URL;
- perform one request per endpoint with no retry loop/timer;
- validate `schemaVersion === 1` and `Array.isArray(publications)`;
- send negative `POST /api/v1/publications` and require 404/405;
- browser smoke uses system `google-chrome`, `chromium`, or `chromium-browser` and validates brand + one of the safe public-data status states.

- [ ] **Step 2: Implement `production-smoke.mjs`**

Expected endpoint contract:

```js
await probe('/', 200);
await probe('/health/live', 200);
await probe('/health/ready', 200);
const publications = await readPublicationEnvelope('/api/v1/publications');
await rejectMutation('/api/v1/publications');
```

Output only bounded lines such as:

```text
production-smoke: root 200
production-smoke: live 200
production-smoke: ready 200
production-smoke: publications schema=1 count=0
production-smoke: mutation rejected 404
production-smoke: PASS
```

- [ ] **Step 3: Implement browser smoke**

Reuse the existing system-browser discovery approach. Dump hydrated DOM from `/`; require the LÕI.META marker, at least one known static guide marker (Samira), and one of:

```text
public-data-status static
public-data-status live
public-data-status fallback
```

Reject rehearsal UUID marker `8d000000-`.

- [ ] **Step 4: Add package scripts and focused tests**

Add:

```json
"production:smoke": "node scripts/production-smoke.mjs",
"production:browser-smoke": "node scripts/production-browser-smoke.mjs"
```

Use a local mock HTTP server inside the Node test to prove normal envelope and negative POST behavior without external network.

- [ ] **Step 5: Commit**

Commit message:

```text
feat: add bounded production smoke probes
```

---

### Task 4: Add Exact-SHA Production Release Workflow

**Files:**
- Create: `.github/workflows/production-release-gate.yml`
- Modify: `package.json` only if a production-contract script still needs wiring.
- Test: `tests/production-delivery.test.mjs`

**Interfaces:**
- Consumes: workflow input `release_sha`; GitHub environment `production`; secret `RAILWAY_TOKEN`; vars/secrets `RAILWAY_PROJECT_ID`, `RAILWAY_ENVIRONMENT`, `RAILWAY_BACKEND_SERVICE`, `RAILWAY_GATEWAY_SERVICE`, `PRODUCTION_BASE_URL`.
- Produces: two jobs: `verify` then `deploy`; no repository writes and no project creation.

- [ ] **Step 1: Extend RED workflow contract**

Require these exact safety properties:

```yaml
on:
  workflow_dispatch:
    inputs:
      release_sha:
        required: true

permissions:
  contents: read
```

Verify job must:

1. reject non-40-hex SHA;
2. fetch `main`;
3. run `git merge-base --is-ancestor "$RELEASE_SHA" origin/main`;
4. checkout/refetch exact SHA;
5. assert `git rev-parse HEAD` equals input;
6. run frontend/backend tests/build/audit/source contracts;
7. build both Docker images.

Deploy job must declare:

```yaml
needs: verify
environment: production
```

and fail closed for missing Railway binding before invoking CLI.

- [ ] **Step 2: Install pinned Railway CLI in deploy job**

Use:

```bash
npm install --global @railway/cli@5.30.1
railway --version
```

- [ ] **Step 3: Deploy exact checked-out tree**

Use the official CLI targeting flags and never `--new`:

```bash
railway up --ci \
  --project "$RAILWAY_PROJECT_ID" \
  --environment "$RAILWAY_ENVIRONMENT" \
  --service "$RAILWAY_BACKEND_SERVICE" \
  --message "release ${RELEASE_SHA} backend"

railway up --ci \
  --project "$RAILWAY_PROJECT_ID" \
  --environment "$RAILWAY_ENVIRONMENT" \
  --service "$RAILWAY_GATEWAY_SERVICE" \
  --message "release ${RELEASE_SHA} gateway"
```

Both commands run from repository root so Railway receives the exact checked-out monorepo tree and service Root Directory/Config File settings remain authoritative.

- [ ] **Step 4: Run public smoke after deploy**

Set only:

```text
PRODUCTION_BASE_URL=${{ vars.PRODUCTION_BASE_URL }}
```

Then run:

```text
npm run production:smoke
npm run production:browser-smoke
```

The workflow records the SHA and `PRODUCTION_DEPLOYED_AND_SMOKE_VERIFIED`, but must not print `PRODUCTION_DELIVERY_READY`.

- [ ] **Step 5: Add deploy guard contract**

Reject workflow content containing:

```text
--new
railway init
railway add
railway project new
contents: write
pages: write
id-token: write
printenv
env |
set -x
PRODUCTION_DELIVERY_READY
```

- [ ] **Step 6: Commit**

Commit message:

```text
ci: add exact-SHA Railway production release gate
```

---

### Task 5: Add Bootstrap, Rollback, and Evidence Runbook

**Files:**
- Create: `docs/runbooks/production-delivery.md`
- Test: `tests/production-delivery.test.mjs`

**Interfaces:**
- Consumes: Railway dashboard/account for the one-time binding step and the workflow from Task 4.
- Produces: an operator checklist that makes external work explicit and prevents repository-only CI from being confused with production completion.

- [ ] **Step 1: Add RED runbook contract**

Require explicit sections/strings for:

```text
One-time Railway bootstrap
Disable GitHub autodeploy
Gateway is the only public service
BACKEND_ORIGIN
DATABASE_URL
REDIS_URL
RAILWAY_TOKEN
production GitHub environment
release_sha
Production smoke
Rollback rehearsal
PRODUCTION_DELIVERY_READY
No rehearsal Publication seed
```

Also require the runbook to say the completion marker is manual evidence after real rollback and cannot be emitted by CI-only validation.

- [ ] **Step 2: Document one-time Railway bootstrap**

The operator creates exactly:

- one Railway project + `production` environment;
- gateway service sourced from this repo, config path `/deploy/production/railway.gateway.toml`, root `/`;
- backend service, config path `/backend/railway.toml`, root `/backend`;
- Railway PostgreSQL and Redis services;
- backend reference vars `DATABASE_URL=${{Postgres.DATABASE_URL}}`, `REDIS_URL=${{Redis.REDIS_URL}}`;
- gateway reference var `BACKEND_ORIGIN=http://${{backend.RAILWAY_PRIVATE_DOMAIN}}:3001`;
- gateway public Railway domain;
- GitHub `production` environment secret `RAILWAY_TOKEN` and safe variables/service identifiers;
- GitHub autodeploy disabled on gateway/backend.

- [ ] **Step 3: Document release and rollback rehearsal**

Release:

```text
Actions -> Production release gate -> Run workflow -> release_sha=<main SHA>
```

Rollback rehearsal is a real Railway deployment action: after revisions A then B are deployed and B passes smoke, use Railway Deployments -> previous A -> Rollback, then rerun both smoke scripts against the public gateway. Record A SHA, B SHA, deployment IDs/timestamps and smoke outcomes in release evidence without secrets.

Railway's current CLI does not expose arbitrary historical rollback by deployment ID; do not fake this with `railway redeploy` of the latest deployment. Dashboard/public API rollback is the authoritative rehearsal step.

- [ ] **Step 4: Define completion evidence**

Only after real deployment + real rollback succeeds, record:

```text
PRODUCTION_DELIVERY_READY
release_sha=<...>
rollback_from=<...>
rollback_to=<...>
public_smoke=PASS
browser_smoke=PASS
```

No secret/domain-private values are included.

- [ ] **Step 5: Commit**

Commit message:

```text
docs: add production delivery and rollback runbook
```

---

### Task 6: Full Verification, Review, and Draft PR

**Files:**
- Review all Sprint 6A-only changes relative to `512baaaa730c39b20d22ec5faa1bca727cae6283`.

**Interfaces:**
- Consumes: Tasks 1–5.
- Produces: repository-level `PRODUCTION_REPO_READY` evidence and a draft PR; this is intentionally not `PRODUCTION_DELIVERY_READY`.

- [ ] **Step 1: Run full regression on exact head**

Required evidence:

```text
npm ci
npm run lint
npm run test:production-contract
npm test
npm run build:pages
npm --prefix backend ci
npm run backend:typecheck
npm run backend:test
npm run backend:build
npm --prefix backend audit --omit=dev --audit-level=high
docker build -f deploy/production/Dockerfile.gateway .
docker build -f backend/Dockerfile backend
```

- [ ] **Step 2: Review security and deployment boundaries**

Confirm no new CORS header, mutation route, automatic Publication path, secret literal, `--new`, project creation, or write-capable GitHub permission.

- [ ] **Step 3: Request code review and fix findings**

Use `requesting-code-review`; for any failure use `systematic-debugging`, then rerun exact-head verification.

- [ ] **Step 4: Open/update draft PR**

Title:

```text
Sprint 6A: add exact-SHA Railway production delivery
```

PR body must distinguish:

```text
PRODUCTION_REPO_READY = repository/config/workflow validation complete
PRODUCTION_DELIVERY_READY = NOT YET until real Railway bootstrap + deploy + rollback rehearsal
```

- [ ] **Step 5: Final repository checkpoint**

If all repository gates pass, report `PRODUCTION_REPO_READY` with exact SHA and workflow evidence. Do not claim the website is deployed until the external Railway environment exists and public smoke confirms it.
