# Guarded AI Provider Execution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a private, bounded OpenAI Responses execution path that validates provider output and persists it only through the verified Sprint 8A run/proposal authority.

**Architecture:** Keep `backend/src/modules/ai-discovery/**` provider-independent. Add a sibling `ai-provider` module that normalizes governed input, builds the versioned prompt/request, invokes OpenAI through injected `fetch`, validates allow-listed structured output, and delegates durable recording to `recordAiDiscoveryRun()`. Expose execution only through a stdin-based private CLI; do not add public routes, schedulers, BullMQ jobs, migrations, or production deployment wiring.

**Tech Stack:** Node.js 22.13.0, TypeScript 5.9, PostgreSQL 17, built-in `fetch`, `node:test`, existing Sprint 8A authority.

## Global Constraints

- Base is `main@d1b5e17ed267c02c72573c751df2a18b15240ea3`.
- No new runtime npm dependency.
- No migration.
- No public Fastify route, operator-browser route, CORS change, Caddy route, Railway service/config, scheduler, BullMQ queue, or production release wiring.
- `modules/ai-discovery/**` remains provider/network independent.
- Provider output is never Evidence and never automatically materializes a Candidate.
- Provider secrets exist only in the private CLI process environment.
- No test makes a real OpenAI network call.
- Provider request/response bodies, prompts, observations, API keys, Authorization headers, database URLs and provider error bodies must never be persisted or logged.
- Provider retries are capped at three total attempts and only for 408, 429, 500, 502, 503, 504 or temporary transport failures.

---

### Task 1: Canonical Provider Execution Input

**Files:**
- Create: `backend/src/modules/ai-provider/types.ts`
- Create: `backend/src/modules/ai-provider/normalize-provider-execution-input.ts`
- Create: `backend/test/normalize-provider-execution-input.test.ts`

**Interfaces:**
- Produces: `normalizeAiProviderExecutionInput(input: unknown): NormalizedAiProviderExecutionInput`
- Produces: `hashNormalizedAiProviderExecutionInput(input: NormalizedAiProviderExecutionInput): string`
- Produces provider-neutral input/result/provider interfaces used by Tasks 2-5.

- [ ] **Step 1: Write failing normalization tests**

Cover deterministic canonical ordering, duplicate subject rejection, duplicate/non-canonical allow-list rejection, observation bounds, 128 KiB canonical-size cap, and secret-bearing text rejection.

```ts
assert.equal(
  hashNormalizedAiProviderExecutionInput(normalizeAiProviderExecutionInput(a)),
  hashNormalizedAiProviderExecutionInput(normalizeAiProviderExecutionInput(b)),
);
assert.throws(() => normalizeAiProviderExecutionInput(duplicateSubject), /AI_PROVIDER_INPUT_INVALID/);
assert.throws(() => normalizeAiProviderExecutionInput(secretObservation), /AI_PROVIDER_INPUT_INVALID/);
```

- [ ] **Step 2: Verify RED**

Run: `npm --prefix backend test -- --test-name-pattern="provider execution input"`
Expected: FAIL because `modules/ai-provider/normalize-provider-execution-input.ts` does not exist.

- [ ] **Step 3: Implement types and canonical normalization**

Use `node:crypto` SHA-256 over a deterministic JSON object with canonical subject order and unchanged already-canonical allow-list order. Reject URL/token/private-key markers in observations with conservative case-insensitive scans for `https?://`, `authorization:`, `bearer `, `api[_-]?key`, `cookie:`, and `BEGIN ... PRIVATE KEY`.

- [ ] **Step 4: Verify GREEN**

Run focused backend test, then `npm --prefix backend run typecheck`.
Expected: PASS.

- [ ] **Step 5: Commit**

Commit: `feat: normalize guarded AI provider input`

---

### Task 2: Versioned Prompt and Strict Provider Request Contract

**Files:**
- Create: `backend/src/modules/ai-provider/build-provider-request.ts`
- Create: `backend/test/build-provider-request.test.ts`

**Interfaces:**
- Consumes: `NormalizedAiProviderExecutionInput`
- Produces: `buildAiProviderRequest(input): AiProviderRequest`
- Produces constants `AI_DISCOVERY_PROMPT_TEMPLATE_KEY = 'aram-mayhem-discovery'` and `AI_DISCOVERY_PROMPT_TEMPLATE_VERSION = 1`.

- [ ] **Step 1: Write failing prompt-contract tests**

Assert stable template key/version, deterministic request object, strict JSON schema, no additional properties, no provider secret fields, and no automatic trust/publication instruction.

```ts
const request = buildAiProviderRequest(normalized);
assert.equal(request.promptTemplateVersion, 1);
assert.equal(request.responseSchema.additionalProperties, false);
assert.deepEqual(Object.keys(request.responseSchema.properties), ['proposals']);
```

- [ ] **Step 2: Verify RED**

Run focused test.
Expected: missing module/export failure.

- [ ] **Step 3: Implement prompt/request builder**

Build fixed system/developer instructions plus canonical JSON input. Response schema permits only:

```json
{
  "proposals": [
    {
      "subjectExternalId": "string",
      "augmentExternalIds": ["string"],
      "itemExternalIds": ["string"],
      "rationale": "string|null"
    }
  ]
}
```

Set every object to `additionalProperties:false`; bound proposal array to 64; rationale to 2000 chars.

- [ ] **Step 4: Verify GREEN**

Run focused tests + backend typecheck.

- [ ] **Step 5: Commit**

Commit: `feat: define AI provider prompt contract`

---

### Task 3: OpenAI Responses Adapter

**Files:**
- Create: `backend/src/modules/ai-provider/openai-responses-provider.ts`
- Create: `backend/test/openai-responses-provider.test.ts`

**Interfaces:**
- Consumes: `AiProviderRequest`, injected `fetchImpl`
- Produces: `createOpenAiResponsesProvider(config): AiDiscoveryProvider`

- [ ] **Step 1: Write failing HTTP adapter tests**

Use a fake `fetchImpl` to assert:

```ts
assert.equal(request.method, 'POST');
assert.equal(url, 'https://api.openai.com/v1/responses');
assert.equal(request.headers.Authorization, 'Bearer test-secret');
assert.ok(!request.body.includes('test-secret'));
```

Also test 401, 429, 503, timeout/AbortError, malformed JSON, missing output text, extra output fields, and allow-list violations. Never assert or snapshot real secret-bearing headers in committed output.

- [ ] **Step 2: Verify RED**

Run focused test.
Expected: missing adapter.

- [ ] **Step 3: Implement adapter**

POST body shape:

```ts
{
  model,
  input: request.messages,
  text: {
    format: {
      type: 'json_schema',
      name: 'aram_mayhem_discovery',
      strict: true,
      schema: request.responseSchema,
    },
  },
}
```

Read only the response fields required to obtain structured text. Map HTTP/status/transport failures to typed internal errors with safe codes; discard provider body/message when throwing. Validate parsed output again locally and enforce every subject/augment/item ID against the input allow-lists.

- [ ] **Step 4: Verify GREEN**

Run focused tests + typecheck.

- [ ] **Step 5: Commit**

Commit: `feat: add bounded OpenAI Responses adapter`

---

### Task 4: Provider Execution Orchestrator and Sprint 8A Recording

**Files:**
- Create: `backend/src/modules/ai-provider/execute-ai-discovery-provider-run.ts`
- Create: `backend/test/execute-ai-discovery-provider-run.test.ts`
- Read/Reuse: `backend/src/modules/ai-discovery/record-ai-discovery-run.ts`

**Interfaces:**
- Consumes: `AiDiscoveryProvider`, normalized input, injected clock/sleeper, `recordAiDiscoveryRun`
- Produces: `executeAiDiscoveryProviderRun(pool, command): Promise<AiProviderExecutionRecordResult>`

- [ ] **Step 1: Write failing orchestration tests**

Cover completed run, failed run with zero proposals, retry 429->503->success, no retry on 401/output invalid, exact replay, and no call to materialization.

```ts
assert.equal(provider.calls, 3);
assert.deepEqual(sleeps, [500, 1500]);
assert.equal(result.status, 'completed');
```

- [ ] **Step 2: Verify RED**

Run focused test against PostgreSQL test fixture.
Expected: missing orchestrator.

- [ ] **Step 3: Implement bounded orchestration**

Compute `inputHash` from canonical normalized input. Compute successful `outputHash` from canonical validated `{schemaVersion:1, proposals:[...]}`. For provider failures compute failure hash from `{schemaVersion:1,failureCode}`. Delegate all durability/idempotency to `recordAiDiscoveryRun()`.

- [ ] **Step 4: Verify GREEN**

Run focused test, Sprint 8A run-recording tests, typecheck.

- [ ] **Step 5: Commit**

Commit: `feat: execute provider runs through AI discovery authority`

---

### Task 5: Private Stdin CLI and Secret-Safe Composition

**Files:**
- Create: `backend/src/ai-discovery-run-cli.ts`
- Create: `backend/test/ai-discovery-run-cli.test.ts`
- Modify: `backend/package.json`

**Interfaces:**
- Consumes: process env + stdin JSON
- Produces: `ai-discovery:run` package script and small sanitized stdout summary.

- [ ] **Step 1: Write failing CLI tests**

Test env validation, 256 KiB stdin cap, forbidden secret-bearing input keys/text, production custom-endpoint rejection, sanitized output, and sanitized provider failure.

```ts
assert.doesNotMatch(stdout, /OPENAI_API_KEY|DATABASE_URL|observation text|rationale/i);
assert.doesNotMatch(stderr, /Bearer|https:\/\/.*@|provider raw body/i);
```

- [ ] **Step 2: Verify RED**

Run focused CLI test.
Expected: missing CLI.

- [ ] **Step 3: Implement CLI**

Required env: `DATABASE_URL`, `AI_DISCOVERY_PROVIDER=openai`, `OPENAI_API_KEY`, `AI_DISCOVERY_OPENAI_MODEL`. Parse timeout in `1000..60000`. Permit `AI_DISCOVERY_OPENAI_ENDPOINT` only outside production. Read stdin once with hard byte limit, invoke orchestrator, print only `{runId,status,proposalCount,replay}` JSON.

