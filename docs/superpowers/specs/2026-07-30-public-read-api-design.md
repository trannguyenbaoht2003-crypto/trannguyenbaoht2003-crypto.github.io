# Sprint 5A Public Read API Design

## Goal

Expose the existing PostgreSQL-authoritative active Publication read boundary through a small, versioned, read-only Fastify API without adding mutation routes, authentication, frontend integration, Redis dependence, deployment, or automatic publication behavior.

## Approved scope

Sprint 5A adds exactly two HTTP endpoints:

- `GET /api/v1/publications`
- `GET /api/v1/publications/:publicationId`

Both endpoints expose only active immutable PublicationVersion data already returned by `readActivePublications` and `readActivePublicationById`.

## Architecture

### HTTP adapter

Create `backend/src/http/public-publications.ts` as the only Publication HTTP adapter. It registers the two GET routes on a Fastify instance and depends on a narrow `PublicPublicationReader` interface:

```ts
export interface PublicPublicationReader {
  listActive(): Promise<ActivePublicationRead[]>;
  findActiveById(publicationId: string): Promise<ActivePublicationRead | null>;
}
```

The adapter must not import `pg`, `ioredis`, `bullmq`, the dispatcher, or any worker. It does not perform Publication authority calculations. It maps the existing domain read values to closed HTTP response objects.

### PostgreSQL adapter

Create `backend/src/modules/publication/public-publication-reader.ts`:

```ts
export function createPublicPublicationReader(pool: Pool): PublicPublicationReader
```

The implementation delegates only to:

- `readActivePublications(pool)`
- `readActivePublicationById(pool, publicationId)`

PostgreSQL remains the sole Publication authority. Redis state, worker state, projection effects, queue delivery, and readiness status cannot change public content.

### Application composition

Extend `BuildAppOptions` with:

```ts
publications: PublicPublicationReader;
```

`buildApp` registers the read-only Publication routes. `server.ts` constructs the PostgreSQL reader from the existing `Pool` and passes it to `buildApp`.

Health readiness remains unchanged and may still depend on PostgreSQL and Redis. The public Publication routes themselves depend only on the reader backed by PostgreSQL.

## HTTP contract

### List response

`GET /api/v1/publications` returns status `200`:

```json
{
  "schemaVersion": 1,
  "publications": [
    {
      "publicationId": "uuid",
      "candidateId": "uuid",
      "candidateRevisionId": "uuid",
      "publicationVersionId": "uuid",
      "versionNumber": 1,
      "publishedAt": "2026-07-29T02:00:00.000Z",
      "payload": {
        "schemaVersion": 1,
        "mode": "aram_mayhem",
        "patchKey": "26.15",
        "catalogRevisionId": "uuid",
        "championExternalId": "samira",
        "augmentExternalIds": ["1194"],
        "itemExternalIds": ["3006", "6672"]
      }
    }
  ]
}
```

The order is the deterministic PostgreSQL order already enforced by `readActivePublications`.

### Single response

`GET /api/v1/publications/:publicationId` returns status `200`:

```json
{
  "schemaVersion": 1,
  "publication": {
    "publicationId": "uuid",
    "candidateId": "uuid",
    "candidateRevisionId": "uuid",
    "publicationVersionId": "uuid",
    "versionNumber": 1,
    "publishedAt": "2026-07-29T02:00:00.000Z",
    "payload": {
      "schemaVersion": 1,
      "mode": "aram_mayhem",
      "patchKey": "26.15",
      "catalogRevisionId": "uuid",
      "championExternalId": "samira",
      "augmentExternalIds": ["1194"],
      "itemExternalIds": ["3006", "6672"]
    }
  }
}
```

### Invalid identifier

A path value that is not a canonical UUID returns status `400`:

```json
{
  "error": {
    "code": "INVALID_PUBLICATION_ID",
    "message": "Invalid publication id"
  }
}
```

Validation happens before calling the reader.

### Not found

A valid UUID with no active Publication returns status `404`:

```json
{
  "error": {
    "code": "PUBLICATION_NOT_FOUND",
    "message": "Publication not found"
  }
}
```

An eligible but unpublished Candidate is not a Publication and therefore remains absent.

### Internal failure

Reader failures return status `500` with only:

```json
{
  "error": {
    "code": "PUBLICATION_READ_FAILED",
    "message": "Publication read failed"
  }
}
```

The response must not expose SQL text, connection URLs, credentials, stack traces, Redis details, or the original exception message. Normal Fastify logging may record the error through the existing redacted logger.

## Closed response mapping

The HTTP adapter reconstructs each response object from the declared fields. It must not spread unknown database/domain fields into the response. The API returns no moderation reason, reviewer identity, Evidence graph, Eligibility reason, source reference, audit record, outbox record, projection state, or credentials.

## Method boundary

Sprint 5A registers no Publication `POST`, `PUT`, `PATCH`, or `DELETE` route. Requests using those methods return Fastify's normal `404` response and create no database side effect.

The new GET routes do not authorize publish, rollback, retraction, re-evaluation, or projection replay.

## Test strategy

### HTTP unit contract

Use Fastify injection with a stub `PublicPublicationReader` to prove:

- list and single success response shapes are exact;
- invalid UUID returns the stable `400` error without calling the reader;
- missing active Publication returns the stable `404` error;
- reader exceptions return the safe `500` error without leaking details;
- Publication mutation methods are not registered.

### PostgreSQL integration contract

Build the app with `createPublicPublicationReader(pool)` and existing Publication fixtures to prove:

- eligible but unpublished Candidates are hidden;
- only the current active immutable version is returned;
- rollback changes the HTTP read immediately;
- deterministic list ordering is preserved;
- the endpoints work with Redis URLs pointed at an unavailable port and with zero projection effects.

### Composition contract

A focused source-boundary test verifies `public-publications.ts` contains no `pg`, `ioredis`, `bullmq`, queue, dispatcher, worker, publish, or rollback import. The server composition may import PostgreSQL to create the reader, but route behavior must not receive a Redis client.

## Workflow and operations

Update the backend runbook and repository workflow contract to state:

- `GET /api/v1/publications`
- `GET /api/v1/publications/:publicationId`
- `Read-only Publication HTTP boundary`
- `Public API reads PostgreSQL only`
- `No Publication mutation route`
- `No frontend integration`
- `No auth provider`
- `No merge`
- `No deploy`

Rename the workflow and concurrency group to Sprint 5A while preserving PostgreSQL 17, Redis 7, `permissions: contents: read`, repository cleanliness, deployment-command scanning, and credential scanning.

## Exact-head acceptance gate

On one immutable SHA run:

```bash
npm run validate:community
npm run lint
npm test
npm run build:pages
npm run backend:typecheck
npm run backend:test
npm run backend:build
git diff --check
```

The same SHA must pass the deployment dry-run with production publishing disabled.

## Locked exclusions

- No Publication mutation HTTP route.
- No frontend or GitHub Pages integration.
- No identity provider, account system, session, API key, or authorization middleware.
- No CORS policy expansion unless a focused RED proves it is required by this backend-only API contract.
- No pagination, filtering, sorting parameters, search, cache, ETag, or CDN behavior.
- No automatic publication or automatic retraction.
- No production scheduler, infrastructure, credential, merge, or deployment.

## Design self-review

- No placeholder or deferred requirement remains.
- The two endpoints share one closed response mapping and one narrow reader interface.
- PostgreSQL remains authoritative; Redis and workers are excluded from route dependencies.
- Error behavior, method exclusions, test fixtures, workflow contract, and exact-head gate are explicit.
- The scope is independently testable and leaves frontend consumption for Sprint 5B.
