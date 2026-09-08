# Sprint 9D Human Review CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a private `human-review:complete` CLI that resolves the current CandidateRevision review authority and delegates safely to `completeHumanReview` with stable output, idempotent retry, and no new HTTP/public mutation surface.

**Architecture:** A top-level CLI adapter parses reviewer-facing flags, resolves candidate ownership and the single active candidate-revision review policy, generates internal IDs, and calls the existing trust authority. The authority path rechecks the active policy after locking the CandidateRevision so a policy race fails closed. Repository contracts and a deployment-free GitHub Actions gate prove the CLI remains outside the read-only operator/public surfaces.

**Tech Stack:** Node.js 22.13+, TypeScript 5.9, PostgreSQL 17, `pg`, Node test runner, GitHub Actions, npm/pnpm scripts.

**Spec:** `docs/superpowers/specs/2026-09-05-human-review-cli-design.md`

## Global Constraints

- Use `completeHumanReview` as the only Human Review completion authority; do not create a direct SQL/admin write path.
- Accept only `candidate-revision-id`, `actor-id`, `outcome`, `reason`, `idempotency-key`, and optional `correlation-id`; never accept candidate ID, policy ID, permission, snapshot ID, review ID, or quorum-evaluation ID from the caller.
- Recheck that exactly one active review policy for scope `candidate_revision` matches the resolved policy while the catalog and policy pointers are held through commit; mismatch returns `REVIEW_INPUT_STALE`.
- Preserve immutable Human Review snapshots/reviews/quorum, audit, outbox, and idempotency behavior; do not add a migration or new table.
- Use exit codes 0, 2, 3, 4, and 5 exactly as defined by the approved spec; treat an idempotency payload conflict as invalid input (2); never print SQL, stack traces, credentials, actor/reason/correlation values, or raw PostgreSQL diagnostics.
- Keep the Sprint 7C/9C operator runtime read-only and loopback-only; do not add an HTTP route, frontend import, Caddy/Railway route, or public deployment artifact.
- Follow RED → GREEN → REFACTOR and commit after each independently testable task.

---

## File map

| File | Responsibility |
| --- | --- |
| `backend/src/human-review-cli.ts` | Flag parser, environment validation, resolver seam, command construction, output/error mapping, direct-execution entrypoint. |
| `backend/src/modules/trust/complete-human-review.ts` | Existing Human Review authority; add active-policy match guard after authority lock. |
| `backend/src/modules/trust/resolve-human-review-context.ts` | Read-only resolver for CandidateRevision → candidate ID + one active review policy. |
| `backend/test/human-review-cli.test.ts` | Parser, resolver seam, output, exit-code, and sanitized-error tests. |
| `backend/test/human-review.test.ts` | Regression tests for policy race/currentness and existing Human Review invariants. |
| `backend/package.json` | `human-review:complete` compiled CLI script. |
| `docs/runbooks/human-review-cli.md` | Private operator procedure, examples, retry/error guidance, trust boundary. |
| `tests/human-review-cli-contract.test.mjs` | Repository/public-surface contract and script/runbook assertions. |
| `package.json` | Root contract script and test-chain inclusion. |
| `.github/workflows/sprint-9d-human-review-cli.yml` | PostgreSQL/Redis-backed deployment-free quality gate. |

---

### Task 1: Define CLI input/output contracts and parser

**Files:**
- Create: `backend/src/human-review-cli.ts`
- Create: `backend/test/human-review-cli.test.ts`

**Interfaces:**
- `parseHumanReviewCliArgs(args: readonly string[]): HumanReviewCliInput`.
- `parseHumanReviewCliConfig(env: NodeJS.ProcessEnv): { databaseUrl: string }`.
- `runHumanReviewCli(args, env, dependencies): Promise<HumanReviewCliResult>`.
- `HumanReviewCliInput` has exactly `candidateRevisionId`, `actorId`, `outcome`, `reason`, `idempotencyKey`, and `correlationId: string | undefined`.
- `HumanReviewCliResult` has `exitCode: 0 | 2 | 3 | 4 | 5`, `stdout`, and `stderr`.

- [ ] **Step 1: Write the failing parser tests**

Use stable UUIDs and assert the accepted flags map exactly:

```ts
assert.deepEqual(parseHumanReviewCliArgs([
  '--candidate-revision-id', IDS.revision,
  '--actor-id', 'reviewer-01',
  '--outcome', 'confirmed',
  '--reason', 'Evidence reviewed against the current dossier',
  '--idempotency-key', 'review-2026-09-05-001',
]), {
  candidateRevisionId: IDS.revision,
  actorId: 'reviewer-01',
  outcome: 'confirmed',
  reason: 'Evidence reviewed against the current dossier',
  idempotencyKey: 'review-2026-09-05-001',
  correlationId: undefined,
});
assert.throws(() => parseHumanReviewCliArgs([
  '--candidate-revision-id', IDS.revision,
  '--actor-id', 'reviewer-01',
  '--outcome', 'confirmed',
  '--reason', 'ok',
  '--idempotency-key', 'k',
  '--review-policy-revision-id', IDS.policy,
]), /HUMAN_REVIEW_CLI_INPUT_INVALID/);
```

Cover missing values, duplicate/unknown flags, invalid UUIDs, invalid outcomes, empty/whitespace text, >256-byte metadata, >1,024-byte reason, and missing/blank `DATABASE_URL`.

- [ ] **Step 2: Run the focused test to verify RED**

```bash
cd backend
node --import tsx --test test/human-review-cli.test.ts
```

Expected: FAIL because the parser/result types do not exist.

- [ ] **Step 3: Implement strict parsing and config validation**

Use one left-to-right parser. Require every flag to have exactly one following token, reject duplicate/unknown flags, lower-case canonical UUIDs, allow only the three outcomes, and enforce UTF-8 byte bounds. Throw stable internal errors `HUMAN_REVIEW_CLI_INPUT_INVALID` and `HUMAN_REVIEW_CLI_CONFIG_INVALID` without including offending values.

- [ ] **Step 4: Run the focused parser tests to verify GREEN**

Run the same Node test command. Expected: parser/config cases PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/human-review-cli.ts backend/test/human-review-cli.test.ts
git commit -m "test: define human review cli contract"
```

### Task 2: Add the current review-context resolver

**Files:**
- Create: `backend/src/modules/trust/resolve-human-review-context.ts`
- Modify: `backend/test/human-review-cli.test.ts`

**Interfaces:**
- `resolveHumanReviewContext(pool: Pool, candidateRevisionId: string): Promise<HumanReviewContext>`.
- `HumanReviewContext` is `{ candidateId: string; reviewPolicyRevisionId: string }`.
- Resolver uses one `REPEATABLE READ READ ONLY` transaction and treats any row count other than one as `REVIEW_INPUT_STALE`.

- [ ] **Step 1: Write failing resolver tests**

Use a fake pool/client and assert the two IDs, `BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`, `COMMIT`, client release, rejection of missing/multiple active policy rows, and absence of `insert`, `update`, and `delete` SQL.

- [ ] **Step 2: Run to verify RED**

```bash
cd backend
node --import tsx --test test/human-review-cli.test.ts
```

Expected: FAIL because the resolver module is absent.

- [ ] **Step 3: Implement the parameterized resolver**

Use the existing authority join:

```sql
select revision.candidate_id,
       policy.review_policy_revision_id
  from candidate_revisions revision
  join active_eligibility_policy_revision active
    on active.scope = 'candidate_revision'
  join eligibility_policy_revisions policy
    on policy.eligibility_policy_revision_id = active.eligibility_policy_revision_id
  where revision.candidate_revision_id = $1
