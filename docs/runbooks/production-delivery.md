# Production Delivery Runbook

This runbook is the operational boundary for Sprint 6A/6B production delivery and the Sprint 8F inert AI-automation extension. Repository validation can establish `PRODUCTION_REPO_READY` and, for the Sprint 8F package, `AI_AUTOMATION_PRODUCTION_REPO_READY`. Only a separately authorized real Railway environment deployment plus the required live verification may establish delivery markers.

`PRODUCTION_DELIVERY_READY` cannot be emitted by CI-only validation. Likewise, `AI_AUTOMATION_DISABLED_DELIVERY_READY` cannot be claimed by repository-only CI.

## One-time Railway bootstrap

The initial Railway account/project binding is intentionally external to the repository. Do not simulate it with test data and do not commit resolved credentials, service IDs, private domains, or database URLs.

Create one Railway project with a `production` environment and these seven services:

1. `gateway` — sourced from this GitHub repository, repository Root Directory `/`, Config File `/deploy/production/railway.gateway.toml`.
2. `backend` — sourced from this GitHub repository, Root Directory `/backend`, Config File `/backend/railway.toml`.
3. `worker` — sourced from this GitHub repository, Root Directory `/backend`, Config File `/backend/railway.worker.toml`.
4. `collector` — sourced from this GitHub repository, Root Directory `/`, Config File `/deploy/production/railway.collector.toml`.
5. `ai-automation` — sourced from this GitHub repository, Root Directory `/backend`, Config File `/backend/railway.ai-automation.toml`. It reuses `backend/Dockerfile` and starts exactly `node dist/src/ai-automation-worker.js`.
6. `Postgres` — Railway PostgreSQL service.
7. `Redis` — Railway Redis service.

The `ai-automation` service bootstrap is external infrastructure setup. Creating the service or running the real production release workflow requires separate explicit authorization; repository readiness does not authorize Railway mutation.

### Gateway is the only public service

Generate a Railway public domain for `gateway` only. Do not generate a public domain for `backend`, `worker`, `collector`, `ai-automation`, Postgres, or Redis. `ai-automation` has no HTTP health/status endpoint and no public domain.

Set gateway variables using Railway references:

```text
BACKEND_ORIGIN=http://${{backend.RAILWAY_PRIVATE_DOMAIN}}:3001
PORT=8080
```

The gateway serves the static frontend and proxies only `/api/v1/*` and `/health/*` to `BACKEND_ORIGIN` over Railway private networking.

Set backend variables:

```text
NODE_ENV=production
HOST=0.0.0.0
PORT=3001
DATABASE_URL=${{Postgres.DATABASE_URL}}
REDIS_URL=${{Redis.REDIS_URL}}
```

Set worker variables:

```text
NODE_ENV=production
DATABASE_URL=${{Postgres.DATABASE_URL}}
REDIS_URL=${{Redis.REDIS_URL}}
```

Set collector variables:

```text
NODE_ENV=production
DATABASE_URL=${{Postgres.DATABASE_URL}}
```

Set `ai-automation` variables for inert delivery only:

```text
NODE_ENV=production
DATABASE_URL=${{Postgres.DATABASE_URL}}
REDIS_URL=${{Redis.REDIS_URL}}
AI_DISCOVERY_SCHEDULER_ENABLED=false
```

Do not provision an OpenAI API key, provider model, provider endpoint override, or any scheduler-true value as part of Sprint 8F inert delivery. PostgreSQL remains Publication authority. Redis is delivery infrastructure and is not a public-read authority.

## Disable GitHub autodeploy

Disable GitHub autodeploy for `gateway`, `backend`, `worker`, `collector`, and `ai-automation`. A push to `main` must not bypass the exact-SHA production release gate.

The repository workflow `.github/workflows/production-release-gate.yml` is the only authorized repository deployment path after bootstrap, and running it still requires separate explicit authorization plus the protected `production` GitHub environment.

## GitHub production environment

Create a `production GitHub environment` for this repository.

Store the Railway project token only as the environment secret:

```text
RAILWAY_TOKEN
```

Add safe environment variables without secret values:

```text
RAILWAY_PROJECT_ID
RAILWAY_ENVIRONMENT=production
RAILWAY_BACKEND_SERVICE
RAILWAY_WORKER_SERVICE
RAILWAY_COLLECTOR_SERVICE
RAILWAY_AI_AUTOMATION_SERVICE
RAILWAY_GATEWAY_SERVICE
PRODUCTION_BASE_URL=https://<gateway-public-domain>
```

