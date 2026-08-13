# Sprint 6B Community Backend Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect the existing community collector to governed backend Observation/Candidate processing while keeping all Evidence/Review/Moderation/Eligibility/Publication authority fail closed.

**Architecture:** Add a deterministic pure bridge and one-shot importer, bootstrap one governed collector source without overriding an existing policy, run the durable outbox dispatcher in the existing worker runtime, and add private Railway worker + cron collector services. The production release gate deploys the new private services by exact SHA; no public mutation route or auto-publish path is added.

**Tech Stack:** Node.js 22.13.0, TypeScript 5.9, PostgreSQL 17, Redis 7, BullMQ 5, Railway Config-as-Code, GitHub Actions.

## Global Constraints

- Collector output is discovery input, never Publication authority.
- No public write API, CORS expansion, browser credential, direct Candidate SQL, direct Publication SQL, or collector-triggered publication.
- `policy.autoPublish` from the legacy registry is ignored by the backend bridge.
- Imported origin is `collector_detected`; mode is `aram_mayhem`.
- Store bounded provenance + normalization snapshot only; no raw page/transcript/title/comment body.
- All retries are idempotent.
- Existing outbox/BullMQ delivery semantics remain authoritative.
- Worker and collector Railway services are private.
- Collector cron is `0 */6 * * *` UTC and exits after one run.

---

### Task 1: Lock Sprint 6B contracts RED

**Files:**
- Create: `backend/test/community-inbox-bridge.test.ts`
- Create: `tests/community-backend-pipeline.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Tests require `buildCommunityObservationBatch()` from `backend/src/modules/community/community-inbox-bridge.ts`.
- Root source-contract test requires worker/collector Railway configs, collector Dockerfile/run script, release bindings, and no auto-publish bridge behavior.

- [ ] Write backend tests for deterministic command construction, privacy minimization, skip reasons, and content-change identity.
- [ ] Write root source-contract tests for private services, six-hour cron, exact-SHA deploy binding, and no public mutation/auto-publication.
- [ ] Add `test:community-backend-pipeline` to the root test chain.
- [ ] Run PR CI and verify RED only because Sprint 6B implementation files are absent.
- [ ] Commit the RED tests.

### Task 2: Implement deterministic inbox bridge

**Files:**
- Create: `backend/src/modules/community/community-inbox-bridge.ts`
- Test: `backend/test/community-inbox-bridge.test.ts`

**Interfaces:**
- `buildCommunityObservationBatch(input)` returns `{ commands, skipped }`.
- Each command is an `IngestObservationCommand` with deterministic UUID/idempotency identity.
- Inputs: parsed inbox, patchKey, sourceId.

- [ ] Implement strict schema guards for inbox/report-facing fields used by the bridge.
- [ ] Import only `modeValid === true`, `currentEnough === true`, empty disqualifiers, exactly one champion, and canonical selection IDs.
- [ ] Map selections to `normalizationSnapshot` schema v1 and `origin: collector_detected`.
- [ ] Persist bounded provenance only and leave `rawBlob` undefined.
- [ ] Verify unchanged input produces identical observation/idempotency identity; changed selection changes identity.
- [ ] Run backend focused tests GREEN and commit.

### Task 3: Add governed source bootstrap and importer

**Files:**
- Create: `backend/src/modules/community/bootstrap-community-source.ts`
- Create: `backend/src/community-import-cli.ts`
- Create: `backend/test/community-source-bootstrap.test.ts`
- Modify: `backend/package.json`

**Interfaces:**
- `bootstrapCommunitySource(pool)` returns `{ sourceId, sourcePolicyRevisionId }`.
- Source key: `community-collector-v1`; immutable revision: 1.
- CLI accepts `--inbox <path>` and `--report <path>` and uses `DATABASE_URL`.

- [ ] Write integration tests proving first bootstrap, replay idempotency, and fail-closed conflict.
- [ ] Implement transactional source/policy bootstrap without overwriting an existing active policy.
- [ ] Implement one-shot importer that validates report patch, builds batch, calls `ingestObservation` sequentially, prints bounded counters, closes DB, and exits.
- [ ] Add backend script `community:import`.
- [ ] Run focused + full backend tests GREEN and commit.

### Task 4: Activate durable outbox dispatch in worker runtime

**Files:**
- Create: `backend/src/queue/outbox-dispatch-loop.ts`
- Create: `backend/test/outbox-dispatch-loop.test.ts`
- Modify: `backend/src/worker.ts`

**Interfaces:**
- `runOutboxDispatchLoop({ dispatch, signal, sleepMs })` serializes dispatch iterations and stops on abort.
- `worker.ts` owns BullMQ Queue clients for normalization/eligibility/publication and passes them to existing `dispatchOutbox`.

- [ ] Write RED tests for serialized iterations, retry-after-error, and abort shutdown.
- [ ] Implement the minimal loop with no overlapping dispatch.
- [ ] Wire Queue clients + loop into worker startup/shutdown while preserving existing consumers.
- [ ] Run worker/outbox/full backend tests GREEN and commit.

### Task 5: Add private Railway worker and collector runtimes

**Files:**
- Create: `backend/railway.worker.toml`
- Create: `deploy/production/Dockerfile.collector`
- Create: `deploy/production/railway.collector.toml`
- Create: `deploy/production/run-community-collector.sh`
- Modify: `tests/community-backend-pipeline.test.mjs`

**Interfaces:**
- Worker start: `node dist/src/worker.js`, no public health/domain requirement.
- Collector command: existing `collect-community-candidates.mjs` then compiled `community-import-cli.js`.
- Collector cron: `0 */6 * * *`; restart policy `NEVER`.

- [ ] Strengthen RED source contracts for Docker/config/runtime privacy.
- [ ] Implement backend worker Railway config.
- [ ] Implement collector image containing only files required for discovery + importer runtime.
- [ ] Implement fail-fast run script and cron config.
- [ ] Verify source contracts and both Docker builds in CI GREEN; commit.

### Task 6: Extend exact-SHA production release gate and runbook

**Files:**
- Modify: `.github/workflows/production-release-gate.yml`
- Modify: `docs/runbooks/production-delivery.md`
- Modify: `tests/production-delivery.test.mjs`
- Modify: `tests/community-backend-pipeline.test.mjs`

**Interfaces:**
- New required GitHub production vars: `RAILWAY_WORKER_SERVICE`, `RAILWAY_COLLECTOR_SERVICE`.
- Deploy order: backend -> worker -> collector -> gateway.
- No workflow write permission; no service creation command.

- [ ] Write RED assertions for new exact-SHA bindings/deploy order and private service bootstrap instructions.
- [ ] Update workflow verify job to build collector image and validate 6B contracts.
- [ ] Update deploy job with fail-closed worker/collector bindings and explicit Railway service targets.
- [ ] Update runbook with private worker/collector setup, reference variables, six-hour UTC cron, first-run evidence, and explicit no-auto-publish boundary.
- [ ] Run all root/backend/production source gates GREEN and commit.

### Task 7: Release-candidate verification and PR

**Files:** all Sprint 6B changes.

- [ ] Run the PR-triggered frontend/backend regression, staging integration, release candidate, and deployment dry-run workflows on exact branch head.
- [ ] Confirm runtime audit and production backend/gateway/collector image builds pass.
- [ ] Review exact `main...head` diff for public exposure, credentials, direct SQL authority bypass, auto-publication, non-idempotent retry, and worker shutdown leaks.
- [ ] Fix every Critical/Important finding.
- [ ] Record `SPRINT_6B_REPO_READY` only after exact-head CI is green. Do not merge or deploy production without a separate verified production handoff.