# Sprint 5C — Environment & Deployment Integration Design

## Status

Approved direction from the Sprint 5C kickoff: staging-only environment integration, same-origin frontend/API access, no production deployment.

Base commit: `fadc3b2ff41b8aaba45cc27bd9625dec7399b40f` (Sprint 5B exact head).

## Goal

Create a reproducible staging environment that proves the static public frontend can read the Sprint 5A Publication API through a same-origin gateway while preserving the Sprint 5B static fallback and all existing publication safety boundaries.

The environment must be runnable locally and in CI without selecting a cloud provider, provisioning DNS, publishing images, or deploying to production.

## Approaches considered

### 1. Same-origin staging gateway — selected

Serve the exported frontend and proxy `/api/v1/*` to the backend behind one HTTP origin.

Advantages:

- no browser CORS expansion;
- no browser credential or token;
- provider-neutral staging package;
- static frontend remains available when the backend is unavailable;
- one public network entry point;
- closely matches the desired production topology without enabling production.

Trade-off: introduces a small gateway container and deployment configuration.

### 2. Separate frontend and API origins

Keep GitHub Pages as the frontend and expose a separate staging API origin with a strict CORS allowlist.

Advantages: fewer changes to frontend hosting.

Rejected for Sprint 5C because it expands the browser cross-origin boundary, requires a concrete public API host, and makes staging depend on external DNS/TLS configuration.

### 3. Build-time Publication snapshot

Fetch API data while building the static frontend.

Rejected because active-version rollback would not appear until the next build, and build availability would depend on the backend.

## Architecture

The staging topology contains four runtime roles:

1. **Gateway**
   - the only service with a host-published port;
   - serves the static frontend export;
   - proxies `/api/v1/*` to the backend over the private Compose network;
   - proxies backend health endpoints for smoke testing;
   - does not cache Publication responses.

2. **Backend**
   - runs the existing Fastify public-read API;
   - remains internal to the Compose network;
   - reads Publication authority from PostgreSQL;
   - receives no browser token and exposes no Publication mutation route.

3. **PostgreSQL 17**
   - stores the existing production-foundation schema and Publication authority;
   - is not published to the host network by default;
   - uses a named staging volume.

4. **Redis 7**
   - satisfies the existing backend resource lifecycle and readiness contract;
   - is not part of the public Publication read route;
   - is not published to the host network by default.

A one-shot migration service runs before the backend. The normalization/eligibility/publication worker is intentionally not started by the default Sprint 5C staging profile. This avoids introducing background processing into a public-read integration sprint.

## Frontend same-origin configuration

Sprint 5B requires `NEXT_PUBLIC_PUBLIC_API_BASE_URL` to enable runtime reads. Sprint 5C adds the closed sentinel value:

```text
same-origin
```

When this exact value is configured, the browser adapter requests the relative URL:

```text
/api/v1/publications
```

Absolute `http:` and `https:` origins remain supported for existing tests and future environments. Empty values remain static-only. Other relative values and credential-bearing URLs remain invalid.

The static frontend image is built with:

```text
NEXT_PUBLIC_PUBLIC_API_BASE_URL=same-origin
```

No staging hostname is embedded in JavaScript, so the same artifact can run behind any staging host.

## Repository components

Planned additions:

- `deploy/staging/compose.yml` — staging service graph and health dependencies;
- `deploy/staging/Caddyfile` — static serving and same-origin reverse proxy;
- `deploy/staging/Dockerfile.frontend` — deterministic static frontend image;
- `backend/Dockerfile` — backend build/runtime image;
- `backend/src/migrate-cli.ts` — one-shot migration entrypoint;
- `deploy/staging/.env.example` — placeholders and non-secret local defaults;
- `scripts/staging-smoke.mjs` — runtime HTTP contract checks;
- `docs/runbooks/staging-environment.md` — start, verify, outage, rollback, and teardown procedures;
- `.github/workflows/sprint-5c-staging-integration.yml` — read-only CI integration gate.

Existing files may be updated only where required for same-origin resolution, scripts, tests, and contract assertions.

## Data flow

### Normal operation

1. Browser requests `/` from the gateway.
2. Gateway serves the exported frontend.
3. Hydrated frontend resolves `same-origin` to `/api/v1/publications`.
4. Browser sends one GET request to the gateway.
5. Gateway proxies the request to the internal backend.
6. Backend reads the active immutable Publication versions from PostgreSQL.
7. Frontend validates the closed schema and overlays resolved augment/item IDs onto static localized guides.

