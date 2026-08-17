# Sprint 8B — Guarded AI Provider Execution Design

**Status:** self-approved under standing project delegation after Sprint 8A completion  
**Base:** `main@d1b5e17ed267c02c72573c751df2a18b15240ea3`  
**Scope:** private, bounded provider execution that feeds the verified Sprint 8A run/proposal authority  
**Production delivery:** explicitly out of scope

## 1. Purpose

Sprint 8B connects the verified Sprint 8A AI discovery authority to a real provider-execution boundary without granting AI any new trust or publication authority.

The provider execution flow is:

`operator/private invocation -> governed execution input -> provider adapter -> strict structured proposal output -> server-side validation/hashing -> recordAiDiscoveryRun() -> optional explicit materialization -> existing Evidence/HumanReview/Moderation/Eligibility -> Publication authority`

The provider may propose candidate selections only. It does not create Evidence, complete HumanReview, decide Moderation, change Eligibility, publish, roll back, or write directly to Candidate Registry tables.

## 2. Chosen approach

Use a narrow provider abstraction plus one initial OpenAI Responses HTTP adapter implemented outside `modules/ai-discovery/**`.

Why this approach:

- preserves Sprint 8A provider-independence and authority-isolation tests;
- avoids coupling Sprint 8A authority code to an SDK lifecycle;
- uses Node 22 built-in `fetch`, so no new runtime dependency is required;
- keeps model identity configured at runtime instead of hard-coding a model;
- makes provider responses mockable in tests without real network calls or secrets;
- allows future provider adapters without changing the run/proposal persistence contract.

Rejected alternatives:

1. **Put provider HTTP calls inside `modules/ai-discovery/**`:** rejected because it weakens the verified 8A authority boundary.
2. **Add an automatic recurring AI scheduler in 8B:** rejected because recurring external spend, rate limiting, and source freshness policy require a separate operational design.
3. **Expose a public or operator-browser AI route:** rejected because provider execution must remain private and credential-free from browser/public surfaces.

## 3. Safety invariants

1. Sprint 8A records remain the only AI discovery run/proposal authority.
2. Provider output is untrusted input until strict server-side validation succeeds.
3. Provider output is never Evidence.
4. Provider execution cannot call Candidate materialization automatically.
5. Provider execution cannot import or invoke Evidence, HumanReview, Moderation, Eligibility, Publication, monitoring transition, or feedback mutation commands.
6. No API key is accepted from HTTP requests, browser state, CLI flags, files, database rows, logs, audit payloads, or outbox payloads.
7. Provider API key is read only from process environment by the private CLI composition root.
8. No public Fastify route, CORS change, operator browser route, Caddy route, or Railway deployment wiring is added.
9. Provider response bodies and prompt bodies are not persisted as raw blobs.
10. Retry is bounded and only for transport/server failures that are safe to retry; no unbounded loop exists.
11. A provider timeout or malformed response records a failed Sprint 8A run with a bounded failure code and zero proposals.
12. Exact replay uses the Sprint 8A run/idempotency rules; no duplicate run/proposal graph is created.
13. Production remains separately gated by Issue #23.

## 4. Module boundaries

Create `backend/src/modules/ai-provider/` with four responsibilities.

### 4.1 `types.ts`

Defines provider-neutral interfaces:

```ts
export interface AiProviderExecutionInput {
  runKey: string;
  patchKey: string;
  gameModeExternalId: 'aram_mayhem';
  subjects: Array<{
    subjectExternalId: string;
    allowedAugmentExternalIds: string[];
    allowedItemExternalIds: string[];
    observations: string[];
  }>;
}

export interface AiProviderProposal {
  subjectExternalId: string;
  augmentExternalIds: string[];
  itemExternalIds: string[];
  rationale: string | null;
}

export interface AiProviderResult {
  providerRequestId: string | null;
  outputText: string;
  proposals: AiProviderProposal[];
}

export interface AiDiscoveryProvider {
  readonly providerKey: string;
  execute(input: AiProviderRequest): Promise<AiProviderResult>;
}
```

`observations` are already-governed short text signals supplied by the caller; 8B does not scrape websites or retrieve arbitrary URLs.

### 4.2 `normalize-provider-execution-input.ts`

Normalizes and validates private invocation input before any network call:

- `runKey`: bounded printable identifier;
- `patchKey`: bounded printable identifier;
- mode must be `aram_mayhem`;
- subjects 1..64;
- unique subject IDs;
- each allow-list is canonical sorted, unique, bounded 0..128 entries;
- each observation is plain text 1..1000 chars;
- max 32 observations per subject;
- max normalized JSON input size 128 KiB;
- reject control characters other than normal whitespace;
- no URLs, API keys, bearer tokens, cookies, authorization headers, or private-key markers are accepted in observations.

The canonical normalized input is serialized deterministically and SHA-256 hashed. That hash becomes Sprint 8A `inputHash`.

