# Sprint 2A Production Foundation Design

## Status

Approved for implementation under the owner's standing delegation after ADR-0002 selected Platform B on 2026-07-23.

This design does not authorize a merge to `main`, production credentials, managed-service selection, infrastructure provisioning, or deployment.

## Goal

Create the first production-shaped backend foundation for Hải Đấu as a modular monolith using Node.js/Fastify, PostgreSQL, and BullMQ/Redis without turning either correctness spike into production code.

Sprint 2A establishes the ordered Core boundary:

> Source Policy Registry → Patch Registry → Catalog Revision → Rules Validation → controlled collection intake.

AI discovery, automated AI moderation, public publication commands, multi-source crawling, and production infrastructure remain outside this sprint.

## Inputs

- Architecture Baseline v0.2.
- Data Model Domain Spec v0.2.
- ADR-0002 accepted on 2026-07-23.
- Evidence Contract 1B-C-v2 and its Common Harness invariants.
- Existing Next.js static frontend and GitHub Pages build contract.

## Approaches considered

### 1. Add backend code directly to the frontend package

This minimizes directory setup but couples the static frontend build to PostgreSQL, Redis, and server-only dependencies. A backend failure could destabilize the canonical GitHub Pages build.

### 2. Add an isolated `backend/` package in the same repository

This preserves one repository and one audit history while keeping backend dependencies, TypeScript configuration, migrations, tests, and runtime commands independent of the frontend. Root scripts may invoke backend checks, but the existing frontend build remains canonical and deployable without backend services.

### 3. Create a separate backend repository

This gives strong isolation but introduces cross-repository contract versioning, coordinated CI, release ownership, and access management before the product has enough scale to justify it.

## Decision

Use approach 2: an isolated `backend/` package in the existing repository.

The backend is a modular monolith. HTTP and worker processes use the same domain and application contracts. Redis/BullMQ is delivery infrastructure; PostgreSQL remains the system of record. The frontend continues to read published snapshots independently and is not made dependent on backend availability in Sprint 2A.

## Components

### Runtime

- `backend/src/app.ts` builds the Fastify application without opening a port.
- `backend/src/server.ts` validates configuration, opens resources, starts the server, and owns graceful shutdown.
- `GET /health/live` proves the Node process is responsive.
- `GET /health/ready` checks PostgreSQL and Redis connectivity but exposes no credentials or internal error detail.

### Configuration

- Environment parsing is centralized and fails closed.
- Production-like startup requires `DATABASE_URL` and `REDIS_URL`.
- Tests inject configuration directly and do not read production credentials.
- Logs redact database URLs, Redis URLs, authorization headers, cookies, and API keys.

### Persistence

SQL migrations are explicit and reviewed. Sprint 2A creates only the structures needed by its module scope:

- sources;
- immutable source-policy revisions plus current active pointer;
- patches plus append-only lifecycle events;
- catalog revisions bound to exactly one patch;
- game entities and immutable entity revisions;
- compatibility rules bound to a catalog revision;
- raw observations with source-policy and storage-permission enforcement;
- audit events;
- idempotency records;
- outbox events.

History records are immutable or append-only. Current pointers and delivery status are mutable projections.

### Application transactions

Sprint 2A implements four commands:

1. Register a source.
2. Activate a source-policy revision atomically with audit and outbox records.
3. Register a patch lifecycle event atomically with audit and outbox records.
4. Ingest a raw observation idempotently, enforcing the active source policy and storage permission, then emit a normalization outbox event.

The collector-facing intake accepts structured references and permitted blobs. It does not crawl external sites in this sprint.

### Queue boundary

- The outbox dispatcher claims pending events with PostgreSQL locking.
- Dispatch to BullMQ uses the outbox event ID as the BullMQ job ID.
- A delivery retry cannot create a second logical job.
- The worker records job attempts and acknowledges only after its database transaction succeeds.
- A terminally failed job is observable and replayable; Redis is never treated as the source of truth.

## Data flow

1. An authorized operator activates a source-policy revision.
2. The same transaction records the policy history, current pointer, audit event, and outbox event.
3. Collection intake resolves the active policy and checks its kill switch and storage permission.
4. An idempotency record guards observation ingest.
5. The ingest transaction stores the allowed representation, provenance, audit record, and normalization outbox event.
6. The dispatcher places the outbox event in BullMQ using a deterministic job ID.
7. The worker records an attempt and invokes a placeholder normalization boundary. Full normalization begins in Sprint 3.

## Error handling

- Invalid configuration prevents startup.
- PostgreSQL or Redis readiness failures return a generic non-ready response and structured server-side error metadata without secrets.
- Missing, suspended, or prohibited source policy rejects ingest without creating an observation.
- `reference_only` policy never stores a raw blob.
- Reusing an idempotency key with the same payload returns the recorded result.
- Reusing the same key with a different payload returns a conflict and creates no side effect.
- Transaction failure rolls back the domain mutation, audit record, outbox event, and idempotency completion together.
- Queue failure leaves the outbox event pending or retryable; it never rolls back a committed domain transaction.

## Security and authority

- No endpoint or worker may publish content.
- AI is not introduced in Sprint 2A.
- Source policy is enforced in the application command and database constraints where representable.
- Raw blobs are accepted only when the active revision explicitly allows them.
- HTTP errors do not expose SQL, stack traces, credentials, or stored source content.
- The CI workflow has read-only repository permissions and no deployment step.

## Testing strategy

All behavior is implemented test-first.

- Unit tests cover configuration, storage-permission decisions, idempotency conflict rules, and log redaction.
- PostgreSQL integration tests apply migrations from an empty database and exercise transaction rollback, immutable history, and outbox consistency.
- Redis/BullMQ integration tests exercise deterministic job IDs, retry safety, and worker acknowledgement.
- Contract tests retain the Common Harness publication and authority vocabulary even though publication is not implemented in Sprint 2A.
- CI runs PostgreSQL 17 and Redis 7 services, backend typecheck/lint/test, existing frontend moderation tests, frontend lint, frontend test, and canonical build.
- No test or migration uses production data.

## Definition of Done

- Backend package installs reproducibly from a lockfile.
- Fresh PostgreSQL 17 accepts every migration and can roll them back through test database recreation.
- Fastify live and ready health contracts are tested.
- Source-policy activation, patch lifecycle, and observation ingest are transactionally consistent.
- Raw blob retention follows the active source-policy revision.
- Observation ingest is idempotent and conflict-safe.
- Outbox-to-BullMQ delivery is retry-safe.
- Audit and outbox rows are created for every implemented mutation.
- Existing frontend lint, tests, and build remain green.
- CI proves the backend against PostgreSQL 17 and Redis 7.
- No spike adapter is imported into production code.
- No merge or deployment occurs.

## Deferred work

- External Chinese-source adapters and source-specific rate limits.
- Full catalog synchronization.
- Normalization, candidate registry, and meta computation.
- Evidence v3 persistence and state machines.
- AI candidate discovery and AI moderation recommendation.
- Human review and publication workflows.
- Managed PostgreSQL/Redis provider selection.
- Production secrets, infrastructure, deployment, and data migration.

## Self-review

- No placeholder or unspecified business state remains in Sprint 2A scope.
- The design preserves the official Evidence, Moderation, Eligibility, and Publication vocabularies.
- The package boundary keeps the current static frontend independently buildable.
- The design does not import spike code or broaden AI publication authority.
- Each implemented mutation has an atomic audit/outbox boundary and a testable failure path.
