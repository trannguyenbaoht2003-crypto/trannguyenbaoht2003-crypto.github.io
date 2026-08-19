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
- Scheduled input excludes `ai_generated` provenance so AI output cannot become its own automatic discovery signal.
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

The AI queue consumer may run while the scheduler is disabled so stale already-delivered jobs can be drained as no-ops. Its processor checks the local desired-state flag before creating a tick or touching provider execution.

The Redis job payload is deliberately minimal:

```json
{"schemaVersion":1}
```

It must not contain observation text, prompts, catalog payloads, AI proposals, provider responses, API keys, database URLs, or authorization headers.

### Hour-slot resolution

The final data-minimization boundary is authoritative: the dynamic hour slot is not placed in Redis. When an enabled scheduled job starts processing, PostgreSQL derives the current UTC hour with its own clock and attempts to create/claim the corresponding durable tick. A delayed scheduler job therefore does not backfill missed hours. This is intentional: Sprint 8D prefers a missed discovery opportunity over a backlog of provider calls.

BullMQ timing is not a cost authority. Even if a newly reconciled scheduler produces an unexpected early trigger, the scheduled budget reservation described below enforces a rolling one-hour provider-attempt floor atomically in PostgreSQL.

## 3. Durable scheduled tick authority

Create migration `0016_ai_discovery_automation.sql` with a `scheduled_ai_discovery_ticks` operational ledger.

Each row represents at most one processed scheduled trigger for one PostgreSQL UTC hour:

- `scheduled_ai_discovery_tick_id uuid primary key`
- `scheduler_key text`, fixed to `ai-discovery-hourly-v1`
- `utc_hour timestamptz`, normalized to the start of a UTC hour
- `status text`, initially `PROCESSING`, then one approved terminal outcome
- `scheduled_content_hash text null`
- `ai_discovery_run_id uuid null`
- `ai_operations_policy_revision_id uuid null`
- `ai_operations_run_budget_reservation_id uuid null`
- `created_at timestamptz default clock_timestamp()`
- `completed_at timestamptz null`

A unique constraint on `(scheduler_key, utc_hour)` makes duplicate/concurrent BullMQ delivery converge on one PostgreSQL tick. The processor that successfully inserts the row owns that scheduled hour. A duplicate that observes the unique row exits without executing the provider.

The row stores safe hashes/IDs/status only. It does not store raw observations, prompts, request/response bodies, rationales, API keys, secrets, or publication content.

`PROCESSING` is the only non-terminal state. Approved terminal outcomes are:

- `NO_NEW_INPUT`
- `CADENCE_NOT_ELAPSED`
- `POLICY_DISABLED`
- `DAILY_BUDGET_EXHAUSTED`
- `POLICY_MIN_INTERVAL`
- `COMPLETED`
- `PROVIDER_FAILED`
- `AMBIGUOUS_FAILURE`

`SCHEDULER_DISABLED` is an operational reconciliation/no-op state, not a durable tick outcome, because a disabled scheduler should not intentionally create new tick rows.

A process crash may leave a claimed tick in `PROCESSING` with `completed_at = null`. Sprint 8D does not automatically retry that tick. The next eligible scheduler occurrence creates a new UTC-hour tick. This is intentional fail-closed crash behavior.

Before provider orchestration begins, the owned tick is updated with `scheduled_content_hash` and deterministic `ai_discovery_run_id`. If a later crash occurs after Sprint 8C budget reservation, the durable budget row can still be joined back to the tick by `ai_discovery_run_id` even if the tick did not receive its final reservation metadata update.

## 4. Deterministic scheduled input builder

Add a read-only authority `buildScheduledAiDiscoveryInput()` that constructs scheduled AI content exclusively from existing PostgreSQL authorities.

Input sources:

1. the active patch;
2. the active catalog revision for `aram_mayhem`;
3. `normalized_observations` belonging to that exact patch/catalog revision;
4. their existing provenance origin for signal labeling.

