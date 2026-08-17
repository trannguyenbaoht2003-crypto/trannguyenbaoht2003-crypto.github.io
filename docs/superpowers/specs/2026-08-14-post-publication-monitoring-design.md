# Sprint 7A — Post-Publication Monitoring Design

**Status:** Approved design, implementation not started  
**Date:** 2026-08-14  
**Base:** `main@bac0e7586c22cae5ecffb16130f082379d79fdcd`  
**Branch:** `feat/7a-post-publication-monitoring`

## 1. Purpose

Sprint 7A adds deterministic post-publication monitoring for active Publications. The system must detect when the trust state behind the CandidateRevision pinned by the currently active PublicationVersion changes after publication and surface that condition as an internal MonitoringAlert.

The feature is advisory only. It must never automatically publish, roll back, retract, hide, or otherwise mutate public content.

The design preserves the existing authority boundary:

`PostgreSQL authority -> transactional outbox -> BullMQ delivery -> monitoring worker -> PostgreSQL monitoring authority`

Redis/BullMQ transports identities and wake-up signals only. Every monitoring decision is recomputed from PostgreSQL authority.

## 2. Goals

Sprint 7A must:

1. Monitor only Publications that are currently active.
2. Re-evaluate monitoring state after the pinned CandidateRevision receives a new canonical Eligibility evaluation.
3. Re-evaluate monitoring state after Publication activation changes through publish or rollback.
4. Open a warning when the active Publication cannot currently be revalidated.
5. Open a warning when the active pinned revision is currently `needs_review`.
6. Open a critical alert when the active pinned revision is currently `ineligible`.
7. Resolve obsolete alerts when the active pinned revision returns to `eligible` or the active PublicationVersion changes.
8. Persist every applicable monitoring evaluation and every alert transition in PostgreSQL.
9. Emit audit records and outbox events for alert open/resolve transitions.
10. Make processing replay-safe, lost-ack safe, concurrency-safe, and independent of untrusted queue payload fields.
11. Keep public Publication reads independent of Redis, workers, and monitoring state.
12. Provide an internal PostgreSQL-backed read boundary for current open alerts without adding a public HTTP mutation surface.

## 3. Non-goals

Sprint 7A does **not** include:

- public feedback intake;
- public or browser-authenticated write endpoints;
- a publisher mutation UI;
- automatic rollback, retraction, hiding, or republishing;
- automatic publication of a newer CandidateRevision;
- alerts merely because a newer CandidateRevision exists;
- AI-generated monitoring decisions;
- changing Evidence, HumanReview, Moderation, Eligibility, Catalog, or Publication policy semantics;
- source crawling changes;
- notification integrations such as email, Discord, Slack, or web push;
- production Railway provisioning or release;
- observability dashboards, SLOs, or incident automation.

A later sprint may add freshness/update-opportunity monitoring and user feedback, but neither is required for 7A correctness.

## 4. Existing authority reused by 7A

The current backend already provides the required trust graph and lifecycle primitives:

- `publication_versions` pins the exact CandidateRevision, Eligibility evaluation/input hash, Moderation decision/input hash, policy revisions, and public payload used when published;
- `active_publication_versions` is the current public activation pointer;
- `candidate_eligibility_evaluations` and `current_candidate_eligibility_evaluations` hold deterministic Eligibility history/current pointers;
- `readCandidateEligibilityStatus()` already defines the fail-closed currentness semantics: missing authority or input-hash drift is stale and returns `needs_review` rather than being treated as eligible;
- `evaluateCandidateEligibility()` emits `CandidateEligibilityEvaluated` after a canonical Eligibility computation;
- trust-changing events such as Candidate provenance, Claim Evidence, HumanReview, and Moderation already route through the Eligibility worker first;
- Publication publish/rollback already use immutable PublicationVersions and append-only activation history;
- the transactional outbox and BullMQ worker model already reload PostgreSQL authority instead of trusting Redis payloads.

`CandidateEligibilityEvaluated` is therefore the preferred trust-drift trigger. 7A must **not** independently subscribe to every upstream Evidence/Review/Moderation event, because doing so would duplicate work and can observe intermediate states before canonical Eligibility has settled.

The implementation should reuse the same currentness semantics as `readCandidateEligibilityStatus()`. If monitoring requires a caller-owned transaction/row locks, factor the shared currentness logic into a `PoolClient`-compatible internal helper rather than creating a nested transaction or duplicating the rules.

