# Sprint 6A — Production Delivery Design

**Status:** approved architecture, implementation not started  
**Branch:** `feat/6a-production-delivery`  
**Base:** `main` after Sprint 5D merge (`512baaaa730c39b20d22ec5faa1bca727cae6283`)  
**Provider:** Railway  
**Primary goal:** make the verified Sprint 5D application deployable as a real, same-origin production service without weakening the publication, moderation, security, or fallback boundaries already proven in staging.

## 1. Scope

Sprint 6A turns the existing staging-shaped stack into a production delivery system. It does **not** add a new collector, AI publisher, public mutation API, browser authentication, or automatic publication. Those remain separate concerns for Sprint 6B and later.

The production release must preserve the same user-visible behavior already proven by Sprint 5D:

- the static frontend is immediately usable;
- the browser reads active Publications through one same-origin `GET /api/v1/publications` request;
- API outage falls back to static guides;
- Publication authority remains PostgreSQL;
- Redis/workers never become public-read authority;
- migrations fail closed;
- publication is never created by the browser or gateway;
- no CORS expansion is required.

## 2. Selected deployment approach

### Selected — Railway full-stack same-origin

Railway hosts one public gateway service and one private backend service in the same project/environment, together with Railway PostgreSQL and Redis services.

This is selected because it is the smallest production change from the exact topology already exercised in Sprint 5C/5D.

### Rejected — GitHub Pages plus a public Railway API

This would require a separate public backend origin, browser CORS policy, public API host lifecycle, and additional failure/security handling. It provides no benefit to the current product and weakens the same-origin boundary already tested.

### Rejected — provider migration before first production release

Moving to another provider would force a new deployment model before the current one has been proven in production. Provider portability is retained through Dockerfiles, environment variables, and the existing Compose staging model; it is not a reason to change providers during this sprint.

## 3. Production architecture

```text
Internet
   |
   v
Railway public domain / custom domain
   |
   v
Gateway service (Caddy + static Next export)
   |                    \
   | static files         \ /api/v1/* and /health/*
   v                       v
Browser                 Backend service (Fastify)
                           |              |
                           v              v
                    Railway Postgres   Railway Redis
```

### Gateway service

Responsibilities:

- the only application service with a public HTTP domain;
- serve the immutable static frontend export;
- proxy `/api/v1/*` to the backend over Railway private networking;
- proxy `/health/*` only for operational health/smoke use;
- never cache Publication API responses;
- return a sanitized gateway error when the backend is unavailable;
- start independently from backend/database readiness so static fallback remains available.

The frontend build keeps:

```text
NEXT_PUBLIC_PUBLIC_API_BASE_URL=same-origin
```

No production hostname is embedded in the browser bundle.

### Backend service

Responsibilities:

- run the existing Fastify API image;
- bind to `0.0.0.0` on a fixed internal `PORT=3001`;
- expose no Railway public domain;
- read/write PostgreSQL according to the existing domain commands;
- use Redis for queue/lifecycle concerns only;
- keep the Publication HTTP boundary GET-only.

Gateway connects to the backend through Railway private DNS, using an environment/reference value derived from the backend service private domain and its explicit internal port.

### PostgreSQL

- Railway PostgreSQL service;
- private connectivity only for application operation;
- persistent storage owned by the database service;
- no application-managed local volume;
- production `DATABASE_URL` is supplied as a Railway reference variable, never committed.

### Redis

- Railway Redis service;
- private connectivity only;
- `REDIS_URL` supplied as a Railway reference variable;
- not part of public Publication authority;
- worker scheduling remains disabled in Sprint 6A unless explicitly needed for an existing production lifecycle command.

## 4. Repository production artifacts

Sprint 6A will add production-specific deployment assets without changing the proven staging assets:

```text
deploy/production/
  Caddyfile
  Dockerfile.gateway
  railway.gateway.toml
  production.env.example

docs/runbooks/
  production-delivery.md

.github/workflows/
  production-release-gate.yml
```

The backend will gain a Railway config file scoped to its monorepo service, expected at:

```text
backend/railway.toml
```

Railway service settings must point to the correct absolute config path because Config-as-Code lookup is independent of a service Root Directory.

## 5. Railway service configuration

### Gateway

Expected service settings:

- source: this GitHub repository;
- root directory: repository root;
- config path: `/deploy/production/railway.gateway.toml`;
- Dockerfile: `/deploy/production/Dockerfile.gateway`;
- public domain: enabled;
- `PORT=8080`;
- healthcheck path: `/`;
- restart policy: `ON_FAILURE` or stricter equivalent supported by current Railway Config-as-Code;
- backend private URL supplied using a Railway reference variable, not a committed hostname.