- [ ] **Step 4: Verify GREEN**

Run focused test + `npm --prefix backend run build`.

- [ ] **Step 5: Commit**

Commit: `feat: add private AI discovery provider CLI`

---

### Task 6: Authority Isolation and Repository Contract

**Files:**
- Create: `tests/ai-provider-execution-contract.test.mjs`
- Modify: `package.json`
- Test existing: `tests/guarded-ai-discovery-contract.test.mjs`

**Interfaces:**
- Produces root script `test:ai-provider-execution`.

- [ ] **Step 1: Write failing repository-contract test**

Source-scan assertions must prove:

- `modules/ai-discovery/**` still contains no provider SDK, `fetch(`, OpenAI endpoint or provider secret env;
- `modules/ai-provider/**` contains no imports/calls into Evidence, HumanReview, Moderation, Eligibility, Publication mutation, monitoring transitions, feedback mutation, Candidate materialization;
- no public route/operator/Caddy/Railway file imports the provider execution module;
- no `OPENAI_API_KEY` appears outside the private CLI/test/runbook/contract allow-list;
- no scheduler/BullMQ provider execution path exists.

- [ ] **Step 2: Verify RED**

Run: `npm run test:ai-provider-execution`
Expected: fail before script/contract is wired.

- [ ] **Step 3: Wire root script and satisfy contract**

Add `"test:ai-provider-execution": "node --test tests/ai-provider-execution-contract.test.mjs"` and include it in root `test` sequence.

- [ ] **Step 4: Verify GREEN**

Run new contract + existing Sprint 8A contract + root tests.

- [ ] **Step 5: Commit**

Commit: `test: gate AI provider execution boundaries`

---

### Task 7: Runbook

**Files:**
- Create: `docs/runbooks/ai-provider-execution.md`

**Interfaces:**
- Documents safe local/private invocation only.

- [ ] **Step 1: Add runbook contract assertions to Task 6 test**

Require runbook to state: no public route, no automatic materialization/publication, no production credential provisioning, no raw prompt/output logging, and Issue #23 deployment gate.

- [ ] **Step 2: Verify RED**

Run repository contract.
Expected: fail because runbook is missing.

- [ ] **Step 3: Write runbook**

Include stdin schema example with fake IDs only, environment variable names without values, sanitized success output example, failure-code behavior, and explicit production/deployment boundary.

- [ ] **Step 4: Verify GREEN**

Run repository contract.

- [ ] **Step 5: Commit**

Commit: `docs: add AI provider execution runbook`

---

### Task 8: Dedicated Sprint 8B CI Gate

**Files:**
- Create: `.github/workflows/sprint-8b-ai-provider-execution.yml`
- Extend: `tests/ai-provider-execution-contract.test.mjs`

**Interfaces:**
- Produces PR gate `Sprint 8B AI provider execution gate`.

- [ ] **Step 1: Extend contract to require workflow safety**

Assert `contents: read`, Node 22.13.0, PostgreSQL 17, Redis 7, new repository contract, frontend lint, backend typecheck/tests/build, cleanliness, and a deployment/secret guard. Assert no `OPENAI_API_KEY` workflow env/secret reference and no network test command.

- [ ] **Step 2: Verify RED**

Run root contract.
Expected: missing workflow failure.

- [ ] **Step 3: Add workflow**

Follow Sprint 8A gate structure, path-filtering only provider/CLI/tests/docs/package files. Do not provide provider credentials.

- [ ] **Step 4: Verify GREEN by repository contract**

Run root contract locally if environment allows; otherwise commit and use GitHub Actions as source of truth.

- [ ] **Step 5: Commit**

Commit: `ci: gate Sprint 8B AI provider execution`

---

### Task 9: Exact-Head Verification, Review, PR and Integration

**Files:**
- No new production files expected.
- Update PR body only after verification.

**Interfaces:**
- Produces `SPRINT_8B_REPO_READY` only after exact-head evidence.

- [ ] **Step 1: Open draft PR**

Base `main`; head `feat/8b-ai-provider-execution`; describe safety boundary and explicitly state production delivery is not authorized.

- [ ] **Step 2: Wait for all triggered exact-head workflows**

Required green: Sprint 8B gate plus inherited Sprint 8A, 7A, 7B, 7C, frontend/backend regression, staging integration, release candidate, and deploy dry-run workflows that trigger for the changed paths.

- [ ] **Step 3: Review exact diff**

Inspect `main...head` for Critical/Important issues: secret leakage, public exposure, retry amplification, malformed-output trust, authority bypass, accidental materialization, provider raw-body logging, production wiring.

- [ ] **Step 4: Fix any Critical/Important finding and rerun exact-head gates**

Do not lower tests or safety policy to make CI pass.

- [ ] **Step 5: Mark repository-ready and merge under standing delegation**

Only after exact-head green and no unresolved blocker: update PR body with `SPRINT_8B_REPO_READY`, mark ready, verify base/head unchanged, merge with expected head SHA. Do not deploy production.