## 5. Monitoring trigger model

### 5.1 Trust trigger

Add `CandidateEligibilityEvaluated` to the outbox routing set for the new monitoring queue.

The monitoring worker receives the outbox identity, reloads the source `outbox_events` row, validates its event type and aggregate relationship, and then reloads the current Publication/Eligibility authority from PostgreSQL.

The queue payload is not authoritative. In particular, the worker must not trust a queued `outcome`, `reason`, Candidate ID, CandidateRevision ID, Publication ID, or policy identifier without reloading and validating it against PostgreSQL.

If the evaluated CandidateRevision is not the revision pinned by the Publication's **currently active** PublicationVersion at processing time, the trigger is stale or not applicable and produces no alert transition.

### 5.2 Publication lifecycle trigger

Publish and rollback must each create an additional outbox event inside their existing PostgreSQL transaction:

`PublicationMonitoringRequested`

This event is separate from `PublicationPublished` / `PublicationRolledBack` so the current publication projection queue does not need multi-destination delivery semantics.

Lifecycle monitoring is required because a rollback can activate a historical PublicationVersion whose pinned revision does not currently have a fresh Eligibility evaluation under current authority.

### 5.3 Persisted event contracts

`CandidateEligibilityEvaluated` keeps its existing persisted contract and aggregate relationship. Monitoring validates it from `outbox_events` and the referenced Candidate/CandidateRevision rows.

`PublicationMonitoringRequested` uses:

- `aggregate_type = 'publication'`
- `aggregate_id = publication_id`
- payload schema exactly:
  - `schemaVersion: 1`
  - `publicationId`
  - `activationId`
  - `requestedReason: 'published' | 'rolled_back'`

The worker validates that `activationId` belongs to the persisted Publication but still reloads `active_publication_versions` at processing time. A delayed request therefore cannot claim that an old activation is still current.

`PublicationMonitoringAlertOpened` and `PublicationMonitoringAlertResolved` use:

- `aggregate_type = 'publication_monitoring_alert'`
- `aggregate_id = publication_monitoring_alert_event_id`
- payload schema exactly:
  - `schemaVersion: 1`
  - `publicationMonitoringAlertEventId`
  - `publicationId`
  - `alertCode`
  - `state: 'open' | 'resolved'`

Output consumers reload and validate every field from PostgreSQL authority.

## 6. Queue and event topology

Add:

`MONITORING_QUEUE_NAME = 'hai-dau-monitoring-v1'`

The outbox dispatcher routes these events to the monitoring queue:

### Evaluation inputs

- `CandidateEligibilityEvaluated`
- `PublicationMonitoringRequested`

### Alert transition outputs

- `PublicationMonitoringAlertOpened`
- `PublicationMonitoringAlertResolved`

The same monitoring worker handles both groups, but with separate code paths.

Input events may evaluate monitoring state and cause an alert transition. Alert transition output events are terminal delivery events: they validate the corresponding PostgreSQL alert event and record a replay-safe delivery effect only. They **must not** emit another monitoring outbox event, preventing recursion.

This terminal output path keeps alert transitions fully represented in the transactional outbox while leaving a stable integration point for future notification delivery.

## 7. Deterministic monitoring states

The monitoring evaluator returns one of:

- `healthy`
- `warning`
- `critical`
- `not_applicable`

`not_applicable` is a processing result only; it is not persisted as a row in `publication_monitoring_evaluations`.

Only the following alert codes exist in Sprint 7A.

### 7.1 `ACTIVE_PUBLICATION_REVALIDATION_REQUIRED`

Severity: `warning`

Open when a Publication lifecycle trigger finds an active PublicationVersion but cannot prove that the pinned CandidateRevision has a **current** Eligibility evaluation under current authority.

This is fail-closed monitoring. It does not mean the content is automatically invalid; it means current trust cannot be established from canonical authority.

### 7.2 `ACTIVE_PUBLICATION_NEEDS_REVIEW`

Severity: `warning`

Open when the current canonical Eligibility outcome for the CandidateRevision pinned by the active PublicationVersion is `needs_review`.

### 7.3 `ACTIVE_PUBLICATION_INELIGIBLE`

Severity: `critical`

Open when the current canonical Eligibility outcome for the CandidateRevision pinned by the active PublicationVersion is `ineligible`.

### 7.4 Healthy state

If the current canonical Eligibility outcome for the active pinned revision is `eligible`, all open Sprint 7A alerts for that Publication are resolved.

