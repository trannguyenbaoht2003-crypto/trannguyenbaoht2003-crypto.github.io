# Sprint 8B — AI Provider Execution Runbook

## Purpose and boundary

This runbook covers one bounded, private AI discovery provider execution that records validated proposals through the existing Sprint 8A authority.

The execution path is private operator tooling only:

`stdin JSON -> ai-discovery:run -> OpenAI Responses adapter -> local validation -> recordAiDiscoveryRun()`

Safety boundaries are mandatory:

- **No public route.** Sprint 8B does not add a public Fastify route, operator-browser route, CORS expansion, Caddy route, Railway service, worker trigger, scheduler, or BullMQ provider queue.
- **AI output is not Evidence.** Provider output is advisory candidate-proposal input only.
- **No automatic materialization.** A successful provider run does not call Candidate materialization.
- **No automatic publication.** The provider cannot complete Human Review, Moderation, Eligibility, Publication, rollback, or retraction authority.
- **Raw prompts and raw provider output are not logged.** Raw prompts, observations, provider response bodies, rationales, Authorization headers, API keys, database URLs, and provider error bodies must not be written to stdout/stderr, PostgreSQL, audit records, outbox payloads, Redis, or BullMQ.
- **No production credential provisioning.** This sprint does not provision `OPENAI_API_KEY` or any other provider credential in production.
- **Production deployment is out of scope.** Production delivery remains separately gated by **Issue #23**.

## Prerequisites

Use Node.js 22.13.0 or later and an existing PostgreSQL database that contains the Sprint 8A schema. Sprint 8B adds no database migration and no new runtime dependency.

Build the backend before invoking the compiled CLI:

```bash
npm --prefix backend ci
npm --prefix backend run build
```

The private CLI reads provider configuration from process environment only. Required variables are:

- `DATABASE_URL`
- `AI_DISCOVERY_PROVIDER=openai`
- `OPENAI_API_KEY`
- `AI_DISCOVERY_OPENAI_MODEL`

Optional variables:

- `AI_DISCOVERY_TIMEOUT_MS`, integer `1000..60000`, default `30000`.
- `AI_DISCOVERY_OPENAI_ENDPOINT`, allowed only when `NODE_ENV` is not `production`; production must use the default OpenAI Responses endpoint.

Do not put secrets in the stdin document, shell arguments, checked-in files, test fixtures, logs, audit metadata, or provider proposal text.

## Private invocation

The command accepts one UTF-8 JSON document from stdin and accepts no CLI flags. The stdin hard limit is 256 KiB.

Example with fake identifiers only:

```bash
cat <<'JSON' | npm --prefix backend run ai-discovery:run
{
  "actorId": "operator-example",
  "correlationId": "corr-example-001",
  "idempotencyKey": "idem-example-001",
  "aiDiscoveryRunId": "22222222-2222-4222-8222-222222222222",
  "startedAt": "2026-08-17T10:30:00.000Z",
  "input": {
    "runKey": "run-example-26.17-samira",
    "patchKey": "26.17",
    "gameModeExternalId": "aram_mayhem",
    "subjects": [
      {
        "subjectExternalId": "samira",
        "allowedAugmentExternalIds": ["1194", "2001"],
        "allowedItemExternalIds": ["3006", "6672"],
        "observations": [
          "Governed community signal favors an aggressive crit setup."
        ]
      }
    ]
  }
}
JSON
```

The selection allow-lists must already be sorted and unique. Observations are bounded governed text; URLs, bearer tokens, authorization headers, API-key markers, cookies, private-key markers, control characters, and oversized inputs fail closed before a provider call.

## Success output

The CLI prints only a small sanitized JSON summary:

```json
{"runId":"22222222-2222-4222-8222-222222222222","status":"completed","proposalCount":1,"replay":false}
```

It does not print the prompt, observations, provider request ID, provider response body, proposal rationale, model response text, API key, Authorization header, or database URL.

A completed provider call is validated again locally. Subject, augment, and item identifiers must be present in the normalized input allow-lists. Validated proposals are canonicalized and hashed before the existing Sprint 8A `recordAiDiscoveryRun()` authority records the run/proposal graph.

Provider transport text is not durable authority. Proposal IDs are generated deterministically by server code from the AI discovery run identity and canonical ordinal.

## Failure behavior

Any CLI-level failure is reduced to the single sanitized stderr line:

```text
AI_DISCOVERY_RUN_FAILED
```

The CLI does not echo the underlying exception or provider response body.

Provider execution may durably record one of these bounded failure codes through Sprint 8A:

- `PROVIDER_TIMEOUT`
- `PROVIDER_RATE_LIMITED`
- `PROVIDER_UNAVAILABLE`
- `PROVIDER_AUTH_REJECTED`
- `PROVIDER_REQUEST_REJECTED`
- `PROVIDER_RESPONSE_INVALID`
- `PROVIDER_TRANSPORT_ERROR`

Only transient timeout, rate-limit, unavailable, and typed transport failures are eligible for retry. Retry is capped at three total provider attempts with deterministic delays of 500 ms and 1500 ms. Authentication, request-shape, structured-output, and allow-list failures are not retried.

A failed run records zero proposals. The durable failure output hash is derived only from the bounded failure code, never from a raw provider error message/body.

## Replay and operator discipline

Sprint 8A remains the durable run/proposal authority and enforces its run/idempotency rules. Sprint 8B does not treat any provider request header as publication or persistence authority.

Use a stable `runKey`, `aiDiscoveryRunId`, and `idempotencyKey` only when replaying the same logical command. If the governed input, prompt version, model identity, or intended inference changes, create a new logical run identity rather than forcing an old run to represent new work.

Provider execution itself may be nondeterministic. Server-side canonicalization protects the durable proposal command shape; it does not grant provider output trust or bypass Sprint 8A conflict checks.

## What happens after a completed run

Nothing is automatically materialized or published. A completed run only means validated AI proposals were recorded under Sprint 8A authority.

Any later Candidate materialization must remain an explicit guarded action and must continue through the existing Evidence, Human Review, Moderation, Eligibility, and Publication pipeline. AI provenance alone never satisfies those trust stages.

## Production boundary

Sprint 8B repository readiness does not authorize production execution.

- Do not add `OPENAI_API_KEY` to production deployment configuration as part of this sprint.
- Do not add a recurring scheduler, queue consumer, public endpoint, or browser trigger.
- Do not change Caddy, Railway, staging/production compose topology, or release deployment policy to enable provider execution.
- Keep production delivery under **Issue #23** and the existing release/deploy gates.

If production provider execution is proposed later, it requires a separate design covering credential provisioning, budgets/quotas, operator authorization, observability/redaction, scheduling policy, incident handling, and rollback/disable controls.