### Backend

Expected service settings:

- source: this GitHub repository;
- root directory: `/backend`;
- config path: `/backend/railway.toml`;
- Dockerfile: `/backend/Dockerfile`;
- no public domain;
- `NODE_ENV=production`;
- `HOST=0.0.0.0`;
- `PORT=3001`;
- `DATABASE_URL` references Railway Postgres;
- `REDIS_URL` references Railway Redis;
- healthcheck path: `/health/ready`;
- pre-deploy command: `node dist/src/migrate-cli.js`;
- start command: existing backend image default unless Config-as-Code must make it explicit.

If the pre-deploy migration exits non-zero, deployment must stop and no new backend deployment may receive traffic.

## 6. Production gateway routing

Production Caddy behavior mirrors the tested staging contract while replacing the Docker Compose hostname with a Railway-supplied private backend origin.

Routing rules:

```text
/api/v1/*  -> backend private origin, Cache-Control: no-store
/health/*  -> backend private origin, Cache-Control: no-store
/*         -> static export with SPA/static fallback behavior
```

Constraints:

- no open reverse proxy;
- no arbitrary upstream supplied by browser input;
- only one backend origin from trusted environment configuration;
- no Authorization header injection;
- no CORS headers;
- gateway errors must not expose private Railway domains or credentials.

## 7. Migration and database safety

The existing checksum-protected, append-only migration system remains authoritative.

Production release order:

1. build backend image;
2. run migration CLI as Railway pre-deploy command;
3. if migration fails, abort deployment;
4. if migration passes, start the new backend deployment;
5. healthcheck `/health/ready` must return HTTP 200 before traffic is accepted;
6. gateway remains available throughout because it is independently deployed and static-first.

Sprint 6A does not add automated down migrations.

Application rollback means redeploying the previous verified application revision. Database rollback remains forward-only/manual according to the existing migration policy.

## 8. Production data state

Sprint 6A is allowed to launch with zero active Publications. That state is valid:

- the public API returns a valid empty envelope;
- the static frontend remains fully useful;
- no synthetic Sprint 5D rehearsal data is inserted into production;
- no direct SQL seed may manufacture a production Publication.

Real automatically discovered content enters the backend authority chain in Sprint 6B. Any initial real Publication before Sprint 6B must use the existing production domain command chain and publisher authorization, not the rehearsal fixture.

## 9. Deployment workflow

A new production workflow will be explicit and separate from the existing staging/release-candidate workflows.

### Trigger

Production deployment is permitted only from `main` and only for a commit that has passed the production release gate.

The first implementation should prefer `workflow_dispatch` for the actual production deployment boundary. Automatic deploy-on-push may be enabled only after the manual path has been exercised successfully and rollback has been proven against a real Railway environment.

### Release gate

Before a deployment is authorized, the workflow must verify:

- checkout is the exact requested `main` SHA;
- frontend dependency install;
- community/static validation;
- frontend lint;
- public-data tests;
- staging and release source contracts;
- full frontend static build and rendered HTML tests;
- backend dependency install;
- backend typecheck;
- all backend tests;
- backend build;
- runtime `npm audit --omit=dev --audit-level=high`;
- production Config-as-Code source contracts;
- production gateway image build;
- backend image build;
- no committed production secret;
- no public backend URL configuration;
- no CORS expansion;
- no public Publication mutation route;
- no automatic Publication creation;
- repository cleanliness.

The release gate and the deploy action are separate jobs. A deploy job must depend on a successful release-gate job.

## 10. Actual deployment authorization

No Railway token will be committed to the repository.

Preferred authorization order:

1. Railway GitHub repository integration and service-level automatic builds from `main`, with the application release workflow serving as a required quality boundary; or
2. a GitHub Actions deploy job using a Railway token stored only as an Actions secret, if an explicit CLI deployment is required.

Because this ChatGPT session currently has no Railway connector, repository implementation can fully create and verify the production manifests/workflows, but first-time Railway project/service creation and secret binding require the external Railway account/GitHub integration. This is an operational binding step, not a reason to weaken or simulate production deployment.

## 11. Production smoke verification

After a real production deployment, verify through the public gateway domain:

1. `GET /` -> 200 and contains the expected application marker;
2. `GET /health/live` -> 200;
3. `GET /health/ready` -> 200;
4. `GET /api/v1/publications` -> 200 with schemaVersion 1 and a closed envelope;
5. `POST /api/v1/publications` -> 404/405 and never mutates data;
6. browser hydration completes;
7. if Publication list is empty, static data remains visible;
8. if backend is temporarily unavailable, gateway still serves `/` and browser falls back to static data;
9. restored backend returns valid Publication reads without frontend rebuild.