### 7.5 State precedence

When authority is available, canonical Eligibility wins:

`ineligible > needs_review > eligible`

`ACTIVE_PUBLICATION_REVALIDATION_REQUIRED` is used only when current canonical Eligibility cannot be established for a lifecycle evaluation.

A transition from warning to critical resolves the warning and opens the critical alert in the same transaction. A transition back to healthy resolves every open 7A alert for the Publication in the same transaction.

If the active PublicationVersion changes, every open alert whose current pointer still references the previous active PublicationVersion is first resolved. The desired state for the newly active version is then applied. This resolve-then-open rule applies even when the old and new active versions produce the same alert code, so a current alert can never point at an obsolete PublicationVersion.

## 8. PostgreSQL data model

Add one forward-only migration. Existing migrations remain immutable.

### 8.1 `publication_monitoring_evaluations`

Append-only record of every applicable active-Publication monitoring evaluation.

Required fields:

- `publication_monitoring_evaluation_id uuid primary key`
- `trigger_outbox_event_id uuid not null unique`
- `publication_id uuid not null`
- `publication_version_id uuid not null`
- `candidate_id uuid not null`
- `candidate_revision_id uuid not null`
- `candidate_eligibility_evaluation_id uuid null`
- `eligibility_policy_revision_id uuid null`
- `eligibility_input_hash text null`
- `monitoring_version text not null` fixed to `post-publication-monitor-v1`
- `outcome text not null` in `healthy | warning | critical`
- `reason_code text null`
- `evaluated_at timestamptz not null`
- `created_at timestamptz not null default clock_timestamp()`

The row pins the exact active PublicationVersion and current Eligibility authority observed by the monitoring transaction. When canonical Eligibility cannot be established, the nullable Eligibility fields remain null and the row records the revalidation-warning evaluation.

No `publication_monitoring_evaluations` row is created for a stale/non-applicable trigger with no matching active PublicationVersion; that result is stored only in `publication_monitoring_effects`.

Rows are immutable after insert.

### 8.2 `publication_monitoring_alert_events`

Append-only alert lifecycle history.

Required fields:

- `publication_monitoring_alert_event_id uuid primary key`
- `publication_id uuid not null`
- `publication_version_id uuid not null`
- `publication_monitoring_evaluation_id uuid not null`
- `alert_code text not null`
- `severity text not null` in `warning | critical`
- `state text not null` in `open | resolved`
- `audit_event_id uuid not null unique`
- `outbox_event_id uuid not null unique`
- `correlation_id text not null`
- `actor_id text not null`
- `created_at timestamptz not null default clock_timestamp()`

Allowed alert codes are exactly the three codes defined in Section 7.

A resolved event copies the severity of the alert state being resolved. Rows are immutable after insert.

### 8.3 `current_publication_monitoring_alerts`

Mutable current pointer table, not historical authority.

Primary key:

`(publication_id, alert_code)`

Required fields:

- `publication_id`
- `alert_code`
- `publication_monitoring_alert_event_id`
- `state`
- `severity`
- `publication_version_id`
- `updated_at`

The pointer must refer to an alert event owned by the same Publication and alert code.

Only `state='open'` rows are returned by the current-open-alert reader. Resolved pointer rows remain available so replay/current-state checks do not need to infer state from history.

### 8.4 `publication_monitoring_effects`

Replay/deduplication record keyed by source input outbox event.

Required fields:

- `trigger_outbox_event_id uuid primary key`
- `publication_id uuid null`
- `publication_version_id uuid null`
- `publication_monitoring_evaluation_id uuid null`
- `effect_outcome text not null` in `evaluated | not_applicable`
- `created_at timestamptz not null default clock_timestamp()`

A source outbox event may produce monitoring state at most once. On duplicate delivery, the existing effect is read and the worker returns `duplicate_noop`; no second effect row is inserted or mutated.

### 8.5 `publication_monitoring_delivery_effects`

Terminal replay-safe effect for `PublicationMonitoringAlertOpened` and `PublicationMonitoringAlertResolved` outbox delivery.

Required fields:

- `outbox_event_id uuid primary key`
- `publication_monitoring_alert_event_id uuid not null unique`
- `publication_id uuid not null`
- `event_type text not null` in `PublicationMonitoringAlertOpened | PublicationMonitoringAlertResolved`
- `created_at timestamptz not null default clock_timestamp()`