```

Validate UUIDs and fields. Roll back on error and always release the client.

- [ ] **Step 4: Run resolver tests to verify GREEN**

Run the focused test file; parser and resolver cases must pass.

- [ ] **Step 5: Commit**

```bash
git add backend/src/modules/trust/resolve-human-review-context.ts backend/test/human-review-cli.test.ts
git commit -m "feat: resolve current human review authority"
```

### Task 3: Harden the authority and wire CLI execution

**Files:**
- Modify: `backend/src/modules/trust/complete-human-review.ts`
- Modify: `backend/src/human-review-cli.ts`
- Modify: `backend/test/human-review.test.ts`
- Modify: `backend/test/human-review-cli.test.ts`
- Modify: `backend/package.json`

**Interfaces:**
- `completeHumanReview(pool, command)` remains the only write authority and retains the exact `CompleteHumanReviewCommand` keys.
- CLI dependencies provide `createPool`, `resolveContext`, and `completeReview`, so output/error tests do not need a live database.

- [ ] **Step 1: Write failing authority-race and execution tests**

Add an integration case where the policy resolved before the write no longer matches the active policy after CandidateRevision locking; expect `REVIEW_INPUT_STALE` and zero new `human_reviews`, audit, outbox, or idempotency rows. Add CLI cases for success, replay, duplicate reviewer, stale input, and generic database failure:

```ts
assert.deepEqual(await runHumanReviewCli(ARGS, ENV, deps), {
  exitCode: 0,
  stdout: `${JSON.stringify({
    candidateRevisionId: IDS.revision,
    humanReviewId: IDS.review,
    outcome: 'confirmed',
    confirmedReviewerCount: 1,
    requiredConfirmedReviews: 1,
    quorumSatisfied: true,
    replayed: false,
  })}\n`,
  stderr: '',
});
```

- [ ] **Step 2: Run to verify RED**

```bash
cd backend
node --import tsx --test test/human-review.test.ts test/human-review-cli.test.ts
```

Expected: the new race/output cases fail.

- [ ] **Step 3: Add the active-policy guard**

After reserving or replaying the CLI receipt, query the active `candidate_revision` policy and require exactly one row whose `review_policy_revision_id` equals `command.reviewPolicyRevisionId`. For a new receipt, perform this check after catalog/policy pointer locks and CandidateRevision authority locking; throw `REVIEW_INPUT_STALE` for zero, multiple, malformed, or mismatched rows. A committed replay returns before currentness checks, so a lost acknowledgement remains replayable after an authority pointer moves.

- [ ] **Step 4: Implement command construction and sanitized execution**

Construct the authority command only after resolving context:

```ts
const context = await resolveContext(pool, input.candidateRevisionId);
const result = await completeReview(pool, {
  actorId: input.actorId,
  candidateId: context.candidateId,
  candidateRevisionId: input.candidateRevisionId,
  completedAt: new Date().toISOString(),
  correlationId: input.correlationId
    ?? deterministicUuid(`human-review-cli:correlation:${input.idempotencyKey}`),
  humanReviewId: deterministicUuid(
    `human-review-cli:review:${input.candidateRevisionId}:${input.idempotencyKey}`,
  ),
  idempotencyKey: input.idempotencyKey,
  outcome: input.outcome,
  permissionUsed: 'reviewer',
  reason: input.reason,
  reviewInputSnapshotId: deterministicUuid(
    `human-review-cli:snapshot:${input.candidateRevisionId}:${input.idempotencyKey}`,
  ),
  reviewPolicyRevisionId: context.reviewPolicyRevisionId,
  reviewQuorumEvaluationId: deterministicUuid(
    `human-review-cli:quorum:${input.candidateRevisionId}:${input.idempotencyKey}`,
  ),
});
```

Map errors by stable prefix to exit codes 2/3/4/5. Map only approved result fields to JSON. Always end the pool in `finally`, suppressing cleanup diagnostics.

- [ ] **Step 5: Add the compiled package script and direct-execution guard**

Add this exact script:

```json
"human-review:complete": "node dist/src/human-review-cli.js"
```

Use the existing `pathToFileURL(process.argv[1])` guard so importing the module in tests never opens a pool or writes stdout.

- [ ] **Step 6: Run typecheck, build, and focused tests**

```bash
npm --prefix backend run typecheck
npm --prefix backend run build
node --import tsx --test backend/test/human-review.test.ts backend/test/human-review-cli.test.ts
```

Expected: all new active-policy, output, replay, duplicate, and sanitized-error cases pass.

- [ ] **Step 7: Commit**

```bash
git add backend/src/human-review-cli.ts backend/src/modules/trust/complete-human-review.ts backend/src/modules/trust/resolve-human-review-context.ts backend/test/human-review.test.ts backend/test/human-review-cli.test.ts backend/package.json
git commit -m "feat: add human review completion cli"
```

### Task 4: Add runbook and repository/public-surface contract

**Files:**
- Create: `docs/runbooks/human-review-cli.md`
- Create: `tests/human-review-cli-contract.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Root script `test:human-review-cli` runs the contract test.
- Contract test reads files only; it never connects to PostgreSQL.

- [ ] **Step 1: Write failing repository contract tests**

Require these final assertions:

```js
assert.equal(scripts['test:human-review-cli'], 'node --test tests/human-review-cli-contract.test.mjs');
assert.equal(backendScripts['human-review:complete'], 'node dist/src/human-review-cli.js');
assert.doesNotMatch(cli, /app\.(?:get|post|put|patch|delete)\s*\(/);
assert.doesNotMatch(cli, /operator-server|fastify|listen\s*\(/i);
assert.match(runbook, /idempotency|exit code|REVIEW_INPUT_STALE|loopback|no public route/i);
```

Also scan `app`, `deploy/production`, and `deploy/staging` to prove no public route/service/bundle references the CLI or `human-review:complete`.

- [ ] **Step 2: Run to verify RED**

```bash
node --test tests/human-review-cli-contract.test.mjs
```

- [ ] **Step 3: Write the runbook**

