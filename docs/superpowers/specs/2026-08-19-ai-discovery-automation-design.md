# Sprint 8D — AI Discovery Automation Design

Base: `main@9b1c716fe2d2055f88a736a198848935ee92b397`.

## Goal

Automate the existing guarded AI discovery path on an hourly cadence without granting AI any new content authority. Sprint 8D adds a private BullMQ scheduling/runtime layer and deterministic PostgreSQL-backed scheduled-input/tick authority around Sprint 8C policy-governed provider execution.

The end state is:

```text
Community observations
        ↓
Normalization
        ↓
Hourly AI scheduler
        ↓
Deterministic new-input detection
        ↓
Sprint 8C policy + budget
        ↓
Sprint 8B provider execution
        ↓
Sprint 8A AI run + proposals
        ↓
      STOP
```

No scheduled path may materialize a Candidate, complete Human Review, mutate Moderation or Eligibility, or create/activate a Publication.

## Locked authority boundary

- PostgreSQL remains the durable authority for catalog/patch state, normalized observations, AI scheduling/tick history, policy, budget reservations, AI runs/proposals, Candidate materialization, Human Review, Moderation, Eligibility, and Publication.
- Redis/BullMQ remains delivery and scheduling infrastructure only. Redis is not allowed to decide whether a provider call is permitted, whether input is new, or whether content may progress toward publication.
- Sprint 8C `executePolicyGovernedAiDiscoveryRun()` remains the provider orchestration entry point used by scheduled execution.
- Sprint 8C budget reservation remains mandatory. Sprint 8D may make scheduled reservation stricter, but never weaker.
- Sprint 8B `executeAiDiscoveryProviderRun()` remains the provider execution/retry/durable-run orchestration beneath Sprint 8C.
- Sprint 8A AI run/proposal persistence remains unchanged.
- Sprint 8A `materializeAiCandidateProposal()` remains explicit/private and is not imported or called by the Sprint 8D scheduler/worker path.
- AI output remains advisory and is never Evidence.
- No public Fastify mutation route, operator-browser mutation, automatic materialization, automatic Human Review, automatic Publication, production credential provisioning, or production deployment is authorized by Sprint 8D.

## 1. Runtime topology

Sprint 8D adds a dedicated AI automation process rather than adding provider credentials and lifecycle to the existing core worker.

```text
Core worker
├─ normalization
├─ eligibility
├─ publication
├─ monitoring
└─ outbox dispatch

AI automation worker
├─ scheduler desired-state reconciliation
├─ AI discovery BullMQ queue consumer
├─ scheduled tick authority
├─ deterministic scheduled-input builder
└─ policy-governed provider execution
```

The AI automation worker has its own Redis connection(s), PostgreSQL pool, provider configuration, worker shutdown path, and sanitized operational logging. A provider configuration failure must not prevent the core worker or public API from starting.

The queue name and scheduler identity are constants owned by Sprint 8D. The scheduler ID is fixed to `ai-discovery-hourly-v1` so repeated startup is an upsert/reconciliation operation, not a scheduler-creation operation.

## 2. Desired-state scheduler and hourly cadence

The scheduler cadence is locked to one hour (A1).

At AI automation process startup:

- when `AI_DISCOVERY_SCHEDULER_ENABLED=true`, call BullMQ `upsertJobScheduler()` for `ai-discovery-hourly-v1` with a one-hour repeat strategy and a minimal static job template;
- when `AI_DISCOVERY_SCHEDULER_ENABLED=false`, call `removeJobScheduler('ai-discovery-hourly-v1')` so a scheduler persisted by an earlier process/configuration cannot continue producing jobs;
- reconciliation is idempotent and safe across repeated process starts;
- scheduler-management failures fail the AI automation process closed and emit only sanitized operational errors.

The Redis job payload is deliberately minimal:

```json
{"schemaVersion":1}
```