### 4.3 `openai-responses-provider.ts`

Implements `AiDiscoveryProvider` using Node built-in `fetch` against the OpenAI Responses API.

Configuration is injected at construction:

```ts
{
  apiKey: string;
  model: string;
  endpoint?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}
```

Rules:

- endpoint defaults to `https://api.openai.com/v1/responses`;
- `Authorization: Bearer ...` exists only in the outgoing request header;
- request uses a strict structured-output JSON schema;
- the schema permits only `{ proposals: [...] }`;
- each proposal contains subjectExternalId, augmentExternalIds, itemExternalIds, rationale;
- the provider adapter does not trust schema adherence alone: local validation re-checks every field;
- proposals may only reference subjects and augment/item IDs present in the normalized allow-lists;
- rationale is bounded and advisory only;
- provider output text is returned in memory for output hashing but is never persisted raw;
- request/response logging is forbidden;
- timeout uses `AbortSignal.timeout()` or equivalent bounded abort;
- retry count is zero inside the adapter. Invocation orchestration may perform a small bounded retry policy.

The model is supplied by `AI_DISCOVERY_OPENAI_MODEL`; no model name is hard-coded in source.

### 4.4 `execute-ai-discovery-provider-run.ts`

Orchestrates one private provider execution and records the result through `recordAiDiscoveryRun()`.

Input:

```ts
{
  actorId: string;
  correlationId: string;
  idempotencyKey: string;
  aiDiscoveryRunId: string;
  provider: AiDiscoveryProvider;
  modelKey: string;
  modelRevision: string;
  promptTemplateKey: 'aram-mayhem-discovery';
  promptTemplateVersion: 1;
  input: AiProviderExecutionInput;
  startedAt: string;
}
```

Behavior:

1. normalize input and compute canonical `inputHash`;
2. build a fixed prompt template from canonical input;
3. call provider with a 30s default timeout;
4. validate provider output against input allow-lists;
5. canonicalize validated proposal output and compute SHA-256 `outputHash` from the validated structured output, not from transport metadata;
6. call `recordAiDiscoveryRun()` with status `completed` and validated proposals;
7. if transport/provider/schema/allow-list validation fails, compute a deterministic failure output hash from `{ schemaVersion:1, failureCode }`, then call `recordAiDiscoveryRun()` with status `failed`, zero proposals, and a bounded failure code;
8. never call `materializeAiCandidateProposal()` automatically.

The orchestrator may retry the provider call at most 2 additional attempts for:

- HTTP 408;
- HTTP 429;
- HTTP 500/502/503/504;
- network connection reset/temporary transport failure.

It must not retry:

- HTTP 400/401/403/404;
- structured-output parse/validation failure;
- allow-list violation;
- invalid local command input.

Retry delays are deterministic and bounded: 500 ms then 1500 ms. Tests inject a sleeper to avoid wall-clock delay.

## 5. Prompt contract

Prompt template key: `aram-mayhem-discovery` version 1.

The provider receives only:

- patch key;
- game mode;
- subject IDs;
- allowed augment IDs;
- allowed item IDs;
- bounded governed observations.

Instruction principles:

- select only IDs supplied in the input allow-lists;
- return zero or more proposals;
- do not invent IDs;
- do not claim win-rate, official status, or factual Evidence unless present in the supplied governed observations;
- rationale is short explanatory text only;
- output must conform to the strict JSON schema.

Prompt text is defined in source and versioned by the explicit template version. Changing the prompt requires incrementing the version and updating tests.

## 6. Private CLI composition

Add `backend/src/ai-discovery-run-cli.ts` and package script `ai-discovery:run`.

Invocation reads one UTF-8 JSON document from stdin only. It does not accept arbitrary provider endpoint or API key flags.

Environment:

- `DATABASE_URL` required;
- `AI_DISCOVERY_PROVIDER=openai` required;
- `OPENAI_API_KEY` required;
- `AI_DISCOVERY_OPENAI_MODEL` required;
- optional `AI_DISCOVERY_OPENAI_ENDPOINT` is allowed only when `NODE_ENV != 'production'`; production must use the default OpenAI endpoint;
- optional `AI_DISCOVERY_TIMEOUT_MS` bounded 1000..60000.

The CLI:

- parses stdin with a 256 KiB hard limit;
- validates no secret-bearing fields are present;
- creates PostgreSQL pool;
- constructs provider;
- invokes `executeAiDiscoveryProviderRun()`;
- prints only a small result summary containing run ID/status/proposal count/replay state;
- never prints prompt, observations, response body, rationale, API key, headers, database URL, or provider error body;
- closes resources on all paths.

No public HTTP route or worker/scheduler is added in 8B.

## 7. Persistence and audit behavior

8B adds no migration.

All durable authority continues through Sprint 8A tables:

- `ai_discovery_runs`;
- `ai_candidate_proposals`;
- existing audit log;
- existing outbox event.

