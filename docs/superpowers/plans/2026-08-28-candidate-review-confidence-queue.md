# Candidate Review Confidence Queue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a deterministic, bounded CandidateRevision review queue in the existing loopback-only operator console, enriched only by persisted Sprint 9A confidence.

**Architecture:** Add an independent read model and GET endpoint beside the unchanged Sprint 7C publication snapshot. One `REPEATABLE READ READ ONLY` PostgreSQL transaction resolves the active review policy, selects the latest sealed unresolved revisions from active catalogs, left-joins the current immutable confidence score, and returns a closed versioned DTO. The existing self-contained operator page renders a separate candidate view without adding any mutation or deployment surface.

**Tech Stack:** Node.js 22.13+, TypeScript, Fastify, PostgreSQL 17, Node test runner, static HTML/CSS/JavaScript assets, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-08-28-candidate-review-confidence-queue-design.md`

## Global Constraints

- Base every change on `main@e141f62f0b69f0e5ad51a999e7dfec6918009024`.
- Keep the operator runtime loopback-only: `127.0.0.1`, `::1`, or `localhost`.
- Add no migration, public route, Caddy route, Railway service, credential, cookie, CORS rule, Redis/BullMQ dependency, worker, or outbox event.
- Read persisted confidence only; never import or invoke `evaluateCandidateConfidence`.
- Never mutate HumanReview, Evidence, Claims, Moderation, Eligibility, Publication, confidence, audit, or outbox state.
- Keep `/api/operator/v1/snapshot` and its schema-version-1 publication response unchanged.
- Candidate queue responses are explicit field-by-field DTOs, `Cache-Control: no-store`, and sanitized on failure.
- Candidate UI strings use DOM `textContent`; no `innerHTML`, storage, telemetry, external assets, polling, or mutation controls.
- Follow RED -> GREEN -> REFACTOR and commit after each independently testable task.

---

### Task 1: Candidate review queue read model

**Files:**
- Modify: `backend/src/modules/operator/types.ts`
- Create: `backend/src/modules/operator/read-candidate-review-queue.ts`
- Create: `backend/test/operator-candidate-review-queue.test.ts`

**Interfaces:**
- Consumes: `Pool`/`PoolClient`, active catalog and eligibility-policy pointers, `candidate_claim_set_seals`, `current_review_quorum_evaluations`, and Sprint 9A current confidence tables.
- Produces: `readOperatorCandidateReviewQueue(pool, { limit, now }): Promise<OperatorCandidateReviewQueue>`.
- Produces types: `OperatorCandidateReviewQueue`, `OperatorCandidateReviewQueueItem`, `OperatorCandidateReviewState`, and `OperatorCandidateConfidenceBand`.

- [ ] **Step 1: Add failing transaction, mapping, validation, and rollback tests**

Create a fake `Pool` whose client records SQL and returns typed rows for the active-policy and queue SELECTs. Cover:

```ts
const queue = await readOperatorCandidateReviewQueue(db.pool, {
  limit: 25,
  now: new Date('2026-08-28T03:00:00.000Z'),
});

assert.equal(queue.schemaVersion, 1);
assert.equal(queue.limit, 25);
assert.equal(queue.activeReviewPolicyRevisionId, REVIEW_POLICY_ID);
assert.deepEqual(db.transactionSql.filter(isBoundarySql), [
  'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
  'COMMIT',
]);
assert.equal(db.released(), 1);
assert.deepEqual(queue.summary, {
  returned: 2,
  unreviewed: 1,
  inProgress: 1,
  unscored: 1,
  low: 0,
  medium: 0,
  high: 1,
  veryHigh: 0,
});
```

Add negative cases for no active policy, non-v1/unknown candidate payload keys, malformed arrays, invalid score components/band, and query failure. Every failure must record `ROLLBACK` and one release.

- [ ] **Step 2: Run the focused test and capture RED**

Run:

```bash
cd backend
node --import tsx --test test/operator-candidate-review-queue.test.ts
```

Expected: FAIL because the module and types do not exist.

- [ ] **Step 3: Add the closed queue DTO types**

Append the exact contracts from the spec to `types.ts`, including:

```ts
export type OperatorCandidateReviewState = 'unreviewed' | 'in_progress';
export type OperatorCandidateConfidenceBand =
  | 'unscored' | 'low' | 'medium' | 'high' | 'very_high';

