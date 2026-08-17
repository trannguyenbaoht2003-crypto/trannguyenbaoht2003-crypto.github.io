# Sprint 7B Public Feedback Intake Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a narrow, anonymous, replay-safe and abuse-limited public feedback flow pinned to immutable PublicationVersions without allowing community feedback to mutate trust, monitoring, or Publication authority.

**Architecture:** The existing same-origin Caddy gateway overwrites a dedicated client-IP header before proxying `/api/v1/*` to the private Fastify backend. The backend validates/normalizes feedback, derives a keyed HMAC fingerprint, applies an atomic Redis replay/rate-limit gate, then persists one append-only PostgreSQL receipt through an idempotent authority function. Public Publication GET remains independent; the frontend only exposes feedback for guides carrying live public Publication metadata.

**Tech Stack:** Node.js 22.13+, TypeScript 5.9, Fastify, PostgreSQL 17 in CI, Redis 7 / ioredis, React 19, Next.js 16 static export, Caddy, GitHub Actions.

## Global Constraints

- `FEEDBACK_INTAKE_ENABLED` defaults to `false`.
- `FEEDBACK_FINGERPRINT_SECRET` is required only when feedback is enabled and must provide at least 32 bytes of unpredictable server-only material.
- No CORS expansion.
- The gateway overwrites `X-Hai-Dau-Client-IP`; backend feedback code must not fall back to arbitrary forwarding headers.
- Feedback details are NFC-normalized plain text, maximum 280 characters, never logged, never rendered as HTML, and URL-like/control-character content is rejected.
- Request body limit is 2 KiB.
- PostgreSQL is durable receipt/idempotency authority; Redis is short-lived replay/abuse state only.
- Exact retries with the same `submissionId` do not consume rate-limit quota twice.
- Feedback never directly creates Evidence, HumanReview, Moderation, Eligibility, Publication, rollback, retraction, or Sprint 7A monitoring state.
- No production secret provisioning or production deployment in this sprint.

---

## File Structure

**Create**
- `backend/migrations/0013_publication_feedback_intake.sql` — append-only receipt schema and relational constraints.
- `backend/src/modules/feedback/types.ts` — feedback domain types/constants.
- `backend/src/modules/feedback/normalize-feedback-input.ts` — pure normalization and canonical request hashing input.
- `backend/src/modules/feedback/feedback-fingerprint.ts` — gateway-IP validation and keyed HMAC digest.
- `backend/src/modules/feedback/feedback-rate-limiter.ts` — atomic Redis replay/burst/daily/duplicate-signal gate.
- `backend/src/modules/feedback/submit-publication-feedback.ts` — PostgreSQL relationship/idempotency authority.
- `backend/src/modules/feedback/read-publication-feedback-signals.ts` — internal bounded operator reader.
- `backend/src/http/public-feedback.ts` — POST route and HTTP mapping.
- `app/public-data/feedback-client.ts` — same-origin browser submission adapter.
- `app/PublicFeedbackPanel.tsx` — compact public report interaction.
- `backend/test/feedback-migration.test.ts`
- `backend/test/feedback-normalization.test.ts`
- `backend/test/feedback-submission.test.ts`
- `backend/test/feedback-rate-limiter.test.ts`
- `backend/test/public-feedback-http.test.ts`
- `backend/test/feedback-reader.test.ts`
- `backend/test/feedback-security.test.ts`
- `tests/feedback-client.test.ts`
- `tests/feedback-intake-contract.test.mjs`
- `docs/runbooks/public-feedback-intake.md`
- `.github/workflows/sprint-7b-feedback-intake.yml`

