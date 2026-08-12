# Sprint 5A Public Read API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose active immutable Publications through two versioned read-only Fastify endpoints backed only by the existing PostgreSQL Publication read boundary.

**Architecture:** A narrow `PublicPublicationReader` interface separates Fastify from PostgreSQL. The HTTP adapter validates path input, maps domain reads to closed response objects, and emits stable safe errors. Server composition constructs the PostgreSQL adapter; Redis remains only a readiness dependency and is never passed to the Publication routes.

**Tech Stack:** Node.js 22.13, TypeScript 5.9, Fastify 5.10, PostgreSQL 17, Redis 7 for existing readiness tests only, Node test runner, GitHub Actions.

## Global Constraints

- Exact base SHA: `ddbf334d154a283c40ba6e7425b8af10c8084684`.
- Branch: `feat/5a-public-read-api`.
- Endpoints: `GET /api/v1/publications` and `GET /api/v1/publications/:publicationId` only.
- PostgreSQL remains Publication authority.
- Public API reads PostgreSQL only; no Redis, BullMQ, dispatcher, worker, or projection dependency.
- No Publication `POST`, `PUT`, `PATCH`, or `DELETE` route.
- No frontend integration, auth provider, automatic publication, production scheduler, credentials, merge, or deploy.
- Keep PostgreSQL 17, Redis 7, and workflow `permissions: contents: read`.
- Production files may be added only after a focused RED proves the expected missing behavior.

---

### Task 1: Lock the HTTP contract with RED tests

**Files:**
- Create: `backend/test/public-publications-http.test.ts`
- Existing reference: `backend/src/app.ts`
- Existing reference: `backend/src/modules/publication/types.ts`

**Interfaces:**
- Consumes: `buildApp(options)` and `ActivePublicationRead`.
- Produces: executable endpoint, error, method, and dependency expectations for Tasks 2–3.

- [ ] **Step 1: Write the failing HTTP contract test**

Create a stub reader:

```ts
interface StubReader {
  listCalls: number;
  findCalls: string[];
  listActive(): Promise<ActivePublicationRead[]>;
  findActiveById(publicationId: string): Promise<ActivePublicationRead | null>;
}
```

Add tests with `app.inject` proving:

```ts
test('GET /api/v1/publications returns the closed list envelope', ...);
test('GET /api/v1/publications/:publicationId returns the closed single envelope', ...);
test('invalid Publication UUID returns safe 400 before reader invocation', ...);
test('missing active Publication returns safe 404', ...);
test('reader failure returns safe 500 without leaking the source error', ...);
test('Publication mutation HTTP methods are not registered', ...);
```

Expected success envelope:

```ts
{
  schemaVersion: 1,
  publications: [activePublication]
}
```

Expected error envelopes:

```ts
{ error: { code: 'INVALID_PUBLICATION_ID', message: 'Invalid publication id' } }
{ error: { code: 'PUBLICATION_NOT_FOUND', message: 'Publication not found' } }
{ error: { code: 'PUBLICATION_READ_FAILED', message: 'Publication read failed' } }
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
npm --prefix backend test -- --test-name-pattern='Publication HTTP|Publication mutation HTTP'
```

Expected: FAIL because `BuildAppOptions` has no `publications` dependency and the routes do not exist. Type/fixture failures do not count as RED; correct those without adding production behavior.

- [ ] **Step 3: Commit the valid RED**

```bash
git add backend/test/public-publications-http.test.ts
git commit -m "test(5a): require read-only Publication HTTP API"
```

---

### Task 2: Add the narrow reader and HTTP adapter

**Files:**
- Create: `backend/src/modules/publication/public-publication-reader.ts`
- Create: `backend/src/http/public-publications.ts`
- Modify: `backend/src/app.ts`
- Test: `backend/test/public-publications-http.test.ts`

**Interfaces:**
- Produces:

```ts
export interface PublicPublicationReader {
  listActive(): Promise<ActivePublicationRead[]>;
  findActiveById(publicationId: string): Promise<ActivePublicationRead | null>;
}

export function createPublicPublicationReader(pool: Pool): PublicPublicationReader;

export function registerPublicPublicationRoutes(
  app: FastifyInstance,
  reader: PublicPublicationReader,
): void;
```

- `BuildAppOptions` gains `publications: PublicPublicationReader`.

- [ ] **Step 1: Implement the PostgreSQL reader adapter**

```ts
export function createPublicPublicationReader(pool: Pool): PublicPublicationReader {
  return {
    listActive: () => readActivePublications(pool),
    findActiveById: (publicationId) =>
      readActivePublicationById(pool, publicationId),
  };
}
```

Do not import Redis, BullMQ, queue modules, workers, publish, or rollback.

- [ ] **Step 2: Implement canonical UUID validation**

Inside `public-publications.ts`, accept only lowercase/uppercase hexadecimal canonical UUID text with hyphens:

```ts
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
```

Invalid input returns `400` before reader invocation.

- [ ] **Step 3: Implement closed response mapping**

Construct each HTTP record explicitly:

```ts
function toPublicPublicationResponse(read: ActivePublicationRead) {
  return {
    publicationId: read.publicationId,
    candidateId: read.candidateId,
    candidateRevisionId: read.candidateRevisionId,
    publicationVersionId: read.publicationVersionId,
    versionNumber: read.versionNumber,
    publishedAt: read.publishedAt,
    payload: {
      schemaVersion: read.payload.schemaVersion,
      mode: read.payload.mode,
      patchKey: read.payload.patchKey,
      catalogRevisionId: read.payload.catalogRevisionId,
      championExternalId: read.payload.championExternalId,
      augmentExternalIds: [...read.payload.augmentExternalIds],
      itemExternalIds: [...read.payload.itemExternalIds],
    },
  };
}
```

Never spread unknown fields.

- [ ] **Step 4: Register only the two GET routes**

List route:

```ts
app.get('/api/v1/publications', async (_request, reply) => {
  try {
    return {
      schemaVersion: 1,
      publications: (await reader.listActive()).map(toPublicPublicationResponse),
    };
  } catch (error) {
    app.log.error({ err: error }, 'public Publication list failed');
    return reply.code(500).send(readFailedError);
  }
});
```

Single route validates UUID, calls `findActiveById`, returns safe `404`, and catches reader errors as safe `500`.

- [ ] **Step 5: Wire the adapter into `buildApp`**

```ts
export interface BuildAppOptions {
  resources: ResourceHealth;
  publications: PublicPublicationReader;
  logger?: boolean;
}
```

Call:

```ts
registerPublicPublicationRoutes(app, options.publications);
```

Update existing health tests with a no-op reader fixture so their behavior remains unchanged.

- [ ] **Step 6: Run focused tests to GREEN**

```bash
npm --prefix backend test -- --test-name-pattern='Publication HTTP|Publication mutation HTTP|health'
npm --prefix backend run typecheck
```

Expected: all focused tests pass.

- [ ] **Step 7: Commit the HTTP adapter**

```bash
git add backend/src/app.ts backend/src/http/public-publications.ts \
  backend/src/modules/publication/public-publication-reader.ts \
  backend/test/health.test.ts backend/test/public-publications-http.test.ts
git commit -m "feat(5a): expose read-only Publication API"
```

---

### Task 3: Prove PostgreSQL authority and worker independence over HTTP

**Files:**
- Create: `backend/test/public-publications-integration.test.ts`
- Modify: `backend/src/server.ts`
- Existing fixtures: `backend/test/helpers/publication.ts`
- Existing commands: `backend/src/modules/publication/publish-candidate-revision.ts`
- Existing commands: `backend/src/modules/publication/rollback-publication.ts`

**Interfaces:**
- Consumes: `createPublicPublicationReader(pool)`, `buildApp`, existing Publication fixture/command shapes.
- Produces: production composition and service-backed HTTP evidence.

- [ ] **Step 1: Write the failing composition/integration tests**

Add PostgreSQL-backed tests:

```ts
test('HTTP list hides eligible but unpublished Candidates', ...);
test('HTTP list and single return only the active immutable version', ...);
test('HTTP read follows rollback immediately', ...);
test('HTTP list preserves deterministic Publication ordering', ...);
test('HTTP Publication reads work with Redis unavailable and zero projection effects', ...);
test('Publication HTTP adapter has no queue, worker, publish, or rollback dependency', ...);
```

Use `resetDatabase`, `seedEligiblePublicationContext`, `seedSecondEligiblePublicationContext`, `publishCandidateRevision`, and `rollbackPublication` exactly as the existing rollback tests do. Build the app with:

```ts
buildApp({
  logger: false,
  publications: createPublicPublicationReader(pool),
  resources: failingResources,
});
```

The Redis-independence test sets both Redis URL environment variables to `redis://127.0.0.1:1`, asserts zero `publication_projection_effects`, and injects both GET routes successfully.

The source-boundary test reads `src/http/public-publications.ts` and rejects imports or tokens matching:

```ts
/\b(pg|ioredis|bullmq|queue|dispatcher|worker|publishCandidateRevision|rollbackPublication)\b/
```

Exclude human-readable error/log wording from the scan by checking import declarations and direct dependency names, not arbitrary prose.

- [ ] **Step 2: Run the integration tests and verify RED**

```bash
npm --prefix backend test -- --test-name-pattern='HTTP list|HTTP read|Publication HTTP adapter'
```

Expected: FAIL because `server.ts` does not yet provide `publications` to `buildApp`; any fixture mismatch must be corrected before production changes.

- [ ] **Step 3: Compose the reader in `server.ts`**

```ts
const app = buildApp({
  publications: createPublicPublicationReader(pool),
  resources: createResourceHealth(pool, redis),
});
```

Do not pass the Redis client or projection worker to the Publication reader/routes.

- [ ] **Step 4: Run integration and backend tests**

```bash
npm --prefix backend test -- --test-name-pattern='HTTP list|HTTP read|Publication HTTP adapter'
npm --prefix backend test
npm --prefix backend run typecheck
npm --prefix backend run build
```

Expected: all pass with no open handle or new warning.