Document the private trust boundary, obtaining a current revision from the read-only queue/dossier, the exact command, JSON success fields, exit codes 0/2/3/4/5, safe retry with the same idempotency key, duplicate-review handling, stale-policy escalation, and the prohibition on direct SQL, HTTP, or production route exposure. State that Human Review history is append-only and has no rollback command.

- [ ] **Step 4: Add the root script and test-chain entry**

Add:

```json
"test:human-review-cli": "node --test tests/human-review-cli-contract.test.mjs"
```

Include it in the root `test` chain immediately after the Sprint 9C dossier contract.

- [ ] **Step 5: Run to verify GREEN**

```bash
npm run test:human-review-cli
```

- [ ] **Step 6: Commit**

```bash
git add docs/runbooks/human-review-cli.md tests/human-review-cli-contract.test.mjs package.json
git commit -m "docs: add human review cli runbook and contract"
```

### Task 5: Add the Sprint 9D CI verification gate

**Files:**
- Create: `.github/workflows/sprint-9d-human-review-cli.yml`

**Interfaces:**
- Workflow triggers on `workflow_dispatch` and pull requests touching the CLI, trust authority, related tests, runbook, manifests, spec/plan, or workflow.
- Job uses PostgreSQL 17 and Redis 7 for the inherited backend suite, Node 22.13.0, and `permissions: contents: read`.

- [ ] **Step 1: Create the workflow from the Sprint 9C gate**

Copy `.github/workflows/sprint-9c-candidate-review-dossier.yml`, rename its name/group/job to Sprint 9D, and include these path filters:

```yaml
- "backend/src/human-review-cli.ts"
- "backend/src/modules/trust/complete-human-review.ts"
- "backend/src/modules/trust/resolve-human-review-context.ts"
- "backend/test/human-review*.test.ts"
- "tests/human-review-cli-contract.test.mjs"
- "docs/runbooks/human-review-cli.md"
- "docs/superpowers/specs/2026-09-05-human-review-cli-design.md"
- "docs/superpowers/plans/2026-09-05-human-review-cli.md"
```

- [ ] **Step 2: Add explicit verification commands**

The job must run:

```bash
npm run test:human-review-cli
npm run test:operator-surface
npm --prefix backend run typecheck
npm --prefix backend test
npm --prefix backend run build
git diff --check
```

Retain the deployment guard for write permissions, `git push`, Railway/Caddy deploy, Docker push/login, Wrangler deploy, `kubectl`, Terraform, Pulumi, and credential/private-key patterns.

- [ ] **Step 3: Run local workflow/source checks**

```bash
npm run test:human-review-cli
npm run test:operator-surface
git diff --check
```

Expected: PASS and no production/deployment command in the executable workflow portion.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/sprint-9d-human-review-cli.yml
git commit -m "ci: add sprint 9d human review cli gate"
```

### Task 6: Full verification and handoff

**Files:**
- Modify only if verification exposes an implementation defect: files from Tasks 1–5.

- [ ] **Step 1: Run focused tests**

```bash
node --import tsx --test backend/test/human-review-cli.test.ts backend/test/human-review.test.ts
```

- [ ] **Step 2: Run repository contracts and backend quality gates**

```bash
npm run test:human-review-cli
npm run test:operator-surface
npm run test:operator-candidate-review-queue
npm run test:operator-candidate-review-dossier
npm --prefix backend run typecheck
npm --prefix backend test
npm --prefix backend run build
```

- [ ] **Step 3: Verify the worktree**

```bash
git diff --check
git status --short --branch
git log --oneline -8
```

Expected: no uncommitted generated files; only intentional Sprint 9D commits are ahead of the approved base.

- [ ] **Step 4: Record handoff**

Report the branch, commit IDs, exact verification results, and that no production deployment or merge was performed. Request separate approval before opening a PR or merging.

## Self-review checklist

- Spec coverage: Tasks 1–3 cover command contract, resolver, active-policy race guard, generated IDs, idempotency, quorum, and sanitized exit codes; Task 4 covers security/runbook/public-surface boundaries; Task 5 covers the deployment-free CI gate; Task 6 covers verification and release handoff.
- Placeholder scan: no `TBD`, `TODO`, or unspecified error-handling steps; every task names files, interfaces, commands, and expected outcomes.
- Type consistency: `HumanReviewCliInput`, `HumanReviewCliResult`, `HumanReviewContext`, `parseHumanReviewCliArgs`, `resolveHumanReviewContext`, `runHumanReviewCli`, and `completeHumanReview` are named consistently.
- Scope check: the spec is one subsystem (private CLI adapter plus its trust guard, contracts, docs, and CI), so one plan is appropriate.
