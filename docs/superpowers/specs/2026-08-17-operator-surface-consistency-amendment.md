# Sprint 7C Operator Surface — Consistent Snapshot Amendment

**Status:** self-approved hardening amendment  
**Supersedes:** the read-composition mechanics in `2026-08-17-operator-surface-design.md` where they conflict

## Problem

Calling the Sprint 7A monitoring reader and Sprint 7B feedback reader through the pool as two independent reads can observe different active PublicationVersion states when a publish or rollback commits between them. That can produce an internally inconsistent operator snapshot even though each source reader is individually correct.

## Decision

Sprint 7C must create one PostgreSQL transaction at `REPEATABLE READ READ ONLY` isolation and execute both existing read boundaries through the same transaction client.

The existing readers are generalized from concrete `Pool` parameters to a narrow query-only interface compatible with both `Pool` and `PoolClient`:

```ts
export interface PgQueryable {
  query: Pool['query'];
}
```

No SQL, ordering, validation or authority semantics inside either reader changes.

The 7C combined reader performs:

```text
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY
readOpenPublicationMonitoringAlerts(client)
readPublicationFeedbackSignals(client, ...)
COMMIT
```

Any error triggers `ROLLBACK` and is propagated to the operator HTTP sanitization boundary.

## Required coverage

- both source readers receive the same transaction client;
- transaction starts with repeatable-read + read-only semantics;
- success commits exactly once;
- source-reader failure rolls back exactly once;
- no mutation SQL is introduced;
- existing 7A and 7B reader tests continue passing with the generalized query-only type.