It must not contain observation text, prompts, catalog payloads, AI proposals, provider responses, API keys, database URLs, or authorization headers.

### Hour-slot resolution

The final data-minimization boundary is authoritative: the dynamic hour slot is not placed in Redis. When a scheduled job starts processing, PostgreSQL derives the current UTC hour with its own clock and attempts to create/claim the corresponding durable tick. A delayed scheduler job therefore does not backfill missed hours. This is intentional: Sprint 8D prefers a missed discovery opportunity over a backlog of provider calls.

BullMQ timing is not a cost authority. Even if a newly reconciled scheduler produces an unexpected early trigger, the scheduled budget reservation described below enforces a rolling one-hour provider-attempt floor atomically in PostgreSQL.

## 3. Durable scheduled tick authority

Create migration `0016_ai_discovery_automation.sql` with a `scheduled_ai_discovery_ticks` operational ledger.

Each row represents at most one processed scheduled trigger for one PostgreSQL UTC hour:

- `scheduled_ai_discovery_tick_id uuid primary key`
- `scheduler_key text`, fixed to `ai-discovery-hourly-v1`
- `utc_hour timestamptz`, normalized to the start of a UTC hour
- `status text` constrained to the approved outcome vocabulary
- `input_hash text null`
- `ai_discovery_run_id uuid null`
- `ai_operations_policy_revision_id uuid null`
- `ai_operations_run_budget_reservation_id uuid null`
- `provider_attempted boolean not null default false`
- `created_at timestamptz default clock_timestamp()`
- `completed_at timestamptz null`

A unique constraint on `(scheduler_key, utc_hour)` makes duplicate/concurrent BullMQ delivery converge on one PostgreSQL tick. The processor that successfully inserts the row owns that scheduled hour. A duplicate that observes the unique row exits without executing the provider.

The row stores safe hashes/IDs/status only. It does not store raw observations, prompts, request/response bodies, rationales, API keys, secrets, or publication content.

Approved terminal outcomes are:

- `NO_NEW_INPUT`
- `CADENCE_NOT_ELAPSED`
- `POLICY_DISABLED`
- `DAILY_BUDGET_EXHAUSTED`
- `POLICY_MIN_INTERVAL`
- `COMPLETED`
- `PROVIDER_FAILED`
- `AMBIGUOUS_FAILURE`

`SCHEDULER_DISABLED` is an operational reconciliation state, not a durable tick outcome, because a disabled scheduler should not intentionally create new tick rows.

A process crash may leave a claimed tick without `completed_at`. Sprint 8D does not automatically retry that tick. The next eligible scheduler occurrence creates a new UTC-hour tick. This is intentional fail-closed crash behavior.

## 4. Deterministic scheduled input builder

Add a read-only authority `buildScheduledAiDiscoveryInput()` that constructs Sprint 8B canonical provider input exclusively from existing PostgreSQL authorities.

Input sources:

1. active patch;
2. active game catalog/rules for `aram_mayhem`;
3. normalized stored observations that are valid for the active patch/catalog.

The builder must not read Redis and must not invent subjects, augments, items, observations, or patch identifiers.

Initial bounded selection is locked to:

- at most 8 subjects per scheduled provider run;
- at most 4 selected observations per subject;
- only `aram_mayhem`;
- only subjects/items/augments present in the active catalog/rules;
- only normalized stored observations;
- prioritize subjects with observations not represented in the most recent scheduled input;
- stable ASCII tie-break by `subjectExternalId`;
- canonical stable ordering/deduplication for selected observations and allowlists.

The resulting shape remains the existing Sprint 8B provider input:

```text
runKey
patchKey
gameModeExternalId = aram_mayhem
subjects[]
  subjectExternalId
  allowedAugmentExternalIds[]
  allowedItemExternalIds[]
  observations[]
```

The builder produces a canonical input hash using the existing Sprint 8B normalization/hash semantics rather than defining a competing hash format.

### No-new-input gate

