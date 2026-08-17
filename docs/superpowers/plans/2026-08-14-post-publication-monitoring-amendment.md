# Sprint 7A Implementation Plan Amendment

**Date:** 2026-08-14  
**Applies to:** `docs/superpowers/plans/2026-08-14-post-publication-monitoring.md`

## Migration numbering correction

The approved implementation plan named the new monitoring migration `backend/migrations/0011_post_publication_monitoring.sql`.

At implementation time, repository verification established that `backend/migrations/0011_publication_live_eligibility.sql` already exists on the Sprint 7A base and is part of the immutable migration chain.

Therefore the Sprint 7A monitoring migration is correctly implemented as:

`backend/migrations/0012_post_publication_monitoring.sql`

This amendment supersedes every migration-number reference to `0011_post_publication_monitoring.sql` in the original Sprint 7A implementation plan. The design and schema requirements are unchanged; only the forward migration ordinal changed to preserve the existing migration history.

The repository contract explicitly verifies that both conditions remain true:

- `0011_publication_live_eligibility.sql` still exists unchanged as the preceding migration;
- exactly one `0012_` migration exists and it is `0012_post_publication_monitoring.sql`.

## Concurrency clarification

The original plan describes the post-condition as having no stale open alert after monitoring and publish/rollback transactions settle. Sprint 7A uses transactional outbox delivery, so convergence is asynchronous by design.

The precise acceptance condition is:

1. publish or rollback commits the new active PublicationVersion and its `PublicationMonitoringRequested` event atomically;
2. the monitoring worker processes that lifecycle request;
3. after processing completes, no open Sprint 7A alert may reference a PublicationVersion other than the then-current active PublicationVersion.

The implemented concurrency tests use this exact convergence boundary and also reject PostgreSQL deadlocks.

No other Sprint 7A scope or authority rule is changed by this amendment.