This table does not own alert state and never mutates Publication authority.

### 8.6 Relational and immutability constraints

The migration must add foreign keys/composite keys sufficient to prove:

- evaluation PublicationVersion belongs to the recorded Publication/Candidate/CandidateRevision;
- current alert pointer references an alert event with the same Publication and alert code;
- alert event references an evaluation for the same Publication and PublicationVersion;
- delivery effect references the exact alert event represented by the persisted outbox event.

Append-only monitoring evaluations and alert events must reject direct UPDATE/DELETE using the same database-hardening pattern already used for trust/publication history where practical.

## 9. Monitoring evaluation transaction

For each input trigger, the worker performs one PostgreSQL transaction.

### 9.1 Validate source

1. Validate `job.id` exists.
2. Require `job.data.outboxEventId === job.id`.
3. Reload `outbox_events` by ID.
4. Require the persisted event type to equal the BullMQ job name.
5. Validate the exact persisted aggregate/payload contract in Section 5.3 and its database relationships.
6. Ignore all untrusted queue payload fields after identity validation.

### 9.2 Replay check

Check `publication_monitoring_effects` by `trigger_outbox_event_id` inside the transaction.

If an effect already exists, return `duplicate_noop` without creating a monitoring evaluation, alert, audit, or output outbox side effect.

### 9.3 Load current authority

For `CandidateEligibilityEvaluated`:

1. Resolve the persisted Candidate ID and CandidateRevision ID from PostgreSQL.
2. Resolve the Publication belonging to that Candidate, if any.
3. Lock the Publication and current active pointer using the established Publication lock order.
4. Require the active PublicationVersion to pin the same CandidateRevision as the source Eligibility evaluation.
5. Reload the **current** Eligibility status/currentness for that revision from PostgreSQL using the same semantics as `readCandidateEligibilityStatus()`.

If there is no Publication, no active version, or the active version pins another CandidateRevision, record `not_applicable` and stop.

For `PublicationMonitoringRequested`:

1. Resolve and validate the Publication/activation from persisted outbox authority.
2. Lock the Publication and current active pointer using the established Publication lock order.
3. Load the current active PublicationVersion, regardless of whether it is the historical activation named by the delayed request.
4. Load the current Eligibility status/currentness for the active version's pinned CandidateRevision.

If no active PublicationVersion exists, record `not_applicable`; monitoring does not repair Publication authority.

### 9.4 Compute desired alert state

The computation is a pure function over the loaded authority:

- missing/non-current canonical Eligibility on lifecycle evaluation -> revalidation warning;
- current `needs_review` -> needs-review warning;
- current `ineligible` -> ineligible critical;
- current `eligible` -> healthy;
- stale/non-active source trigger -> not applicable.

For `CandidateEligibilityEvaluated`, the source must correspond to the active pinned revision. If the currentness read is unexpectedly stale by processing time because another trust change has already occurred, monitoring must treat that state fail-closed and open/maintain `ACTIVE_PUBLICATION_REVALIDATION_REQUIRED` rather than trusting the older event's stored outcome.

No external calls and no AI inference are permitted.

### 9.5 Persist transitions atomically

Inside the same transaction:

1. Insert the monitoring evaluation when applicable.
2. Lock current alert pointers for the Publication.
3. Resolve any open alerts that reference a PublicationVersion that is no longer active.
4. Determine the minimal desired transition set for the current active version.
5. For each actual state transition only:
   - insert immutable alert event;
   - insert audit event;
   - insert `PublicationMonitoringAlertOpened` or `PublicationMonitoringAlertResolved` outbox event using Section 5.3;
   - update the current alert pointer.
6. Insert the source `publication_monitoring_effects` row.
7. Commit.

If desired alert state is already current **and references the same active PublicationVersion**, no new alert/audit/output-outbox event is created.

## 10. Alert output delivery transaction

For `PublicationMonitoringAlertOpened` / `PublicationMonitoringAlertResolved` jobs:

1. Validate job/outbox identity.
2. Reload the persisted outbox event.
3. Validate the exact aggregate/payload contract in Section 5.3.
4. Resolve the referenced `publication_monitoring_alert_events` row from PostgreSQL.
5. Require event type, Publication ID, alert event ID, alert code, and state to agree with PostgreSQL authority.
6. Insert `publication_monitoring_delivery_effects` if absent.
7. Return `delivered` or `duplicate_noop`.

