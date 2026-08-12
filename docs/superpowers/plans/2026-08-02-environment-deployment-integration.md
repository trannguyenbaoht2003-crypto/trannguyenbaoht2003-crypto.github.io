# Sprint 5C Environment & Deployment Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a provider-neutral, staging-only Docker Compose environment where one gateway origin serves the static frontend and proxies the read-only Publication API, while production deployment remains disabled.

**Architecture:** Extend the Sprint 5B browser adapter with a closed `same-origin` sentinel, build immutable frontend and backend images, and compose them with PostgreSQL 17, Redis 7, a one-shot migration service, and a Caddy gateway. CI builds and starts the stack locally, verifies normal and backend-outage behavior, then tears it down without pushing images or deploying infrastructure.

**Tech Stack:** Next.js 16 static export, React 19, Node.js 22.13, TypeScript 5.9, Fastify 5, PostgreSQL 17, Redis 7, Docker Compose, Caddy 2, GitHub Actions.

## Global Constraints

- Base exact Sprint 5B head: `fadc3b2ff41b8aaba45cc27bd9625dec7399b40f`.
- Staging only; no production deployment, cloud provisioning, DNS, TLS, CDN, WAF, or registry push.
- Frontend and API use one origin; do not add CORS middleware or permissive origin headers.
- `NEXT_PUBLIC_PUBLIC_API_BASE_URL=same-origin` resolves only to `/api/v1/publications`.
- Existing absolute `http:` and `https:` API base URLs remain supported.
- Browser reads remain GET-only, one-shot, unauthenticated, without retry, polling, timers, mutation, or automatic publication.
- Only the gateway publishes a host port; backend, PostgreSQL, and Redis remain private to the Compose network.
- Default staging profile does not start the background worker.
- Migrations remain forward-only, append-only, and checksum-protected.
- GitHub Actions permissions remain `contents: read`.
- Every CI path must end with unconditional Compose teardown.

---

### Task 1: Same-Origin Publication URL Resolution

**Files:**
- Modify: `tests/public-data-adapter.test.ts`
- Modify: `app/public-data/http-publication-adapter.ts`
- Modify: `docs/runbooks/frontend-public-data.md`

**Interfaces:**
- Consumes: `fetchPublications({ apiBaseUrl, signal?, fetchImpl? })`.
- Produces: exported `buildPublicationListUrl(apiBaseUrl: string): string` supporting `same-origin` and absolute HTTP(S) origins.

- [ ] **Step 1: Write the failing same-origin tests**

Add tests that assert:

```ts
assert.equal(buildPublicationListUrl("same-origin"), "/api/v1/publications");
assert.equal(
  buildPublicationListUrl("https://api.example.test/"),
  "https://api.example.test/api/v1/publications",
);
assert.throws(() => buildPublicationListUrl("/relative"), PublicPublicationRequestError);
assert.throws(() => buildPublicationListUrl("https://user:pass@example.test"), PublicPublicationRequestError);
```

Add a fetch assertion using `apiBaseUrl: "same-origin"` and verify exactly one request to `/api/v1/publications` with method `GET` and no authorization header.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
npm run test:public-data
```

Expected: FAIL because `buildPublicationListUrl` is not exported and `same-origin` is rejected by `new URL()`.

- [ ] **Step 3: Implement the minimal closed resolver**

Use this behavior:

```ts
export function buildPublicationListUrl(apiBaseUrl: string): string {
  const trimmed = apiBaseUrl.trim();
  if (!trimmed) throw new PublicPublicationRequestError("Public API base URL is not configured");
  if (trimmed === "same-origin") return "/api/v1/publications";

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new PublicPublicationRequestError("Public API base URL is invalid");
  }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new PublicPublicationRequestError("Public API base URL is invalid");
  }
  return `${trimmed.replace(/\/+$/, "")}/api/v1/publications`;
}
```

Do not add retries, timers, credentials, CORS options, or mutation methods.

- [ ] **Step 4: Document the sentinel and rerun GREEN**

Update the runbook with:

```text
NEXT_PUBLIC_PUBLIC_API_BASE_URL=same-origin
```

Explain that the browser requests the relative `/api/v1/publications` path through the staging gateway. Run:

```bash
npm run test:public-data
npm run lint
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/public-data-adapter.test.ts app/public-data/http-publication-adapter.ts docs/runbooks/frontend-public-data.md
git commit -m "feat: support same-origin public API reads"
```

---

### Task 2: One-Shot Migration Runtime and Backend Image

**Files:**
- Create: `backend/src/migrate-cli.ts`
- Create: `backend/Dockerfile`
- Create: `backend/.dockerignore`
- Modify: `backend/package.json`
- Create: `backend/test/staging-runtime.test.ts`

**Interfaces:**
- Consumes: `parseConfig(process.env)` and `migrate(pool)`.
- Produces: `npm run migrate` and a backend image whose runtime commands are `node dist/src/migrate-cli.js` and `node dist/src/server.js`.

- [ ] **Step 1: Write failing runtime contract tests**

Create `backend/test/staging-runtime.test.ts` that reads the package, migration CLI, and Dockerfile and asserts:

```ts
assert.equal(packageJson.scripts.migrate, "node dist/src/migrate-cli.js");
assert.match(migrateCli, /new Pool\(\{ connectionString: config\.databaseUrl \}\)/);
assert.match(migrateCli, /await migrate\(pool\)/);
assert.match(migrateCli, /await pool\.end\(\)/);
assert.match(dockerfile, /FROM node:22\.13\.0-bookworm-slim AS build/);
assert.match(dockerfile, /RUN npm ci/);
assert.match(dockerfile, /RUN npm run build/);
assert.match(dockerfile, /CMD \["node", "dist\/src\/server\.js"\]/);
assert.doesNotMatch(dockerfile, /DATABASE_URL|REDIS_URL|PASSWORD|TOKEN/);
```

- [ ] **Step 2: Run the focused backend test and verify RED**

Run:

```bash
npm --prefix backend test -- --test-name-pattern="staging runtime"
```

Expected: FAIL because the migration CLI, Dockerfile, and `migrate` script do not exist.

- [ ] **Step 3: Implement the migration CLI**

Create `backend/src/migrate-cli.ts`:

```ts
import { Pool } from "pg";
import { parseConfig } from "./config.js";
import { migrate } from "./database/migrate.js";