**Modify**
- `backend/test/migration.test.ts` — add feedback table to exact inventory.
- `backend/src/config.ts` and `backend/test/config.test.ts` — disabled-default feature flag and strong-secret validation.
- `backend/src/app.ts` — optional feedback dependency + network-field logger redaction.
- `backend/src/server.ts` — construct feedback dependencies only when enabled.
- `deploy/production/Caddyfile` and `deploy/staging/Caddyfile` — overwrite `X-Hai-Dau-Client-IP`.
- `deploy/production/production.env.example` and `deploy/staging/.env.example` — disabled feature flag only; no real secret.
- `tests/staging-deployment.test.mjs` — assert gateway header overwrite and disabled-by-default staging contract.
- `app/page.tsx` — render feedback action only when guide has `publicPublication` metadata.
- `app/globals.css` — minimal feedback UI styling consistent with existing site.
- `tests/public-data-adapter.test.ts` / `tests/rendered-html.test.mjs` as needed for live metadata and safe rendered copy.
- `package.json` — add `test:feedback-intake` and include it in `npm test`.

---

### Task 1: PostgreSQL feedback receipt authority schema

**Files:**
- Create: `backend/migrations/0013_publication_feedback_intake.sql`
- Create: `backend/test/feedback-migration.test.ts`
- Modify: `backend/test/migration.test.ts`

**Interfaces:**
- Produces table `publication_feedback_submissions` keyed by `client_submission_id` and exact `(publication_version_id, publication_id)` ownership.
- Later tasks rely on immutable columns `request_hash`, `reason_code`, `details`, `was_active_at_submission`, `received_at`.

- [ ] **Step 1: Write failing schema tests**

Create tests that reset/migrate PostgreSQL and assert:

```ts
const columns = await pool.query<{ column_name: string }>(
  `select column_name from information_schema.columns
   where table_schema = 'public'
     and table_name = 'publication_feedback_submissions'
   order by ordinal_position`,
);
assert.deepEqual(columns.rows.map((row) => row.column_name), [
  'id', 'client_submission_id', 'request_hash', 'publication_id',
  'publication_version_id', 'reason_code', 'details',
  'was_active_at_submission', 'received_at', 'created_at',
]);
```

Also seed two Publication fixtures via `backend/test/helpers/publication.ts`, then prove a version from Publication B cannot be paired with Publication A, `OTHER` without detail is rejected, unknown reasons are rejected, and UPDATE/DELETE raise `/immutable/`.

Add `'publication_feedback_submissions'` to the exact `expectedTables` array in `backend/test/migration.test.ts` only after the dedicated RED test exists.

- [ ] **Step 2: Run RED**

Run:

```bash
npm --prefix backend run typecheck
npm --prefix backend test
```

Expected: feedback migration tests fail because the table does not exist.

- [ ] **Step 3: Add migration**

Use the existing `reject_immutable_change()` trigger function:

```sql
create table publication_feedback_submissions (
  id uuid primary key,
  client_submission_id uuid not null unique,
  request_hash text not null check (request_hash ~ '^[a-f0-9]{64}$'),
  publication_id uuid not null references publications(publication_id),
  publication_version_id uuid not null,
  reason_code text not null check (reason_code in (
    'OUTDATED','WRONG_BUILD','WRONG_ITEMS','WRONG_AUGMENTS','MISMATCHED_CHAMPION','OTHER'
  )),
  details text,
  was_active_at_submission boolean not null,
  received_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp(),
  check (details is null or char_length(details) between 1 and 280),
  check (reason_code <> 'OTHER' or details is not null),
  foreign key (publication_version_id, publication_id)
    references publication_versions(publication_version_id, publication_id)
);

create index publication_feedback_submissions_target_idx
  on publication_feedback_submissions(publication_id, publication_version_id, received_at desc);

create trigger publication_feedback_submissions_immutable
before update or delete on publication_feedback_submissions
for each row execute function reject_immutable_change();
```

- [ ] **Step 4: Run GREEN**

Run full backend tests and require PASS.

- [ ] **Step 5: Commit**

Commit message: `feat: add immutable publication feedback receipts`.

---

### Task 2: Pure input normalization and request hash

**Files:**
- Create: `backend/src/modules/feedback/types.ts`
- Create: `backend/src/modules/feedback/normalize-feedback-input.ts`
- Create: `backend/test/feedback-normalization.test.ts`

