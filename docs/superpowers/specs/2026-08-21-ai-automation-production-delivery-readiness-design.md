# Sprint 8F — AI Automation Production Delivery Readiness Design

Date: 2026-08-21
Base: `main@c4e2f25c37946572bc85eaaae51d432c689f41e9`
Status: Approved in-chat design intent; implementation not authorized by this document.

## 1. Purpose

Sprint 8F adds the already-built AI automation runtime to the production delivery topology while keeping it deliberately inert.

The sprint separates two authorities that must not be conflated:

- **delivery authority**: the code/runtime can be deployed to production as a private Railway service;
- **provider-spend authority**: the runtime may enable the scheduler, construct an OpenAI provider, and make external AI calls.

Sprint 8F grants only delivery authority.

The production AI automation service must start with:

```text
AI_DISCOVERY_SCHEDULER_ENABLED=false
```

and must not require or use a production OpenAI credential.

## 2. Non-goals

Sprint 8F does not:

- enable the production AI discovery scheduler;
- activate an AI operations policy for production execution;
- provision `OPENAI_API_KEY` or production model configuration;
- make a real OpenAI request;
- add a public AI health/status endpoint;
- auto-materialize Candidate data;
- automate Human Review;
- mutate Moderation or Eligibility from AI;
- create Evidence from AI output;
- create or activate Publication;
- create Railway infrastructure from the repository;
- perform a real production deployment as part of the implementation PR;
- emit `AI_DISCOVERY_PRODUCTION_ACTIVE`.

## 3. Existing architecture retained

The existing authority boundaries remain unchanged:

```text
PostgreSQL = domain / budget / execution authority
Redis + BullMQ = scheduling and delivery only
AI discovery output = advisory AI Run + Proposal only
Publication = independent of AI runtime availability
```

The AI automation runtime remains separate from the core worker.

## 4. Production topology

Before Sprint 8F the production topology is:

```text
gateway
backend
core worker
collector
Postgres
Redis
```

Sprint 8F adds a seventh Railway service:

```text
gateway                 public
backend                 private
core worker             private
collector               private
ai-automation           private
Postgres                private
Redis                   private
```

Only `gateway` may have a public Railway domain.

The AI automation service must not receive a public domain.

Failure or restart of `ai-automation` must not make public reads, backend API reads, the core worker, collector, or existing Publication data unavailable.

## 5. AI automation Railway service

Add:

```text
backend/railway.ai-automation.toml
```

It uses the existing backend Docker image/build context and starts:

```text
node dist/src/ai-automation-worker.js
```

The service does not get a dedicated Dockerfile, package, repository, or HTTP server.

Expected Railway configuration shape:

```toml
[build]
builder = "DOCKERFILE"
dockerfilePath = "Dockerfile"

[deploy]
startCommand = "node dist/src/ai-automation-worker.js"
restartPolicyType = "ON_FAILURE"
restartPolicyMaxRetries = 3
```

No HTTP healthcheck path is added to this worker service.

## 6. Production environment variables

The service receives only the non-provider variables needed for disabled operation:

```text
NODE_ENV=production
DATABASE_URL=${{Postgres.DATABASE_URL}}
REDIS_URL=${{Redis.REDIS_URL}}
AI_DISCOVERY_SCHEDULER_ENABLED=false
```

Sprint 8F must not add any of these to the production release workflow or production environment example:

```text
OPENAI_API_KEY
OPENAI_MODEL
OPENAI_BASE_URL
provider endpoint override
```

Even an empty provider-secret placeholder is out of scope.

## 7. Disabled runtime control flow

Disabled startup must follow this order:

```text
parse disabled config
  -> connect PostgreSQL
  -> connect Redis queue + worker connections
  -> recover stale Sprint 8E provider executions
  -> reconcile desired scheduler state = false
  -> wait until the disabled BullMQ worker connection is ready
  -> emit disabled-ready marker
```

A provider must not be constructed anywhere on this path.