async function main(): Promise<void> {
  const config = parseConfig(process.env);
  const pool = new Pool({ connectionString: config.databaseUrl });
  try {
    await migrate(pool);
  } finally {
    await pool.end();
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "unknown migration error";
  process.stderr.write(`Migration failed: ${message}\n`);
  process.exitCode = 1;
});
```

Add to `backend/package.json`:

```json
"migrate": "node dist/src/migrate-cli.js"
```

- [ ] **Step 4: Add the multi-stage backend image**

The build stage installs locked dependencies and compiles TypeScript. The runtime stage copies `dist`, `migrations`, `package.json`, and production `node_modules`; it runs as the existing unprivileged `node` user and defaults to the API server command. Do not bake environment values into any layer.

- [ ] **Step 5: Run backend verification and commit**

Run:

```bash
npm --prefix backend run typecheck
npm --prefix backend test
npm --prefix backend run build
docker build -f backend/Dockerfile -t hai-dau-backend:5c backend
```

Expected: PASS.

```bash
git add backend/src/migrate-cli.ts backend/Dockerfile backend/.dockerignore backend/package.json backend/test/staging-runtime.test.ts
git commit -m "feat: add staging backend runtime image"
```

---

### Task 3: Static Frontend Gateway Image and Compose Topology

**Files:**
- Create: `deploy/staging/Dockerfile.frontend`
- Create: `deploy/staging/Caddyfile`
- Create: `deploy/staging/compose.yml`
- Create: `deploy/staging/.env.example`
- Create: `tests/staging-deployment.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: frontend `npm run build:pages`, backend image from Task 2.
- Produces: Compose services `gateway`, `backend`, `migrate`, `postgres`, and `redis`; root script `test:staging-contract`.

- [ ] **Step 1: Write failing deployment contract tests**

Create assertions that require:

```js
assert.match(compose, /postgres:\n\s+image: postgres:17/);
assert.match(compose, /redis:\n\s+image: redis:7/);
assert.match(compose, /migrate:/);
assert.match(compose, /condition: service_completed_successfully/);
assert.match(compose, /backend:/);
assert.match(compose, /gateway:/);
assert.match(compose, /ports:\n\s+- "\$\{STAGING_PORT:-8080\}:80"/);
assert.doesNotMatch(compose, /5432:5432|6379:6379|3001:3001/);
assert.doesNotMatch(compose, /worker:/);
assert.match(caddy, /handle \/api\/v1\/\*/);
assert.match(caddy, /reverse_proxy backend:3001/);
assert.match(caddy, /try_files \{path\} \{path\}\/ \/index\.html/);
assert.match(frontendDockerfile, /NEXT_PUBLIC_PUBLIC_API_BASE_URL=same-origin/);
```

Also scan all new deployment files for production hostnames, private keys, cloud credentials, registry pushes, or deploy commands.

- [ ] **Step 2: Run the contract test and verify RED**

Run:

```bash
node --test tests/staging-deployment.test.mjs
```

Expected: FAIL because the staging bundle does not exist.

- [ ] **Step 3: Implement the frontend/gateway image**

