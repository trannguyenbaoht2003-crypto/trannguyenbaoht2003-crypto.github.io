# AI Operations Policy Runbook

Sprint 8C adds a private, fail-closed operations layer around Sprint 8B AI provider execution. It does not add a recurring scheduler, public mutation route, browser operator mutation, BullMQ AI provider queue, or production deployment.

## Safety model

The active AI operations policy is disabled by default after migration `0015_ai_operations_policy.sql`.

Default revision 1:

- `enabled=false`
- `maxRunsPerUtcDay=0`
- `minIntervalSeconds=3600`
- `maxProposalsPerRun=16`
- `gameModeExternalId=aram_mayhem`

No private tick may call the provider until an operator explicitly registers and activates an enabled policy revision.

PostgreSQL is the authority for active policy and budget reservations. Budget is counted by PostgreSQL UTC date. Reservations count across policy revisions, so policy rotation does not reset same-day usage or the minimum interval.

A successful reservation consumes one provider-run budget unit even if the provider later fails. Reservations are not refunded automatically. This is intentional cost-safe fail-closed behavior.

## Build the backend

From the repository root:

```bash
npm --prefix backend ci
npm --prefix backend run typecheck
npm --prefix backend test
npm --prefix backend run build
```

Private runtime commands use compiled files under `backend/dist/src`.

## Register an operations policy revision

Set only the database connection in the shell environment for policy management:

```bash
export DATABASE_URL='postgresql://...'
```

Send exactly one stdin JSON command:

```bash
printf '%s\n' '{
  "action":"register",
  "actorId":"operator:example",
  "correlationId":"ops-policy-register-2",
  "idempotencyKey":"ops-policy-register-2",
  "aiOperationsPolicyRevisionId":"22222222-2222-4222-8222-222222222222",
  "revision":2,
  "enabled":true,
  "maxRunsPerUtcDay":4,
  "minIntervalSeconds":3600,
  "maxProposalsPerRun":12,
  "reason":"reviewed bounded AI discovery policy"
}' | npm --prefix backend run ai-operations:policy
```

Policy revisions are append-only. Reusing the same idempotency key with the same payload safely replays. Reusing it with a different payload fails closed.

## Activate a policy revision

Activation is compare-and-set. The operator must provide the exact currently active policy revision ID as `expectedCurrentAiOperationsPolicyRevisionId`.

```bash
printf '%s\n' '{
  "action":"activate",
  "actorId":"operator:example",
  "correlationId":"ops-policy-activate-2",
  "idempotencyKey":"ops-policy-activate-2",
  "aiOperationsPolicyRevisionId":"22222222-2222-4222-8222-222222222222",
  "expectedCurrentAiOperationsPolicyRevisionId":"<CURRENT_POLICY_REVISION_UUID>",
  "reason":"activate reviewed bounded AI discovery policy"
}' | npm --prefix backend run ai-operations:policy
```

A stale expected-current ID fails with no pointer update.

## Run one private policy-governed tick

Provider credentials are required only for the private tick process:

```bash
export DATABASE_URL='postgresql://...'
export AI_DISCOVERY_PROVIDER='openai'
export OPENAI_API_KEY='...'
export AI_DISCOVERY_OPENAI_MODEL='...'
```

Optional:

- `AI_DISCOVERY_TIMEOUT_MS`, `1000..60000`.
- `AI_DISCOVERY_OPENAI_ENDPOINT` only outside `NODE_ENV=production`.

The stdin command shape is the same bounded Sprint 8B execution input:

```bash
printf '%s\n' '{
  "actorId":"operator:example",
  "correlationId":"ops-tick-1",
  "idempotencyKey":"ops-tick-1",
  "aiDiscoveryRunId":"33333333-3333-4333-8333-333333333333",
  "startedAt":"2026-08-18T15:00:00.000Z",
  "input":{
    "runKey":"aram-mayhem-26.17-example-1",
    "patchKey":"26.17",
    "gameModeExternalId":"aram_mayhem",
    "subjects":[
      {
        "subjectExternalId":"samira",
        "allowedAugmentExternalIds":["1194"],
        "allowedItemExternalIds":["3006","3031"],
        "observations":["Bounded community observation for discovery."]
      }
    ]
  }
}' | npm --prefix backend run ai-operations:tick
```

Execution order is fixed:

1. normalize bounded Sprint 8B input;
2. atomically reserve one PostgreSQL budget unit;
3. enforce active policy proposal cap;
4. delegate provider execution and durable run/proposal recording to Sprint 8B/8A authority.

The tick never materializes a Candidate.

Expected sanitized success fields are only run status/count/replay and budget reservation/policy IDs. All failures print only `AI_OPERATIONS_TICK_FAILED`.

## Explicitly materialize one reviewed AI proposal

Materialization is a separate operator action. The tick does not invoke it.

Set `DATABASE_URL` and send exactly one proposal command:

```bash
printf '%s\n' '{
  "actorId":"operator:example",
  "correlationId":"ai-materialize-1",
  "idempotencyKey":"ai-materialize-1",
  "aiCandidateMaterializationId":"44444444-4444-4444-8444-444444444444",
  "aiCandidateProposalId":"55555555-5555-4555-8555-555555555555",
  "reason":"operator explicitly selected this proposal for Candidate review",
  "materializedAt":"2026-08-18T15:30:00.000Z"
}' | npm --prefix backend run ai-discovery:materialize
```

This delegates to the existing Sprint 8A `materializeAiCandidateProposal()` authority. It creates Candidate provenance with origin `ai_generated`. It does not create Evidence, complete Human Review, record Moderation, calculate publication eligibility, or publish.

There is no bulk materialization command in Sprint 8C.

## Disable / rollback AI operations

Do not mutate an existing policy revision. Register a new disabled revision, then activate it with compare-and-set using the currently active revision ID.

A disabled revision may set `maxRunsPerUtcDay=0`. Once active, new budget reservations fail closed before any provider call.

Existing historical reservations, runs, proposals, and audit events remain immutable.

## Budget troubleshooting

Common safe failures:

- `AI_OPERATIONS_DISABLED`: active policy does not allow execution.
- `AI_OPERATIONS_DAILY_BUDGET_EXHAUSTED`: PostgreSQL UTC daily run limit reached.
- `AI_OPERATIONS_MIN_INTERVAL_NOT_ELAPSED`: newest reservation is too recent.
- `AI_OPERATIONS_RUN_ALREADY_RESERVED`: the run ID already has another reservation.
- `IDEMPOTENCY_PAYLOAD_CONFLICT`: an idempotency key was reused for a different command.

Do not delete budget reservation rows to make quota available. Budget rows are append-only audit authority.

## Secret handling

Never put the following into repository files, policy reasons, correlation IDs, audit reasons, CLI stdin metadata, screenshots, issue comments, or logs:

- provider API keys;
- Authorization headers;
- database URLs/passwords;
- raw provider request/response bodies;
- raw provider errors;
- prompt bodies or private observation payloads beyond the bounded tick input provided directly to the private process.

The policy CLI and materialization CLI do not require provider credentials. The tick CLI sanitizes failures and does not emit raw provider/database errors.

## Verification

Repository contract:

```bash
npm run test:ai-operations-policy
```

Full backend verification:

```bash
npm --prefix backend run typecheck
npm --prefix backend test
npm --prefix backend run build
```

Sprint 8C is repository-ready only after the exact PR head passes the dedicated Sprint 8C gate plus the applicable Sprint 8B/8A, 7A/7B/7C, 5C regression/staging, 5D release-candidate, and deploy dry-run gates. Production delivery remains separately gated and is not authorized by Sprint 8C.