The existing provider control-flow invariant remains:

```text
schedulerEnabled=false
  -> providerConfig is not required
  -> provider factory is not called
```

This must remain true even if an `OPENAI_API_KEY` variable is accidentally present in the process environment.

## 8. Disabled-ready marker

The application emits one safe positive marker only after disabled initialization succeeds:

```text
AI_AUTOMATION_DISABLED_READY scheduler_enabled=false provider_configured=false
```

The marker must not be emitted if any of these fail:

- config parsing;
- PostgreSQL access / Sprint 8E stale recovery;
- Redis queue connection;
- scheduler reconciliation;
- BullMQ worker readiness.

The marker contains no deployment ID, URLs, credentials, prompts, observations, provider data, or model data.

Deployment identity belongs to the deployment verifier, not the application log.

## 9. Scheduler state represented by the marker

`AI_AUTOMATION_DISABLED_READY` means more than the environment flag being false.

It means:

```text
desired scheduler = false
actual scheduler reconciliation completed successfully
provider was not constructed
disabled worker runtime is connected and ready
```

A stale `ai-discovery-hourly-v1` scheduler seeded before startup must be removed before this marker can be emitted.

## 10. Sprint 8E recovery behavior in production

The disabled runtime still performs the existing DB-only Sprint 8E stale recovery sweep.

It preserves the already-approved semantics:

- expired `PREPARED` lease -> clear stale lease; remain `PREPARED`;
- expired `IN_FLIGHT` -> `UNCERTAIN`; never automatically replay provider;
- terminal/reconciled history remains immutable;
- no provider credential is needed for recovery.

`unreconciledUncertain > 0` is an activation warning, not a reason to prevent inert deployment.

Therefore:

```text
deployment readiness != activation readiness
```

## 11. Production release authority

Sprint 8F does not add a separate AI deployment workflow.

The AI service is deployed only through:

```text
.github/workflows/production-release-gate.yml
```

The existing exact-SHA authority remains mandatory:

- `release_sha` is a full 40-character SHA;
- the SHA is reachable from `main`;
- the workflow checks out exactly that SHA;
- deploy re-verifies the same SHA before Railway mutation.

All application services in one release come from the same exact repository tree.

## 12. Production release sequence

The verified sequence becomes:

```text
backend
  -> verify exact deployment terminal SUCCESS
core worker
  -> verify exact deployment terminal SUCCESS
collector
  -> verify exact deployment terminal SUCCESS
ai-automation
  -> verify exact deployment terminal SUCCESS
  -> verify exact-deployment disabled-ready marker
gateway
  -> verify exact deployment terminal SUCCESS
public HTTP smoke
browser smoke
```

Gateway remains last.

If any private service fails readiness verification, gateway for the new release is not deployed.

## 13. Railway CLI version and deterministic deployment identity

The release workflow keeps Railway CLI pinned to:

```text
@railway/cli@5.30.1
```

Sprint 8F replaces build-log-only `railway up --ci` sequencing with a deterministic deployment-ID flow.

For each service, creation uses:

```text
railway up --detach --json \
  --project "$RAILWAY_PROJECT_ID" \
  --environment "$RAILWAY_ENVIRONMENT" \
  --service "$SERVICE" \
  --message "release ${RELEASE_SHA} <service>"
```

For Railway CLI v5.30.1, detached JSON output directly returns the deployment identifier created by that upload.

The workflow/helper must parse the returned `deploymentId` and reject missing/malformed output.

It must never infer the deployment by choosing `latest`, sorting timestamps, or sleeping and selecting the first result.

## 14. Exact deployment status verification

After obtaining the exact ID, status verification polls the service-scoped deployment list:

```text
railway deployment list --json \
  --project "$RAILWAY_PROJECT_ID" \
  --environment "$RAILWAY_ENVIRONMENT" \
  --service "$SERVICE" \
  --limit 100
```

The verifier searches the result for the exact captured deployment ID.