This path emits no audit event and no additional outbox event.

## 11. Audit contract

Only actual alert state transitions create audit records.

Actions:

- `monitoring.publication_alert_opened`
- `monitoring.publication_alert_resolved`

Audit payload must contain bounded identifiers and reason codes only. It must not contain raw source article bodies, transcripts, comments, credentials, connection strings, or arbitrary collector payloads.

Actor for worker-driven monitoring transitions is exactly:

`post-publication-monitor-v1`

Correlation ID is inherited from the validated source outbox event.

## 12. Internal read boundary

Add a narrow PostgreSQL-backed module such as:

`readOpenPublicationMonitoringAlerts(pool)`

It returns only current open alert state joined to the immutable latest alert event/evaluation required for an operator to understand:

- Publication ID;
- active PublicationVersion ID;
- CandidateRevision ID;
- alert code;
- severity;
- monitoring evaluation timestamp;
- current Eligibility outcome/reason where available.

The reader must verify that an open pointer still references the currently active PublicationVersion; inconsistent pointer/activation state fails closed rather than returning a misleading alert.

Ordering is deterministic: critical before warning, then oldest open transition, then Publication ID.

Sprint 7A does not register a new public HTTP route. A future authenticated operator surface may depend on this read boundary without changing monitoring authority.

## 13. Concurrency and stale-event rules

Monitoring must be correct under delayed and concurrent delivery.

### 13.1 Delayed Eligibility event

If a delayed `CandidateEligibilityEvaluated` event arrives after a different PublicationVersion became active, the worker evaluates the current active pointer. If the source revision is no longer active, it records `not_applicable` and cannot reopen an obsolete alert.

### 13.2 Delayed lifecycle event

If a delayed `PublicationMonitoringRequested` references an older activation, the worker validates that the named activation existed but evaluates the **current** active PublicationVersion. This makes lifecycle monitoring self-healing under queue delay.

### 13.3 Eligibility versus rollback/publish

Monitoring transactions lock the Publication/current activation authority before deciding alert state. Publication activation and monitoring must use a consistent lock order to avoid deadlocks.

The implementation plan must inspect the existing publish/rollback lock order and match it rather than inventing a second order.

### 13.4 Duplicate/lost-ack delivery

`publication_monitoring_effects.trigger_outbox_event_id` and `publication_monitoring_delivery_effects.outbox_event_id` are unique replay boundaries. A duplicate BullMQ delivery cannot duplicate alert, audit, or downstream outbox side effects.

### 13.5 Multiple trust changes

Each canonical `CandidateEligibilityEvaluated` event can trigger a monitoring evaluation, but alert lifecycle history changes only when the desired current state or active PublicationVersion changes.

## 14. Failure behavior

Fail closed for monitoring, fail open for public reads.

- PostgreSQL unavailable: monitoring job fails retryably; no partial alert state is committed.
- Redis/BullMQ unavailable: monitoring is delayed; outbox remains authoritative/pending. Public Publication reads remain available from PostgreSQL.
- malformed/tampered queue envelope: fail with a stable non-secret error code.
- invalid persisted outbox relationship: fail without trusting payload.
- no active matching Publication: `not_applicable`, not an error.
- active Publication but current Eligibility cannot be established: open/maintain `ACTIVE_PUBLICATION_REVALIDATION_REQUIRED` for the current active version.
- output alert event replay: `duplicate_noop`.

No error path may automatically mutate `active_publication_versions`.

## 15. Security and authority invariants

Sprint 7A is unacceptable if any of these invariants are violated:

1. Monitoring cannot call publish or rollback commands.
2. Monitoring cannot write `publications`, `publication_versions`, `publication_activation_history`, or `active_publication_versions`.
3. Monitoring cannot make a Candidate eligible/ineligible; it only reads Eligibility authority.
4. Queue payloads cannot override PostgreSQL identities, outcomes, reasons, or current pointers.
5. AI output is not monitoring authority.
6. Raw community content is not persisted into monitoring/audit records.
7. No new browser credential, CORS expansion, or public mutation route is added.
8. Redis/workers are not required for public Publication reads.
9. Alert state never changes public content automatically.
10. Only existing publisher-authorized Publication commands may change active public content.
11. Monitoring does not treat a newer CandidateRevision as evidence that the active Publication is wrong or stale.

## 16. Worker composition

The private backend worker adds one BullMQ consumer for `hai-dau-monitoring-v1` and one producer Queue in the existing routed outbox dispatcher set.