Provider-specific request IDs are intentionally not persisted in 8B because they are transport metadata and are not needed for authority. Future observability may add a separate redacted operational telemetry path.

Raw prompts, raw provider output, API keys, Authorization headers, provider error bodies, and HTTP headers must not be written to:

- PostgreSQL;
- Redis/BullMQ;
- audit log;
- outbox;
- stdout/stderr;
- test snapshots committed to the repository.

## 8. Error model

Local deterministic failures:

- `AI_PROVIDER_INPUT_INVALID`
- `AI_PROVIDER_CONFIG_INVALID`
- `AI_PROVIDER_OUTPUT_INVALID`
- `AI_PROVIDER_ALLOWLIST_VIOLATION`

Recorded provider-run failure codes:

- `PROVIDER_TIMEOUT`
- `PROVIDER_RATE_LIMITED`
- `PROVIDER_UNAVAILABLE`
- `PROVIDER_AUTH_REJECTED`
- `PROVIDER_REQUEST_REJECTED`
- `PROVIDER_RESPONSE_INVALID`
- `PROVIDER_TRANSPORT_ERROR`

Failure codes are bounded identifiers only. Provider error messages/bodies are not persisted.

## 9. Testing strategy

TDD coverage must prove:

1. canonical input normalization/hash is deterministic;
2. subject and allow-list duplicates fail closed;
3. observation/token-like secret patterns fail closed;
4. prompt template is stable and versioned;
5. OpenAI adapter sends POST only to the configured/default endpoint with Authorization header and strict structured-output request;
6. no request body contains API key;
7. local structured-output parser rejects extra fields, malformed arrays, overlong rationale, invented subject/augment/item IDs;
8. successful provider result records exactly one completed Sprint 8A run with canonical proposals;
9. failed provider result records failed run with zero proposals;
10. retry occurs only for the allowed transient conditions and is capped at three total attempts;
11. auth/request/schema failures are not retried;
12. exact replay remains duplicate-noop through Sprint 8A idempotency;
13. provider execution never materializes a Candidate automatically;
14. source scan proves `modules/ai-provider/**` cannot import Evidence/HumanReview/Moderation/Eligibility/Publication mutation commands;
15. source scan proves existing `modules/ai-discovery/**` remains provider/network independent;
16. source scan proves no public Fastify/operator/Caddy/Railway exposure is added;
17. CLI output/error sanitization excludes secrets, prompts, observations, response bodies, rationales and database URLs;
18. root/backend typecheck/full tests/build and inherited Sprint 7A/7B/7C/8A, regression, staging, release candidate and deploy dry-run gates remain green.

No test makes a real OpenAI network call.

## 10. Repository contract and CI

Add:

- `tests/ai-provider-execution-contract.test.mjs`;
- root script `test:ai-provider-execution` inherited by root `test`;
- `.github/workflows/sprint-8b-ai-provider-execution.yml`.

CI uses Node 22.13.0, PostgreSQL 17 and Redis 7, then runs:

- root/backend `npm ci`;
- `npm run test:ai-provider-execution`;
- frontend lint;
- backend typecheck;
- backend full tests;
- backend build;
- repository cleanliness;
- deployment/secret guard.

The workflow must use `contents: read`, contain no OpenAI secret, and never make a real provider call.

## 11. Files

Create:

- `backend/src/modules/ai-provider/types.ts`
- `backend/src/modules/ai-provider/normalize-provider-execution-input.ts`
- `backend/src/modules/ai-provider/build-provider-request.ts`
- `backend/src/modules/ai-provider/openai-responses-provider.ts`
- `backend/src/modules/ai-provider/execute-ai-discovery-provider-run.ts`
- `backend/src/ai-discovery-run-cli.ts`
- focused backend tests for normalization/provider/orchestration/CLI safety
- `tests/ai-provider-execution-contract.test.mjs`
- `docs/runbooks/ai-provider-execution.md`
- `.github/workflows/sprint-8b-ai-provider-execution.yml`

Modify:

- `backend/package.json` for the private CLI script only;
- root `package.json` for the Sprint 8B repository contract;
- only narrowly required shared test helpers.

No migration, frontend route, Fastify public route, operator browser route, Caddy config, Railway service config, scheduler, BullMQ queue, or production release wiring is changed.

## 12. Completion boundary

A merged Sprint 8B means the repository can execute one bounded private OpenAI-backed discovery run and persist only validated proposals through Sprint 8A authority.

It does **not** mean:

- provider credentials exist in production;
- recurring AI execution is enabled;
- AI has web browsing or source collection authority;
- AI output is Evidence;
- AI proposals are automatically materialized;
- AI can approve, moderate, make eligible, publish, roll back or retract;
- a public AI endpoint exists;
- production has been deployed.

A later Sprint 8C may add policy-governed scheduling/budget controls and explicit operator-triggered materialization integration after 8B exact-head verification.