Allowed non-terminal states include Railway building/deploying/initializing/waiting/queued states.

Terminal interpretation:

```text
SUCCESS -> pass
FAILED -> fail
CRASHED -> fail
REMOVED -> fail
other terminal/error condition -> fail closed
```

Polling is bounded:

```text
interval = 5 seconds
per-deployment timeout = 900 seconds
```

The verifier must fail rather than switch to another deployment ID if the target is temporarily absent from the list.

The production deploy job timeout increases only as needed to cover sequential bounded verification; it does not become unbounded.

## 15. Exact AI deployment log verification

For the AI automation service only, after exact deployment status is `SUCCESS`, the verifier reads logs from that exact deployment ID:

```text
railway logs "$DEPLOYMENT_ID" \
  --deployment \
  --json \
  --lines 200 \
  --project "$RAILWAY_PROJECT_ID" \
  --environment "$RAILWAY_ENVIRONMENT" \
  --service "$RAILWAY_AI_AUTOMATION_SERVICE"
```

The helper parses bounded JSON log output and requires the exact marker:

```text
AI_AUTOMATION_DISABLED_READY scheduler_enabled=false provider_configured=false
```

Because Railway log ingestion can lag terminal deployment status, marker lookup may retry for a separate bounded period:

```text
interval = 5 seconds
marker timeout = 120 seconds
```

It never reads generic latest-deployment logs.

## 16. Railway deployment verification helper

Add:

```text
scripts/verify-railway-deployment.mjs
```

The helper has two modes:

```text
status-only
status-and-marker
```

Required inputs are bounded identifiers only:

- project ID;
- environment ID/name;
- service ID/name;
- exact deployment ID;
- optional expected fixed marker enum.

The marker is not arbitrary user input. The only 8F supported marker value is the fixed disabled-ready marker.

The helper:

- executes only Railway read commands;
- parses structured JSON;
- prints bounded status summaries;
- never prints Railway raw environment, private domains, database URLs, Redis URLs, or credentials;
- never mutates Railway resources;
- never chooses `latest`.

Repository tests use a fake Railway CLI fixture and do not require a Railway account.

## 17. Positive evidence vs absence of logs

8F does not claim safety because provider-related logs are absent.

It requires positive control-flow evidence:

```text
scheduler_enabled=false
provider_configured=false
scheduler reconciliation completed
worker ready
```

The direct provider-construction regression separately proves that disabled startup does not call the provider factory, even when a dummy provider secret is present in test environment variables.

## 18. Public surface

No public AI route is added.

Existing public smoke remains authoritative for the public application:

```text
GET /
GET /health/live
GET /health/ready
GET /api/v1/publications
POST /api/v1/publications -> no mutation route
```

No `/api/ai/*`, `/health/ai-*`, or public operator route is introduced.

## 19. Private operational status

`ai-automation:status` remains a private operator command.

It may use production PostgreSQL/Redis only from an execution context that already has private-network access and authorized credentials.

Sprint 8F does not expose PostgreSQL or Redis publicly merely to run this probe from GitHub Actions.

The production release gate uses Railway deployment status and exact-deployment log evidence instead.

## 20. Pre-deploy behavior

Sprint 8F does not move Sprint 8E recovery into Railway `preDeployCommand`.

Recovery belongs to the actual running AI automation process.

No AI-specific pre-deploy command may:

- call a provider;
- mutate Candidate/Review/Evidence/Publication authority;
- create or remove AI history.

The service can rely on runtime startup for DB/Redis/recovery readiness evidence.

## 21. GitHub production environment binding

The production GitHub Environment adds one safe variable:

```text
RAILWAY_AI_AUTOMATION_SERVICE
```

The release workflow's external binding validation requires it together with the existing Railway bindings.

If it is missing, the workflow fails before any `railway up` command runs.

No OpenAI secret is added to GitHub production environment in Sprint 8F.

## 22. External Railway bootstrap

