# Sprint 5C Staging Environment Runbook

## Purpose and boundaries

This runbook starts a provider-neutral staging stack where one gateway origin serves the static frontend and proxies the read-only Publication API. The frontend image is built with `NEXT_PUBLIC_PUBLIC_API_BASE_URL=same-origin`, so the browser requests `/api/v1/publications` without CORS, credentials, or an embedded hostname.

The stack contains PostgreSQL 17, Redis 7, a one-shot migration service, the Fastify backend, and a Caddy gateway. The default topology does not start the background worker. No production deployment, cloud provisioning, DNS change, registry push, or automatic publication is performed by Sprint 5C.

## Prerequisites

- Docker Engine with Docker Compose v2.
- Node.js 22.13.0 for contract and smoke scripts.
- Ports selected through `STAGING_PORT`; the local default is `8080`.

`deploy/staging/.env.example` contains local/CI-only values. Copy it to an untracked file or provide environment overrides for a shared staging host. Never commit real database passwords, tokens, private keys, production URLs, or cloud credentials.

## Validate configuration

```bash
npm run test:staging-contract
npm run staging:config
```

The resolved configuration must publish only the gateway port. PostgreSQL, Redis, and the backend remain accessible only on the Compose network.

## Start and verify

```bash
npm run staging:up
npm run staging:smoke -- normal
```

Startup order is:

1. PostgreSQL 17 and Redis 7 become healthy.
2. The one-shot migration container runs checksum-protected, append-only migrations.
3. The backend starts only after migration completion and Redis health.
4. The gateway starts after backend readiness and serves the static export.

The normal smoke check requires:

- `/` returns the static `Lõi.Meta` application;
- `/health/live` and `/health/ready` succeed through the gateway;
- `/api/v1/publications` returns the closed schema-version-1 envelope;
- unauthenticated `POST /api/v1/publications` remains unavailable.

## Backend outage and recovery

A backend outage must not remove the static frontend. Exercise the contract with:

```bash
docker compose --env-file deploy/staging/.env.example -f deploy/staging/compose.yml stop backend
npm run staging:smoke -- backend-down
docker compose --env-file deploy/staging/.env.example -f deploy/staging/compose.yml up -d --wait backend
npm run staging:smoke -- recovered
```

During the outage, `/` remains available while the API returns a sanitized gateway 5xx. The browser adapter then retains static guide data. It does not retry, poll, mutate Publication state, or trigger automatic publication.

A PostgreSQL or Redis outage causes backend readiness to fail closed. The gateway continues serving static files, and PostgreSQL remains the only Publication authority.

## Teardown

```bash
npm run staging:down
```

This removes containers, the local staging volume, and orphaned Compose resources. It does not delete external infrastructure because Sprint 5C creates none.

## Application rollback

Application rollback means checking out or selecting a previously verified commit/image set and starting that complete frontend/backend pair through the same Compose topology. Run the normal smoke check after rollback.

Database migrations are forward-only and checksum-protected. Sprint 5C does not automate schema rollback or destructive down migrations. A migration checksum mismatch blocks startup rather than rewriting applied history.

## Safe diagnostics

Use only component status and bounded logs:

```bash
docker compose --env-file deploy/staging/.env.example -f deploy/staging/compose.yml ps
docker compose --env-file deploy/staging/.env.example -f deploy/staging/compose.yml logs --tail=100 gateway backend migrate postgres redis
```

Do not print `.env` contents, expanded database URLs, credentials, or private material into issue comments or CI logs.

## No production deployment

Sprint 5C builds and runs containers only on the local machine or CI runner. It does not push images, modify GitHub Pages, provision a public environment, merge the stacked PR chain, or deploy production infrastructure.
