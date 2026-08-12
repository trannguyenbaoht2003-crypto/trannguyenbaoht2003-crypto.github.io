# Sprint 6A — Production Delivery Design

**Status:** approved architecture, implementation not started  
**Branch:** `feat/6a-production-delivery`  
**Base:** `main` after Sprint 5D merge (`512baaaa730c39b20d22ec5faa1bca727cae6283`)  
**Provider:** Railway  
**Primary goal:** deliver the verified Sprint 5D application as a real same-origin production service without weakening Publication authority, moderation, security, migration, rollback, or static-fallback boundaries.

## 1. Scope

Sprint 6A turns the staging-shaped stack into a production delivery system. It does not add a collector, AI publisher, public mutation API, browser authentication, or automatic Publication. Those are separate Sprint 6B+ concerns.

Production must preserve the behavior already proven in Sprint 5D:

- static frontend remains immediately usable;
- browser performs one same-origin `GET /api/v1/publications` request;
- API outage falls back to static guides;
- PostgreSQL remains Publication authority;
- Redis/workers never become public-read authority;
- migrations fail closed;
- no browser/gateway Publication write path exists;
- no CORS expansion is required.

## 2. Selected approach

### Selected — Railway full-stack same-origin

Railway hosts one public gateway, one private backend, Railway PostgreSQL, and Railway Redis in one production project/environment.

This is the smallest change from the exact topology exercised by Sprint 5C/5D.

### Rejected — GitHub Pages + public Railway API

That model would introduce a second public origin, CORS, public API-host lifecycle, and additional browser security behavior without product benefit.

### Rejected — changing provider before first real release

Dockerfiles, environment variables, and Compose already preserve portability. Provider migration is not required to prove the current release model.

## 3. Production architecture

```text
Internet
   |
   v
Railway public/custom domain
   |
   v
Gateway (Caddy + static Next export)
   |                       \
   | static files            \ /api/v1/* + /health/*
   v                          v
Browser                   Backend Fastify
                              |        |
                              v        v
                         Postgres     Redis
```

### Gateway

The gateway is the only application service with public HTTP exposure. It:

- serves the immutable frontend export;
- proxies `/api/v1/*` and `/health/*` over Railway private networking;
- never caches Publication responses;
- returns sanitized proxy failures;
- starts independently from backend/database readiness;
- never injects Authorization or CORS headers.

Frontend build remains:

```text
NEXT_PUBLIC_PUBLIC_API_BASE_URL=same-origin
```

No production hostname is embedded in browser code.

### Backend

The backend:

- runs the existing Fastify image;
- binds `HOST=0.0.0.0`, `PORT=3001`;
- has no public Railway domain;
- uses PostgreSQL for domain authority;
- uses Redis only for queue/lifecycle concerns;
- keeps the Publication HTTP boundary GET-only.

Gateway reaches the backend through a Railway reference variable derived from the backend private domain plus explicit internal port.

### PostgreSQL and Redis

Railway-provided PostgreSQL and Redis services remain private for application operation. `DATABASE_URL` and `REDIS_URL` are Railway reference variables, never committed values. Application services do not manage database persistence volumes themselves.

## 4. Production repository assets

Sprint 6A will add production assets without replacing the proven staging assets:

```text
deploy/production/
  Caddyfile
  Dockerfile.gateway
  railway.gateway.toml
  production.env.example

backend/
  railway.toml

docs/runbooks/
  production-delivery.md

.github/workflows/
  production-release-gate.yml
```

Railway Config-as-Code location is explicit because config-file lookup does not follow a monorepo service Root Directory automatically.

## 5. Railway service configuration

### Gateway service

Expected settings:

- repository root as build context;
- config path `/deploy/production/railway.gateway.toml`;
- Dockerfile `/deploy/production/Dockerfile.gateway`;
- public domain enabled;
- `PORT=8080`;
- healthcheck `/`;
- production backend origin supplied only by Railway reference variable;
- GitHub autodeploy **disabled** for Sprint 6A.

### Backend service

Expected settings:

- Root Directory `/backend`;
- config path `/backend/railway.toml`;
- Dockerfile `/backend/Dockerfile`;
- no public domain;
- `NODE_ENV=production`;
- `HOST=0.0.0.0`;
- `PORT=3001`;
- `DATABASE_URL` references Railway Postgres;
- `REDIS_URL` references Railway Redis;
- healthcheck `/health/ready`;
- pre-deploy command `node dist/src/migrate-cli.js`;
- GitHub autodeploy **disabled** for Sprint 6A.