Use the exact project/service identifiers from the bootstrapped Railway project. Missing `RAILWAY_AI_AUTOMATION_SERVICE`, or any other required binding, must fail closed before the first Railway mutation. Never place `RAILWAY_TOKEN` in source code, an example env file, workflow output, issue text, or release evidence.

## No rehearsal Publication seed

Do not run Sprint 5D rehearsal seed commands against production. Do not insert a Publication directly with SQL.

Zero active Publications is a valid initial production state. `/api/v1/publications` may return:

```json
{"schemaVersion":1,"publications":[]}
```

The static frontend remains usable. Any real Publication must traverse the existing domain authority and publisher authorization chain. Delivering `ai-automation` does not grant Candidate, Human Review, Moderation, Eligibility, Evidence, or Publication authority.

## Sprint 6B governed community ingestion

Sprint 6B connects the existing private community discovery collector to the governed backend chain:

```text
public community sources
  -> existing collector
  -> community inbox
  -> community-collector-v1 Source Policy
  -> RawObservation
  -> outbox/BullMQ Normalization
  -> Candidate
  -> Evidence / Human Review / Moderation / Eligibility
  -> publisher-controlled Publication
  -> public read projection
```

The collector is discovery-only authority. The legacy registry field `autoPublish` is ignored by the backend bridge. The worker runs durable asynchronous processing; PostgreSQL remains authority and Redis/BullMQ transports event identity and delivery only.

The `collector` remains private and uses its approved schedule. Do not add an HTTP mutation endpoint, browser token, or CORS exception for ingestion.

Repository-only completion for the Sprint 6B work remains:

```text
SPRINT_6B_REPO_READY
```

Do not treat that marker as proof that a real cron execution has run.

## Sprint 8F inert AI automation delivery

Sprint 8F packages the already-governed 8D/8E automation runtime for private production delivery while keeping it inert. The repository-only completion marker is:

```text
AI_AUTOMATION_PRODUCTION_REPO_READY
```

That marker means code/config/tests/workflow/runbooks are ready for review. It does not mean Railway was changed.

A separately authorized real deployment may emit:

```text
AI_AUTOMATION_DISABLED_DELIVERY_READY release_sha=<sha>
```

only after the exact `ai-automation` deployment reaches Railway `SUCCESS`, and its exact deployment logs contain the disabled-ready marker:

```text
AI_AUTOMATION_DISABLED_READY scheduler_enabled=false provider_configured=false
```

The latter is verified against the exact deployment ID. It appears only after Sprint 8E stale execution recovery, scheduler reconciliation to disabled, and BullMQ worker readiness. It is not an activation marker and must never be replaced by `latest` deployment inference.

## Release procedure

A release candidate must first be merged to `main`. Copy the full 40-character commit SHA intended for production. Do not run the production workflow as part of Sprint 8F repository implementation itself; a real production run requires separate explicit authorization.

In GitHub, after that authorization:

```text
Actions -> Production release gate -> Run workflow
release_sha=<full main SHA>
```

The workflow verifies that `release_sha` is a full SHA reachable from `main`, checks out exactly that SHA, runs frontend/backend regression, runtime audit, source contracts, and production image builds, then requires the `production` GitHub environment before the deploy job.

The deploy job is bounded by `timeout-minutes: 90`. Railway CLI is pinned to `@railway/cli@5.30.1`. Each application deployment is created with `railway up --detach --json`; the workflow accepts deployment identity only from the returned `deploymentId`.

The exact deployment ID sequence is:

```text
backend
  -> verify exact deployment ID SUCCESS
worker
  -> verify exact deployment ID SUCCESS
collector
  -> verify exact deployment ID SUCCESS
ai-automation
  -> verify exact deployment ID SUCCESS
  -> verify exact disabled-ready marker
 gateway
  -> verify exact deployment ID SUCCESS
```

The actual application release order is therefore `backend -> worker -> collector -> ai-automation -> gateway`. The gateway remains last. No next deployment is created until the prior exact deployment is verified successful.

The backend Railway Config-as-Code executes the migration CLI as a pre-deploy command. A failed migration prevents the new backend release from becoming healthy. The AI service stays private and disabled; no provider credential or activation input is present in the release workflow.

Never infer a deployment by `latest`, timestamp, sleep-and-select, or list order. Status polling is bounded to the captured ID; an unknown terminal state fails closed.

## Production smoke

After all exact deployment checks complete, the workflow runs the same bounded public probes against `PRODUCTION_BASE_URL`:

```text
npm run production:smoke
npm run production:browser-smoke
```

