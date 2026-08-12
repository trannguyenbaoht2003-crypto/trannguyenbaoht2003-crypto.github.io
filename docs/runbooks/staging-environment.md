# Sprint 5C–5D Staging Environment Runbook

## Purpose and boundaries

This runbook starts a provider-neutral staging stack where one gateway origin serves the static frontend and proxies the read-only Publication API. The frontend image is built with `NEXT_PUBLIC_PUBLIC_API_BASE_URL=same-origin`, so the browser requests `/api/v1/publications` without CORS, credentials, or an embedded hostname.

The stack contains PostgreSQL 17, Redis 7, a one-shot migration service, the Fastify backend, and a Caddy gateway. The default topology does not start the background worker. No production deployment, cloud provisioning, DNS change, registry push, or automatic publication is performed by Sprint 5C or Sprint 5D.

## Prerequisites

- Docker Engine with Docker Compose v2.
- Node.js 22.13.0 for contract and smoke scripts.
- A system headless Chrome/Chromium binary for Sprint 5D browser rehearsal.
- Ports selected through `STAGING_PORT`; the local default is `8080`.

`deploy/staging/.env.example` contains local/CI-only values. Copy it to an untracked file or provide environment overrides for a shared staging host. Never commit real database passwords, tokens, private keys, production URLs, or cloud credentials.

## Validate configuration

```bash
npm run test:staging-contract
npm run test:release-source
npm run staging:config
```

The resolved configuration must publish only the gateway port. PostgreSQL, Redis, and the backend remain accessible only on the Compose network. The backend and gateway final images must run as non-root users.

## Start and verify

```bash
npm run staging:up
npm run staging:smoke -- normal
```

Startup behavior is:

1. The non-root gateway starts independently and can serve the static export even while backend dependencies are starting or unavailable.
2. PostgreSQL 17 and Redis 7 become healthy.
3. The one-shot migration container runs checksum-protected, append-only migrations.
4. The backend starts only after migration completion and Redis health.

The normal smoke check requires:

- `/` returns the static `Lõi.Meta` application;
- `/health/live` and `/health/ready` succeed through the gateway;
- `/api/v1/publications` returns the closed schema-version-1 envelope;
- unauthenticated `POST /api/v1/publications` remains unavailable.

## Sprint 5D deterministic Publication rehearsal

The release rehearsal is internal to the backend container. It does not add a public write route. Mutating operations fail closed unless `STAGING_REHEARSAL_ENABLED=1` is explicitly passed.

Publish V1:

```bash
docker compose --env-file deploy/staging/.env.example -f deploy/staging/compose.yml run --rm -T --no-deps -e STAGING_REHEARSAL_ENABLED=1 backend node dist/src/rehearsal/release-rehearsal-cli.js seed-v1
```

Publish immutable V2 from the same authoritative CandidateRevision:

```bash
docker compose --env-file deploy/staging/.env.example -f deploy/staging/compose.yml run --rm -T --no-deps -e STAGING_REHEARSAL_ENABLED=1 backend node dist/src/rehearsal/release-rehearsal-cli.js publish-v2
```

Roll the active pointer back to V1:

```bash
docker compose --env-file deploy/staging/.env.example -f deploy/staging/compose.yml run --rm -T --no-deps -e STAGING_REHEARSAL_ENABLED=1 backend node dist/src/rehearsal/release-rehearsal-cli.js rollback-v1
```

Verify the current bounded public-reader state:

```bash
docker compose --env-file deploy/staging/.env.example -f deploy/staging/compose.yml run --rm -T --no-deps -e STAGING_REHEARSAL_ENABLED=1 backend node dist/src/rehearsal/release-rehearsal-cli.js verify
```

V1 and V2 intentionally have the same authority-derived Samira build payload. Candidate identity includes the normalized build signature, so changing augment/items would mean a different Candidate rather than a new version of the same Publication. The rehearsal therefore proves version immutability and rollback through version metadata while preserving the domain identity invariant.

## Browser rehearsal

The browser check uses a real system headless Chrome/Chromium against the gateway. It combines the public API version assertion with hydrated DOM verification:

```bash
RELEASE_E2E_EXPECT=v1 npm run release:browser-e2e
RELEASE_E2E_EXPECT=v2 npm run release:browser-e2e
RELEASE_E2E_EXPECT=backend-down npm run release:browser-e2e
RELEASE_E2E_EXPECT=recovered-v1 npm run release:browser-e2e
```