Before any budget reservation, Sprint 8D compares the canonical input hash with the latest prior scheduled tick that has an `input_hash`.

If there is no eligible input, or the canonical input hash is identical to the latest scheduled input hash:

```text
NO_NEW_INPUT
→ complete tick
→ zero budget reservations
→ zero provider calls
```

A failed scheduled provider run is not automatically repeated with the same input. The same hash remains `NO_NEW_INPUT` until authoritative input changes. Explicit private/manual execution remains a separate operator path if recovery is required.

## 5. Deterministic run identity

The scheduled provider identity is based on canonical input, not the wall-clock hour:

```text
runKey = scheduled:v1:<inputHash>
idempotencyKey = ai-discovery-scheduled:v1:<inputHash>
aiDiscoveryRunId = deterministic UUIDv5-style value derived from a fixed Sprint 8D namespace + inputHash
```

Exact UUID derivation must use a repository-local deterministic helper with a fixed versioned namespace and tests. It must not depend on process randomness, Redis job ID, hostname, worker count, or hour slot.

Consequences:

- the same authoritative input cannot become a new AI run merely because another hour passed;
- duplicate jobs/workers converge on the same provider identity;
- Sprint 8B replay preflight can return an existing durable run without another provider call;
- new authoritative input produces a new identity.

`startedAt` for a newly executing scheduled run comes from PostgreSQL-backed tick processing time, not untrusted Redis payload data.

## 6. Scheduled policy/budget reservation

Sprint 8D must enforce A1 as a rolling one-hour provider-attempt floor even if the active Sprint 8C policy is configured with a smaller `min_interval_seconds`.

Do not duplicate the Sprint 8C budget ledger or policy logic. Refactor the existing budget implementation behind a private shared reservation primitive that accepts a minimum-interval floor:

```text
manual/private 8C reservation:
  effectiveMinInterval = activePolicy.minIntervalSeconds

scheduled 8D reservation:
  effectiveMinInterval = max(activePolicy.minIntervalSeconds, 3600)
```

Both paths:

- use the same PostgreSQL advisory budget lock;
- read the same active policy;
- count the same UTC-day reservations across policy revisions;
- write the same `ai_operations_run_budget_reservations` table;
- preserve existing idempotency semantics;
- preserve the existing unique reservation per `aiDiscoveryRunId`;
- snapshot the existing proposal cap;
- write the same safe audit event.

The public behavior of existing Sprint 8C manual/private commands does not become stricter. Only scheduled Sprint 8D execution injects the 3600-second floor.

The scheduled execution composes `executePolicyGovernedAiDiscoveryRun()` with the stricter scheduled reservation dependency. It does not bypass or replace Sprint 8C policy-governed execution.

Policy/budget denial is mapped to the safe scheduled outcomes `POLICY_DISABLED`, `DAILY_BUDGET_EXHAUSTED`, `POLICY_MIN_INTERVAL`, or `CADENCE_NOT_ELAPSED` as applicable, with zero provider calls.

## 7. Provider execution, retry, and crash safety

BullMQ scheduled jobs use `attempts: 1`. Sprint 8D must not add automatic BullMQ provider retries.

Sprint 8B already owns bounded provider retry for its approved retryable provider failures. That behavior is preserved unchanged underneath Sprint 8C/8D.

Reason: after a provider request has crossed the network boundary, a process crash can make it impossible to know whether the provider accepted/billed the request. Automatically replaying the BullMQ job could create a second billable request.

Therefore:

```text
ambiguous process/provider boundary crash
→ no automatic BullMQ provider retry
→ any already-created budget reservation remains consumed
→ durable tick may remain incomplete or become AMBIGUOUS_FAILURE when safely detectable
→ wait for a later hour and new authoritative input
```

A provider result that Sprint 8B safely records as failed maps the tick to `PROVIDER_FAILED`. A completed/replayed provider run maps the tick to `COMPLETED` and stores only safe IDs/metadata.