export type OperatorCandidateReviewQueueOptions = {
  limit?: number;
  now?: Date;
};
```

Represent scored confidence as a discriminated non-null object and unscored confidence as `null`; do not reuse arbitrary database row types as API types.

- [ ] **Step 4: Implement the read-only transaction and active-policy load**

Create `read-candidate-review-queue.ts` with:

```ts
const client = await pool.connect();
try {
  await client.query(
    'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
  );
  // exact active policy SELECT, then bounded queue SELECT
  await client.query('COMMIT');
  return queue;
} catch (error) {
  try { await client.query('ROLLBACK'); } catch {}
  throw error;
} finally {
  client.release();
}
```

Load the active review policy through:

```sql
select policy.review_policy_revision_id,
       review_policy.minimum_confirmed_reviews
  from active_eligibility_policy_revision active
  join eligibility_policy_revisions policy
    on policy.eligibility_policy_revision_id = active.eligibility_policy_revision_id
  join review_policy_revisions review_policy
    on review_policy.review_policy_revision_id = policy.review_policy_revision_id
 where active.scope = 'candidate_revision'
```

Reject zero or multiple rows with `OPERATOR_ACTIVE_REVIEW_POLICY_UNAVAILABLE`.

- [ ] **Step 5: Implement the deterministic bounded queue SELECT**

Use exact joins and window/anti-join rules:

```sql
with latest_active_revisions as (
  select revision.*,
         row_number() over (
           partition by revision.candidate_id
           order by revision.revision desc,
                    revision.candidate_revision_id::text collate "C" desc
         ) as candidate_rank
    from candidate_revisions revision
    join candidates candidate on candidate.candidate_id = revision.candidate_id
    join active_catalog_revisions active_catalog
      on active_catalog.patch_id = revision.patch_id
     and active_catalog.game_mode_external_id = candidate.game_mode_external_id
     and active_catalog.catalog_revision_id = revision.catalog_revision_id
)
select ...
  from latest_active_revisions revision
  join candidate_claim_set_seals seal
    on seal.candidate_revision_id = revision.candidate_revision_id
  join candidates candidate on candidate.candidate_id = revision.candidate_id
  join game_entities subject
    on subject.game_entity_id = candidate.subject_game_entity_id
  left join current_review_quorum_evaluations current_review
    on current_review.candidate_revision_id = revision.candidate_revision_id
   and current_review.review_policy_revision_id = $1
  left join review_quorum_evaluations review
    on review.review_quorum_evaluation_id = current_review.review_quorum_evaluation_id
  left join current_candidate_confidence_scores current_confidence
    on current_confidence.candidate_revision_id = revision.candidate_revision_id
  left join candidate_confidence_scores confidence
    on confidence.candidate_confidence_score_id =
       current_confidence.candidate_confidence_score_id
 where revision.candidate_rank = 1
   and coalesce(review.quorum_satisfied, false) = false
 order by
   case when current_review.review_quorum_evaluation_id is null then 1 else 0 end,
   case confidence.band
     when 'very_high' then 0 when 'high' then 1 when 'medium' then 2
     when 'low' then 3 else 4
   end,
   confidence.score desc nulls last,
   revision.created_at,
   revision.candidate_id::text collate "C",
   revision.candidate_revision_id::text collate "C"
 limit $2