Connection policy remains consistent with Sprint 6B:

- worker consumer Redis connection uses worker-compatible retry settings;
- producer Queue connection uses finite retry;
- shutdown aborts the outbox dispatch loop, waits for it, closes workers, closes Queues, then Redis/PostgreSQL resources in the established order.

No additional public Railway service is introduced. Sprint 7A runs inside the existing private worker process.

## 17. Historical outbox/backlog behavior

`CandidateEligibilityEvaluated` already exists as a persisted outbox event type but was not previously routed by the dispatcher. When 7A first enables routing, older pending events may become eligible for dispatch.

This is intentionally safe:

- existing dispatcher batch/lease limits remain in force;
- each historical event is validated against current PostgreSQL authority;
- events for non-active CandidateRevisions become `not_applicable`;
- multiple historical events for the active revision may create evaluations, but alert transitions occur only when current desired state changes;
- no historical event can reactivate an obsolete PublicationVersion or mutate public content.

The implementation must test a small synthetic historical backlog and must not add a destructive migration that deletes old outbox rows merely to avoid processing them.

## 18. Test and verification requirements

Implementation must follow RED -> GREEN TDD and add service-backed PostgreSQL 17 / Redis 7 tests.

Minimum scenarios:

1. Active eligible Publication + same pinned revision reevaluates `needs_review` -> exactly one warning opens.
2. Duplicate source delivery -> no duplicate monitoring evaluation side effects, alert, audit, or output outbox transition.
3. Warning -> `ineligible` -> warning resolves and critical opens atomically.
4. Critical -> `eligible` -> critical resolves and no 7A alert remains open.
5. Lifecycle request with missing/non-current Eligibility -> revalidation warning opens.
6. Later current eligible evaluation -> revalidation warning resolves.
7. Delayed Eligibility event for a revision no longer active -> `not_applicable`; no obsolete alert opens.
8. Active PublicationVersion changes while the same alert code remains desired -> old-version alert resolves and a new-version alert opens atomically.
9. Delayed lifecycle request evaluates the then-current activation, not the historical activation named in the request.
10. Tampered BullMQ payload with valid outbox ID -> PostgreSQL authority wins.
11. Job ID / outbox ID mismatch -> rejected.
12. Alert transition output event -> terminal delivery effect recorded exactly once.
13. Duplicate alert-output delivery -> `duplicate_noop`.
14. Redis outage does not affect direct PostgreSQL public Publication reads.
15. Monitoring worker failure cannot alter active Publication pointers.
16. Concurrent monitoring versus publish/rollback produces no deadlock and no alert for a stale active version after both transactions settle.
17. Currentness/hash drift after an older `CandidateEligibilityEvaluated` source event -> revalidation warning, never trust the older queued outcome.
18. Historical pending `CandidateEligibilityEvaluated` backlog -> bounded processing, stale events no-op, no public mutation.
19. No public `POST`, `PUT`, `PATCH`, or `DELETE` monitoring/Publications route is introduced.
20. Repository scan finds no production credentials, Railway provisioning, notification token, or browser write credential.
21. Existing frontend, backend, publication, eligibility, staging, and release-candidate regression gates remain green.

## 19. Acceptance criteria

Sprint 7A is repository-ready only when:

- the forward-only monitoring migration is verified;
- deterministic monitoring computation is covered by unit tests;
- PostgreSQL integration tests cover open/resolve/replay/stale/currentness/concurrency behavior;
- monitoring outbox routing and terminal alert delivery are verified with Redis 7;
- public read independence is re-proven with monitoring worker/Redis unavailable;
- historical pending Eligibility-event routing is proven safe;
- no Critical or Important review finding remains;
- exact-head CI is green;
- documentation/runbook explains operator meaning of every alert code and explicitly states that alerts never change public content.

Repository completion marker:

`SPRINT_7A_REPO_READY`

This marker does not imply Railway production deployment and does not change the still-separate production delivery gate tracked outside Sprint 7A.

## 20. Follow-on boundary

The recommended next step after Sprint 7A is a separate design cycle for one of:

- **Sprint 7B — Feedback Intake:** abuse-resistant user feedback ingestion and internal review, without treating feedback as Evidence; or
- **Sprint 7C — Monitoring Operator Surface:** authenticated internal alert visibility/actions if the project chooses to establish operator identity/RBAC first.

Neither is part of this specification.
