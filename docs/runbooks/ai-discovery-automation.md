# Sprint 8D AI Discovery Automation Runbook

## Safety boundary

Sprint 8D automates only the discovery wake-up and guarded provider execution path. It does not materialize Candidates, does not create or complete Human Review, does not mutate Moderation or Eligibility, does not create Evidence, and does not publish. PostgreSQL remains the authority for the UTC-hour tick ledger and Sprint 8C provider budget. Redis/BullMQ only schedules and delivers wake-ups.

The runtime ships disabled by default:

```text
AI_DISCOVERY_SCHEDULER_ENABLED=false
```

No production credential provisioning or production activation is part of Sprint 8D. Enabling provider execution in production requires separate explicit authorization.

## Disabled startup and inspection

The automation runtime always requires PostgreSQL and Redis because disabled mode removes the desired scheduler and drains stale delivered jobs as no-ops. It does not require an OpenAI credential while disabled.

```bash
test -n "$DATABASE_URL"
test -n "$REDIS_URL"
AI_DISCOVERY_SCHEDULER_ENABLED=false npm --prefix backend run start:ai-automation
AI_DISCOVERY_SCHEDULER_ENABLED=false npm --prefix backend run ai-automation:status
```

The status command is read-only. It may inspect BullMQ scheduler inventory plus safe PostgreSQL policy, budget, proposal and tick metadata. It does not read or require `OPENAI_API_KEY` and must not print prompts, structured observation bodies, provider responses or secrets.

## Scheduled execution

When separately authorized and configured, one BullMQ Job Scheduler with ID `ai-discovery-hourly-v1` emits at most one wake-up cadence every 3,600,000 ms. Job data is exactly `{ "schemaVersion": 1 }` and BullMQ attempts are fixed at 1. The provider layer retains its existing bounded internal transient retry behavior.

Every delivered job must still pass all durable gates:

1. scheduler desired state is enabled;
2. PostgreSQL uniquely owns the current UTC-hour tick;
3. deterministic input is built only from the exact active patch/catalog and normalized non-AI observations;
4. identical content with a previous durable budget reservation is skipped;
5. Sprint 8C policy is enabled;
6. UTC daily budget remains available;
7. effective minimum interval is `max(policy interval, 3600 seconds)`.

A successful or failed provider attempt stops at durable AI discovery run/proposals. Candidate materialization remains an explicit private operator action outside this runtime.

## Activation gate

Do not perform the following without separate explicit authorization. The later production activation procedure is:

1. deploy already-reviewed code and migration with scheduler disabled;
2. verify public API/core worker health and public read independence;
3. run read-only automation status with scheduler disabled;
4. verify stale scheduler is absent and stale jobs no-op;
5. provision the approved provider secret/model only to the dedicated automation runtime;
6. activate the approved Sprint 8C AI operations policy;
7. set `AI_DISCOVERY_SCHEDULER_ENABLED=true` and restart the dedicated automation runtime;
8. verify scheduler inventory and the first durable tick/budget outcome.

## Rollback

Primary rollback is operational and history-preserving:

1. set `AI_DISCOVERY_SCHEDULER_ENABLED=false`;
2. restart the dedicated automation runtime so desired-state reconciliation removes `ai-discovery-hourly-v1`;
3. run `ai-automation:status` and confirm the scheduler is absent;
4. confirm any stale delivered job returns before creating a PostgreSQL tick/provider run;
5. Do not delete PostgreSQL history.

Rollback must retain scheduled ticks, AI discovery runs/proposals, budget reservations, audit events, Candidate history, Human Reviews, Moderation/Eligibility decisions and Publication history.

## Failure interpretation

`NO_NEW_INPUT` means no eligible structured input or already budget-consumed identical content. Policy/cadence outcomes mean no provider call was authorized. `PROVIDER_FAILED` means the provider layer returned a durable failed AI discovery run after its bounded internal handling. `AMBIGUOUS_FAILURE` means the scheduled orchestration caught an unexpected failure; no BullMQ provider retry/backfill is requested. A hard process interruption can leave `PROCESSING`, which is visible through the read-only snapshot for operator investigation.