Repository code does not create the service.

An operator must separately create one Railway production service:

```text
name: ai-automation
Root Directory: /backend
Config File: /backend/railway.ai-automation.toml
public domain: none
```

Variables:

```text
NODE_ENV=production
DATABASE_URL=${{Postgres.DATABASE_URL}}
REDIS_URL=${{Redis.REDIS_URL}}
AI_DISCOVERY_SCHEDULER_ENABLED=false
```

GitHub autodeploy remains disabled for this service.

The repository continues to forbid production workflow commands such as:

```text
railway init
railway add
railway project new
railway up --new
```

## 23. Production environment example

Update:

```text
deploy/production/production.env.example
```

It documents the scheduler's disabled production default:

```text
AI_DISCOVERY_SCHEDULER_ENABLED=false
```

It must not contain provider credential/model placeholders.

## 24. Application source changes

Expected application-source changes are narrowly scoped to disabled readiness and testability.

Primary file:

```text
backend/src/ai-automation-worker.ts
```

The runtime must:

- await worker readiness before emitting the disabled marker;
- emit the marker only for disabled mode;
- keep startup failure output bounded;
- preserve graceful `SIGINT`/`SIGTERM` shutdown.

A small isolated provider-construction helper or dependency boundary may be introduced so tests can prove a disabled runtime does not invoke provider construction. The helper must not alter enabled-mode provider semantics.

No core worker or public server ownership moves into this file.

## 25. Deployment helper source changes

Add:

```text
scripts/verify-railway-deployment.mjs
```

The helper is production-release infrastructure, not domain authority.

It has no database, Redis, OpenAI, Candidate, Evidence, Moderation, Eligibility, or Publication dependency.

## 26. Production contract changes

Update:

```text
tests/production-delivery.test.mjs
```

The old contract that merely requires `railway up --ci` is replaced with semantic assertions requiring:

- `backend/railway.ai-automation.toml` exists;
- correct backend Dockerfile reuse;
- correct AI runtime start command;
- AI service binding exists;
- deploy creation returns/captures an exact deployment ID;
- each service is verified by exact deployment ID;
- AI deployment requires disabled-ready marker;
- AI deploy completes before gateway creation;
- gateway remains last;
- no activation workflow input exists;
- no OpenAI credential is referenced;
- no Railway infrastructure-creation command exists;
- the public surface is unchanged.

## 27. Dedicated Sprint 8F repository contract

Add:

```text
tests/ai-automation-production-delivery-contract.test.mjs
```

and root script:

```text
test:ai-automation-production-delivery
```

Root `npm test` runs it before older production delivery/release contracts.

The 8F contract locks:

- private-service topology;
- disabled scheduler default;
- absent provider credential wiring;
- same backend Docker image;
- AI runtime command;
- deterministic exact deployment ID capture;
- exact-ID polling;
- disabled marker verification;
- gateway-last sequencing;
- no activation input;
- no downstream AI content authority.

## 28. Dedicated Sprint 8F CI workflow

Add:

```text
.github/workflows/sprint-8f-ai-automation-production-delivery.yml
```

The workflow is repository validation only and must not target Railway production.

CI services:

```text
Postgres 17
Redis 7
Node 22.13.0
```

Required checks:

1. Sprint 8F repository contract;
2. production delivery contract;
3. backend typecheck;
4. backend focused tests;
5. backend full tests;
6. backend build;
7. local disabled-runtime integration;
8. stale scheduler cleanup integration;
9. provider-construction-zero-call regression;
10. Sprint 8E regression;
11. Sprint 8D regression;
12. Sprint 8C / 8B / 8A regressions;
13. Sprint 5C / 5D release regressions or their existing source contracts as appropriate;
14. repository cleanliness;
15. deployment/secret guard.

No CI step makes a real OpenAI request or a real Railway deployment.

## 29. Local disabled-runtime integration

Repository integration tests must start the built AI automation runtime with real test PostgreSQL and Redis:

```text
DATABASE_URL=<test postgres>
REDIS_URL=<test redis>
AI_DISCOVERY_SCHEDULER_ENABLED=false
```

No `OPENAI_API_KEY` is required.

Acceptance:

```text
process stays alive
AI_AUTOMATION_DISABLED_READY appears exactly after reconciliation/readiness
scheduler ai-discovery-hourly-v1 is absent
provider call/construction count is zero
graceful SIGTERM closes runtime cleanly
```

## 30. Stale scheduler cleanup integration

The test intentionally creates the existing scheduler ID before disabled runtime startup:

```text
ai-discovery-hourly-v1
```

After disabled-ready:

```text
scheduler must be absent
```

This proves the marker represents completed desired-state reconciliation, not merely configuration parsing.

## 31. Provider-construction invariant

A focused test uses disabled scheduler configuration and deliberately supplies dummy provider variables in the environment.

Expected:

```text
provider factory call count = 0
```

The test must not contact OpenAI.

This locks the control-flow invariant that scheduler authority, not accidental secret presence, decides provider construction.

## 32. Disabled stale-job behavior

Inherited Sprint 8D behavior remains:

- a stale delivered AI job in disabled mode returns before tick/provider work;
- Redis/BullMQ retry does not authorize provider execution;
- no Candidate/Publication mutation occurs.

8F regression coverage keeps this behavior intact.

## 33. Documentation changes

Update at least:

```text
docs/runbooks/production-delivery.md
docs/runbooks/ai-discovery-automation.md
docs/runbooks/ai-provider-execution-recovery.md
```

### production-delivery.md

Document:

- service #7;
- external bootstrap;
- disabled variables;
- exact deployment-ID sequencing;
- disabled-ready verification;
- rollback set;
- repository vs real delivery readiness.

### ai-discovery-automation.md

Replace obsolete Sprint 8D retry wording with current Sprint 8E semantics:

```text
HTTP 429 -> durable bounded retry, max 3 attempts
timeout / transport / 408 / 5xx -> UNCERTAIN, no automatic replay
```

Document production disabled delivery while preserving separate activation authority.

### ai-provider-execution-recovery.md

Update the historical statement that Sprint 8E has no production deployment so it remains accurate after 8F: the 8E execution subsystem may now be present in production through a disabled AI runtime, but provider activation remains unauthorized.

## 34. Rollback

Rollback remains history-preserving.

The production application set becomes:

```text
backend
core worker
collector
ai-automation
gateway
```

When rolling back a release that changed a runtime contract, operators restore a mutually compatible verified application set.

Throughout Sprint 8F rollback:

```text
AI_DISCOVERY_SCHEDULER_ENABLED=false
```

must remain false.

Never delete:

- provider executions;
- provider attempts;
- reconciliations;
- scheduled AI ticks;
- AI runs/proposals;
- Candidate history;
- Review/Moderation/Eligibility history;
- Publication history.

Database rollback is not automatic.

If an older application revision is incompatible with the migrated schema, rollback must stop and use a separately reviewed expand/migrate/contract strategy.

## 35. Repository readiness marker

Repository completion may record:

```text
AI_AUTOMATION_PRODUCTION_REPO_READY
```

only when:

- AI Railway config is versioned;
- production release workflow is wired;
- disabled integration passes;
- exact deployment verifier tests pass;
- provider construction is zero in disabled mode;
- docs are updated;
- dedicated 8F and inherited gates are green on exact head.

This marker does not mean Railway production has been modified.

## 36. Real delivery readiness marker

A later, separately authorized real production deployment may record:

```text
AI_AUTOMATION_DISABLED_DELIVERY_READY
```

only after:

- the AI Railway service has been externally bootstrapped;
- the exact merged `main` SHA has been deployed through the production release gate;
- the exact AI deployment reaches `SUCCESS`;
- its exact deployment logs contain the disabled-ready marker;
- gateway/public HTTP smoke passes;
- browser smoke passes.

