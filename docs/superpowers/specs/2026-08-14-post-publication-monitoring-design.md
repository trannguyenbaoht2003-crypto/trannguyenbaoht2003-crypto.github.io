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
8. Persist every monitoring evaluation and alert transition in PostgreSQL.
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
- `evaluateCandidateEligibility()` emits `CandidateEligibilityEvaluated` after a canonical Eligibility computation;
- trust-changing events such as Candidate provenance, Claim Evidence, HumanReview, and Moderation already route through the Eligibility worker first;
- Publication publish/rollback already use immutable PublicationVersions and append-only activation history;
- the transactional outbox and BullMQ worker model already reload PostgreSQL authority instead of trusting Redis payloads.

`CandidateEligibilityEvaluated` is therefore the preferred trust-drift trigger. 7A must **not** independently subscribe to every upstream Evidence/Review/Moderation event, because doing so would duplicate work and can observe intermediate states before canonical Eligibility has settled.

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

The monitoring request contains only bounded identity/provenance fields. The worker reloads the current active pointer and does not trust the request payload as the active PublicationVersion.

Lifecycle monitoring is required because a rollback can activate a historical PublicationVersion whose pinned revision does not currently have a fresh Eligibility evaluation under current authority.

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

## 8. PostgreSQL data model

Add one forward-only migration. Existing migrations remain immutable.

### 8.1 `publication_monitoring_evaluations`

Append-only record of every applicable monitoring evaluation.

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
- `outcome text not null` in `healthy | warning | critical | not_applicable`
- `reason_code text null`
- `evaluated_at timestamptz not null`
- `created_at timestamptz not null default clock_timestamp()`

The row pins the exact active PublicationVersion and current Eligibility authority observed by the monitoring transaction.

`not_applicable` may be recorded in `publication_monitoring_effects` without creating a monitoring evaluation row when no active matching Publication exists. The implementation plan should choose one representation and keep it deterministic; the preferred representation is to reserve `publication_monitoring_evaluations` for active Publication evaluations only and use the effect table for no-ops.

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

Rows are immutable after insert.

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

Replay/deduplication record keyed by source outbox event.

Required fields:

- `trigger_outbox_event_id uuid primary key`
- `publication_id uuid null`
- `publication_version_id uuid null`
- `publication_monitoring_evaluation_id uuid null`
- `effect_outcome text not null` in `evaluated | duplicate_noop | not_applicable`
- `created_at timestamptz not null default clock_timestamp()`

A source outbox event may produce monitoring state at most once.

### 8.5 `publication_monitoring_delivery_effects`

Terminal replay-safe effect for `PublicationMonitoringAlertOpened` and `PublicationMonitoringAlertResolved` outbox delivery.

Required fields:

- `outbox_event_id uuid primary key`
- `publication_monitoring_alert_event_id uuid not null`
- `publication_id uuid not null`
- `event_type text not null`
- `created_at timestamptz not null default clock_timestamp()`

This table does not own alert state and never mutates Publication authority.

## 9. Monitoring evaluation transaction

For each input trigger, the worker performs one PostgreSQL transaction.

### 9.1 Validate source

1. Validate `job.id` exists.
2. Require `job.data.outboxEventId === job.id`.
3. Reload `outbox_events` by ID.
4. Require the persisted event type to equal the BullMQ job name.
5. Validate aggregate type/aggregate ID and persisted relationships.
6. Ignore all untrusted queue payload fields after identity validation.

### 9.2 Replay check

Lock/check `publication_monitoring_effects` by `trigger_outbox_event_id`.

If an effect already exists, return `duplicate_noop` without creating alert/audit/outbox side effects.

### 9.3 Load current authority

For `CandidateEligibilityEvaluated`:

1. Resolve the persisted Candidate ID and CandidateRevision ID from PostgreSQL.
2. Resolve the Publication belonging to that Candidate, if any.
3. Lock the Publication and current active pointer.
4. Require the active PublicationVersion to pin the same CandidateRevision as the source Eligibility evaluation.
5. Reload the **current** Eligibility evaluation/currentness for that revision from PostgreSQL.

