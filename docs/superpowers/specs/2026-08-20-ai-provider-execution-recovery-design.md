# Sprint 8E — Durable AI Provider Execution Recovery Design

Base: `main@c7243c63672689b81f13facbedfbace969fbdc7d`.

## Goal

Sprint 8E closes the remaining crash/ambiguity gap around external AI provider execution without granting AI any new content authority and without activating production AI automation.

The problem after Sprint 8D is deliberately narrow: PostgreSQL can prove that policy/budget authorization occurred, but a process can still die after an external provider request crosses the network boundary and before the resulting AI run/proposals are durably recorded. In that window, blindly replaying the provider request can create duplicate spend or duplicate external side effects.

Sprint 8E therefore adds a durable provider-execution journal, per-attempt execution records, leases, fail-closed recovery, and explicit append-only operator reconciliation.

The target flow is:

```text
Sprint 8D scheduled/manual provider trigger
        ↓
normalized provider input + deterministic run identity
        ↓
ATOMIC PostgreSQL preparation
  ├─ Sprint 8C policy/budget authorization
  ├─ provider execution PREPARED
  └─ provider attempt #1 PREPARED
        ↓
lease acquired
        ↓
durable PREPARED → IN_FLIGHT
        ↓
OpenAI Responses request
        ↓
┌──────────────────┬───────────────────────┬──────────────────────┐
│ completed        │ safe deterministic    │ ambiguous boundary   │
│ response         │ rejection / 429       │ timeout/crash/etc.   │
└────────┬─────────┴──────────┬────────────┴──────────┬───────────┘
         ↓                    ↓                       ↓
 durable AI run       retry only when safe       UNCERTAIN
 + proposals          and durably journaled          ↓
 + journal terminal                               STOP
                                                     ↓
                                           operator reconciliation
```

Sprint 8E does **not** promise exactly-once provider execution. PostgreSQL cannot atomically commit a transaction together with an external HTTP side effect. The safety goal is instead:

> Never automatically replay a provider execution when the system cannot prove that the previous external request was not received.

AI output remains advisory. Sprint 8E ends at the existing durable AI discovery run and AI candidate proposal authority. It does not automatically materialize a Candidate, complete Human Review, mutate Moderation or Eligibility, create Evidence, or create/activate Publication.

## Locked authority boundary

- PostgreSQL is the durable authority for provider execution identity, policy/budget authorization, execution/attempt state, leases, reconciliation decisions, AI runs/proposals, and all downstream domain authorities.
- Redis/BullMQ remains scheduling/delivery infrastructure only. Redis never decides whether an external provider call may be replayed.
- Sprint 8C remains the policy/budget authority. Sprint 8E refactors its transaction boundary but does not create a second budget ledger or weaken policy.
- Sprint 8B remains responsible for provider request construction, strict response validation, allow-list enforcement, canonical proposal/output construction, and AI-run persistence semantics. Its opaque internal retry loop is replaced by durable 8E attempt orchestration.
- Sprint 8A remains the authority for immutable AI discovery runs and append-only AI candidate proposals.
- Sprint 8D remains the hourly scheduler/input/tick authority. The existing 3600-second scheduled policy floor remains mandatory.
- `materializeAiCandidateProposal()` remains explicit/private and must not be imported or called from the 8E provider execution/recovery path.
- No public Fastify mutation route, operator-browser mutation, automatic Candidate materialization, automatic Human Review, automatic Evidence/Publication mutation, production credential provisioning, production scheduler activation, or production deployment is authorized by Sprint 8E.

## 1. Why the existing boundary is insufficient

Sprint 8B currently performs provider execution and bounded retries in one process-local loop, then calls `recordAiDiscoveryRun()` only after a provider response/failure has been canonicalized. Sprint 8C currently reserves budget in a transaction before calling Sprint 8B. Sprint 8D correctly refuses BullMQ replay across an ambiguous external boundary and treats a budget reservation as consumed scheduled content.

This leaves an unavoidable window:

```text
budget reservation committed
        ↓
provider request received or possibly received
        ↓
process crashes / transport becomes ambiguous
        ↓
AI discovery run not durably recorded
```

The correct response is not to make BullMQ more aggressive. Sprint 8E makes the uncertainty itself durable and visible.

## 2. Durable execution model

Create migration `0017_ai_provider_execution_journal.sql` with three new append-oriented operational authorities:

1. `ai_provider_executions`
2. `ai_provider_execution_attempts`
3. `ai_provider_execution_reconciliations`

No table stores the OpenAI API key, Authorization header, raw prompt/messages, raw observation payload, raw provider output text, or full HTTP body.