The browser must reach the same-origin API without credentials, show live Publication status when the backend is healthy, retain the static Samira catalog and display the API-unavailable state during a backend outage, and never render deterministic raw rehearsal IDs.

## Backend outage and recovery

A backend outage must not remove the static frontend. Exercise the contract with:

```bash
docker compose --env-file deploy/staging/.env.example -f deploy/staging/compose.yml stop backend
npm run staging:smoke -- backend-down
RELEASE_E2E_EXPECT=backend-down npm run release:browser-e2e
docker compose --env-file deploy/staging/.env.example -f deploy/staging/compose.yml up -d --wait backend
npm run staging:smoke -- recovered
RELEASE_E2E_EXPECT=recovered-v1 npm run release:browser-e2e
```

During the outage, `/` remains available while the API returns a sanitized gateway 5xx. The browser adapter retains static guide data. It does not retry, poll, mutate Publication state, or trigger automatic publication.

A PostgreSQL or Redis outage causes backend readiness to fail closed. Because gateway startup is independent, it continues serving static files, and PostgreSQL remains the only Publication authority.

## Backup and restore rehearsal

After V2 has been rolled back to V1, run:

```bash
npm run staging:backup-restore
```

The script creates a temporary logical PostgreSQL dump from the disposable staging database, restores it into a temporary database, and verifies the restored active Publication through the same compiled public-reader path. It requires exactly two immutable PublicationVersions with V1 active. The temporary dump and restore database are deleted in `finally` and are never uploaded as workflow artifacts.

## Release security gate

Run only while the staging stack is healthy:

```bash
npm run release:security-gate
```

The gate verifies non-root backend/gateway users, one published host port owned by gateway, no default worker, absent Publication mutation methods, no Node/Next runtime in the final gateway image, backend runtime dependency audit status, and bounded committed-secret patterns. It does not run an automatic force upgrade.

## Service restart checks

For bounded operational rehearsal:

```bash
docker compose --env-file deploy/staging/.env.example -f deploy/staging/compose.yml restart redis
docker compose --env-file deploy/staging/.env.example -f deploy/staging/compose.yml restart postgres
docker compose --env-file deploy/staging/.env.example -f deploy/staging/compose.yml up -d --wait backend
```

After dependency recovery, verify `/health/ready`, the public Publication read, and the browser state before accepting the environment.

## Teardown

```bash
npm run staging:down
```

This removes containers, the local staging volume, and orphaned Compose resources. It does not delete external infrastructure because Sprint 5C–5D creates none.

## Application rollback

The application rollback procedure means checking out or selecting a previously verified commit/image set and starting that complete frontend/backend pair through the same Compose topology. Run the normal smoke check after rollback.

Database migrations are forward-only and checksum-protected. Sprint 5C–5D does not automate schema rollback or destructive down migrations. A migration checksum mismatch blocks startup rather than rewriting applied history.

Publication rollback is different from application/schema rollback: Sprint 5D calls the existing `rollbackPublication` domain command to move the active Publication pointer from immutable V2 back to immutable V1 while retaining both versions.

## Safe diagnostics

Use only component status and bounded logs:

```bash
docker compose --env-file deploy/staging/.env.example -f deploy/staging/compose.yml ps
docker compose --env-file deploy/staging/.env.example -f deploy/staging/compose.yml logs --tail=100 gateway backend migrate postgres redis
```

Do not print `.env` contents, expanded database URLs, credentials, database dumps, or private material into issue comments or CI logs.

## `RC_READY`

The `Sprint 5D release candidate gate` explicitly checks out `github.event.pull_request.head.sha`, compares it with `git rev-parse HEAD`, and performs the complete rehearsal on that immutable branch head. The separate `rc-ready` job prints exactly `RC_READY` only after the rehearsal job, including its unconditional staging teardown, has succeeded.

`RC_READY` means the exact commit is a candidate for a future real staging deployment. It does not authorize merging the stacked PR chain, publishing GitHub Pages, provisioning a public host, or deploying production.

## No production deployment

Sprint 5C–5D builds and runs containers only on the local machine or CI runner. It does not push images, modify GitHub Pages, provision a public environment, merge the stacked PR chain, or deploy production infrastructure.