The HTTP probe remains unchanged and verifies:

- `GET /` -> 200;
- `GET /health/live` -> 200;
- `GET /health/ready` -> 200;
- `GET /api/v1/publications` -> schemaVersion 1 with a publications array;
- `POST /api/v1/publications` -> 404/405 and no mutation route.

Sprint 8F adds no `/api/ai/*`, `/health/ai-*`, or public operator endpoint. The browser probe still confirms LÕI.META/Samira static content and safe public-data behavior. Smoke output must not print the full public URL, Railway private domains, `DATABASE_URL`, `REDIS_URL`, credentials, or environment dumps.

A successful real release workflow may record:

```text
PRODUCTION_DEPLOYED_AND_SMOKE_VERIFIED release_sha=<sha>
AI_AUTOMATION_DISABLED_DELIVERY_READY release_sha=<sha>
```

These lines prove a real disabled deployment and smoke, not provider activation.

## Rollback rehearsal

A real Railway rollback must be rehearsed before `PRODUCTION_DELIVERY_READY` is declared complete.

1. Deploy verified revision A from `main` through the protected production workflow and record A's exact Git SHA and deployment IDs.
2. Deploy verified revision B with no schema-destructive change and verify exact deployments plus both production smoke probes.
3. Roll the backend back to the previous verified historical deployment A using Railway controls.
4. Roll back/redeploy the matching worker and collector revisions when their runtime contract changed.
5. Roll back/redeploy the matching `ai-automation` revision when its runtime contract changed, keeping `AI_DISCOVERY_SCHEDULER_ENABLED=false`; verify its exact disabled-ready marker again.
6. If the gateway changed, rollback/redeploy the matching gateway revision so the application set is consistent.
7. Verify `/health/ready`, `npm run production:smoke`, and `npm run production:browser-smoke` again.
8. Confirm Publication reads remain valid and no database restore was required.

Do not substitute a redeploy of the current/latest deployment for historical rollback proof. Rollback must not replay Sprint 8E `IN_FLIGHT` or `UNCERTAIN` provider-execution history. If a schema change makes A incompatible with the migrated schema, stop and redesign the release using an expand/migrate/contract sequence before claiming rollback readiness.

## Evidence and readiness states

### PRODUCTION_REPO_READY

This marker means repository/config/workflow validation is complete. Record only bounded evidence such as:

```text
PRODUCTION_REPO_READY
release_candidate_sha=<sha>
production_contract=PASS
frontend_regression=PASS
backend_regression=PASS
runtime_audit=PASS
production_images=PASS
```

It does not mean Railway is live.

### AI_AUTOMATION_PRODUCTION_REPO_READY

This Sprint 8F marker is allowed only after exact-head repository validation proves the inert AI delivery package. It cannot be used as evidence of a real Railway deployment.

### AI_AUTOMATION_DISABLED_DELIVERY_READY

This marker belongs only to a separately authorized real production deploy job after exact `ai-automation` SUCCESS, exact disabled marker verification, gateway deployment, and production smoke. CI-only validation cannot emit it. It still does not authorize AI provider execution.

### PRODUCTION_DELIVERY_READY

Record this only after the real Railway environment is bound, deployment succeeds, public smoke succeeds, and Rollback rehearsal succeeds:

```text
PRODUCTION_DELIVERY_READY
release_sha=<sha>
rollback_from=<sha>
rollback_to=<sha>
public_smoke=PASS
browser_smoke=PASS
```

Never include secret values, private service domains, database URLs, Redis URLs, or tokens in this evidence.

## Failure handling

- Backend unavailable: gateway remains static-available; API returns sanitized 5xx; browser uses static fallback.
- PostgreSQL unavailable: backend and AI runtime cannot become ready; do not expose private services publicly as a workaround.
- Redis unavailable: queue lifecycle may fail, but PostgreSQL remains authority and pending outbox work remains durable.
- Worker unavailable: public read remains available from PostgreSQL; asynchronous processing pauses until recovery.
- Collector unavailable: no new community Observations are imported; existing Publication/public-read state remains unchanged.
- `ai-automation` unavailable while disabled: no provider call is authorized; public read and core worker paths remain independent. Restore the prior private disabled runtime rather than exposing it publicly.
- Unresolved Sprint 8E `UNCERTAIN` execution: treat it as an activation warning; it is not an inert-deployment blocker and must not be automatically replayed.
- Migration failure: new backend deployment must fail before healthy activation.
- Gateway deployment failure: keep/restore the prior healthy gateway; never expose backend or AI automation directly to the Internet.