**Interfaces:**

Produce:

```ts
export const FEEDBACK_REASON_CODES = [
  'OUTDATED','WRONG_BUILD','WRONG_ITEMS','WRONG_AUGMENTS','MISMATCHED_CHAMPION','OTHER',
] as const;
export type FeedbackReasonCode = typeof FEEDBACK_REASON_CODES[number];

export type NormalizedFeedbackInput = {
  schemaVersion: 1;
  submissionId: string;
  publicationVersionId: string;
  reasonCode: FeedbackReasonCode;
  details: string | null;
};

export function normalizeFeedbackInput(input: unknown): NormalizedFeedbackInput;
export function hashFeedbackRequest(
  publicationId: string,
  input: NormalizedFeedbackInput,
): string;
```

- [ ] **Step 1: Write RED truth-table tests**

Cases:
- Vietnamese text such as `"  Sai   trang bị ở vòng cuối  "` becomes `"Sai trang bị ở vòng cuối"`;
- Unicode decomposed input becomes NFC;
- no detail for non-OTHER becomes `null`;
- `OTHER` without detail throws;
- 281 chars throws;
- control characters throw;
- `https://`, mixed-case `HTTP://`, and `www.` throw;
- unknown property/reason/schema/UUID throws;
- canonical hashes are equal for semantically normalized whitespace and differ when reason/version changes.

- [ ] **Step 2: Run RED**

Expected: missing module/export failure.

- [ ] **Step 3: Implement minimal pure functions**

Use `node:crypto` SHA-256 over deterministic JSON:

```ts
const canonical = JSON.stringify({
  schemaVersion: 1,
  publicationId,
  publicationVersionId: input.publicationVersionId,
  reasonCode: input.reasonCode,
  details: input.details,
});
return createHash('sha256').update(canonical, 'utf8').digest('hex');
```

No database/Redis imports.

- [ ] **Step 4: Run GREEN**

Require focused test + full backend suite PASS.

- [ ] **Step 5: Commit**

`feat: normalize public feedback input`.

---

### Task 3: PostgreSQL submission/idempotency authority

**Files:**
- Create: `backend/src/modules/feedback/submit-publication-feedback.ts`
- Create: `backend/test/feedback-submission.test.ts`

**Interfaces:**

```ts
export type SubmitPublicationFeedbackCommand = NormalizedFeedbackInput & {
  publicationId: string;
  requestHash: string;
  receivedAt: Date;
};

export type SubmitPublicationFeedbackResult =
  | { outcome: 'accepted'; replayed: boolean }
  | { outcome: 'not_found' }
  | { outcome: 'conflict' };

export async function submitPublicationFeedback(
  pool: Pool,
  command: SubmitPublicationFeedbackCommand,
): Promise<SubmitPublicationFeedbackResult>;
```

- [ ] **Step 1: Write RED integration tests**

Use `seedEligiblePublicationContext()` / existing Publication helpers. Prove:
- first insert returns accepted/replayed=false and one row;
- exact replay returns accepted/replayed=true with same one row;
- same submission ID/different requestHash returns conflict;
- wrong Publication/version ownership returns not_found;
- after a second version is activated, the first immutable version can still receive feedback;
- `was_active_at_submission` reflects current pointer at transaction time.

- [ ] **Step 2: Run RED**

Expected missing submission module.

- [ ] **Step 3: Implement transaction authority**

Inside one `withTransaction()`:
1. query existing row by `client_submission_id` first;
2. if existing, compare `request_hash`, returning replay/conflict without relationship revalidation;
3. otherwise query PublicationVersion ownership and left-join active pointer;
4. if missing -> not_found;
5. insert one row using a generated server UUID and the observed active boolean;
6. on unique-race, reload row and apply the same hash replay/conflict rule.

Do not import any trust/monitoring/Publication mutation function.

- [ ] **Step 4: Run GREEN**