### 2.1 `ai_provider_executions`

One row represents one logical provider execution for one `aiDiscoveryRunId`.

Required columns:

- `ai_provider_execution_id uuid primary key`
- `ai_discovery_run_id uuid not null unique`
- `ai_operations_run_budget_reservation_id uuid not null unique references ai_operations_run_budget_reservations(...)`
- `run_key text not null unique`
- `idempotency_key text not null`
- `provider_key text not null`
- `model_key text not null`
- `model_revision text not null`
- `prompt_template_key text not null`
- `prompt_template_version integer not null`
- `input_hash text not null`, canonical SHA-256 hex
- `status text not null`
- `current_attempt_ordinal smallint not null`, constrained to `1..3`
- `lease_token uuid null`
- `leased_at timestamptz null`
- `lease_expires_at timestamptz null`
- `created_at timestamptz not null default clock_timestamp()`
- `updated_at timestamptz not null default clock_timestamp()`
- `terminal_at timestamptz null`

`ai_discovery_run_id` is an execution identity at preparation time and cannot initially be a foreign key to `ai_discovery_runs`, because the durable AI run is intentionally created only after provider execution resolves to a final completed/failed result. Terminal database guards verify consistency with the durable AI run when one is required.

Approved execution statuses:

- `PREPARED`
- `IN_FLIGHT`
- `COMPLETED`
- `FAILED`
- `UNCERTAIN`

`COMPLETED` and `FAILED` are immutable terminal states. `UNCERTAIN` is fail-closed and may be reopened only through the explicit `CONFIRMED_NOT_RECEIVED` reconciliation protocol defined below.

Lease fields satisfy an all-null/all-present consistency constraint, and `lease_expires_at > leased_at` when present. `COMPLETED`, `FAILED`, and reconciled terminal `UNCERTAIN` executions cannot retain an active lease.

The execution row stores identity/safe metadata only. In particular it does not duplicate Sprint 8D `scheduled_content_hash`; scheduled content remains an 8D tick/input authority, while 8E is generic to both scheduled and approved private/manual policy-governed provider execution.

### 2.2 `ai_provider_execution_attempts`

One logical execution may have at most three durable provider attempts.

Required columns:

- `ai_provider_execution_attempt_id uuid primary key`
- `ai_provider_execution_id uuid not null references ai_provider_executions(...)`
- `ordinal smallint not null`, constrained to `1..3`
- `client_request_id uuid not null unique`
- `status text not null`
- `failure_code text null`
- `provider_request_id text null`
- `provider_response_id text null`
- `output_hash text null`, canonical SHA-256 hex when present
- `prepared_at timestamptz not null default clock_timestamp()`
- `dispatch_started_at timestamptz null`
- `completed_at timestamptz null`

Approved attempt statuses:

- `PREPARED`
- `IN_FLIGHT`
- `COMPLETED`
- `FAILED`
- `UNCERTAIN`

Unique `(ai_provider_execution_id, ordinal)` prevents duplicate ordinals. A partial unique constraint/index allows at most one active (`PREPARED` or `IN_FLIGHT`) attempt per execution.

Attempt history is immutable after it becomes `COMPLETED`, `FAILED`, or `UNCERTAIN`. A later retry is a new attempt row, never an update that erases the prior external request.

### 2.3 `ai_provider_execution_reconciliations`

Reconciliation decisions are append-only operator authority for uncertain attempts.

Required columns:

- `ai_provider_execution_reconciliation_id uuid primary key`
- `ai_provider_execution_id uuid not null references ai_provider_executions(...)`
- `ai_provider_execution_attempt_id uuid not null unique references ai_provider_execution_attempts(...)`
- `decision text not null`
- `actor_id text not null`
- `reason_code text not null`
- `evidence_reference text not null`
- `created_at timestamptz not null default clock_timestamp()`

Approved decisions:

- `CONFIRMED_NOT_RECEIVED`
- `CONFIRMED_RECEIVED`
- `ABANDONED`

A unique reconciliation per uncertain attempt prevents later history rewriting. Reconciliation rows cannot be updated or deleted. The reconciliation command also emits a safe audit event containing IDs, decision, actor, reason code, evidence reference, and correlation metadata only.

`evidence_reference` is bounded operational text such as a provider support case/reference. It is not a container for raw prompts, model output, credentials, or arbitrary provider payloads.

## 3. Execution and attempt state machines

### 3.1 Normal dispatch

A provider call is forbidden until execution and current attempt are durably `IN_FLIGHT` under a valid lease:

```text
execution PREPARED + attempt PREPARED
        ↓ acquire execution lease
BEGIN
  verify lease token + expiry
  execution PREPARED → IN_FLIGHT
  attempt PREPARED → IN_FLIGHT
  set dispatch_started_at = PostgreSQL clock
COMMIT
        ↓
provider.execute(...)
```

If the process crashes after the `IN_FLIGHT` commit but before the HTTP call is actually sent, recovery still treats the attempt as `UNCERTAIN`. This false-positive uncertainty is intentional: the system cannot safely distinguish that crash point from a crash after the request crossed the network boundary.

### 3.2 Safe automatic retry

Sprint 8E removes the opaque process-local three-attempt loop from Sprint 8B. The only automatic retry class approved for 8E is a clearly received HTTP `429` rate-limit response.

When attempts remain, one transaction:

1. marks the current attempt `FAILED` with `PROVIDER_RATE_LIMITED`;
2. creates the next attempt `PREPARED` with a new deterministic client request ID;
3. updates `current_attempt_ordinal`;
4. moves the logical execution back to `PREPARED` while preserving the same lease when still valid;
5. commits before any subsequent provider call.

Backoff may preserve the existing bounded delays (`500 ms`, then `1500 ms`), but the retry is now visible in durable attempt history.

If attempt 3 receives `429`, no attempt 4 may be created. The logical execution resolves to terminal `FAILED` and a final failed AI discovery run is atomically recorded with `PROVIDER_RATE_LIMITED`.

### 3.3 Safe terminal failures

Failures that prove a request reached a deterministic terminal response and should not be retried include:

- authentication/authorization rejection (`401`/`403`);
- deterministic non-`408`, non-`429` client/request rejection;
- HTTP success whose response body/structured output is invalid;
- allow-list/proposal-cap violation after a provider response was received.

These create a final failed AI discovery run and terminal `FAILED` execution/attempt in one transaction. They never create another provider attempt.

### 3.4 Ambiguous failures

The following are fail-closed `UNCERTAIN`:

- client timeout / abort;
- transport/network error where no authoritative HTTP response was obtained;
- HTTP `408`;
- HTTP `5xx`/gateway errors, because the request may have reached provider processing;
- process crash while the durable attempt is `IN_FLIGHT`;
- durable persistence failure after the provider returned, when the final AI run/journal transaction cannot be committed safely.

No automatic provider attempt is created from any of these outcomes.

If the process catches an ambiguous outcome, it should best-effort persist `UNCERTAIN` immediately and retain any safe provider request/response IDs already known. If that persistence also fails or the process crashes, the stale-lease recovery path later converges `IN_FLIGHT → UNCERTAIN`.

### 3.5 Reopening `UNCERTAIN`

`UNCERTAIN` cannot return to `PREPARED` through worker restart, lease expiry, scheduler delivery, CLI recovery, or a generic force flag.

The only approved reopening is:

```text
uncertain attempt
        ↓
append reconciliation = CONFIRMED_NOT_RECEIVED
        ↓
if ordinal < 3, in one transaction:
  create next attempt PREPARED
  execution UNCERTAIN → PREPARED
  current_attempt_ordinal += 1
  terminal_at remains null
```

`CONFIRMED_RECEIVED` and `ABANDONED` do not permit another provider call. The execution remains `UNCERTAIN`; the reconciliation makes it operationally terminal and sets `terminal_at`.

There is no `force-retry-uncertain` command in Sprint 8E.

## 4. Policy/budget preparation must be atomic with the journal

The existing Sprint 8C reservation helper opens and owns its own transaction. Sprint 8E must refactor, not replace, that authority.

Extract a transaction-scoped primitive equivalent to:

```text
reserveAiOperationsRunBudgetInTransaction(client, command, options)
```

It continues to own:

- idempotency scope/recording for budget reservation;
- the existing PostgreSQL advisory budget lock;
- active policy validation;
- UTC daily budget counting;
- policy minimum interval;
- optional stricter minimum-interval floor;
- unique reservation per `aiDiscoveryRunId`;
- proposal-cap snapshot;
- safe audit event.

Existing wrappers remain available:

```text
reserveAiOperationsRunBudget(pool, ...)
reserveAiOperationsRunBudgetWithFloor(pool, ...)
```

and simply call the transaction-scoped primitive inside `withTransaction()` so existing approved private/manual behavior remains compatible.

New 8E preparation performs:

```text
BEGIN
  reserveAiOperationsRunBudgetInTransaction(...)
  insert ai_provider_executions PREPARED
  insert attempt #1 PREPARED
COMMIT
```