### Backend outage

1. Gateway continues serving the static frontend.
2. The API request returns a gateway failure without raw backend details.
3. Sprint 5B catches the request failure and retains the complete static guide.
4. No retry, polling, timer, write, or automatic publication is triggered.

### Database or Redis outage

- backend readiness fails closed;
- the gateway still serves static files;
- Publication reads fail and the frontend remains on static data;
- no fallback data is written to another authority.

## Environment variables

The staging contract uses server-side values for:

- `DATABASE_URL`;
- `REDIS_URL`;
- `NODE_ENV=production`;
- `HOST=0.0.0.0`;
- `PORT=3001`.

The frontend build uses only:

- `NEXT_PUBLIC_PUBLIC_API_BASE_URL=same-origin`.

The repository must not contain real passwords, API tokens, private keys, cloud credentials, production URLs, or production database values. The example environment file uses placeholders and is not a production secret source.

## Network and security boundaries

- only the gateway port is published;
- PostgreSQL, Redis, and backend ports remain private to the Compose network;
- no CORS middleware or permissive origin header is added;
- no browser authorization header is added;
- no registry push, `git push`, cloud deploy command, Pages deployment, or infrastructure mutation appears in the Sprint 5C gate;
- GitHub Actions permissions remain `contents: read`;
- Publication HTTP methods remain GET-only.

## Migration behavior

The migration container:

- runs the existing checksum-verified append-only migrations;
- exits successfully before backend startup;
- blocks backend startup on checksum mismatch or database failure;
- does not perform destructive or down migrations.

Application rollback means running the previously verified application artifact or commit. Schema rollback is not automated; database migrations remain forward-only and checksum-protected.

## Testing strategy

### Unit and contract tests

- `same-origin` resolves to `/api/v1/publications`;
- absolute HTTP(S) origins still resolve correctly;
- credential-bearing and malformed values remain rejected;
- adapter remains GET-only and one-shot;
- no timer, retry, mutation method, browser token, or CORS dependency is introduced.

### Build tests

- frontend static export succeeds with `same-origin` configuration;
- backend image builds from the compiled TypeScript output;
- frontend/gateway image builds from the static export;
- Compose configuration resolves with only example/test values;
- no production hostname or credential appears in generated artifacts.

### Runtime integration tests

The CI gate starts the full staging stack and verifies:

1. gateway root returns the static application;
2. proxied backend live and ready endpoints succeed;
3. proxied Publication list returns the closed JSON envelope;
4. no Publication mutation endpoint is available;
5. PostgreSQL and Redis have no published host ports;
6. stopping the backend leaves `/` available while `/api/v1/publications` fails safely;
7. restarting the backend restores the read path;
8. teardown removes containers and ephemeral CI volumes.

The test may seed only the minimal deterministic authority graph needed to produce a public Publication response. It must not call an automatic publish route because none exists.

## CI gate

The Sprint 5C workflow runs on pull requests and manual dispatch. It performs:

- existing Sprint 5B frontend/backend gates;
- focused same-origin tests;
- Docker/Compose configuration validation;
- staging image builds;
- staging stack startup;
- migration and health verification;
- normal-path and backend-outage smoke tests;
- repository cleanliness and deployment guards;
- unconditional Compose teardown.

It builds locally on the runner and does not push images or deploy an environment.

## Observability and diagnostics

Smoke failures report only:

- failed component or HTTP contract;
- safe status code and endpoint name;
- container health/status summaries.

Logs must not print database URLs containing credentials, environment-file contents, or raw secrets.

## Scope exclusions

Sprint 5C does not include:

- production deployment;
- cloud-provider selection or provisioning;
- DNS, TLS certificate, CDN, WAF, or public load-balancer configuration;
- GitHub Pages publication changes;
- CORS expansion;
- browser authentication;
- Publication mutation UI or endpoint;
- automatic publication;
- worker scheduling or background refresh;
- monitoring vendor integration;
- merge of the stacked PR chain.

## Acceptance criteria

Sprint 5C is complete when:

- the staging bundle is reproducible from the Sprint 5C branch;
- frontend and API operate through one origin;
- the active Publication read path works through the gateway;
- static frontend availability survives backend outage;
- all prior frontend/backend tests remain green;
- the staging integration gate and deploy dry-run pass on the exact head;
- the draft PR remains unmerged and no production deployment occurs.