## 8. Configuration and secrets

Do not make OpenAI configuration mandatory for the public API or core worker.

Create an AI-automation-specific configuration parser with:

- `DATABASE_URL`
- `REDIS_URL`
- `AI_DISCOVERY_SCHEDULER_ENABLED`, default `false`, exact boolean parsing
- `AI_DISCOVERY_PROVIDER=openai`
- `OPENAI_API_KEY`
- `AI_DISCOVERY_OPENAI_MODEL`
- bounded optional `AI_DISCOVERY_TIMEOUT_MS`
- optional non-production `AI_DISCOVERY_OPENAI_ENDPOINT` using the existing Sprint 8B production restriction

When scheduler desired state is disabled, provider credentials are not required; the process must still be able to connect to Redis, remove a stale scheduler, and exit/run safely without an OpenAI secret.

When scheduler desired state is enabled, missing/invalid provider configuration fails closed before processing provider work.

Secrets and sensitive payloads must not be written to:

- Redis job data;
- scheduled tick rows;
- audit events;
- stdout/stderr;
- CI artifacts;
- repository files.

## 9. Read-only observability

Extend the existing AI operations read model with safe automation metadata. The read model remains private/read-only; Sprint 8D does not add a browser or public mutation surface.

Add an `automation` section containing at least:

- last completed tick time;
- last tick outcome;
- last input hash;
- last AI discovery run ID;
- last budget reservation/provider-attempt time where available.

Add bounded recent counters derived from durable tick rows:

- ticks;
- no-new-input;
- policy/cadence blocked;
- completed;
- provider failed/ambiguous.

The snapshot must never expose prompts, raw observation text, provider response bodies, API keys, request headers, or Evidence/Publication mutation capability.

Add a private status command/runbook procedure that can inspect BullMQ Job Scheduler inventory and compare actual Redis scheduler state with the configured desired state. It is observational only.

## 10. Rollout and rollback

Sprint 8D merges disabled by default:

```text
AI_DISCOVERY_SCHEDULER_ENABLED=false
```

The implementation PR does not provision production credentials and does not deploy or activate production AI automation.

A later explicitly authorized production activation sequence is:

1. deploy code/migrations;
2. verify core API/worker unaffected;
3. verify AI automation runtime with scheduler disabled;
4. verify stale scheduler is absent;
5. provision provider secret/model configuration;
6. activate an appropriate Sprint 8C policy;
7. enable scheduler;
8. verify desired-state reconciliation and actual scheduler inventory;
9. observe the first durable tick and confirm expected outcome/provider budget behavior.

Primary rollback:

1. set `AI_DISCOVERY_SCHEDULER_ENABLED=false`;
2. restart/reconcile AI automation runtime;
3. verify `ai-discovery-hourly-v1` is removed from Redis scheduler inventory;
4. leave all PostgreSQL history intact.

Rollback must not delete AI runs, proposals, budget reservations, scheduled ticks, audit events, Candidate history, reviews, moderation decisions, eligibility decisions, or publications.

A stale already-delivered job encountered after disable must check desired state before scheduled provider execution and exit without a provider call.

## 11. Testing and CI gates

Implementation follows TDD. The first implementation-stage commit after the approved spec/plan must establish failing Sprint 8D tests/contracts before production implementation.

Required Sprint 8D tests include:

### Scheduler and configuration

- scheduler ID is fixed and cadence is one hour;
- enabled startup upserts desired scheduler;
- disabled startup removes stale scheduler;
- repeated reconciliation is idempotent;
- disabled configuration does not require OpenAI credentials;
- enabled configuration fails closed when provider configuration is invalid;
- Redis job payload is limited to the approved minimal schema;
- produced jobs use `attempts: 1`.

### Tick concurrency and durability

- PostgreSQL UTC hour is used;
- duplicate delivery creates one tick;
- two workers racing the same UTC hour produce one owned tick;
- duplicate/non-owner path performs zero provider calls;
- crash/incomplete tick is not automatically retried/backfilled.