Use a Node 22.13 build stage with:

```dockerfile
ARG NEXT_PUBLIC_PUBLIC_API_BASE_URL=same-origin
ENV NEXT_PUBLIC_PUBLIC_API_BASE_URL=$NEXT_PUBLIC_PUBLIC_API_BASE_URL
RUN npm run build:pages
```

Copy only `out/` into `caddy:2-alpine`. The Caddyfile must serve static files, proxy `/api/v1/*` and `/health/*` to `backend:3001`, disable API response caching, and return sanitized gateway errors.

- [ ] **Step 4: Implement Compose service dependencies**

Use private service networking and health checks:

- PostgreSQL 17 with a named volume and `pg_isready`.
- Redis 7 with `redis-cli ping`.
- `migrate` waits for PostgreSQL healthy and runs `node dist/src/migrate-cli.js`.
- `backend` waits for migration completion and Redis healthy.
- `gateway` waits for backend healthy and is the only service with `ports`.
- No worker service in the default file.

`.env.example` must contain placeholders or local-only defaults, never real credentials.

- [ ] **Step 5: Add root scripts, verify, and commit**

Add:

```json
"test:staging-contract": "node --test tests/staging-deployment.test.mjs",
"staging:config": "docker compose --env-file deploy/staging/.env.example -f deploy/staging/compose.yml config",
"staging:up": "docker compose --env-file deploy/staging/.env.example -f deploy/staging/compose.yml up --build -d",
"staging:down": "docker compose --env-file deploy/staging/.env.example -f deploy/staging/compose.yml down -v --remove-orphans"
```

Run:

```bash
npm run test:staging-contract
npm run staging:config
docker build -f deploy/staging/Dockerfile.frontend -t hai-dau-gateway:5c .
```

Expected: PASS.

```bash
git add deploy/staging package.json tests/staging-deployment.test.mjs
git commit -m "feat: add staging same-origin compose topology"
```

---

### Task 4: Runtime Smoke Test and Outage Recovery

**Files:**
- Create: `scripts/staging-smoke.mjs`
- Modify: `package.json`
- Modify: `tests/staging-deployment.test.mjs`

**Interfaces:**
- Consumes: `STAGING_BASE_URL` defaulting to `http://127.0.0.1:8080`.
- Produces: `npm run staging:smoke` with modes `normal`, `backend-down`, and `recovered`.

- [ ] **Step 1: Extend contract tests for smoke behavior**

Require source assertions for:

```js
assert.match(smoke, /STAGING_BASE_URL/);
assert.match(smoke, /\/health\/live/);
assert.match(smoke, /\/health\/ready/);
assert.match(smoke, /\/api\/v1\/publications/);
assert.match(smoke, /method: "POST"/);
assert.match(smoke, /expected 404|expected 405/i);
assert.doesNotMatch(smoke, /authorization|bearer|setInterval|setTimeout/);
```

The POST is a negative probe only and must assert no mutation endpoint exists.

- [ ] **Step 2: Run RED**

Run:

```bash
npm run test:staging-contract
```

Expected: FAIL because `scripts/staging-smoke.mjs` is absent.

- [ ] **Step 3: Implement safe HTTP probes**

The script must:

- fetch `/` and require status 200 plus a known static HTML marker;
- in `normal` or `recovered`, require `/health/live`, `/health/ready`, and `/api/v1/publications` to return the expected closed JSON envelopes;
- send one unauthenticated POST to `/api/v1/publications` and require 404 or 405;
- in `backend-down`, require `/` to remain 200 while the API returns a 5xx gateway failure;
- print only endpoint names and status summaries, never environment-file contents or URLs with credentials.

- [ ] **Step 4: Add script and run against the local stack**

Add:

```json
"staging:smoke": "node scripts/staging-smoke.mjs"
```

Run:

```bash
npm run staging:up
npm run staging:smoke -- normal
docker compose --env-file deploy/staging/.env.example -f deploy/staging/compose.yml stop backend
npm run staging:smoke -- backend-down
docker compose --env-file deploy/staging/.env.example -f deploy/staging/compose.yml start backend
npm run staging:smoke -- recovered
npm run staging:down
```

Expected: all three smoke modes PASS and teardown succeeds.

- [ ] **Step 5: Commit**

```bash
git add scripts/staging-smoke.mjs package.json tests/staging-deployment.test.mjs
git commit -m "test: add staging gateway smoke checks"
```

---

### Task 5: Staging Runbook and CI Integration Gate

**Files:**
- Create: `docs/runbooks/staging-environment.md`
- Create: `.github/workflows/sprint-5c-staging-integration.yml`
- Modify: `.github/workflows/backend-production-foundation.yml`
- Modify: `backend/test/migration.test.ts`
- Modify: `tests/staging-deployment.test.mjs`