- [ ] **Step 5: Commit production composition and integration evidence**

```bash
git add backend/src/server.ts backend/test/public-publications-integration.test.ts
git commit -m "test(5a): prove PostgreSQL-only Publication HTTP reads"
```

---

### Task 4: Update the Sprint 5A runbook and workflow contract

**Files:**
- Modify: `backend/README.md`
- Modify: `.github/workflows/backend-production-foundation.yml`
- Modify: `backend/test/migration.test.ts`

**Interfaces:**
- Produces: repository-owned operational and CI contract for Sprint 5A.

- [ ] **Step 1: Add a focused workflow/runbook RED**

Extend the migration contract with these exact phrases:

```text
GET /api/v1/publications
GET /api/v1/publications/:publicationId
Read-only Publication HTTP boundary
Public API reads PostgreSQL only
No Publication mutation route
No frontend integration
No auth provider
No merge
No deploy
```

Also require:

```text
name: Sprint 5A public read API gate
group: sprint-5a-public-read-api-${{ github.ref }}
name: verify public read API
permissions:
  contents: read
```

- [ ] **Step 2: Run and commit the valid RED**

```bash
npm --prefix backend test -- --test-name-pattern='Sprint 5A workflow'
```

Expected: FAIL only because the new runbook/workflow phrases are absent.

```bash
git add backend/test/migration.test.ts
git commit -m "test(5a): require public read API runbook"
```

- [ ] **Step 3: Document operations and exclusions**

Add a runbook section explaining:

- endpoint responses and stable errors;
- PostgreSQL-only authority;
- rollback visibility is immediate;
- Redis/worker/projection outage does not change public reads;
- no mutation method, frontend adapter, auth provider, pagination, cache, scheduler, merge, or deploy.

- [ ] **Step 4: Rename and harden workflow**

Rename workflow/job/concurrency to Sprint 5A. Keep PostgreSQL 17, Redis 7, `contents: read`, clean-checkout verification, deploy-command scan, and credential scan. Add the Sprint 5A phrases to the inline runbook contract.

- [ ] **Step 5: Run contract and backend GREEN**

```bash
npm --prefix backend test -- --test-name-pattern='Sprint 5A workflow'
npm --prefix backend test
npm --prefix backend run typecheck
npm --prefix backend run build
```

- [ ] **Step 6: Commit documentation and workflow**

```bash
git add backend/README.md backend/test/migration.test.ts \
  .github/workflows/backend-production-foundation.yml
git commit -m "docs(5a): operate public read API"
```

---

### Task 5: Exact-range review and final release gate

**Files:**
- Review all changes from `ddbf334d154a283c40ba6e7425b8af10c8084684` to the final head.
- No production edit unless a reproducible focused RED proves a bug.

**Interfaces:** Final quality checkpoint only.

- [ ] **Step 1: Review the exact range**

Verify:

- only two Publication GET routes exist;
- response mapping is closed and stable;
- path UUID validation happens before reader invocation;
- 404 and 500 bodies reveal no internal details;
- route module has no PostgreSQL/Redis/queue/worker/mutation import;
- server passes only the PostgreSQL reader to Publication routes;
- rollback visibility and deterministic order come from the existing domain read;
- no frontend, CORS expansion, auth, pagination, cache, scheduler, credential, merge, or deploy was added.

For every Critical/Important finding, reproduce one focused RED, add the smallest GREEN fix, rerun the full gate, and review the new exact head.

- [ ] **Step 2: Run one exact-head quality gate**

On the same immutable SHA with PostgreSQL 17 and Redis 7:

```bash
npm run validate:community
npm run lint
npm test
npm run build:pages
npm run backend:typecheck
npm run backend:test
npm run backend:build
git diff --check
```

Require a clean repository and successful deployment/credential guard.

- [ ] **Step 3: Run deployment dry-run on the same SHA**

Confirm it builds the artifact without production publishing, write permission, or deployment command.

- [ ] **Step 4: Open a draft stacked PR**

Use:

```text
Title: Sprint 5A: expose read-only Publication API
Base: main
Head: feat/5a-public-read-api
State: draft
```

The body lists exact head, test counts, PostgreSQL/Redis versions, endpoints, safe error contract, worker independence, locked exclusions, and that the branch is stacked on unmerged PR #16.

- [ ] **Step 5: Stop at the boundary**

Leave PR #16 and the Sprint 5A PR open, draft, and unmerged. Do not deploy. Report exact SHA, test counts, Actions/dry-run evidence, and review verdict.

---

## Plan self-review

- **Spec coverage:** Every design requirement maps to Tasks 1–5.
- **Placeholder scan:** No TBD, TODO, vague error handling, or deferred code step remains.
- **Type consistency:** `PublicPublicationReader`, `createPublicPublicationReader`, `registerPublicPublicationRoutes`, response envelopes, and error codes are identical across tasks.
- **Isolation:** Fastify routes depend on the narrow reader only; PostgreSQL remains authority and Redis stays outside the route boundary.
- **Safety:** No mutation route, frontend integration, auth provider, scheduler, production credential, merge, or deploy.
