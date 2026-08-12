# Sprint 5D — Release Hardening & End-to-End Staging Rehearsal

## Status

Approved direction from the product owner: proceed with the recommended release-hardening path after Sprint 5C. This specification converts that direction into an implementation boundary. Sprint 5D remains staging/CI-only: it does not merge the stacked PR chain, provision public infrastructure, or deploy production.

Base commit: `62e2ccaefa9bb5aa15d5a9258bd1ee923c6b14d4` (Sprint 5C exact head).

## Goal

Prove that one real Publication can travel through the complete authority path and be rendered by the browser through the Sprint 5C same-origin topology, while rollback, backend outage, recovery, migration, backup/restore, and security boundaries remain safe.

Sprint 5D ends only when the exact head can produce an `RC_READY` result from a fresh disposable staging environment.

## Chosen approach

### A. Real domain-command rehearsal — chosen

Create a deterministic staging rehearsal dataset by calling existing domain commands and state-transition APIs. Publication creation and rollback must use `publishCandidateRevision` and `rollbackPublication`; no script may insert, update, or delete Publication authority rows directly.

The rehearsal creates two eligible CandidateRevisions for one champion with different, frontend-mappable augment/item selections. It publishes version 1, publishes version 2, then rolls back to version 1. This makes every state transition observable through the public API and browser.

### B. Prebuilt PostgreSQL snapshot — rejected

A prepared database would be faster, but it could hide migration defects and bypass domain invariants. It would not prove that the release candidate can build authority state from a clean schema.

### C. Browser tests against a mocked Publication API — rejected

Mocks are useful for unit coverage but do not exercise PostgreSQL, Fastify, Caddy, same-origin routing, Publication authority, or rollback. Sprint 5B already covers adapter-level behavior, so Sprint 5D must add real-system evidence rather than another mock layer.

## Scope

### In scope

- deterministic staging-only rehearsal data created from a fresh migrated database;
- real domain-command transitions through catalog/candidate/trust/moderation/eligibility/publication boundaries needed by the rehearsal;
- one Publication with at least two immutable versions whose payloads differ visibly in the frontend;
- a staging-only internal rehearsal CLI or one-shot service; no public mutation HTTP endpoint;
- browser E2E through the gateway using a real headless browser;
- normal, backend-down, recovered, version-2, and rolled-back browser/API states;
- backup/restore rehearsal against disposable staging data;
- dependency, container-user, network-exposure, secret, and mutation-surface checks;
- bounded operational diagnostics and runbook updates;
- a dedicated Sprint 5D CI workflow whose final success marker is `RC_READY`.

### Out of scope

- production deployment;
- cloud provider selection or provisioning;
- DNS or public TLS changes;
- registry push;
- production secrets;
- automatic publication or enabling the background worker by default;
- adding a browser-authenticated write surface;
- changing Publication eligibility policy semantics;
- schema down migrations or destructive automated database rollback;
- general analytics, telemetry platform work, or new product features.

## Safety invariants

1. The public browser boundary remains read-only and one-shot. It may GET active Publications but cannot publish, rollback, review, moderate, or mutate authority state.
2. The rehearsal CLI is not exposed through Caddy or Fastify. It must require an explicit staging/rehearsal enable flag and fail closed when that flag is absent.
3. Publication authority rows are created or changed only through existing domain commands. Direct Publication SQL fixtures remain test-only guard tools and are forbidden in the rehearsal path.
4. The default Compose topology still starts no background worker.
5. PostgreSQL remains the Publication read authority; Redis is not required for public Publication reads.
6. Only the gateway publishes a host port.
7. Browser fallback remains static and non-blocking when the API is unavailable.
8. No credential, database URL, token, private key, or raw environment file may be printed into CI output.
9. Production deployment remains disabled in every Sprint 5D workflow.
10. `RC_READY` is emitted only by the final CI gate after every required rehearsal and security check has passed on the same exact head.

## Architecture

### 1. Rehearsal dataset module

Add a staging-focused module under the backend source tree rather than importing test helpers into runtime code. It owns deterministic IDs and invokes existing command APIs to create the minimum graph needed for the rehearsal.

The dataset must contain:

- one active ARAM Mayhem patch/catalog context;
- one champion whose external ID matches a current frontend champion ID/slug;
- augment and item IDs that already exist in the frontend static asset catalog;
- CandidateRevision V1 with build A;
- CandidateRevision V2 for the same publication identity with build B;
- Evidence/Review/Moderation/Eligibility authority sufficient for each revision to be publishable;
- one Publication aggregate;
- immutable PublicationVersion 1 and PublicationVersion 2;
- rollback activation back to PublicationVersion 1.

The module must not author Publication payload text. The Publication payload continues to be derived from CandidateRevision authority.

### 2. Staging rehearsal CLI

Provide a CLI that can run inside the backend image against the private PostgreSQL service. Supported operations are intentionally narrow:

- `seed-v1`: create prerequisites and publish PublicationVersion 1;
- `publish-v2`: create/activate the second eligible revision and publish PublicationVersion 2;
- `rollback-v1`: rollback the same Publication to PublicationVersion 1;
- `verify`: read authoritative state and emit only non-secret identifiers/status needed by CI.

Every mutating operation requires an explicit rehearsal enable flag. Re-running an operation must either be idempotent or fail with a stable, documented conflict; it must never create silent duplicate authority history.

No HTTP route is added for these commands.

### 3. Browser E2E runner

Use a real headless Chromium session against the gateway origin. Playwright is the preferred minimal tool because it verifies hydration, the runtime GET, DOM rendering, and reload behavior that HTTP-only smoke tests cannot prove.

The browser suite verifies:

- V1: the selected champion renders the Publication build from API data and preserves the existing Vietnamese/editorial title/description;
- V2: after the internal publish operation and page reload, the changed augment/item build is visible;
- rollback: after rollback and reload, V1 becomes visible again immediately;
- no raw external IDs are rendered as fallback labels for unresolved assets;
- backend outage: a fresh page load still renders the static guide and the API-unavailable state without blocking champion browsing;
- recovery: after backend restoration and reload, the rolled-back active Publication is rendered again;
- no browser credential is required and no write request is issued by the application.

The test must select elements using stable semantic/test IDs added only where existing accessible text is insufficient. It must not depend on fragile CSS layout selectors.

### 4. Runtime fault rehearsal

The workflow starts the fresh Sprint 5C stack and performs failure injection only against disposable CI containers:

1. start stack and run migrations;
2. seed/publish V1;
3. browser/API V1 checks;
4. publish V2;
5. browser/API V2 checks;
6. rollback to V1;
7. browser/API rollback checks;
8. stop backend;
9. reload browser and verify static fail-open behavior;
10. start backend and wait for readiness;
11. reload browser and verify V1 authority is visible again.

No polling is added to the application. CI may explicitly wait for container health between orchestrated steps.

### 5. Backup and restore rehearsal

After the rollback state is established, create a logical PostgreSQL backup from the disposable staging database and restore it into a fresh disposable database/schema target. Verify at least:

- migrations/history remain consistent;
- the Publication aggregate and both immutable versions exist;
- the active pointer resolves to V1 after rollback;
- the public reader returns the same active payload from the restored database.

The backup is rehearsal-only and is not uploaded as a workflow artifact. The workflow deletes it during cleanup.

### 6. Security hardening

Sprint 5D adds explicit release checks rather than blindly applying dependency upgrades.

Required checks:

- backend final image runs as a non-root user;
- gateway final image also runs as non-root before `RC_READY`; if necessary it serves on an unprivileged internal port and Compose maps the host port to it;
- only the gateway has published host ports;
- no CORS expansion is introduced;
- unauthenticated POST/PUT/PATCH/DELETE Publication HTTP methods remain unavailable;
- browser requests contain no application credential/token;
- backend production dependency audit has no untriaged high/critical issue affecting the shipped backend runtime;
- frontend dependency findings are triaged against the actual shipped artifact: the final gateway image contains static files plus Caddy, not a Node/Next runtime;
- no `npm audit fix --force` or unrelated breaking dependency upgrade is performed automatically;
- repository and built artifacts are scanned for obvious committed secret material using bounded pattern checks already compatible with CI logs.

A dependency finding that affects only a build-time package may be documented as non-runtime only after the final container contents prove that package is not shipped.

