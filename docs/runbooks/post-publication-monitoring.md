# Post-Publication Monitoring Runbook

## Purpose

Sprint 7A adds deterministic monitoring for trust drift behind the CandidateRevision pinned by a currently active PublicationVersion.

Monitoring is advisory only and never publishes or rolls back content automatically. It does not hide, retract, replace, republish, or otherwise mutate public content. Any change to active public content remains an explicit publisher-authorized Publication command.

PostgreSQL is the authority. Redis and BullMQ carry wake-up and identity envelopes only. The public Publication read path remains PostgreSQL-backed and does not depend on monitoring, Redis, or the private worker being available.

## Runtime topology

The monitoring path runs inside the existing private backend worker process; Sprint 7A does not add another public or private Railway service.

```text
PostgreSQL authority
  -> transactional outbox
  -> hai-dau-monitoring-v1
  -> private monitoring worker
  -> PostgreSQL monitoring evaluation / alert authority
```

The worker reloads every authoritative identity and current state from PostgreSQL. Queue payload fields cannot override Publication, CandidateRevision, Eligibility, alert, or active-version authority.

## Input triggers

### CandidateEligibilityEvaluated

This existing canonical Eligibility event is the trust-drift trigger. Monitoring validates the persisted outbox row and the referenced Candidate/CandidateRevision/evaluation relationship, then reloads the current active PublicationVersion and current Eligibility authority.

If the CandidateRevision named by the event is no longer pinned by the active PublicationVersion, the event is `not_applicable`. A delayed event can therefore never reopen an alert for an obsolete active version.

If a newer trust change has already made the stored Eligibility evaluation stale, monitoring does not trust the older event payload. It opens or maintains the revalidation warning for the currently active version.

### PublicationMonitoringRequested

Every successful publish or rollback activation emits a separate `PublicationMonitoringRequested` event in the same database transaction after the active pointer has been updated.

Persisted contract:

- `aggregate_type = publication`
- `aggregate_id = publication_id`
- payload keys are exactly `schemaVersion`, `publicationId`, `activationId`, `requestedReason`
- `schemaVersion = 1`
- `requestedReason = published | rolled_back`

The worker validates that the named activation exists for that Publication, but it evaluates the active PublicationVersion at processing time. A delayed lifecycle request is therefore self-healing rather than authoritative about which version is active.

## Alert meanings

### ACTIVE_PUBLICATION_REVALIDATION_REQUIRED

Severity: `warning`.

The active PublicationVersion exists, but monitoring cannot prove that its pinned CandidateRevision has a current canonical Eligibility evaluation under current authority. This is fail-closed monitoring, not a declaration that the public content is automatically invalid.

Operator meaning: allow canonical trust evaluation to settle or investigate why current Eligibility cannot be established. Any rollback remains a separate explicit publisher decision.

### ACTIVE_PUBLICATION_NEEDS_REVIEW

Severity: `warning`.

The active pinned CandidateRevision currently evaluates to `needs_review` under canonical Eligibility authority.

Operator meaning: inspect the underlying Evidence, HumanReview, Moderation, and Eligibility state. Monitoring itself performs no Publication mutation.

### ACTIVE_PUBLICATION_INELIGIBLE

Severity: `critical`.

The active pinned CandidateRevision currently evaluates to `ineligible` under canonical Eligibility authority.

Operator meaning: prioritize review. If public content should change, an authorized publisher must explicitly choose the appropriate Publication command; the monitoring worker cannot perform that action.

## Alert lifecycle

Monitoring evaluations are append-only. Alert transition history is append-only. Current alert pointers are mutable projections constrained to their owning Publication, alert code, version, state, and severity.

For one active PublicationVersion:

- `eligible` resolves every open Sprint 7A alert;
- `needs_review` opens or maintains `ACTIVE_PUBLICATION_NEEDS_REVIEW`;
- `ineligible` resolves weaker alerts and opens or maintains `ACTIVE_PUBLICATION_INELIGIBLE`;
- missing or non-current canonical Eligibility opens or maintains `ACTIVE_PUBLICATION_REVALIDATION_REQUIRED`.

When the active PublicationVersion changes, open alerts referencing the prior version are resolved before the desired state for the new active version is opened. Even if the alert code is unchanged, the new active version receives a new alert transition so an open pointer never intentionally points to an obsolete version.

Only actual state transitions create audit and output outbox events:

- `monitoring.publication_alert_opened`
- `monitoring.publication_alert_resolved`
- `PublicationMonitoringAlertOpened`
- `PublicationMonitoringAlertResolved`

The alert-output worker path is terminal. It validates the immutable PostgreSQL alert event and records one `publication_monitoring_delivery_effects` row. It emits no new alert, audit, or outbox event, preventing recursion.

## Replay and delayed delivery

`publication_monitoring_effects.trigger_outbox_event_id` is the replay boundary for input triggers. A duplicate BullMQ delivery returns `duplicate_noop` and cannot duplicate monitoring evaluations, alert transitions, audits, or output outbox events.

`publication_monitoring_delivery_effects.outbox_event_id` is the replay boundary for terminal alert-output delivery.

Historical pending `CandidateEligibilityEvaluated` rows are safe when Sprint 7A routing becomes active:

- dispatcher batching and leases remain bounded;
- non-active CandidateRevisions become `not_applicable`;
- current authority is always reloaded;
- repeated historical events may record applicable evaluations, but alert history changes only when desired current state changes;
- no historical event can activate a PublicationVersion or mutate public content.

## Concurrency model

Monitoring locks the Publication and active pointer using the established Publication lock direction. It does not introduce a second Publication mutation path.

Publish and rollback emit lifecycle requests transactionally. If monitoring races with a publish or rollback, the lifecycle request produced by the winning activation is the convergence trigger. After that request is processed, open alert state must agree with the then-current active PublicationVersion.

The concurrency tests explicitly reject deadlocks and stale open alerts after lifecycle convergence.

## Failure behavior

Monitoring fails closed while public reads fail open with respect to monitoring infrastructure:

- PostgreSQL unavailable: the monitoring job fails retryably; no partial monitoring transaction commits.
- Redis/BullMQ unavailable: monitoring delivery is delayed; PostgreSQL outbox authority remains pending/retryable.
- malformed or tampered queue envelope: reject with a stable error and do not trust queued state.
- invalid persisted outbox relationship: reject without changing Publication authority.
- no active matching Publication: record `not_applicable`.
- current Eligibility unavailable or stale for an active Publication: open/maintain the revalidation warning.
- duplicate alert-output delivery: `duplicate_noop`.

None of these paths writes `publications`, `publication_versions`, `publication_activation_history`, or `active_publication_versions`.

## Internal operator read boundary

`readOpenPublicationMonitoringAlerts(pool)` reads current open alerts directly from PostgreSQL. It returns Publication ID, active PublicationVersion ID, CandidateRevision ID, alert code, severity, evaluation timestamp, and canonical Eligibility outcome/reason when available.

The reader fails closed if an open alert pointer no longer references the current active PublicationVersion. Sprint 7A exposes no new public HTTP endpoint and no browser write credential.

## Security boundaries

- AI output is not monitoring authority.
- Community feedback is not Evidence and is outside Sprint 7A.
- Raw article bodies, transcripts, comments, credentials, connection strings, and collector payloads are not copied into monitoring audit records.
- Queue payloads are not authoritative.
- No CORS expansion is introduced.
- No public `POST`, `PUT`, `PATCH`, or `DELETE` monitoring/Publication route is introduced.
- No notification token or third-party notification integration is introduced.
- No Railway provisioning or production deployment is part of Sprint 7A repository completion.

## Verification

Repository verification must include:

1. PostgreSQL 17 migration and relational/immutability tests.
2. Pure deterministic monitoring computation tests.
3. PostgreSQL open/resolve/replay/stale/currentness tests.
4. Redis 7/BullMQ routing, tamper, terminal-delivery, and replay tests.
5. Worker composition and shutdown-order contracts.
6. Direct PostgreSQL public-read regression while monitoring remains an independent private worker concern.
7. Publish/rollback concurrency and stale-alert convergence tests.
8. Repository scan proving no Publication mutation import/write path in monitoring code.
9. Repository scan proving no public mutation route or committed production credential.
10. Exact-head GitHub Actions on the Sprint 7A gate plus inherited regression/staging/release-candidate gates.

## Readiness boundary

`SPRINT_7A_REPO_READY` means the repository implementation, tests, documentation, and exact-head CI have passed review.

It does not mean production has been provisioned or delivered. `PRODUCTION_DELIVERY_READY = NO` remains the correct state until the separate production bootstrap/live-delivery gate is satisfied with real production evidence.