Smoke diagnostics must print endpoint class/status only. They must not print database URLs, Redis URLs, Railway private domains containing secret material, or environment dumps.

## 12. Rollback rehearsal

Before production delivery is declared complete, a real-environment rollback rehearsal must prove:

- deploy verified revision A;
- deploy verified revision B with no schema-destructive change;
- roll application back to A using Railway deployment rollback/redeploy capability;
- gateway remains available;
- backend returns healthy;
- Publication read contract remains valid;
- no database restore is required for an application-only rollback.

If a schema change is not backward compatible with A, the release must not claim rollback readiness and must be redesigned as an expand/migrate/contract sequence before production.

## 13. Security boundaries

Production delivery must preserve all of these:

- only gateway is public;
- backend has no public Railway domain;
- Postgres and Redis have no application-required public exposure;
- no credentials in source control;
- no browser auth token;
- no CORS expansion;
- no public mutation route;
- no automatic Publication;
- no raw SQL Publication seeding;
- no deployment from an unverified branch;
- no workflow that prints secret environment variables;
- no lowering of runtime audit severity to make a release pass.

## 14. Failure behavior

### Backend unavailable

- gateway continues serving static frontend;
- API proxy returns sanitized 5xx;
- browser switches to the existing static fallback state;
- no client polling/retry loop is introduced.

### PostgreSQL unavailable

- backend readiness fails;
- new backend deployment cannot become healthy;
- gateway remains static-available;
- public read fails safely.

### Redis unavailable

- backend readiness behavior remains as currently implemented;
- public Publication authority is still PostgreSQL;
- no alternate cache becomes authoritative.

### Migration failure

- Railway pre-deploy command exits non-zero;
- new backend deployment is blocked;
- previous healthy deployment remains the serving application where Railway deployment lifecycle permits it.

### Gateway deployment failure

- Railway must retain/recover the prior healthy gateway deployment according to its deployment lifecycle;
- backend must not be made public as an emergency workaround.

## 15. Observability

Sprint 6A adds only production-essential diagnostics:

- gateway access/error status sufficient to distinguish static vs proxy failures;
- backend structured safe logs already used by the application;
- `/health/live` and `/health/ready` as machine-readable health boundaries;
- release workflow records exact Git SHA and release outcome;
- production smoke records only safe status summaries.

A third-party monitoring vendor, distributed tracing platform, or alerting suite is not required for the first production release.

## 16. Acceptance criteria

Sprint 6A is complete only when all of the following are true:

- production deployment assets are version-controlled and tested;
- Railway backend and gateway configuration are deterministic enough to recreate the service build/deploy settings;
- backend migration pre-deploy is fail-closed;
- gateway and backend images build from a clean checkout;
- only gateway is intended for public exposure;
- the browser remains same-origin and requires no CORS change;
- existing Sprint 5D regression/rehearsal gates remain green;
- production security gate passes with no high/critical runtime dependency finding;
- a real Railway environment is bound to the repo/account;
- production public smoke passes on an exact `main` SHA;
- application rollback is rehearsed successfully on the real environment;
- no production secret is committed;
- no synthetic rehearsal Publication is inserted into production;
- release evidence records the deployed Git SHA.

The completion marker is:

```text
PRODUCTION_DELIVERY_READY
```

This marker may be emitted only after **real-environment** smoke and rollback rehearsal succeed. Repository-only or CI-only validation must never emit it.

## 17. Explicit exclusions

Sprint 6A does not implement:

- Collector -> PostgreSQL authority bridge;
- automated Bilibili/Douyin discovery scheduling;
- AI extraction/translation/publication;
- public write APIs;
- publisher UI;
- browser authentication;
- automatic Publication creation;
- automatic rollback based on metrics;
- cross-region database failover;
- custom domain purchase/DNS ownership;
- a new monitoring vendor.

Those are intentionally deferred so production delivery can be proven independently before automated discovery begins.

## 18. Next sprint boundary

After `PRODUCTION_DELIVERY_READY`, Sprint 6B will connect the existing community collector to the backend authority chain:

```text
existing collector
  -> Source Policy
  -> Raw Observation
  -> Normalizer
  -> Candidate Registry
  -> Evidence / Review / Moderation / Eligibility
  -> publisher-controlled Publication
  -> public API
  -> frontend
```

Sprint 6B must reuse the existing collector rather than create a competing collector pipeline.