Require focused + full backend PASS.

- [ ] **Step 5: Commit**

`feat: persist replay-safe publication feedback`.

---

### Task 4: Trusted fingerprint and atomic Redis abuse gate

**Files:**
- Create: `backend/src/modules/feedback/feedback-fingerprint.ts`
- Create: `backend/src/modules/feedback/feedback-rate-limiter.ts`
- Create: `backend/test/feedback-rate-limiter.test.ts`

**Interfaces:**

```ts
export function createFeedbackFingerprint(secret: string, gatewayIp: string): string;

export type FeedbackRateLimitInput = {
  fingerprint: string;
  submissionId: string;
  publicationVersionId: string;
  reasonCode: FeedbackReasonCode;
};

export type FeedbackRateLimitResult =
  | { outcome: 'allowed' }
  | { outcome: 'replay_pass' }
  | { outcome: 'denied'; retryAfterSeconds: number };

export interface FeedbackRateLimiter {
  check(input: FeedbackRateLimitInput): Promise<FeedbackRateLimitResult>;
}

export function createFeedbackRateLimiter(redis: Redis): FeedbackRateLimiter;
```

- [ ] **Step 1: Write RED tests**

Fingerprint tests require equivalent canonical IPv6 forms to hash identically after canonicalization, invalid IP to throw, same secret/IP deterministic, different secret different digest, and output exactly 64 lowercase hex chars.

Redis integration tests concurrently exercise:
- 5 burst allows then deny within 10 minutes;
- 20 daily allows across distinct duplicate-signal keys then deny;
- same fingerprint/version/reason duplicate-signal denied for 30 minutes;
- same fingerprint/submission ID returns `replay_pass` and does not increment counts;
- Redis command failure rejects rather than returning allow.

- [ ] **Step 2: Run RED**

Expected missing modules.

- [ ] **Step 3: Implement**

Use `node:net` for IP family validation and canonicalize via a focused helper (IPv4 normalized decimal octets; IPv6 canonicalization implemented/tested without accepting hostnames). HMAC uses `createHmac('sha256', secret)`.

Use one Lua script executed with `EVAL` so replay marker, burst count, daily count and duplicate-signal check are atomic. Every key receives the exact corresponding expiry and uses prefix `hai-dau:feedback:v1:`.

The script checks replay marker first. Only a new submission can increment counters.

- [ ] **Step 4: Run GREEN**

Require Redis integration + full backend PASS.

- [ ] **Step 5: Commit**

`feat: rate limit anonymous feedback safely`.

---

### Task 5: Config, HTTP route, logging, and backend composition

**Files:**
- Create: `backend/src/http/public-feedback.ts`
- Create: `backend/test/public-feedback-http.test.ts`
- Modify: `backend/src/config.ts`
- Modify: `backend/test/config.test.ts`
- Modify: `backend/src/app.ts`
- Modify: `backend/src/server.ts`

**Interfaces:**

Extend config:

```ts
export interface AppConfig {
  // existing fields...
  feedbackIntakeEnabled: boolean;
  feedbackFingerprintSecret?: string;
}
```

Provide HTTP dependency:

```ts
export interface PublicFeedbackIntake {
  fingerprint(gatewayIp: string): string;
  rateLimit(input: FeedbackRateLimitInput): Promise<FeedbackRateLimitResult>;
  submit(command: SubmitPublicationFeedbackCommand): Promise<SubmitPublicationFeedbackResult>;
}
```

- [ ] **Step 1: RED config tests**

Require:
- unset flag -> disabled;
- `false` -> disabled without secret;
- `true` without secret -> throws;
- `true` with secret shorter than 32 UTF-8 bytes -> throws;
- `true` with >=32 bytes -> enabled.

- [ ] **Step 2: RED route tests**