### 7. Operational readiness

Update the staging runbook with:

- deterministic seed/publish/rollback rehearsal commands;
- how to verify current Publication version without exposing secrets;
- backup/restore rehearsal procedure;
- backend/PostgreSQL/Redis restart checks;
- safe bounded log commands;
- interpretation of browser fallback versus backend readiness;
- the exact conditions required for `RC_READY`.

Diagnostics remain stdout/stderr and CI-step based. Sprint 5D does not introduce a persistent telemetry backend.

## Data flow

```text
fresh PostgreSQL
    -> migrations
    -> catalog/candidate/trust domain commands
    -> eligible CandidateRevision V1
    -> publishCandidateRevision
    -> PublicationVersion 1 active
    -> GET /api/v1/publications
    -> Caddy same-origin gateway
    -> browser adapter
    -> localized primary build

second eligible revision
    -> publishCandidateRevision
    -> PublicationVersion 2 active
    -> browser reload shows build B

rollbackPublication
    -> active pointer returns to PublicationVersion 1
    -> browser reload shows build A

backend stopped
    -> gateway still serves static export
    -> API returns sanitized gateway 5xx
    -> browser keeps static guide and unavailable state

backend recovered
    -> PostgreSQL active pointer still V1
    -> browser reload shows V1 again
```

## Error handling

- Missing rehearsal-enable flag: CLI exits non-zero before connecting or writing.
- Existing inconsistent rehearsal data: fail closed with a bounded stable error; do not attempt destructive repair.
- Unmappable champion/augment/item ID: fail the rehearsal before `RC_READY`; do not expose raw IDs or partially overlay a build.
- Migration checksum mismatch: preserve Sprint 5C fail-closed behavior.
- Browser/API mismatch: fail the E2E job and retain bounded diagnostics (status, route, semantic selector), not response bodies containing sensitive data.
- Backup/restore mismatch: fail the release gate; do not change the authoritative source database to make the comparison pass.
- Dependency/security finding: fail `RC_READY` when it is high/critical and affects a shipped runtime until explicitly fixed or proven non-applicable.

## Test strategy and TDD order

Implementation follows RED -> GREEN -> refactor checkpoints. The planned order is:

1. rehearsal guard and deterministic dataset contract;
2. CLI command contract and idempotency/fail-closed behavior;
3. V1/V2/rollback authoritative backend integration;
4. browser E2E for V1, V2, rollback, outage, and recovery;
5. backup/restore rehearsal;
6. non-root/network/dependency/secret security gates;
7. runbook/workflow contract;
8. exact-head full regression and staging rehearsal.

Existing Sprint 5C regression gates remain inherited and must stay green.

## `RC_READY` acceptance gate

The final exact-head workflow may emit `RC_READY` only when all of the following pass on one commit:

- frontend lint and existing frontend regression;
- public-data adapter tests;
- staging source contracts;
- backend typecheck/build/full tests;
- clean-schema migration;
- V1 real Publication API + browser E2E;
- V2 publish API + browser E2E;
- rollback-to-V1 API + browser E2E;
- backend outage static fail-open browser E2E;
- backend recovery browser E2E;
- backup/restore verification;
- non-root backend and gateway checks;
- single-public-port/network isolation checks;
- read-only Publication HTTP boundary checks;
- dependency/security triage gate;
- repository cleanliness and secret-pattern guard;
- deployment guard;
- unconditional teardown.

`RC_READY` means the stack is a release candidate for a future real staging deployment. It does not authorize merge or production deployment.

## Deliverables

Expected implementation artifacts include:

- a staging rehearsal backend module/CLI;
- deterministic release-rehearsal fixtures owned by backend source, not test-only direct SQL helpers;
- browser E2E tests and minimal stable selectors where necessary;
- backup/restore verification script;
- security/release gate script(s);
- updated staging runbook;
- Sprint 5D GitHub Actions workflow;
- implementation plan under `docs/superpowers/plans/`;
- draft Sprint 5D pull request after implementation work begins.

## Explicit non-authorization

This specification does not authorize merging any stacked PR, deploying to a public host, enabling automatic publication, exposing mutation endpoints, turning on the worker by default, or using production credentials.