The existing normalization authority stores structured selection payloads, not arbitrary raw observation text. Sprint 8D therefore does **not** assume that a raw community post/video transcript is available. It deterministically serializes each eligible structured normalized observation into a bounded provider observation string.

Eligible origins are:

- `collector_detected`
- `community_submitted`
- `editorial`

`ai_generated` is excluded from scheduled discovery input.

### Deterministic ranking and bounds

Initial selection is locked to:

- at most 8 subjects per scheduled provider run;
- at most 4 normalized observations per subject;
- only `aram_mayhem`;
- only the active patch and exact active catalog revision;
- subjects ranked by their newest eligible `normalized_observations.created_at` descending, then `subjectExternalId` ASCII ascending;
- observations within a subject ranked by `created_at` descending, then `normalized_observation_id` ascending;
- after selecting the top subjects/observations, the final provider subject list is normalized by the existing Sprint 8B normalization function.

A structured observation string is the canonical JSON serialization of only safe structured facts needed for discovery, for example the equivalent of:

```json
{
  "schemaVersion": 1,
  "origin": "collector_detected",
  "augmentExternalIds": ["..."],
  "itemExternalIds": ["..."]
}
```

The serializer uses fixed key order and already-normalized ID arrays. It never includes source URLs, raw blobs, authorization data, usernames, free-form collector text, Evidence claims, or publication state.

Each serialized observation must independently satisfy Sprint 8B observation validation, including its length/control/secret-pattern bounds. An oversized or otherwise invalid structured serialization is ineligible; Sprint 8D does not truncate an observation because truncation could silently change its meaning.

Duplicate structured observations may remain as separate entries when they correspond to separate normalized observation rows. This lets additional durable community sightings change the scheduled content while keeping the provider input factual and structured.

### Provider allow-lists

For each selected subject, `allowedAugmentExternalIds` and `allowedItemExternalIds` are the ASCII-sorted union of IDs present in the selected eligible normalized observations for that subject, revalidated against the exact active catalog revision.

The builder must not add unobserved IDs merely because they exist in the catalog. This keeps scheduled AI discovery bounded to combinations already present in authoritative normalized community/editorial signals.

If adding an observation would cause an existing Sprint 8B allow-list limit to be exceeded, that observation is skipped deterministically rather than truncating its selection. If no valid observations remain, the subject is omitted. If no subjects remain, the tick becomes `NO_NEW_INPUT`.

## 5. Scheduled content hash and deterministic run identity

Sprint 8B's provider execution input contains `runKey`, so its existing full provider-input hash cannot be used to derive `runKey` without a circular dependency.

Sprint 8D therefore defines a separate versioned **scheduled content hash** over the provider-facing content **before** `runKey` exists:

```text
ScheduledAiDiscoveryContentV1 = {
  patchKey,
  gameModeExternalId,
  subjects
}

scheduledContentHash = hashCanonicalJson(ScheduledAiDiscoveryContentV1)
```

This uses the repository's existing canonical JSON hash primitive; it is not a replacement for Sprint 8B's provider input hash. Sprint 8B continues to compute and persist its own full normalized provider-input hash after `runKey` is assigned.

Scheduled identities are then derived from `scheduledContentHash`:

```text
runKey = scheduled:v1:<scheduledContentHash>
idempotencyKey = ai-discovery-scheduled:v1:<scheduledContentHash>
aiDiscoveryRunId = deterministic UUID derived from a fixed Sprint 8D namespace + scheduledContentHash
```

Exact UUID derivation must use a repository-local deterministic helper with a fixed versioned namespace and tests. It must not depend on process randomness, Redis job ID, hostname, worker count, or hour slot.

Consequences:

- the same authoritative scheduled content cannot become a new AI run merely because another hour passed;
- duplicate jobs/workers converge on the same provider identity;
- Sprint 8B replay preflight can return an existing durable run without another provider call;
- new authoritative selected content produces a new identity.

`startedAt` for a newly executing scheduled run comes from PostgreSQL-backed tick processing time, not untrusted Redis payload data.