Therefore no new 8E provider execution may exist without its durable budget reservation, and no new budget reservation produced by this execution path may commit without its execution journal.

Policy denial (`POLICY_DISABLED`, daily budget exhausted, policy minimum interval, scheduled 3600-second floor) rolls back the transaction and produces **no** execution journal or provider attempt.

### Scheduled floor preservation

Sprint 8D currently injects a stricter reservation function to enforce `max(policy min interval, 3600 seconds)`. Sprint 8E moves that policy option to atomic preparation rather than weakening/removing it.

Conceptually:

```text
private/manual 8C provider execution:
  minimumIntervalFloorSeconds = 0

scheduled 8D provider execution:
  minimumIntervalFloorSeconds = 3600
```

Both go through the same transaction-scoped Sprint 8C budget authority.

## 5. Replay and existing historical records

Sprint 8E is not permitted to synthesize external attempts for historical ambiguous rows.

### Existing completed/failed AI runs

Sprint 8B replay preflight remains authoritative for already-durable `ai_discovery_runs`. If a compatible historical run and completed idempotency record exist, it is replayed with zero provider call and does not require a backfilled 8E journal.

### Existing historical budget reservation without a durable AI run

A pre-8E budget reservation without a durable AI run is treated as already consumed external authorization. Sprint 8E must not manufacture a new journal/attempt and call the provider under that old reservation. Scheduled 8D already treats a budget reservation as consumed content; private/manual replay must fail closed rather than infer that the provider was never contacted.

### New 8E executions

Before creating a new execution, preparation checks for an existing execution by `aiDiscoveryRunId`/`runKey` and verifies immutable execution identity (`provider`, model revision, prompt template, input hash). Replays behave by state:

- `COMPLETED` / terminal `FAILED`: return the durable AI run replay, zero provider calls;
- `PREPARED`: may be safely reclaimed/continued through lease authority, no new budget reservation;
- `IN_FLIGHT` with valid lease: duplicate caller does not execute provider;
- stale `IN_FLIGHT`: recovery first marks `UNCERTAIN`; no provider replay;
- `UNCERTAIN`: no provider call unless an append-only `CONFIRMED_NOT_RECEIVED` reconciliation has already reopened it by creating a next prepared attempt.

Tracing/correlation metadata does not create a new logical provider execution. Any mismatch in durable content identity (run ID/run key, provider, model revision, prompt template, input hash) fails closed.

## 6. Single-attempt provider boundary

Sprint 8B remains responsible for request building, response validation, canonical output/proposal construction, proposal ID determinism, and failure normalization, but provider network execution becomes a single-attempt operation.

Replace the opaque retry loop with a unit equivalent to:

```text
executeAiDiscoveryProviderAttempt(...)
```

It performs exactly one `provider.execute()` call and returns a typed disposition to the 8E orchestration:

- `COMPLETED`
- `SAFE_RETRYABLE` (`429` only)
- `SAFE_TERMINAL`
- `UNCERTAIN`

The outer policy-governed execution facade may preserve its existing production call shape where practical, but its internal dependency boundary must no longer allow provider retries outside the durable 8E attempt authority.

Proposal-cap enforcement remains active before a successful provider result can become a durable AI run.

## 7. OpenAI request identity semantics

Sprint 8E separates three identifiers that are distinct in the OpenAI API:

```text
client_request_id
  = deterministic Hải Đấu ID
  = sent as X-Client-Request-Id

provider_request_id
  = OpenAI HTTP response x-request-id

provider_response_id
  = OpenAI Responses JSON body id (resp_... or other opaque response ID)
```

The current adapter must stop naming the JSON body `response.id` as a provider request ID.

For every durable attempt, generate a deterministic UUID using a fixed versioned namespace and the logical execution identity plus attempt ordinal, e.g. conceptually:

```text
UUIDv5(
  namespace = hai-dau-ai-provider-attempt-v1,
  value = <execution-id>:<ordinal>
)
```

This UUID is stored as `client_request_id` and explicitly sent on the OpenAI HTTP request as:

```text
X-Client-Request-Id: <client_request_id>
```

The ID is a trace/reconciliation identifier only. Sprint 8E must not treat it as a provider-supported idempotency key.

The OpenAI provider adapter captures `x-request-id` from HTTP response headers when available and separately captures the Responses body `id`. Both are bounded opaque metadata. Neither authorizes replay.

OpenAI API request-ID behavior referenced by this design is documented at:

`https://developers.openai.com/api/reference/overview#debugging-requests`