### Deterministic input and identity

- only active patch/catalog/rules/normalized observations are selected;
- selection caps are 8 subjects and 4 observations per subject;
- ordering and deduplication are deterministic;
- invalid/non-catalog IDs cannot enter provider input;
- identical authoritative state produces identical normalized input/hash/run identity;
- changed authoritative input produces a new identity;
- identical latest input produces `NO_NEW_INPUT`, zero budget reservations, and zero provider calls.

### Policy, cadence, cost, and provider safety

- scheduled effective interval is `max(policy interval, 3600)`;
- cadence rejection is atomic under concurrency;
- disabled policy, exhausted daily budget, policy interval, and scheduled cadence denial all produce zero provider calls;
- same scheduled run replay consumes no second reservation and performs no second provider call;
- existing Sprint 8B bounded internal provider retry still works;
- BullMQ does not retry an ambiguous provider job;
- provider proposal cap remains enforced by Sprint 8C;
- failed provider runs remain consumed budget units as in Sprint 8C.

### Authority/security contracts

- scheduled worker/module graph has no import/call path to `materializeAiCandidateProposal()`;
- no automatic Human Review/Moderation/Eligibility/Publication mutation is introduced;
- AI output remains non-Evidence;
- OpenAI secret and raw prompt/observation/provider response are absent from Redis job data, safe logs, tick persistence, and read-only snapshot;
- no production deployment/secret command is introduced.

### Regression gates

At exact feature head before PR merge:

- Sprint 8D dedicated workflow/contract passes;
- Sprint 8C policy/budget gate passes;
- Sprint 8B provider execution gate passes;
- Sprint 8A guarded AI discovery gate passes;
- full backend typecheck/tests/build pass;
- frontend lint/build/regression gates pass where inherited workflows require them;
- Sprint 7A/7B/7C gates pass;
- Sprint 5C staging/regression and Sprint 5D release-candidate gates pass;
- deployment workflow remains dry-run only;
- repository cleanliness/secret guard passes.

CI uses fake/injected providers and must not make a real OpenAI request.

## 12. Definition of Done

Sprint 8D is complete only when all of the following are true:

- a dedicated AI automation runtime exists independently of the core worker;
- BullMQ scheduler desired state is reconciled on startup and disabled by default;
- scheduler cadence is one hour and scheduled provider attempts cannot occur more frequently than the stricter of 3600 seconds or active Sprint 8C policy;
- PostgreSQL uniquely owns each processed UTC-hour tick;
- duplicate/concurrent delivery cannot create duplicate provider execution;
- deterministic input selection uses only existing authoritative normalized data and approved caps;
- no-new-input produces zero budget/provider usage;
- same input cannot become a new scheduled AI run solely because time passed;
- Sprint 8C policy/budget remains mandatory and authoritative;
- BullMQ performs no automatic provider retry;
- core API/worker do not require OpenAI credentials;
- Redis/log/tick/read model do not expose secrets or raw AI payloads;
- scheduled execution stops at durable AI proposals;
- no Candidate materialization, Human Review, Moderation, Eligibility, or Publication is automated;
- all Sprint 8D and inherited regression workflows are green at exact PR head;
- no production deployment, credential provisioning, or production activation has occurred.

## Out of scope

Explicitly deferred to later separately designed/approved work:

- production deployment and secret provisioning;
- automatic Candidate materialization;
- automatic Human Review or review recommendations that mutate review state;
- automatic Moderation, Eligibility, or Publication;
- public/browser controls for enabling/disabling AI automation;
- dynamic cadence configuration;
- multi-game-mode or non-`aram_mayhem` AI discovery;
- automatic retry/backfill of missed or ambiguous scheduled runs;
- semantic/vector search or a new observation ranking subsystem;
- replacing PostgreSQL budget authority with Redis/BullMQ state.