**Interfaces:**
- Consumes: all scripts and Docker assets from Tasks 1–4.
- Produces: a pull-request/manual staging gate with exact-head evidence and unconditional teardown.

- [ ] **Step 1: Add failing workflow/runbook contract assertions**

Require the runbook to contain:

```text
same-origin
PostgreSQL 17
Redis 7
migration
backend outage
application rollback
forward-only
No production deployment
```

Require the workflow to contain:

```text
permissions:
  contents: read

docker compose ... config
docker compose ... up --build -d
npm run staging:smoke -- normal
docker compose ... stop backend
npm run staging:smoke -- backend-down
docker compose ... start backend
npm run staging:smoke -- recovered
if: always()
docker compose ... down -v --remove-orphans
```

Reject `packages: write`, `pages: write`, `id-token: write`, registry login/push, cloud credentials, `git push`, Pages deploy, or production deploy commands.

- [ ] **Step 2: Run RED**

Run:

```bash
npm run test:staging-contract
npm run backend:test
```

Expected: FAIL because the workflow and staging runbook do not exist and the legacy migration contract still names Sprint 5B.

- [ ] **Step 3: Write the staging runbook**

Document:

- prerequisites and exact start/config/smoke/stop commands;
- local-only example secrets and how to override them without committing values;
- same-origin request flow;
- backend/database/Redis outage behavior;
- application rollback to a previous verified image/commit;
- forward-only schema migrations with checksum protection;
- no worker and no production deployment in Sprint 5C;
- safe diagnostics that do not print secrets.

- [ ] **Step 4: Create the CI workflow**

The new workflow must:

1. check out and install frontend/backend dependencies;
2. run existing Sprint 5B lint/tests/build/backend gates;
3. run `test:staging-contract` and `docker compose config`;
4. build/start the stack using test-only environment values;
5. execute normal, backend-down, and recovered smoke modes;
6. run repository cleanliness and deployment guards;
7. always tear down containers and volumes.

Update the legacy contract workflow/test only enough to recognize Sprint 5C while retaining all Sprint 4B/5A/5B safety assertions.

- [ ] **Step 5: Run the complete local gate and commit**

Run:

```bash
npm ci
npm --prefix backend ci
npm run validate:community
npm run lint
npm run test:public-data
npm run test:staging-contract
npm test
npm run build:pages
npm run backend:typecheck
npm run backend:test
npm run backend:build
npm run staging:config
npm run staging:up
npm run staging:smoke -- normal
docker compose --env-file deploy/staging/.env.example -f deploy/staging/compose.yml stop backend
npm run staging:smoke -- backend-down
docker compose --env-file deploy/staging/.env.example -f deploy/staging/compose.yml start backend
npm run staging:smoke -- recovered
npm run staging:down
git diff --check
git status --short
```

Expected: every command PASS and repository status empty.

```bash
git add .github/workflows/sprint-5c-staging-integration.yml .github/workflows/backend-production-foundation.yml backend/test/migration.test.ts docs/runbooks/staging-environment.md tests/staging-deployment.test.mjs
git commit -m "ci: add Sprint 5C staging integration gate"
```

---

### Task 6: Draft PR, Exact-Head Verification, and Review

**Files:**
- Modify only when verification identifies a concrete defect.

**Interfaces:**
- Consumes: completed Sprint 5C branch.
- Produces: draft PR stacked on the existing unmerged chain, exact-head CI evidence, and no deployment.

- [ ] **Step 1: Open a draft PR**

Create a draft PR titled:

```text
Sprint 5C: integrate staging environment and deployment topology
```

State that it is stacked on exact Sprint 5B head `fadc3b2ff41b8aaba45cc27bd9625dec7399b40f`, is staging-only, and performs no deployment.

- [ ] **Step 2: Inspect RED/GREEN evidence**

Record the valid RED commit/run where focused tests failed for missing Sprint 5C behavior, then record the GREEN exact-head run IDs.

- [ ] **Step 3: Review the exact Sprint 5C range**

Compare:

```text
fadc3b2ff41b8aaba45cc27bd9625dec7399b40f..<SPRINT_5C_HEAD>
```

Confirm no production hostname, secret, browser credential, CORS expansion, mutation route, auto-publish behavior, worker default, registry push, merge, or deployment command was added.

- [ ] **Step 4: Verify exact head**

Require the Sprint 5C staging workflow and existing deployment dry-run to pass on the same commit. Confirm the PR remains open, draft, mergeable, unmerged, and undeployed.

- [ ] **Step 5: Update the PR body**

Include architecture, security boundaries, test counts, normal/outage/recovery smoke evidence, exact head, run IDs, reviewed range, and explicit statements that no merge or production deployment occurred.
