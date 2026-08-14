# Sprint 6B Community Backend Pipeline Design

## Goal

Connect the existing community discovery collector to the authoritative backend pipeline without creating a public mutation API or allowing collector output to bypass Evidence, Review, Moderation, Eligibility, or publisher-controlled Publication.

## Locked boundaries

- Existing public community discovery remains an untrusted discovery input.
- The bridge writes only through backend `ingestObservation`; it does not insert Candidate, Evidence, Moderation, Eligibility, or Publication rows directly.
- Imported observations use `origin=collector_detected` and `gameModeExternalId=aram_mayhem`.
- Only structurally normalizable rows are imported: current ARAM Mayhem row, no disqualifier, exactly one champion, valid patch, and canonical item/augment IDs.
- Raw article/transcript/title text is not persisted by the bridge. Only bounded provenance metadata and the normalization snapshot are stored.
- Re-running an unchanged collector row is idempotent and produces no duplicate observation.
- The legacy registry `policy.autoPublish` is ignored by the backend bridge. It never authorizes Publication.
- PostgreSQL remains authority; Redis/BullMQ are delivery only.
- Outbox delivery must be active in the production worker so `RawObservationIngested` reaches Normalization and later authority events can reach Eligibility/Publication projection workers.
- No new public backend domain and no browser credential/CORS expansion.
- Publication remains possible only through existing backend publication authority after current Evidence/Review/Moderation/Eligibility gates permit it.

## Architecture

### 1. Pure community-to-observation bridge

A focused backend module converts `community-inbox.json` plus the collector report patch into deterministic `IngestObservationCommand` values. The observation identity and idempotency key are derived from the canonical normalization snapshot and bounded provenance metadata.

The bridge persists only:

- candidate id, platform, canonical URL, author, publish date;
- score/status and Evidence v3 state as provenance metadata;
- champion/item/augment canonical IDs in `normalizationSnapshot`;
- no raw page body, subtitle, full title, comment text, image bytes, or generated guide body.

Rows that cannot be normalized are skipped with explicit reason codes; they are not coerced.

### 2. Governed source bootstrap

The importer owns one source key, `community-collector-v1`. On first execution it creates the source and immutable revision 1 policy only when absent. If an active policy already exists but does not match the expected source/revision/storage contract, execution fails closed rather than overwriting operator policy.

The policy allows governed aggregate/reference storage while the importer deliberately leaves `rawBlob` absent.

### 3. One-shot importer

`community-import-cli` reads collector inbox/report files, bootstraps/loads the governed source, converts candidates, calls `ingestObservation` sequentially, prints bounded counters, closes PostgreSQL, and exits. It never publishes.

### 4. Runtime delivery

The existing backend worker is extended to run the already-tested outbox dispatcher alongside the Normalization, Eligibility, and Publication projection consumers. The dispatcher uses the existing durable outbox routing and BullMQ job IDs, so retry/duplicate safety stays with the current implementation.

### 5. Railway topology

Sprint 6B adds two private processes to the existing production topology:

- `worker`: same backend image, `node dist/src/worker.js`, always on, no public domain;
- `collector`: root collector image, Railway cron `0 */6 * * *` (UTC), runs public discovery then the one-shot importer, then exits.

The collector receives `DATABASE_URL` through a Railway reference variable. It does not require a browser/public write token and does not expose HTTP.

The exact-SHA production release workflow verifies and builds both new runtime images/configs and deploys backend -> worker -> collector -> gateway. Service bindings are mandatory and fail closed when missing.

## Data flow

`public sources -> existing collector -> community inbox -> governed importer -> RawObservation -> outbox -> BullMQ Normalization -> Candidate -> existing Evidence/Review/Moderation/Eligibility authority -> publisher-controlled Publication -> public read projection`

The bridge has no path from collector score, status, Evidence v3 metadata, or `autoPublish` to a Publication command.

## Error handling

- Missing/invalid inbox or report: importer exits non-zero before writes.
- Missing patch or unsupported row shape: row skipped with a reason count; no guessed IDs.
- Source policy conflict: fail closed before ingestion.
- Database failure: importer exits non-zero; idempotency makes a safe rerun possible.
- Queue outage: observations remain committed with pending outbox events; dispatcher retries through the existing lease/retry contract.
- Collector HTTP/source failures retain the existing collector behavior and do not weaken backend authority.

## Verification

- Unit tests cover deterministic mapping, privacy minimization, skip conditions, and changed-content identity.
- Backend integration tests cover source bootstrap idempotency/conflict and observation replay.
- Source-contract tests lock private Railway worker/collector configuration, cron cadence, release-gate binding/order, and absence of auto-publication/public write expansion.
- Existing backend/full regression, production source contracts, image builds, and runtime audit remain mandatory.

## Completion state

Repository completion is `SPRINT_6B_REPO_READY` only. A real production claim additionally requires a real cron run that creates/replays governed observations and demonstrates Candidate processing while creating no unauthorized Publication.