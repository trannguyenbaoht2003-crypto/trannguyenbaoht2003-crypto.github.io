# AI Provider Execution Recovery Runbook — Sprint 8E

Sprint 8E makes external AI-provider execution recoverable without granting AI any downstream content authority. PostgreSQL is the authority for budget authorization, provider execution/attempt state, leases, reconciliation decisions, and final AI discovery runs/proposals. Redis/BullMQ remains delivery infrastructure only.

## Safety boundary

- `AI_DISCOVERY_SCHEDULER_ENABLED=false` remains the default.
- Sprint 8E did not itself authorize production activation. Sprint 8F may deploy the 8E-capable runtime to production in disabled mode as inert infrastructure, while activation remains separately authorized.
- No production OpenAI credential is required for Sprint 8F inert delivery, CI, status, recovery, or reconciliation.
- AI remains advisory. This path does not automatically materialize Candidate data, complete Human Review, mutate Moderation/Eligibility, create Evidence, or create/activate Publication.
- Never delete or rewrite execution, attempt, or reconciliation history to make a run retryable.

## Durable states

One logical `aiDiscoveryRunId` has one `ai_provider_executions` row and at most three `ai_provider_execution_attempts` rows.

Execution and attempt states are:

- `PREPARED`: budget/journal exists; provider has not yet been authorized for this attempt.
- `IN_FLIGHT`: a valid 120-second PostgreSQL lease exists and `dispatch_started_at` was durably committed before the provider call.
- `COMPLETED`: a valid provider response and the final AI discovery run/proposals were committed atomically with terminal journal state.
- `FAILED`: a known safe terminal failure, or attempt 3 received rate limiting; final failed AI discovery run and terminal journal state were committed atomically.
- `UNCERTAIN`: the provider might have received the request but the system cannot safely prove the final outcome. Automatic replay stops.

A provider call is forbidden before both the execution and current attempt are durably `IN_FLIGHT` under a valid lease.

## Retry rule

Automatic retry is permitted for **only HTTP 429** / `PROVIDER_RATE_LIMITED`, because that response proves the request reached a known rate-limit outcome. The next attempt is created as a durable `PREPARED` row before any retry delay or subsequent provider call. Delays remain bounded at 500 ms and 1500 ms. There is no attempt 4.

Timeouts, transport ambiguity, HTTP 408, HTTP 5xx/gateway errors, process crashes while `IN_FLIGHT`, and post-provider persistence ambiguity become `UNCERTAIN`. They have no automatic replay.

## Request tracing

Three identifiers are deliberately separate and are not provider idempotency guarantees:

1. `X-Client-Request-Id`: deterministic UUIDv5 generated locally from execution ID + attempt ordinal.
2. HTTP `x-request-id`: bounded provider/server request metadata when present.
3. Responses JSON `id`: the provider response-object identifier when a valid body is received.

The journal may store these bounded identifiers. It must not persist API keys, Authorization headers, raw prompt/messages, raw observation payloads, raw model output text, or full HTTP bodies.

## Stale recovery

Recovery is DB-only and requires no provider credentials.

```bash
npm --prefix backend run ai-provider-execution -- recover
npm --prefix backend run ai-provider-execution -- recover --limit 50
```

Recovery uses the PostgreSQL clock and a bounded batch:

- expired `PREPARED` lease: clear the stale lease and leave the attempt `PREPARED` so a normal execution path may claim it later;
- expired `IN_FLIGHT`: mark the current attempt and execution `UNCERTAIN`, clear the lease, and stop;
- valid leases, terminal rows, and reconciled history are not replayed by recovery.

The AI automation runtime performs a DB-only recovery sweep before scheduler reconciliation. An enabled scheduled job also sweeps before scheduled processing. A scheduler-disabled stale job returns `SCHEDULER_DISABLED` before recovery/provider work.