```

Select every outward field explicitly. Use the active policy's minimum count when there is no quorum row and the immutable quorum row counts when present.

- [ ] **Step 6: Validate and map every row field-by-field**

Require the candidate payload to equal:

```ts
{
  schemaVersion: 1,
  augmentExternalIds: string[],
  itemExternalIds: string[],
}
```

Reject unknown keys, duplicate/non-string IDs, impossible review counts, partial confidence rows, component values outside their closed sets, total/component mismatch, or score/band mismatch. Convert dates to ISO strings and copy arrays.

- [ ] **Step 7: Add PostgreSQL graph and authority-isolation coverage**

In the same test file, use `resetDatabase()`, `seedActivatedGateContext()`, `evaluateCandidateConfidence()`, and `completeHumanReview()` to build real authority graphs. Assert that:

```ts
const before = await Promise.all([
  tableCount(pool, 'human_reviews'),
  tableCount(pool, 'candidate_confidence_scores'),
  tableCount(pool, 'audit_events'),
  tableCount(pool, 'outbox_events'),
]);
const queue = await readOperatorCandidateReviewQueue(pool, {
  limit: 50,
  now: new Date('2026-08-28T03:00:00.000Z'),
});
const after = await Promise.all([
  tableCount(pool, 'human_reviews'),
  tableCount(pool, 'candidate_confidence_scores'),
  tableCount(pool, 'audit_events'),
  tableCount(pool, 'outbox_events'),
]);
assert.deepEqual(after, before);
```

Create separate database cases proving active-catalog/latest-revision selection, partial quorum presentation, satisfied-quorum exclusion, historical-policy isolation, exact confidence mapping, unscored mapping, and SQL ranking/limit behavior. Close the pool in `finally` for every case.

- [ ] **Step 8: Run focused GREEN tests and typecheck**

Run:

```bash
cd backend
node --import tsx --test test/operator-candidate-review-queue.test.ts
npm run typecheck
```

Expected: all focused tests PASS and TypeScript exits 0.

- [ ] **Step 9: Commit the reader slice**

```bash
git add backend/src/modules/operator/types.ts \
  backend/src/modules/operator/read-candidate-review-queue.ts \
  backend/test/operator-candidate-review-queue.test.ts
git commit -m "feat: add candidate review confidence queue"
```

### Task 2: Additive GET-only operator HTTP boundary

**Files:**
- Modify: `backend/src/operator/http.ts`
- Modify: `backend/src/operator-server.ts`
- Modify: `backend/test/operator-http.test.ts`

**Interfaces:**
- Consumes: `readOperatorCandidateReviewQueue(pool, { limit, now })`.
- Extends `BuildOperatorAppOptions` with `readCandidateQueue(options)`.
- Produces: `GET /api/operator/v1/candidate-review-queue`.

- [ ] **Step 1: Add failing HTTP contract tests**

Define an empty queue fixture and assert:

```ts
const response = await app.inject({
  method: 'GET',
  url: '/api/operator/v1/candidate-review-queue?limit=25',
});
assert.equal(response.statusCode, 200);
assert.deepEqual(observedQueueOptions, {
  limit: 25,
  now: new Date('2026-08-28T03:00:00.000Z'),
});
expectedSecurityHeaders(response.headers);
```

Cover default `50`; invalid `0`, `101`, `1.5`, `+1`, whitespace, duplicate `limit`, and unknown keys; sanitized 503; and 404 for POST/PUT/PATCH/DELETE. Re-run existing publication snapshot tests unchanged.

- [ ] **Step 2: Run HTTP tests and capture RED**

```bash
cd backend
node --import tsx --test test/operator-http.test.ts
```

Expected: FAIL because `readCandidateQueue` and the route do not exist.

- [ ] **Step 3: Implement strict query parsing and closed errors**

Add route-specific constants:

```ts
const INVALID_CANDIDATE_QUEUE_QUERY = {
  error: {
    code: 'INVALID_OPERATOR_CANDIDATE_QUEUE_QUERY',
    message: 'Invalid operator candidate queue query',
  },
} as const;

const CANDIDATE_QUEUE_UNAVAILABLE = {
  error: {
    code: 'OPERATOR_CANDIDATE_QUEUE_UNAVAILABLE',
    message: 'Operator candidate queue is temporarily unavailable',
  },
} as const;
```

Reuse the exact integer parser but a dedicated key set containing only `limit`.

- [ ] **Step 4: Register the GET route and wire the server**

Capture `now` once, call `readCandidateQueue`, log only `OPERATOR_CANDIDATE_QUEUE_READ_FAILED`, and sanitize every thrown error to the closed 503 body. In `operator-server.ts`, inject:

```ts
readCandidateQueue: (options) =>
  readOperatorCandidateReviewQueue(pool, options),
```

Do not alter the existing publication snapshot dependency or route.

- [ ] **Step 5: Run HTTP, config, and existing operator tests**

```bash
cd backend
node --import tsx --test \
  test/operator-http.test.ts \
  test/operator-config.test.ts \
  test/operator-signal-reader.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit the HTTP slice**

```bash
git add backend/src/operator/http.ts backend/src/operator-server.ts \
  backend/test/operator-http.test.ts
git commit -m "feat: expose read-only operator candidate queue"
```

### Task 3: Candidate queue operator presentation