The design relies only on the documented ability to send a unique `X-Client-Request-Id`, receive/log `x-request-id` when a response is available, and use the client request ID for troubleshooting. It does not rely on undocumented exactly-once/idempotency semantics.

## 8. Lease authority

Use the repository's existing lease style: token + leased timestamp + expiry timestamp protected by PostgreSQL constraints and conditional updates.

Default provider-execution lease duration is **120 seconds**.

The configured provider timeout remains bounded to at most 60 seconds. Since the only automatic retries are explicit `429` responses with short bounded backoff, 120 seconds is sufficient without adding lease heartbeats in Sprint 8E.

### Claim rule

Only `PREPARED` executions may be claimed for provider dispatch. Claiming uses a new random lease token and PostgreSQL clock. A caller must present the current valid lease token for the durable `PREPARED → IN_FLIGHT` transition and for subsequent safe state changes during that claimed execution.

### Expired `PREPARED`

```text
PREPARED + expired lease
→ clear stale lease
→ remain PREPARED
→ may be claimed safely later
```

No external provider call was authorized by the `PREPARED` state.

### Expired `IN_FLIGHT`

```text
IN_FLIGHT + expired lease
→ current attempt UNCERTAIN
→ execution UNCERTAIN
→ clear lease
→ STOP
```

Expired `IN_FLIGHT` is never reclaimed for dispatch.

## 9. Recovery protocol

Add a provider-independent read/write authority equivalent to:

```text
recoverStaleAiProviderExecutions(pool)
```

It uses PostgreSQL time and row/transition constraints. It does not construct a provider, read `OPENAI_API_KEY`, contact Redis, or call OpenAI.

A recovery sweep only:

- clears expired leases on `PREPARED` executions so they can be claimed again;
- converts expired `IN_FLIGHT` executions/attempts to `UNCERTAIN` and clears their lease;
- leaves terminal/reconciled history untouched.

Recovery runs:

1. once during dedicated AI automation runtime startup before normal provider work;
2. before processing an enabled scheduled AI-discovery job;
3. from an explicit private recovery CLI command.

Sprint 8E does not add a second BullMQ scheduler or cron solely for recovery.

## 10. Reconciliation protocol and operator authority

Add a private CLI, conceptually:

```text
ai-provider-execution status
ai-provider-execution recover
ai-provider-execution reconcile
```

No public Fastify mutation endpoint and no operator-browser mutation surface is added.

### `status`

Read-only. Requires PostgreSQL connectivity only. It can show safe execution/attempt metadata including:

- execution/run IDs;
- status and attempt ordinal;
- lease timestamps/state;
- client request ID;
- provider request ID;
- provider response ID;
- bounded failure code;
- reconciliation state/timestamps.

It does not print API keys, Authorization headers, prompts, observation content, rationale/output bodies, or database credentials.

### `recover`

Runs only the deterministic recovery sweep described above. It never calls the provider and does not require provider credentials.

### `reconcile`

Requires explicit execution/attempt identity, one approved decision, actor/reason/evidence metadata, and exact uncertain-state validation.

`CONFIRMED_NOT_RECEIVED` means the operator has external evidence that the uncertain request did not reach the provider. If attempts remain, reconciliation and creation of the next `PREPARED` attempt happen in one transaction. The reconcile command itself does **not** immediately call the provider.

`CONFIRMED_RECEIVED` means the request is known to have reached the provider but Hải Đấu does not have a durable final AI run. The execution remains `UNCERTAIN`, becomes operationally terminal, and cannot be retried automatically.

`ABANDONED` explicitly closes operational follow-up without asserting provider receipt. It also leaves the execution `UNCERTAIN`, terminal, and non-retryable.

## 11. Atomic terminal persistence

Preparation is not the only transaction boundary that must be hardened.

The existing `recordAiDiscoveryRun()` owns its own transaction. Sprint 8E extracts a transaction-scoped primitive equivalent to:

```text
recordAiDiscoveryRunInTransaction(client, command)
```

The existing public wrapper remains and calls this primitive inside `withTransaction()` so inherited callers/tests retain approved behavior.

### Successful provider response

One PostgreSQL transaction must:

1. record the immutable `ai_discovery_run` as completed;
2. record deterministic AI candidate proposals;
3. write existing AI-run audit/outbox/idempotency records;
4. mark current attempt `COMPLETED`, including safe request/response IDs and output hash;
5. mark execution `COMPLETED` and clear lease;
6. commit.

If this transaction cannot commit after the provider returned, do not call the provider again. Best-effort transition to `UNCERTAIN` in a separate safe transaction; otherwise stale recovery performs that transition later.