If there is no Publication, no active version, or the active version pins another CandidateRevision, record `not_applicable` and stop.

For `PublicationMonitoringRequested`:

1. Resolve and lock the Publication from persisted outbox authority.
2. Load the current active PublicationVersion.
3. Load the current Eligibility status for its pinned CandidateRevision.

### 9.4 Compute desired alert state

The computation is a pure function over the loaded authority:

- missing/non-current canonical Eligibility -> revalidation warning;
- current `needs_review` -> needs-review warning;
- current `ineligible` -> ineligible critical;
- current `eligible` -> healthy;
- stale/non-active source trigger -> not applicable.

No external calls and no AI inference are permitted.

### 9.5 Persist transitions atomically

Inside the same transaction:

1. Insert the monitoring evaluation when applicable.
2. Lock current alert pointers for the Publication.
3. Determine the minimal transition set.
4. For each actual state transition only:
   - insert immutable alert event;
   - insert audit event;
   - insert `PublicationMonitoringAlertOpened` or `PublicationMonitoringAlertResolved` outbox event;
   - update the current alert pointer.
5. Insert the source `publication_monitoring_effects` row.
6. Commit.

If desired alert state is already current, no new alert/audit/output-outbox event is created.

## 10. Alert output delivery transaction

For `PublicationMonitoringAlertOpened` / `PublicationMonitoringAlertResolved` jobs:

1. Validate job/outbox identity.
2. Reload the persisted outbox event.
3. Resolve the referenced `publication_monitoring_alert_events` row from PostgreSQL.
4. Require event type, Publication ID, alert event ID, alert code, and state to agree with PostgreSQL authority.
5. Insert `publication_monitoring_delivery_effects` with `ON CONFLICT`/equivalent replay protection.
6. Return `delivered` or `duplicate_noop`.

This path emits no audit event and no additional outbox event.

## 11. Audit contract

Only actual alert state transitions create audit records.

Actions:

- `monitoring.publication_alert_opened`
- `monitoring.publication_alert_resolved`

Audit payload must contain bounded identifiers and reason codes only. It must not contain raw source article bodies, transcripts, comments, credentials, connection strings, or arbitrary collector payloads.

Actor for worker-driven monitoring transitions is fixed and explicit, for example:

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

Ordering is deterministic: critical before warning, then oldest open transition, then Publication ID.

Sprint 7A does not register a new public HTTP route. A future authenticated operator surface may depend on this read boundary without changing monitoring authority.

## 13. Concurrency and stale-event rules

Monitoring must be correct under delayed and concurrent delivery.

### 13.1 Delayed Eligibility event

If a delayed `CandidateEligibilityEvaluated` event arrives after a different PublicationVersion became active, the worker evaluates the current active pointer. If the source revision is no longer active, it returns `not_applicable` and cannot reopen an obsolete alert.

### 13.2 Eligibility versus rollback/publish

Monitoring transactions lock the Publication/current activation authority before deciding alert state. Publication activation and monitoring must use a consistent lock order to avoid deadlocks.

The implementation plan must inspect the existing publish/rollback lock order and match it rather than inventing a second order.

### 13.3 Duplicate/lost-ack delivery

`publication_monitoring_effects.trigger_outbox_event_id` and `publication_monitoring_delivery_effects.outbox_event_id` are unique replay boundaries. A duplicate BullMQ delivery cannot duplicate alert, audit, or downstream outbox side effects.

### 13.4 Multiple trust changes

Each canonical `CandidateEligibilityEvaluated` event can trigger a monitoring evaluation, but alert lifecycle history changes only when the desired current state changes.

## 14. Failure behavior

Fail closed for monitoring, fail open for public reads.