During Sprint 8F inert production startup, the same DB-only recovery sweep runs before scheduler reconciliation and before the disabled-ready marker. Existing execution and reconciliation history remains immutable; no `UNCERTAIN` execution is replayed merely because code was deployed or rolled back.

## Inspecting status

Status is DB-only and safe for private operator use:

```bash
npm --prefix backend run ai-provider-execution -- status --execution-id <uuid>
npm --prefix backend run ai-provider-execution -- status --run-id <uuid>
```

The status reader may return execution/attempt/reconciliation IDs, states, timestamps, failure code, `clientRequestId`, `providerRequestId`, and `providerResponseId`. It does not return raw prompts, raw output, provider bodies, Authorization headers, or credentials.

The aggregate AI operations snapshot additionally exposes only counts/timestamps: `prepared`, `inFlight`, `completed`, `failed`, `uncertain`, `stalePrepared`, `staleInFlight`, `attemptsToday`, `safeRetriesToday`, `uncertainExecutions`, `unreconciledUncertain`, and `lastExecutionAt`.

`unreconciledUncertain > 0` is an operational warning before any later production-activation decision. It is not an inert-deployment blocker while the scheduler remains disabled and no provider configuration is provisioned.

## Reconciliation authority

An uncertain attempt can receive exactly one append-only operator reconciliation:

- `CONFIRMED_NOT_RECEIVED`: authoritative evidence says the provider did not receive the request. If ordinal < 3, one new durable `PREPARED` attempt may be created atomically. At ordinal 3, the decision is recorded but no attempt 4 exists.
- `CONFIRMED_RECEIVED`: the provider received the request. No further provider spend is authorized.
- `ABANDONED`: the operator intentionally closes the uncertainty without another provider call.

Examples:

```bash
npm --prefix backend run ai-provider-execution -- reconcile \
  --attempt <uuid> \
  --decision CONFIRMED_NOT_RECEIVED \
  --reason-code provider-confirmed-miss \
  --evidence-reference support-case-123

npm --prefix backend run ai-provider-execution -- reconcile \
  --attempt <uuid> \
  --decision CONFIRMED_RECEIVED \
  --reason-code provider-confirmed-received \
  --evidence-reference support-case-124

npm --prefix backend run ai-provider-execution -- reconcile \
  --attempt <uuid> \
  --decision ABANDONED \
  --reason-code operator-abandoned \
  --evidence-reference incident-125
```

There is no force-retry command. `CONFIRMED_RECEIVED` and `ABANDONED` never authorize new spend.

## Scheduled execution compatibility

Sprint 8D's scheduled provider path continues to use the same atomic Sprint 8C budget authority with a minimum interval floor of exactly 3600 seconds. Manual/private governed execution uses floor 0. Durable AI-run replay is checked before a new budget/journal is prepared.

A historical pre-8E budget reservation without a durable AI discovery run is treated as consumed and fail-closed; Sprint 8E does not synthesize a fresh external attempt under that historical authorization.

## Rollback

Code rollback must not delete journal/history. The safe rollback posture is:

1. keep `AI_DISCOVERY_SCHEDULER_ENABLED=false`;
2. stop or redeploy the dedicated AI automation runtime only through the separately authorized production delivery path;
3. revert application code to the previously approved release while preserving migration/history unless a separately reviewed database rollback procedure explicitly proves safety;
4. do not replay `IN_FLIGHT` or `UNCERTAIN` rows during rollback;
5. inspect unresolved state with the DB-only status/recovery commands before any later reactivation.

Sprint 8F may deploy or roll back the runtime in disabled mode. That operational action does not authorize a scheduler, provider credential, or provider call, and it does not rewrite or automatically replay historical execution/reconciliation state.

## Review and release gate

Sprint 8E recovery invariants remain binding when Sprint 8F packages the runtime for inert production delivery. The dedicated 8F repository workflow and inherited 8D/8C/8B/8A gates must be green on the exact PR head. The PR remains draft and must not be merged, actually deployed to Railway, provisioned with production credentials, or used to enable the scheduler without separate explicit authorization.