**Files:**
- Modify: `backend/src/operator/assets.ts`
- Modify: `backend/test/operator-http.test.ts`

**Interfaces:**
- Consumes: `/api/operator/v1/candidate-review-queue` schema version 1.
- Preserves: `/api/operator/v1/snapshot` monitoring/feedback rendering.

- [ ] **Step 1: Add failing asset assertions**

Assert that the static assets include the candidate endpoint, candidate/monitoring view controls, confidence and review filters, and both manual refresh paths. Preserve the existing negative assertions:

```ts
assert.match(OPERATOR_JS, /\/api\/operator\/v1\/candidate-review-queue/);
assert.match(OPERATOR_HTML, /Candidate review/);
assert.match(OPERATOR_HTML, /Monitoring & feedback/);
assert.doesNotMatch(assets, /innerHTML|insertAdjacentHTML|document\.write/i);
assert.doesNotMatch(assets, /localStorage|sessionStorage|indexedDB/i);
assert.doesNotMatch(assets, /setInterval|setTimeout/i);
assert.doesNotMatch(assets, /approve|decline|publish|rollback/i);
```

- [ ] **Step 2: Run the asset test and capture RED**

```bash
cd backend
node --import tsx --test test/operator-http.test.ts
```

Expected: FAIL on missing candidate view/endpoint markers.

- [ ] **Step 3: Refactor assets into two independent view states**

Keep one self-contained HTML/CSS/JS module. Add two accessible buttons with `aria-selected`; only the active view is rendered. Maintain independent state:

```js
let candidateQueue = null;
let publicationSnapshot = null;
let activeView = 'candidates';
```

Candidate load uses exactly:

```js
fetch('/api/operator/v1/candidate-review-queue', {
  method: 'GET',
  cache: 'no-store',
});
```

Monitoring load continues using the existing snapshot URL and query defaults.

- [ ] **Step 4: Render candidate summary, filters, and cards with DOM APIs**

Render all strings through the existing `node()` helper and `textContent`. Add:

- review-state filter: all, unreviewed, in progress;
- band filter: all, very high, high, medium, low, unscored;
- local search across the exact ID fields in the spec;
- component labels for provenance, evidence diversity, patch alignment, and freshness;
- manual refresh scoped to the active view.

No interactive control may call a mutation route.

- [ ] **Step 5: Run focused asset/HTTP tests and lint**

```bash
cd backend
node --import tsx --test test/operator-http.test.ts
cd ..
npm run lint
```

Expected: tests PASS; lint exits 0 with no new warning in modified files.

- [ ] **Step 6: Commit the presentation slice**

```bash
git add backend/src/operator/assets.ts backend/test/operator-http.test.ts
git commit -m "feat: present confidence in operator review queue"
```

### Task 4: Authority, repository, runbook, and CI contracts

**Files:**
- Modify: `backend/test/operator-authority-isolation.test.ts`
- Modify: `tests/operator-surface-contract.test.mjs`
- Create: `tests/operator-candidate-review-queue-contract.test.mjs`
- Modify: `docs/runbooks/operator-surface.md`
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `.github/workflows/sprint-9b-candidate-review-queue.yml`

**Interfaces:**
- Produces root script `test:operator-candidate-review-queue`.
- Preserves root `test:operator-surface` and appends the new contract to `npm test`.

- [ ] **Step 1: Add RED authority and repository contracts**

Expand the forbidden import/call list with:

```ts
'evaluateCandidateConfidence',
'completeHumanReview',
'recordClaimEvidenceDecision',
'recordCandidateModerationDecision',
'evaluateCandidateEligibility',
'publishCandidateRevision',
'rollbackPublication',
```

The new root contract must assert the exact endpoint, reader, runbook, and workflow exist while Caddy, Railway, public `app/`, and production deployment files contain no candidate queue/operator exposure. Assert the reader source contains `REPEATABLE READ READ ONLY` and contains no insert/update/delete SQL statement.

- [ ] **Step 2: Run root contracts and capture RED**

```bash
node --test tests/operator-surface-contract.test.mjs \
  tests/operator-candidate-review-queue-contract.test.mjs
```

Expected: FAIL until the new script, runbook text, and workflow are present.

- [ ] **Step 3: Update the runbook**

Document:

- the candidate queue endpoint and `limit=1..100`;
- active-catalog/latest-revision/sealed-claim/unresolved-active-policy eligibility;
- confidence is persisted/advisory and never evaluated on read;
- missing score is `unscored`;
- exact deterministic ranking;
- sanitized failure and separate failure boundary from publication signals;
- no mutation controls and unchanged loopback/deployment prohibition.

- [ ] **Step 4: Wire the root contract script**

Add:

```json
"test:operator-candidate-review-queue": "node --test tests/operator-candidate-review-queue-contract.test.mjs"
```

Insert it immediately after `test:operator-surface` in the root `test` chain and run `npm install --package-lock-only` to update the lockfile mechanically.

- [ ] **Step 5: Add the dedicated deployment-free workflow**

Create `sprint-9b-candidate-review-queue.yml` with PostgreSQL 17 and Redis 7 test services, Node 22.13.0, read-only `contents` permission, path filters for every Sprint 9B file, and these steps:

```yaml
- run: npm run test:operator-candidate-review-queue
- run: npm run test:operator-surface
- run: npm run lint
- run: npm --prefix backend run typecheck
- run: npm --prefix backend test
- run: npm --prefix backend run build
```

Add repository-cleanliness and deployment-guard steps copied from Sprint 7C with the workflow path changed. Include no write permission, secret, artifact publication, deployment command, or provider credential.

- [ ] **Step 6: Run focused GREEN contracts**

```bash
npm run test:operator-candidate-review-queue
npm run test:operator-surface
cd backend
node --import tsx --test test/operator-authority-isolation.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit the governance slice**

```bash
git add backend/test/operator-authority-isolation.test.ts \
  tests/operator-surface-contract.test.mjs \
  tests/operator-candidate-review-queue-contract.test.mjs \
  docs/runbooks/operator-surface.md package.json package-lock.json \
  .github/workflows/sprint-9b-candidate-review-queue.yml
git commit -m "test: lock Sprint 9B operator authority"
```

### Task 5: Full verification, review, and PR handoff

**Files:**
- Verify all Sprint 9B files and inherited contracts.
- Modify only files required by a demonstrated failure or review finding.

**Interfaces:**
- Produces a reviewable remote branch and PR targeting `main`.

- [ ] **Step 1: Run the focused local gate**

```bash
npm run test:operator-candidate-review-queue
npm run test:operator-surface
npm --prefix backend run typecheck
npm --prefix backend run build
node --import tsx --test \
  backend/test/operator-candidate-review-queue.test.ts \
  backend/test/operator-http.test.ts \
  backend/test/operator-authority-isolation.test.ts \
  backend/test/candidate-confidence-compute.test.ts
git diff --check
```

Expected: all commands exit 0.

- [ ] **Step 2: Run the full local repository gate**

```bash
npm run lint
npm test
```

Expected: exit 0; no new warning in modified Sprint 9B files.

- [ ] **Step 3: Review the complete diff against the exact merge base**

```bash
git status --short
git log --oneline e141f62f0b69f0e5ad51a999e7dfec6918009024..HEAD
git diff --check e141f62f0b69f0e5ad51a999e7dfec6918009024..HEAD
git diff --stat e141f62f0b69f0e5ad51a999e7dfec6918009024..HEAD
```

Confirm no migration, public app change, deployment route, provider path, credential, write route, or authority mutation appears.

- [ ] **Step 4: Request independent code review**

Review for spec compliance, SQL graph correctness, closed DTO validation, deterministic ranking, query bounds, failure sanitization, XSS resistance, and authority isolation. Fix verified Critical/Important findings with new RED tests first.

- [ ] **Step 5: Push and open a draft PR**

Push `sprint-9b-candidate-review-queue` and create a PR against `main` titled:

`Sprint 9B — Candidate Review Confidence Queue`

The PR body must summarize scope, safety boundaries, local verification, and the exact base/head SHAs.

- [ ] **Step 6: Wait for and diagnose every CI workflow**

Require the dedicated Sprint 9B gate, inherited frontend/backend regression gates, and Sprint 5D `rc-ready` to pass on the exact PR head. For any failure, inspect the failing step/log, reproduce where possible, add a RED test, implement the minimal fix, and rerun the full affected gate.

- [ ] **Step 7: Mark ready only after all gates and re-review pass**

Update the PR body with final evidence, mark the PR ready for review, and leave merge as a separate integration decision. Preserve the worktree for review feedback.
