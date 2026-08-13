# Production Delivery Runbook

This runbook is the operational boundary for Sprint 6A and the governed community-ingestion extension in Sprint 6B. Repository validation can establish `PRODUCTION_REPO_READY`; only a real Railway environment deployment, public smoke verification, and a real rollback rehearsal can establish `PRODUCTION_DELIVERY_READY`.

`PRODUCTION_DELIVERY_READY` cannot be emitted by CI-only validation.

## One-time Railway bootstrap

The initial Railway account/project binding is intentionally external to the repository. Do not simulate it with test data and do not commit resolved credentials, service IDs, private domains, or database URLs.

Create one Railway project with a `production` environment and these six services:

1. `gateway` — sourced from this GitHub repository, repository Root Directory `/`, Config File `/deploy/production/railway.gateway.toml`.
2. `backend` — sourced from this GitHub repository, Root Directory `/backend`, Config File `/backend/railway.toml`.
3. `worker` — sourced from this GitHub repository, Root Directory `/backend`, Config File `/backend/railway.worker.toml`.
4. `collector` — sourced from this GitHub repository, Root Directory `/`, Config File `/deploy/production/railway.collector.toml`.
5. `Postgres` — Railway PostgreSQL service.
6. `Redis` — Railway Redis service.

### Gateway is the only public service

Generate a Railway public domain for `gateway` only. Do not generate a public domain for `backend`, `worker`, `collector`, Postgres, or Redis.

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

PostgreSQL remains Publication authority. Redis is delivery infrastructure and is not a public-read authority.

## Disable GitHub autodeploy

Disable GitHub autodeploy for `gateway`, `backend`, `worker`, and `collector`. A push to `main` must not bypass the exact-SHA production release gate.