With injected fake intake prove:
- disabled app has no feedback route (404);
- missing/wrong `X-Hai-Dau-Feedback` -> 400;
- non-JSON -> 400/415 bounded error;
- invalid route/body UUID/schema -> 400 and zero dependency calls;
- body >2 KiB -> 413;
- missing/invalid `X-Hai-Dau-Client-IP` -> fail closed;
- limiter denied -> 429 + bounded Retry-After;
- limiter error -> 503, submit not called;
- submit accepted/replay -> 202;
- submit not_found -> 404;
- submit conflict -> 409;
- submit throws -> 503;
- existing GET `/api/v1/publications` still succeeds when feedback limiter fake throws.

Capture Fastify logs with a test logger/stream and assert raw gateway IP, fingerprint sentinel and detail text never appear.

- [ ] **Step 3: Run RED**

Expected config/route dependency failures.

- [ ] **Step 4: Implement config and logger redaction**

Parse only explicit `true`/`false` for the flag. Validate secret byte length when enabled.

Extend logger redaction paths to include the custom IP header and network identity fields exposed by current Fastify/Pino request serialization.

- [ ] **Step 5: Implement route**

Register with route body limit `2048`; normalize/hash before calling the injected limiter; fingerprint only the dedicated gateway header; use bounded constant error shapes.

- [ ] **Step 6: Wire server only when enabled**

If disabled, pass no feedback dependency. If enabled, create fingerprint helper and Redis limiter around existing Redis connection and submission function around existing Pool.

- [ ] **Step 7: Run GREEN**

Require config, HTTP, health/public-read tests + full backend suite PASS.

- [ ] **Step 8: Commit**

`feat: expose guarded public feedback route`.

---

### Task 6: Gateway trust boundary and staging/production configuration contract

**Files:**
- Modify: `deploy/production/Caddyfile`
- Modify: `deploy/staging/Caddyfile`
- Modify: `deploy/production/production.env.example`
- Modify: `deploy/staging/.env.example`
- Modify: `tests/staging-deployment.test.mjs`

**Interfaces:**
- Gateway guarantees backend receives an overwritten `X-Hai-Dau-Client-IP` for `/api/v1/*`.
- Example environments keep `FEEDBACK_INTAKE_ENABLED=false`; no real secret committed.

- [ ] **Step 1: Write RED source-contract tests**

Assert both Caddyfiles contain an explicit reverse-proxy request-header overwrite equivalent to:

```caddy
header_up X-Hai-Dau-Client-IP {remote_host}
```

and that no `Access-Control-Allow-Origin` wildcard is added.

Assert example env files contain `FEEDBACK_INTAKE_ENABLED=false` and no value that resembles a real fingerprint secret.

- [ ] **Step 2: Run RED**

`npm run test:staging-contract` must fail for missing overwrite.

- [ ] **Step 3: Update Caddy/env examples**

Add the overwrite inside the existing `/api/v1/*` reverse proxy in both environments. Do not expose backend publicly or alter `/health/*` semantics.

- [ ] **Step 4: Run GREEN**

Require staging contract plus `docker compose ... config` PASS in CI.

- [ ] **Step 5: Commit**

`feat: establish trusted feedback client ip boundary`.

---

### Task 7: Internal PostgreSQL feedback signal reader

**Files:**
- Create: `backend/src/modules/feedback/read-publication-feedback-signals.ts`
- Create: `backend/test/feedback-reader.test.ts`

**Interfaces:**

```ts
export type PublicationFeedbackSignal = {
  publicationId: string;
  publicationVersionId: string;
  isActive: boolean;
  totalCount: number;
  countsByReason: Partial<Record<FeedbackReasonCode, number>>;
  newestReceivedAt: string;
  recentDetails: Array<{ reasonCode: FeedbackReasonCode; details: string; receivedAt: string }>;
};

export async function readPublicationFeedbackSignals(
  pool: Pool,
  options?: { sinceHours?: number; limit?: number; detailSampleLimit?: number },
): Promise<PublicationFeedbackSignal[]>;
```

Defaults: `sinceHours=168`, `limit=50`, `detailSampleLimit=3`; cap to safe maxima (`sinceHours<=720`, `limit<=100`, samples<=5).