Even then:

```text
scheduler=false
provider-spend authority=not granted
OpenAI production secret=not required by 8F
```

## 37. Future activation marker

The following state is explicitly outside Sprint 8F:

```text
AI_DISCOVERY_PRODUCTION_ACTIVE
```

Reaching it requires a new explicit design/approval covering at least provider secret provisioning, production model choice, policy activation, cost/budget values, activation smoke, monitoring, and rollback.

## 38. Security invariants

Sprint 8F must preserve all of these:

- gateway remains the only public Railway service;
- AI worker has no public HTTP endpoint;
- workflow permissions remain read-only except the external Railway mutation performed with its scoped token;
- no OpenAI credential appears in repository, examples, GitHub workflow output, or runbooks;
- no environment dump (`printenv`, `set -x`) in release paths;
- no provider/raw observation/model output in readiness logs;
- helper output is bounded;
- repository workflow cannot create Railway projects/services;
- repository workflow cannot enable the AI scheduler;
- AI runtime cannot directly mutate Candidate/HumanReview/Moderation/Eligibility/Evidence/Publication.

## 39. Test matrix

Mandatory test groups:

1. AI Railway config uses backend Dockerfile and correct start command.
2. AI service has no healthcheck/public-domain contract.
3. Disabled config works without provider credentials.
4. Invalid scheduler flag fails closed.
5. Disabled runtime with real test DB/Redis emits ready marker.
6. Ready marker occurs after scheduler reconciliation and worker readiness.
7. Seeded stale scheduler is removed before ready.
8. Disabled runtime never constructs provider, even if dummy secret exists.
9. Disabled stale BullMQ job causes zero provider calls.
10. SIGTERM closes cleanly.
11. Production workflow requires AI service binding before any deploy.
12. `railway up --detach --json` deployment ID is parsed deterministically.
13. Missing/malformed deployment ID fails closed.
14. Verifier waits for exact deployment ID only.
15. Verifier does not use latest/timestamp heuristics.
16. Failed/crashed/removed deployment fails release.
17. AI exact deployment must contain disabled-ready marker.
18. Marker lookup is bounded and exact-deployment scoped.
19. Gateway deploy is last.
20. A failed private deployment blocks gateway deployment.
21. No activation workflow input exists.
22. No OpenAI credential reference exists in production release wiring.
23. Production env example contains disabled flag and no provider placeholder.
24. Public smoke adds no AI endpoint.
25. Rollback documentation preserves disabled state/history.
26. 8E execution recovery regression remains green.
27. 8D automation regression remains green.
28. 8C/8B/8A authority regressions remain green.
29. 5C/5D release regressions remain green.
30. Repository tests use fake Railway CLI; no Railway account required.
31. No test or workflow calls real OpenAI.

## 40. Definition of Done

Sprint 8F repository implementation is complete when all of the following are true on the exact implementation head:

```text
backend/railway.ai-automation.toml exists
same backend Docker build reused
AI start command correct
AI service binding added to release contract
scheduler disabled by default
provider credentials absent from release wiring
disabled runtime reaches positive READY marker
stale scheduler removed before READY
provider factory zero-call under disabled control flow
exact deployment ID captured from deploy creation
exact deployment ID polled to terminal state
AI marker read only from exact deployment logs
backend -> worker -> collector -> AI -> gateway ordering enforced
public surface unchanged
rollback/history contract updated
dedicated 8F gate green
all inherited release/authority gates green
```

Repository completion stops at:

```text
AI_AUTOMATION_PRODUCTION_REPO_READY
```

It does not perform production deployment or production activation.

## 41. Implementation authorization boundary

Approval of this design/spec authorizes only creation of an implementation plan after the written-spec review gate.

It does not authorize:

- implementation before plan approval;
- merge of an implementation PR;
- real Railway production deployment;
- external bootstrap mutations;
- production OpenAI credentials;
- AI scheduler activation.