### No-new-input gate

Before any new budget reservation, Sprint 8D compares the current `scheduledContentHash` with prior scheduled content that has already consumed a Sprint 8C budget reservation.

The authoritative consumed-input test is a join from prior scheduled ticks by `ai_discovery_run_id` to `ai_operations_run_budget_reservations`; it does not rely only on the tick's final status/metadata, because a crash may occur after reservation but before final tick update.

If the same `scheduledContentHash` already has a budget reservation:

```text
NO_NEW_INPUT
→ complete current tick
→ zero new budget reservations
→ zero provider calls
```

If an earlier tick with the same content was blocked **before** budget reservation (for example policy disabled, daily budget exhausted, or cadence not elapsed), the content is not considered consumed and may be attempted on a later hourly tick when policy permits.

A failed or ambiguous provider attempt that already consumed a budget reservation is considered consumed scheduled content and is not automatically retried with identical input. Explicit private/manual execution remains a separate operator recovery path.

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

For denial reporting, evaluate the active policy interval and scheduled floor distinctly while holding the same budget authority lock:

- if elapsed time violates the active policy's own interval, return `POLICY_MIN_INTERVAL`;
- otherwise, if elapsed time is at least the policy interval but below 3600 seconds, return `CADENCE_NOT_ELAPSED`.

The scheduled execution composes `executePolicyGovernedAiDiscoveryRun()` with the stricter scheduled reservation dependency. It does not bypass or replace Sprint 8C policy-governed execution.

`POLICY_DISABLED`, `DAILY_BUDGET_EXHAUSTED`, `POLICY_MIN_INTERVAL`, and `CADENCE_NOT_ELAPSED` all result in zero provider calls.

## 7. Provider execution, retry, and crash safety

BullMQ scheduled jobs use `attempts: 1`. Sprint 8D must not add automatic BullMQ provider retries.

Sprint 8B already owns bounded provider retry for its approved retryable provider failures. That behavior is preserved unchanged underneath Sprint 8C/8D.

Reason: after a provider request has crossed the network boundary, a process crash can make it impossible to know whether the provider accepted/billed the request. Automatically replaying the BullMQ job could create a second billable request.

Therefore:

```text
ambiguous process/provider boundary crash
→ no automatic BullMQ provider retry
→ any already-created budget reservation remains consumed
→ durable tick may remain PROCESSING or become AMBIGUOUS_FAILURE when safely detectable
→ identical scheduled content is treated as consumed if a budget reservation exists
→ wait for later new authoritative content or explicit private/manual recovery
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

When scheduler desired state is disabled, provider credentials are not required; the process must still be able to connect to Redis, remove a stale scheduler, consume stale jobs as no-ops, and shut down safely without an OpenAI secret.

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
- last scheduled content hash;
- last AI discovery run ID;
- last budget reservation/provider-attempt authorization time where available.

Add bounded recent counters derived from durable tick rows:

- ticks;
- no-new-input;
- policy/cadence blocked;
- completed;
- provider failed/ambiguous;
- incomplete `PROCESSING` ticks.

The snapshot must never expose prompts, raw observation text, structured observation bodies, provider response bodies, API keys, request headers, or Evidence/Publication mutation capability.

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
4. verify stale scheduler is absent and stale jobs are no-op safe;
5. provision provider secret/model configuration;
6. activate an appropriate Sprint 8C policy;
7. enable scheduler;
8. verify desired-state reconciliation and actual scheduler inventory;
9. observe the first durable tick and confirm expected outcome/provider budget behavior.

Primary rollback:

1. set `AI_DISCOVERY_SCHEDULER_ENABLED=false`;
2. restart/reconcile AI automation runtime;
3. verify `ai-discovery-hourly-v1` is removed from Redis scheduler inventory;
4. verify any stale delivered job exits before creating a provider run;
5. leave all PostgreSQL history intact.

Rollback must not delete AI runs, proposals, budget reservations, scheduled ticks, audit events, Candidate history, reviews, moderation decisions, eligibility decisions, or publications.

## 11. Testing and CI gates

Implementation follows TDD. The first implementation-stage commit after the approved spec/plan must establish failing Sprint 8D tests/contracts before production implementation.

Required Sprint 8D tests include:

### Scheduler and configuration

- scheduler ID is fixed and cadence is one hour;
- enabled startup upserts desired scheduler;
- disabled startup removes stale scheduler;
- repeated reconciliation is idempotent;
- stale jobs while disabled are consumed as no-ops before tick/provider execution;
- disabled configuration does not require OpenAI credentials;
- enabled configuration fails closed when provider configuration is invalid;
- Redis job payload is exactly the approved minimal schema;
- produced jobs use `attempts: 1`.

### Tick concurrency and durability

- PostgreSQL UTC hour is used;
- new tick begins as `PROCESSING`;
- duplicate delivery creates one tick;
- two workers racing the same UTC hour produce one owned tick;
- duplicate/non-owner path performs zero provider calls;
- deterministic run ID is persisted on the tick before provider orchestration;
- a reservation created before a crash remains discoverable by tick `ai_discovery_run_id`;
- crash/incomplete tick is not automatically retried/backfilled.

### Deterministic input and identity

- only active patch/exact active catalog/normalized observations are selected;
- `ai_generated` provenance is excluded;
- selection caps are 8 subjects and 4 observations per subject;
- subject and observation ranking are deterministic using durable `created_at`/ID tie-breaks;
- structured observation serialization is deterministic and contains no raw/free-form source data;
- oversized/invalid structured observations are skipped, never truncated;
- per-subject allow-lists are only the sorted union of IDs in selected observations and revalidate against the active catalog;
- invalid/non-catalog IDs cannot enter provider input;
- scheduled content hash excludes `runKey` and is deterministic;
- identical authoritative selected content produces identical scheduled content hash/run identity;
- changed authoritative selected content produces a new identity;
- same content with a prior budget reservation produces `NO_NEW_INPUT`, zero new reservations, and zero provider calls;
- same content previously blocked before reservation remains eligible on a later tick.

### Policy, cadence, cost, and provider safety

- scheduled effective interval is `max(policy interval, 3600)`;
- cadence/policy interval rejection is atomic under concurrency and maps to the correct safe reason;
- disabled policy, exhausted daily budget, policy interval, and scheduled cadence denial all produce zero provider calls;
- same scheduled run replay consumes no second reservation and performs no second provider call;
- existing Sprint 8B bounded internal provider retry still works;
- BullMQ does not retry an ambiguous provider job;
- provider proposal cap remains enforced by Sprint 8C;
- failed/ambiguous provider attempts with a durable budget reservation are not automatically retried with identical scheduled content;
- failed provider runs remain consumed budget units as in Sprint 8C.

### Authority/security contracts

- scheduled worker/module graph has no import/call path to `materializeAiCandidateProposal()`;
- no automatic Human Review/Moderation/Eligibility/Publication mutation is introduced;
- AI output remains non-Evidence;
- OpenAI secret, source raw text/blob, prompt, structured observation bodies, and provider response are absent from Redis job data, safe logs, tick persistence, and read-only snapshot;
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
- deterministic input selection uses only the active patch/catalog and existing authoritative normalized structured signals, excluding AI-generated provenance;
- scheduled observation strings are deterministic bounded serializations of structured data, not assumed raw community text;
- no-new-input is based on previously budget-consumed scheduled content, so policy-blocked content can be attempted later while failed/ambiguous billable attempts are not automatically repeated;
- scheduled content hash is non-circular and distinct from Sprint 8B's full provider input hash;
- same selected content cannot become a new scheduled AI run solely because time passed;
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
- raw transcript/text ingestion as an AI discovery prerequisite;
- semantic/vector search or a new observation ranking subsystem;
- replacing PostgreSQL budget authority with Redis/BullMQ state.