### Final safe failure

When no further safe retry is permitted, one transaction must:

1. record the immutable failed `ai_discovery_run` with zero proposals;
2. write existing AI-run audit/outbox/idempotency records;
3. mark current attempt `FAILED` with bounded failure code and safe provider IDs;
4. mark execution `FAILED` and clear lease;
5. commit.

A non-final `429` attempt does not create a failed AI discovery run because the logical execution is still active.

### Uncertain outcome

`UNCERTAIN` does not create a fake failed `ai_discovery_run`. The absence of a final AI run is intentional and distinguishes uncertainty from a known terminal provider failure.

## 12. Integration with Sprint 8C and Sprint 8D

`executePolicyGovernedAiDiscoveryRun()` becomes the façade over atomic 8C+8E preparation plus durable 8E attempt orchestration. It must not separately commit a budget reservation and only then create the provider execution.

The production caller-facing command remains policy-governed. Internal test/dependency injection may change from `reserveBudget` + `executeRun` to a transaction-aware preparation/execution boundary.

Sprint 8D scheduled execution continues to:

- build deterministic scheduled input;
- claim one PostgreSQL UTC-hour tick;
- enforce the consumed-content/budget join;
- apply the 3600-second minimum provider interval floor;
- use BullMQ `attempts: 1`;
- stop at durable AI run/proposals.

Tick mapping after 8E:

- execution `COMPLETED` → tick `COMPLETED`;
- execution terminal `FAILED` → tick `PROVIDER_FAILED`;
- execution `UNCERTAIN` → tick `AMBIGUOUS_FAILURE`;
- policy/budget denials keep their existing tick outcomes;
- duplicate/consumed content keeps existing no-call behavior.

The 8D tick remains a scheduler summary. Provider receipt/retry/reconciliation truth belongs to the 8E journal.

## 13. OpenAI adapter changes

The current OpenAI Responses provider remains server-side/private and keeps `store: false` plus strict structured output.

Its call boundary becomes equivalent to:

```text
provider.execute(request, { clientRequestId })
```

It must:

- send `X-Client-Request-Id` explicitly;
- capture HTTP `x-request-id` when present;
- capture JSON response `id` separately;
- never log API keys or Authorization headers;
- keep raw response/output text only in process memory long enough to validate/canonicalize it;
- return only the bounded data required for canonicalization/final persistence;
- expose enough transport metadata for the 8E disposition classifier to distinguish safe terminal, safe retryable, and ambiguous outcomes.

The adapter does not decide whether a failed request may be replayed. Retry authority belongs to the durable 8E orchestration.

## 14. Runtime topology

Sprint 8E remains inside the dedicated AI automation runtime introduced by 8D.

```text
Core API / core worker
  └─ no provider execution credentials or recovery authority

Dedicated AI automation runtime
  ├─ scheduler desired-state reconciliation
  ├─ startup stale-execution recovery
  ├─ AI discovery BullMQ worker
  ├─ 8D scheduled input/tick authority
  ├─ 8C policy/budget authority
  ├─ 8E provider execution journal/lease/recovery
  └─ 8B single-attempt provider adapter/canonicalization
```

Provider configuration failure must not prevent the public API/core worker from starting.

The scheduler remains disabled by default. Disabled mode still does not require an OpenAI credential and must be capable of safe scheduler reconciliation/status/recovery behavior that does not contact the provider.

## 15. Read-only observability

Extend the existing private AI operations snapshot with a bounded `providerExecution` section containing at least:

- `prepared`
- `inFlight`
- `completed`
- `failed`
- `uncertain`
- `stalePrepared`
- `staleInFlight`
- `attemptsToday`
- `safeRetriesToday`
- `uncertainExecutions`
- `unreconciledUncertain`
- `lastExecutionAt`

`unreconciledUncertain > 0` is a release/operations warning signal. It does not automatically disable Publication or other independent services, but production activation procedures must surface it prominently.

The default snapshot does not expose client/provider request IDs or provider response IDs; those are available through the private execution-status CLI when troubleshooting is necessary.

No raw prompt, observation, model output, API key, Authorization header, database URL, or provider body is exposed by the snapshot.

## 16. Database invariants

The `0017` migration must enforce authority at the database layer, not only TypeScript.

At minimum:

1. one execution per `aiDiscoveryRunId` and one execution per `runKey`;
2. one budget reservation per execution and one execution per referenced budget reservation;
3. immutable execution identity: run identity, provider/model/prompt revision, input hash, budget reservation, created timestamp;
4. `(execution_id, ordinal)` and `client_request_id` unique;
5. at most one active attempt per execution;
6. attempts limited to ordinals 1..3;
7. provider dispatch requires a valid lease and durable `IN_FLIGHT` state;
8. attempt/execution cannot move `IN_FLIGHT → PREPARED` except the approved safe-retry transaction that terminally records the prior `429` attempt and creates the next attempt;
9. stale `IN_FLIGHT` can only converge to `UNCERTAIN`, never to a dispatchable state;
10. `UNCERTAIN → PREPARED` requires an append-only `CONFIRMED_NOT_RECEIVED` reconciliation for the current uncertain attempt and creation of the next attempt in the same transaction;
11. `COMPLETED` requires a matching durable completed `ai_discovery_run` whose run/provider/model/prompt/input/output identity agrees with the execution/current attempt;
12. terminal `FAILED` requires a matching durable failed `ai_discovery_run`;
13. `COMPLETED`/`FAILED` executions and terminal attempts are immutable;
14. execution/attempt/reconciliation rows cannot be deleted;
15. reconciliation rows cannot be updated;
16. reconciled `CONFIRMED_RECEIVED`/`ABANDONED` uncertainty cannot be reopened;
17. lease field consistency and expiry ordering are checked;
18. hashes/identifiers use bounded canonical formats.

Triggers/checks may be split for clarity, but no application-only escape hatch may bypass these transitions.

## 17. Security and data minimization

Provider execution journal/history may store:

- internal UUIDs;
- run key/idempotency key;
- provider/model/prompt revision identifiers;
- canonical input/output hashes;
- bounded failure codes;
- lease metadata;
- client request ID;
- provider request ID;
- provider response ID;
- operator reconciliation reason/evidence references;
- timestamps.

It must not store:

- `OPENAI_API_KEY`;
- Authorization headers;
- raw request messages/prompts;
- raw normalized/community observations;
- raw OpenAI response bodies/output text;
- AI rationale text outside existing proposal authority;
- publication content;
- browser/user credentials.

Repository/static authority contracts must ensure the 8E subsystem does not import/call Candidate materialization, Human Review mutation, Moderation mutation, Eligibility mutation, Evidence mutation, or Publication mutation.

## 18. Recovery/CLI failure behavior

All private mutation commands fail closed:

- invalid execution/attempt ID → no state change;
- identity mismatch → no state change;
- reconciliation of non-uncertain attempt → no state change;
- second reconciliation for the same attempt → conflict, no overwrite;
- `CONFIRMED_NOT_RECEIVED` at attempt 3 → decision may be recorded but no attempt 4 may be created and no provider call is authorized;
- database transaction failure → rollback;
- missing provider credentials do not prevent `status`, `recover`, or `reconcile` from operating because none of those commands contacts the provider.

Operational errors are sanitized and must not print secrets/raw provider payloads.

## 19. Testing strategy

Sprint 8E uses RED-first TDD. The first implementation commit after the approved implementation plan must contain failing 8E tests/contracts only, with failures attributable to missing 8E capabilities rather than syntax/fixture errors.

Required focused coverage includes:

### Migration/authority

- all three 0017 tables and indexes/constraints;
- immutable identity and terminal rows;
- no deletes; reconciliations append-only;
- one execution per run/run key/budget reservation;
- one active attempt; max ordinal 3;
- lease consistency;
- invalid state transitions rejected by PostgreSQL.

### Atomic preparation

- policy denial produces neither budget reservation nor journal;
- budget reservation + execution + attempt #1 commit atomically;
- injected transaction failure rolls all three back;
- scheduled path still enforces 3600-second floor;
- manual/private 8C path keeps policy semantics with floor 0;
- concurrent preparation converges to one execution/reservation.

### Lease/recovery

- only one worker claims a prepared execution;
- provider is never called before durable `IN_FLIGHT`;
- stale `PREPARED` clears lease/reclaims safely;
- stale `IN_FLIGHT` becomes `UNCERTAIN` and never provider-replays;
- recovery has zero provider calls and needs no API key;
- runtime startup recovery is provider-independent.

### Provider request identity

- deterministic unique per-attempt `X-Client-Request-Id`;
- exact request header is sent;
- HTTP `x-request-id` and JSON response `id` are captured separately;
- IDs are bounded/sanitized;
- no raw Authorization/prompt/output is persisted/logged.

### Retry classification

- `429` is the only automatic retry class;
- retry creates a durable next attempt rather than looping opaquely;
- at most three attempts;
- timeout/transport/408/5xx produce `UNCERTAIN` with zero automatic retry;
- auth/request rejection is terminal failed with zero retry;
- invalid/allow-list/provider response after HTTP success is terminal failed with zero retry;
- ambiguous DB persistence failure after provider response never triggers another provider call.