- [ ] **Step 1: Write RED integration tests**

Seed multiple receipts/reasons/versions and assert:
- grouping by exact PublicationVersion;
- active version sorts before historical version;
- higher recent count then newest receipt ordering;
- reason counts exact;
- at most three default detail samples;
- detail-free receipts do not create samples;
- bounded option caps apply.

- [ ] **Step 2: Run RED**

Expected missing reader.

- [ ] **Step 3: Implement read-only SQL**

Use PostgreSQL CTEs/lateral query to aggregate bounded rows. No public route, no Redis, no mutation.

- [ ] **Step 4: Run GREEN**

Require focused + full backend PASS.

- [ ] **Step 5: Commit**

`feat: read bounded publication feedback signals`.

---

### Task 8: Frontend feedback client and interaction

**Files:**
- Create: `app/public-data/feedback-client.ts`
- Create: `app/PublicFeedbackPanel.tsx`
- Create: `tests/feedback-client.test.ts`
- Modify: `app/page.tsx`
- Modify: `app/globals.css`
- Modify: `tests/rendered-html.test.mjs`

**Interfaces:**

```ts
export type PublicFeedbackReasonCode =
  | 'OUTDATED' | 'WRONG_BUILD' | 'WRONG_ITEMS'
  | 'WRONG_AUGMENTS' | 'MISMATCHED_CHAMPION' | 'OTHER';

export type FeedbackClientResult =
  | { outcome: 'accepted' }
  | { outcome: 'rate_limited'; retryAfterSeconds?: number }
  | { outcome: 'unavailable' }
  | { outcome: 'invalid' };

export async function submitPublicFeedback(input: {
  publicationId: string;
  publicationVersionId: string;
  submissionId: string;
  reasonCode: PublicFeedbackReasonCode;
  details?: string;
  fetchImpl?: typeof fetch;
}): Promise<FeedbackClientResult>;
```

- [ ] **Step 1: RED client tests**

With a fake fetch assert exact POST path/body/header, exact version pinning, stable caller-provided submission ID, response mapping 202/400/409/429/503/network failure, and no credential/auth header added.

- [ ] **Step 2: RED UI/source tests**

Require `Báo lỗi nội dung` only when a guide has `publicPublication`, six localized reason options, maxLength 280, OTHER-required behavior, and no `dangerouslySetInnerHTML` in the feedback component/client.

- [ ] **Step 3: Run RED**

Run `npm run test:public-data` plus new feedback client test; expect missing modules/copy.

- [ ] **Step 4: Implement client**

Use same-origin `/api/v1/...` and `X-Hai-Dau-Feedback: web-v1`; no CORS/auth/credentials special casing.

- [ ] **Step 5: Implement compact panel**

Keep component state local. Generate `crypto.randomUUID()` once when a submission action begins and preserve it while retrying an unavailable response; clear it only after accepted or user changes the semantic report.

Render panel in the existing guide detail/card context only when `guide.publicPublication` exists. Avoid broad page refactoring.

- [ ] **Step 6: Run GREEN**

Require frontend unit/source tests and `npm run build:pages` PASS.

- [ ] **Step 7: Commit**

`feat: add public guide feedback interaction`.

---

### Task 9: Security repository contract, runbook, dedicated CI

**Files:**
- Create: `tests/feedback-intake-contract.test.mjs`
- Create: `docs/runbooks/public-feedback-intake.md`
- Create: `.github/workflows/sprint-7b-feedback-intake.yml`
- Modify: `package.json`

**Interfaces:**
- Root script `test:feedback-intake` becomes the repository contract entry point.
- Dedicated workflow job name: `verify public feedback intake`.

- [ ] **Step 1: Add RED repository contract and wire root test**