The repository workflow `.github/workflows/production-release-gate.yml` is the only authorized repository deployment path after bootstrap.

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
RAILWAY_GATEWAY_SERVICE
PRODUCTION_BASE_URL=https://<gateway-public-domain>
```

Use the exact project/service identifiers from the bootstrapped Railway project. Never place `RAILWAY_TOKEN` in source code, an example env file, workflow output, issue text, or release evidence.

## No rehearsal Publication seed

Do not run Sprint 5D rehearsal seed commands against production. Do not insert a Publication directly with SQL.

Zero active Publications is a valid initial production state. `/api/v1/publications` may return:

```json
{"schemaVersion":1,"publications":[]}
```

The static frontend remains usable. Any real Publication must traverse the existing domain authority and publisher authorization chain.

## Sprint 6B governed community ingestion

Sprint 6B connects the existing community discovery collector to the backend chain:

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

The collector is discovery-only authority. It may create a governed Observation through the one-shot importer, but it cannot create Candidate, Evidence, Moderation, Eligibility, or Publication rows directly.

The legacy registry field `autoPublish` is ignored by the backend bridge. It does not grant publisher permission and it does not bypass Evidence, Human Review, Moderation, or Eligibility.

The importer stores only bounded provenance metadata plus the canonical normalization snapshot. Raw page HTML, full title text, subtitle/transcript bodies, comment text, and image bytes are not written by the bridge.

The `worker` runs the durable outbox dispatcher together with Normalization, Eligibility, and Publication projection consumers. PostgreSQL remains authority; Redis/BullMQ transports event identity and delivery only.

The `collector` is a private cron service with schedule:

```text
0 */6 * * *
```

The scheduled process runs `scripts/collect-community-candidates.mjs`, then `backend/dist/src/community-import-cli.js`, then exits. A rerun of unchanged collector input is idempotent.

Do not generate a public domain for `worker` or `collector`. Do not add an HTTP mutation endpoint, browser token, or CORS exception for ingestion.

### Sprint 6B first-run evidence

After a real production deployment, wait for one scheduled collector execution or invoke the same one-shot process through the private Railway service controls. Verify all of the following without exposing private URLs or credentials:

1. the collector process exits successfully;
2. `community-collector-v1` exists with the expected active source-policy revision;
3. structurally valid input creates or replays governed Observations;
4. `RawObservationIngested` outbox events are delivered to Normalization and Candidate processing is observable in PostgreSQL;
5. replaying unchanged input does not create duplicate Observations;
6. no Publication is created merely because collector score/status or legacy `autoPublish` is positive.

Repository-only completion for this work is:

```text
SPRINT_6B_REPO_READY
```

Do not treat that marker as proof that the real cron execution has run.

## Release procedure

A release candidate must first be merged to `main`. Copy the full 40-character commit SHA intended for production.

In GitHub:

```text
Actions -> Production release gate -> Run workflow
release_sha=<full main SHA>
```

The workflow verifies that `release_sha` is a full SHA reachable from `main`, checks out exactly that SHA, runs frontend/backend regression, runtime audit, source contracts, and production image builds, then requires the `production` GitHub environment before the deploy job.

If any Railway/GitHub binding is absent, deployment fails closed before `railway up` runs.

Backend deploys first. Its Railway Config-as-Code executes the migration CLI as a pre-deploy command. A failed migration prevents the new backend release from becoming healthy. The private worker deploys next, then the private collector, then the gateway. Gateway deployment therefore remains last in the exact-tree application sequence.

## Production smoke

After the deploy commands complete, the workflow runs the two bounded probes against `PRODUCTION_BASE_URL`:

```text
npm run production:smoke
npm run production:browser-smoke
```

The HTTP probe verifies:

- `GET /` -> 200;
- `GET /health/live` -> 200;
- `GET /health/ready` -> 200;
- `GET /api/v1/publications` -> schemaVersion 1 with a publications array;
- `POST /api/v1/publications` -> 404/405 and no mutation route.

The browser probe confirms LÕI.META/Samira static content hydrates and that the public-data state is safe. It rejects Sprint 5D rehearsal IDs.

Smoke output records endpoint class/status only. It does not print the full public URL, Railway private domain, `DATABASE_URL`, `REDIS_URL`, or environment dumps.

A successful repository release workflow may record:

```text
PRODUCTION_DEPLOYED_AND_SMOKE_VERIFIED release_sha=<sha>
```

That message is not the final Sprint 6A/6B production completion marker.

## Rollback rehearsal

A real Railway rollback must be rehearsed before production delivery is declared complete.

1. Deploy verified revision A from `main` with the production workflow and record A's Git SHA and Railway deployment identifier/timestamp.
2. Deploy verified revision B with no schema-destructive change and verify both production smoke probes.
3. In the Railway dashboard, open the backend service Deployments view, select the previous healthy deployment A, and use the available Rollback action.
4. Roll back/redeploy the matching verified worker and collector revisions when their runtime contract changed between A and B. If the gateway also changed, rollback/redeploy the matching gateway revision so the application set is consistent.
5. Wait for `/health/ready` to return 200 through the public gateway.
6. Run `npm run production:smoke` and `npm run production:browser-smoke` against the public gateway again.
7. Confirm the Publication read contract remains valid and no database restore was required.

Do not substitute a redeploy of the current/latest deployment for this historical rollback proof. If a schema change makes A incompatible with the migrated schema, stop and redesign the release using an expand/migrate/contract sequence before claiming rollback readiness.

## Evidence and readiness states

### PRODUCTION_REPO_READY

This marker means repository/config/workflow validation is complete. Record only:

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
- PostgreSQL unavailable: backend readiness fails; do not expose backend publicly as a workaround.
- Redis unavailable: readiness/lifecycle may fail, but PostgreSQL remains Publication authority and pending outbox work remains durable in PostgreSQL.
- Worker unavailable: public read remains available from PostgreSQL; new asynchronous Candidate/Eligibility/projection processing pauses until the worker recovers.
- Collector unavailable: no new community Observations are imported; existing Publication/public-read state remains unchanged.
- Migration failure: new backend deployment must fail before healthy activation.
- Gateway deployment failure: keep/restore the prior healthy gateway; never expose backend directly to the Internet.