- PostgreSQL unavailable: monitoring job fails retryably; no partial alert state is committed.
- Redis/BullMQ unavailable: monitoring is delayed; outbox remains authoritative/pending. Public Publication reads remain available from PostgreSQL.
- malformed/tampered queue envelope: fail with a stable non-secret error code.
- invalid persisted outbox relationship: fail without trusting payload.
- no active matching Publication: `not_applicable`, not an error.
- active Publication but current Eligibility cannot be established on a lifecycle trigger: open/maintain `ACTIVE_PUBLICATION_REVALIDATION_REQUIRED`.
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

## 16. Worker composition

The private backend worker adds one BullMQ consumer for `hai-dau-monitoring-v1` and one producer Queue in the existing routed outbox dispatcher set.

Connection policy remains consistent with Sprint 6B:

- worker consumer Redis connection uses worker-compatible retry settings;
- producer Queue connection uses finite retry;
- shutdown aborts the outbox dispatch loop, waits for it, closes workers, closes Queues, then Redis/PostgreSQL resources in the established order.

No additional public Railway service is introduced. Sprint 7A runs inside the existing private worker process.

## 17. Test and verification requirements

Implementation must follow RED -> GREEN TDD and add service-backed PostgreSQL 17 / Redis 7 tests.

Minimum scenarios:

1. Active eligible Publication + same pinned revision reevaluates `needs_review` -> exactly one warning opens.
2. Duplicate source delivery -> no duplicate monitoring evaluation side effects, alert, audit, or output outbox transition.
3. Warning -> `ineligible` -> warning resolves and critical opens atomically.
4. Critical -> `eligible` -> critical resolves and no 7A alert remains open.
5. Lifecycle request with missing/non-current Eligibility -> revalidation warning opens.
6. Later current eligible evaluation -> revalidation warning resolves.
7. Delayed Eligibility event for a revision no longer active -> `not_applicable`; no obsolete alert opens.
8. Publish/rollback activation change resolves alerts tied to an obsolete active state as required by the current evaluation.
9. Tampered BullMQ payload with valid outbox ID -> PostgreSQL authority wins.
10. Job ID / outbox ID mismatch -> rejected.
11. Alert transition output event -> terminal delivery effect recorded exactly once.
12. Duplicate alert-output delivery -> `duplicate_noop`.
13. Redis outage does not affect direct PostgreSQL public Publication reads.
14. Monitoring worker failure cannot alter active Publication pointers.
15. Concurrent monitoring versus publish/rollback produces no deadlock and no alert for a stale active version after both transactions settle.
16. No public `POST`, `PUT`, `PATCH`, or `DELETE` monitoring/Publications route is introduced.
17. Repository scan finds no production credentials, Railway provisioning, notification token, or browser write credential.
18. Existing frontend, backend, publication, eligibility, staging, and release-candidate regression gates remain green.

## 18. Acceptance criteria

Sprint 7A is repository-ready only when:

- the forward-only monitoring migration is verified;
- deterministic monitoring computation is covered by unit tests;
- PostgreSQL integration tests cover open/resolve/replay/stale/concurrency behavior;
- monitoring outbox routing and terminal alert delivery are verified with Redis 7;
- public read independence is re-proven with monitoring worker/Redis unavailable;
- no Critical or Important review finding remains;
- exact-head CI is green;
- documentation/runbook explains operator meaning of every alert code and explicitly states that alerts never change public content.

Repository completion marker:

`SPRINT_7A_REPO_READY`

This marker does not imply Railway production deployment and does not change the still-separate production delivery gate tracked outside Sprint 7A.

## 19. Follow-on boundary

The recommended next step after Sprint 7A is a separate design cycle for one of:

- **Sprint 7B — Feedback Intake:** abuse-resistant user feedback ingestion and internal review, without treating feedback as Evidence; or
- **Sprint 7C — Monitoring Operator Surface:** authenticated internal alert visibility/actions if the project chooses to establish operator identity/RBAC first.

Neither is part of this specification.