### Reconciliation

- `UNCERTAIN` cannot retry without reconciliation;
- `CONFIRMED_NOT_RECEIVED` is append-only and alone can create the next prepared attempt when ordinal < 3;
- reconcile command itself never calls the provider;
- `CONFIRMED_RECEIVED`/`ABANDONED` remain non-retryable terminal uncertainty;
- no force-retry path exists;
- second reconciliation conflicts rather than overwriting history.

### Atomic finalization/replay

- success writes AI run + proposals + attempt/execution completion atomically;
- final safe failure writes failed AI run + journal terminal state atomically;
- non-final 429 does not create a final failed AI run;
- uncertain outcome does not create a fake failed AI run;
- completed/failed replay returns durable result with zero provider calls;
- historical pre-8E durable runs replay without backfill;
- historical consumed budget without durable run never causes a new provider call;
- scheduled duplicate/consumed content still makes zero new provider calls.

### Observability/security

- snapshot counters match durable execution state;
- `unreconciledUncertain` is accurate;
- status/recovery/reconcile require no OpenAI API key;
- snapshot omits provider IDs by default and all secret/raw payload fields;
- core public API/core worker remain provider-execution free;
- 8E subsystem cannot materialize/review/moderate/publish.

### Regression

Run the dedicated Sprint 8E gate plus inherited Sprint 8A, 8B, 8C, 8D, 7A, 7B, 7C, frontend/backend regression, staging integration, release-candidate, and deploy-dry-run gates used by the repository. CI uses fake/stub providers only and must never make a real OpenAI request.

## 20. Definition of Done

Sprint 8E is complete only when all of the following are proven by code, database constraints, tests, and exact-head CI:

```text
1 logical aiDiscoveryRun
→ exactly 1 new-8E provider execution journal

1 execution
→ max 3 durable attempts

new provider authorization
→ budget reservation + PREPARED execution + attempt #1 are atomic

provider call
→ impossible before durable IN_FLIGHT under valid lease

expired PREPARED
→ safe reclaim

expired IN_FLIGHT
→ UNCERTAIN, never automatic replay

UNCERTAIN
→ cannot retry without append-only CONFIRMED_NOT_RECEIVED

429
→ only automatic retry class

client timeout / transport / 408 / 5xx / in-flight crash
→ UNCERTAIN

success
→ AI run + proposals + journal completion atomic

final known failure
→ failed AI run + journal failure atomic

provider response persistence failure
→ no provider replay; converge UNCERTAIN

OpenAI identities
→ client request ID, HTTP request ID, response body ID remain distinct

journal
→ no API key / Authorization / raw prompt / raw provider body

operator reconciliation
→ private, append-only, no provider call

AI authority
→ no automatic Candidate materialization
→ no automatic Human Review
→ no Evidence mutation
→ no Publication mutation
```

Before completion, self-review must inspect the full diff for accidental provider-call escape hatches, retry loops outside 8E, secret/raw-payload persistence, and downstream authority imports.

A draft PR is created only after focused and inherited exact-head verification is green. Merge remains a separate explicit user authorization.

## 21. Explicit non-goals

Sprint 8E does not include:

- production deployment;
- production OpenAI credentials;
- production scheduler activation;
- a second recovery scheduler/cron;
- OpenAI background mode;
- provider-side exactly-once/idempotency assumptions;
- retrieval of lost provider responses from OpenAI;
- automatic retries for timeout/transport/408/5xx;
- force-retry of uncertain attempts;
- new scrapers/collectors;
- model/evaluation subsystem;
- automatic Candidate materialization;
- automatic Human Review/Moderation/Eligibility decisions;
- Evidence generation/approval;
- automatic Publication.

`AI_DISCOVERY_SCHEDULER_ENABLED=false` remains the default after Sprint 8E.

## 22. Rollout and rollback

Sprint 8E rollout is code/schema-only and disabled from production execution by existing scheduler/provider configuration gates.

If later runtime activation exposes an operational defect, disabling the AI discovery scheduler/provider runtime must stop new scheduled provider calls without deleting execution history. Existing `PREPARED`, `IN_FLIGHT`, `UNCERTAIN`, completed, failed, attempt, and reconciliation history remains durable for operator inspection.

Rollback must never delete or rewrite execution/attempt/reconciliation history merely to make the system retryable. A migration rollback that would destroy 8E audit history is not an operational recovery procedure.