A non-zero pre-deploy migration blocks the new backend deployment.

## 6. Production gateway routing

Production routing mirrors staging while replacing the Compose backend hostname with a trusted environment-supplied private origin:

```text
/api/v1/*  -> backend private origin, Cache-Control: no-store
/health/*  -> backend private origin, Cache-Control: no-store
/*         -> static export
```

The production Caddy configuration must use one trusted backend origin from process environment. It must not accept an upstream from request data, expose the private hostname in error output, or become an open proxy.

## 7. Migration safety

Existing checksum-protected append-only migrations remain authoritative.

Backend deployment order:

1. build backend artifact/image;
2. run `node dist/src/migrate-cli.js` as Railway pre-deploy;
3. abort the deployment if migration fails;
4. start new backend only after migration success;
5. require HTTP 200 from `/health/ready` before deployment is healthy.

No automated down migrations are added.

Application rollback means restoring a previous verified application deployment. Schema changes must remain backward compatible with the rollback candidate; otherwise the release must use an expand/migrate/contract sequence before production.

## 8. Production data state

Zero active Publications is a valid initial production state:

- API returns a valid empty schemaVersion 1 envelope;
- static frontend remains useful;
- Sprint 5D rehearsal records are never seeded into production;
- no direct SQL may manufacture a production Publication.

Real automatically discovered content is Sprint 6B. Any real Publication before 6B must traverse the existing domain authority and publisher authorization path.

## 9. Release gate

The production release workflow is separate from staging/release-candidate workflows.

### Trigger

The actual production workflow uses `workflow_dispatch` with an explicit `release_sha` input.

The workflow must fail unless:

- `release_sha` is a full commit SHA;
- the SHA is reachable from `main`;
- checkout resolves to exactly `release_sha`;
- `release_sha` is still the intended release revision when deploy begins.

Railway GitHub autodeploy remains disabled, so a push to `main` cannot bypass this gate.

### Verification job

Before any deploy command, verify:

- exact-SHA checkout;
- frontend dependency install and community/static validation;
- frontend lint;
- public-data tests;
- staging/release/production source contracts;
- full static build and rendered HTML tests;
- backend dependency install;
- backend typecheck;
- all backend tests;
- backend build;
- `npm audit --omit=dev --audit-level=high`;
- production Config-as-Code contracts;
- production gateway image build;
- backend image build;
- no committed production secret;
- no public backend exposure configuration;
- no CORS expansion;
- no Publication mutation route;
- no automatic Publication creation;
- repository cleanliness.

The deploy job depends on successful completion of this verification job.

## 10. Exact-SHA Railway deployment

The deployment path for Sprint 6A is GitHub Actions -> Railway CLI, not Railway GitHub autodeploy.

A Railway **project token** is stored only as the GitHub Actions secret `RAILWAY_TOKEN`. Project/environment/service identifiers are stored as non-secret repository/environment configuration where safe, or as GitHub environment secrets/variables where appropriate.

The deploy job runs from the exact checked-out `release_sha` and targets the pre-created Railway production project/environment explicitly. It uses Railway CLI CI mode, conceptually:

```text
railway up --ci --project <project> --environment production --service backend
railway up --ci --project <project> --environment production --service gateway
```

The implementation plan must validate the current Railway CLI flag behavior before committing executable workflow syntax.

Backend deploy occurs first. Gateway deploy occurs only after backend deployment succeeds. The production public smoke follows gateway deployment.

The workflow must never create a new Railway project implicitly. If project/service binding is missing, deployment fails closed.

First-time creation of the Railway project, gateway/backend services, PostgreSQL, Redis, service reference variables, domain, and `RAILWAY_TOKEN` binding is an external account bootstrap step because this ChatGPT session has no Railway connector. After that one-time binding, releases are repository-driven and exact-SHA gated.

## 11. Production smoke

After a real deployment, verify through the public gateway domain:

1. `GET /` -> 200 and application marker exists;
2. `GET /health/live` -> 200;
3. `GET /health/ready` -> 200;
4. `GET /api/v1/publications` -> 200 with closed schemaVersion 1 envelope;
5. `POST /api/v1/publications` -> 404/405 and causes no mutation;
6. browser hydration completes;
7. empty Publication list still shows static content;
8. temporary backend failure keeps `/` available and browser falls back to static content;
9. restored backend returns valid Publication reads without frontend rebuild.

Diagnostics print safe endpoint/status summaries only. They never dump environment variables, database URLs, Redis URLs, tokens, or private-domain values.

## 12. Real-environment rollback rehearsal

`PRODUCTION_DELIVERY_READY` requires a real Railway rollback rehearsal:

- deploy verified revision A;
- deploy verified revision B with a backward-compatible schema state;
- use Railway's deployment rollback action on the prior successful deployment;
- verify gateway availability;
- verify backend health;
- verify Publication read contract;
- verify no database restore is required for the application-only rollback.

Railway rollback restores the selected previous deployment image/configuration subject to Railway deployment retention. The runbook must document the retention limitation and the redeploy fallback for older deployments.

## 13. Security boundaries

All of these remain mandatory:

- only gateway public;
- backend private;
- Postgres/Redis need no public application exposure;
- no source-controlled credentials;
- no browser token;
- no CORS expansion;
- no public mutation route;
- no automatic Publication;
- no raw SQL Publication seeding;
- no deployment from an unverified SHA;
- no workflow secret/environment dump;
- no lowering runtime audit severity to pass release;
- Railway autodeploy disabled during Sprint 6A.

## 14. Failure behavior

### Backend unavailable

Gateway serves static frontend; API proxy fails with sanitized 5xx; browser uses existing static fallback; no polling/retry loop is added.

### PostgreSQL unavailable

Backend readiness fails and cannot become healthy; gateway remains static-available; public reads fail safely.

### Redis unavailable

Current readiness behavior remains in force; PostgreSQL remains Publication authority; no cache becomes authoritative.

### Migration failure

Railway pre-deploy exits non-zero and blocks new backend deployment.

### Gateway deployment failure

Backend is never made public as an emergency workaround. Prior healthy gateway deployment/rollback path remains the recovery mechanism.

### Missing Railway binding/token

Deploy job exits before `railway up`; no implicit project/service creation is permitted in CI.

## 15. Observability

Sprint 6A adds production-essential diagnostics only:

- safe gateway access/error status;
- existing backend structured safe logs;
- `/health/live` and `/health/ready` boundaries;
- exact Git SHA recorded by release workflow;
- Railway deployment result recorded without secret values;
- safe public smoke result.

A new monitoring vendor or tracing platform is out of scope for the first production delivery.

## 16. Acceptance criteria

Sprint 6A is complete only when:

- production deployment assets are version-controlled and tested;
- Railway gateway/backend Config-as-Code is reproducible;
- backend migration pre-deploy is fail-closed;
- clean-checkout gateway/backend images build;
- only gateway is public by design and actual Railway binding;
- browser remains same-origin with no CORS change;
- all Sprint 5D regression/rehearsal gates remain green;
- runtime security gate has no high/critical finding;
- a real Railway project/environment is bound;
- GitHub autodeploy is disabled;
- exact-SHA production deployment succeeds through the gated workflow;
- public smoke succeeds on that exact SHA;
- real-environment application rollback rehearsal succeeds;
- no production secret is committed;
- no synthetic rehearsal Publication is inserted;
- release evidence records the deployed Git SHA.

Completion marker:

```text
PRODUCTION_DELIVERY_READY
```

This marker may be emitted only after real-environment deployment, public smoke, and rollback rehearsal succeed. Repository-only or CI-only validation must never emit it.

## 17. Explicit exclusions

Sprint 6A does not implement:

- Collector -> PostgreSQL authority bridge;
- scheduled Bilibili/Douyin discovery;
- AI extraction/translation/publication;
- public write API;
- publisher UI;
- browser authentication;
- automatic Publication;
- metric-triggered automatic rollback;
- cross-region database failover;
- custom-domain purchase/DNS ownership;
- a new monitoring vendor.

## 18. Next sprint boundary

After `PRODUCTION_DELIVERY_READY`, Sprint 6B connects the existing collector to backend authority rather than creating a parallel collector:

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

Sprint 6B preserves the rule that discovery/AI may create evidence-backed Candidates but cannot bypass publisher-controlled Publication.