# Sprint 7C Operator Surface Plan — Consistency Amendment

**Status:** self-approved  
**Applies to:** Task 1 of `2026-08-17-operator-surface.md`

Task 1 additionally modifies:

- `backend/src/modules/monitoring/read-open-publication-monitoring-alerts.ts`
- `backend/src/modules/feedback/read-publication-feedback-signals.ts`

Before implementing combined operator production code, RED tests must require one `REPEATABLE READ READ ONLY` transaction and prove commit/rollback behavior.

Implementation requirements:

1. Introduce a narrow query-only PostgreSQL type compatible with `Pool` and `PoolClient` without changing existing reader SQL/semantics.
2. `readOperatorPublicationSignals()` obtains `pool.connect()` and executes `BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`.
3. Both injected/default source readers receive the same transaction client.
4. Successful composition executes one `COMMIT`; any source-reader/composition error executes one `ROLLBACK` and rethrows.
5. Client release occurs in `finally`.
6. Existing 7A/7B tests, backend typecheck and full backend suite must remain green.