Contract reads source files and asserts:
- spec/runbook/migration/modules/route/client/component/workflow exist;
- feedback module tree does not contain imports/calls for `publishCandidateRevision`, `rollbackPublication`, `recordClaimEvidenceDecision`, `completeHumanReview`, `recordCandidateModerationDecision`, `evaluateCandidateEligibility`, or monitoring evaluator mutation entry points;
- outbox dispatcher does not route a `FeedbackSubmitted` event;
- public Publication read/projection modules do not reference `publication_feedback_submissions`;
- Caddy production/staging overwrite the custom client-IP header;
- no wildcard CORS addition;
- no raw IP/fingerprint/details logging patterns in feedback route/modules;
- feature disabled in checked-in env examples;
- dedicated workflow contains no write permissions, deploy command, Railway command, secret echo, or production environment target.

Add:

```json
"test:feedback-intake": "node --experimental-strip-types --test tests/feedback-client.test.ts && node --test tests/feedback-intake-contract.test.mjs"
```

and include it in root `test` before `build:pages`.

- [ ] **Step 2: Run RED**

Expected fail because runbook/workflow do not yet exist.

- [ ] **Step 3: Add runbook**

Document endpoint, reason codes, replay order, trusted gateway header, Redis TTL limits, privacy/logging, disabled-default behavior, PostgreSQL reader, failure modes, production enablement prerequisites, and explicit statement that feedback is not Evidence/trust/monitoring authority.

- [ ] **Step 4: Add dedicated GitHub Actions gate**

Follow Sprint 7A gate style:
- `permissions: contents: read`;
- Node 22.13.0;
- PostgreSQL 17 service;
- Redis 7 service;
- install root/backend deps;
- run `npm run test:feedback-intake`;
- run backend typecheck/test/build;
- run relevant frontend tests/build;
- repository cleanliness/security guard;
- no deployment step.

- [ ] **Step 5: Run GREEN**

Require root `npm test`, backend typecheck/test/build, and dedicated contract locally/CI where available.

- [ ] **Step 6: Commit**

`ci: gate Sprint 7B feedback intake`.

---

### Task 10: Exact-head integration verification and autonomous merge

**Files:**
- No product code unless verification exposes a defect.
- PR metadata only after repository verification.

- [ ] **Step 1: Open/update draft PR against current `main`**

Title: `Sprint 7B: public feedback intake`.

PR body records exact base/head, design boundaries, disabled-by-default production status, and no production deployment authorization.

- [ ] **Step 2: Verify exact-head workflow set**

Require successful conclusions on the feature exact head for:
- `Sprint 7B feedback intake gate` / `verify public feedback intake`;
- inherited frontend/backend regression;
- staging integration;
- release candidate rehearsal;
- deploy workflow dry run.

If any gate fails, use systematic debugging and fix on the feature branch, invalidating prior exact-head evidence until the new head is green.

- [ ] **Step 3: Review diff/security boundary**

Inspect full PR patch and specifically verify:
- no production secret value;
- no CORS expansion;
- no backend-public topology expansion;
- no trust/Publication/monitoring mutation path;
- no raw IP/fingerprint/details persistence/logging;
- Redis replay marker cannot become domain authority;
- public GET path does not depend on feedback intake.

- [ ] **Step 4: Mark PR Ready when repository-ready**

Set marker `SPRINT_7B_REPO_READY` only after fresh exact-head evidence.

- [ ] **Step 5: Autonomous merge under standing delegation**

Immediately before merge:
- refetch `main`;
- confirm PR is mergeable;
- confirm no unresolved review threads/blockers;
- confirm feature head is unchanged;
- if base changed since verified PR CI, require GitHub mergeability and rerun/revalidate gates as necessary rather than assuming old evidence remains valid.

Merge with expected feature head SHA locking. Do not deploy production.

- [ ] **Step 6: Post-merge verification**

Refetch `main`, confirm merge commit parents include previous main + exact feature head, and inspect post-merge workflow state. Final repository status may be reported as:

`SPRINT_7B_MERGED = YES`

while production remains:

`PRODUCTION_DELIVERY_READY = NO`
