# Sprint 2B Catalog Authority Design

## Status

Approved for design and implementation under the owner's standing delegation to continue the agreed Hải Đấu roadmap without requiring a prompt for every previously ordered Core step.

This design is implemented only on the stacked draft branch `feat/2b-catalog-authority`, based on the verified Sprint 2A head `16ab189b96041b3b00355a25c07689f487b844ff`. It does not authorize merging PR #8, PR #9, or the Sprint 2B PR; production credentials; provider selection; infrastructure provisioning; data migration; or deployment.

## Goal

Make a patch-bound catalog revision the authoritative source for game entity identity and compatibility validation before normalization and candidate registration begin.

Sprint 2B establishes this dependency boundary:

> Active Patch → Sealed Catalog Revision → Validation Decision → Active Catalog Pointer → Catalog Selection Validation

It prepares the production backend for Common Harness scenario S12 (patch/catalog mismatch) while preserving PostgreSQL as the system of record and the existing static frontend as the public read path.

## Inputs

- Architecture Baseline v0.2.
- Data Model Domain Spec v0.2.
- ADR-0002 selecting Node/Fastify + PostgreSQL + BullMQ/Redis.
- Sprint 2A production foundation at `16ab189b96041b3b00355a25c07689f487b844ff`.
- Common Harness T3/T7 vocabulary and scenario S12.
- Existing Riot/CommunityDragon identifiers already used by the static frontend.
- Existing Source Policy and Patch lifecycle commands.

## Non-goals

Sprint 2B does not:

- fetch Riot, CommunityDragon, Hải Đấu, Bilibili, or any other external source;
- replace or rewrite the frontend's generated catalog files;
- normalize raw observations;
- create candidates, claims, Evidence decisions, HumanReview, Moderation, Eligibility, or Publication records;
- add AI;
- add production infrastructure, credentials, scheduled jobs, deployment, or data migration;
- route catalog events to the normalization queue;
- merge any draft PR.

## Approaches considered

### 1. Treat `app/generated-guides.ts` as the backend catalog

This would be quick, but it would make backend correctness depend on a frontend TypeScript artifact that mixes catalog identity, Hải Đấu guide content, translation, presentation, and community records. It would also prevent a clean patch/revision audit trail.

### 2. Fetch CommunityDragon directly inside the catalog command

This would reduce adapter work but make the domain transaction depend on network availability and mutable remote responses. Retrying the same command could import different bytes, and tests would require network fixtures.

### 3. Import a deterministic adapter snapshot, seal it, validate it, then activate it

The adapter supplies a bounded structured snapshot plus its source digest and version. The backend canonicalizes and hashes the snapshot, persists its entity revisions and compatibility rules, seals the revision, records an immutable validation decision, and changes the active pointer only after validation passes.

## Decision

Use approach 3.

External fetching remains an adapter responsibility in a later sprint. Sprint 2B implements the catalog application boundaries and PostgreSQL guarantees against deterministic snapshots. The current frontend catalog remains unchanged and continues to serve production.

## Branch and integration strategy

Sprint 2B is a stacked draft change:

- base commit: Sprint 2A PASS head `16ab189b96041b3b00355a25c07689f487b844ff`;
- head branch: `feat/2b-catalog-authority`;
- pull request base: `feat/2a-production-foundation`;
- intended merge order, only after separate approval: ADR PR #8 → Sprint 2A PR #9 → Sprint 2B;
- no merge and no deployment during implementation.

This keeps PR #9 frozen as an auditable Sprint 2A checkpoint instead of expanding its scope.

## Catalog snapshot contract

The application accepts only `CatalogSnapshotV1`:

```ts
interface CatalogSnapshotV1 {
  schemaVersion: 1;
  patchKey: string;
  gameModeExternalId: 'aram_mayhem';
  source: {
    adapterVersion: string;
    sourceDigest: string;
  };
  entities: Array<{
    entityType: 'champion' | 'item' | 'augment' | 'mode';
    externalId: string;
    displayName: string;
    active: boolean;
    attributes: Record<string, unknown>;
  }>;
  rules: Array<{
    ruleKey: string;
    constraintType: 'allow' | 'deny' | 'limit';
    definition:
      | {
          modeExternalId: string;
          entityType: 'champion' | 'item' | 'augment';
          entityExternalIds: string[];
          subjectExternalIds?: string[];
        }
      | {
          modeExternalId: string;
          entityType: 'item' | 'augment';
          maxSelections: number;
          subjectExternalIds?: string[];
        };
  }>;
}
```

Canonical hashing uses the existing sorted-key JSON hash and includes `schemaVersion`, `patchKey`, `gameModeExternalId`, source metadata, entities, and rules. Array order is normalized by stable entity/rule keys before hashing so equivalent snapshots produce the same content hash.

The syntactic import gate requires:

- schema version exactly `1`;
- patch key and game mode exactly matching the command;
- non-empty adapter version and 64-character lowercase hexadecimal source digest;
- unique `entityType + externalId`;
- one and only one active `mode:aram_mayhem` entity;
- non-empty display names;
- unique rule keys;
- finite positive `maxSelections`;
- no duplicate IDs inside a rule.

## Persistence model

Migration `0005_catalog_authority.sql` reuses the Sprint 2A tables `catalog_revisions`, `game_entities`, `game_entity_revisions`, and `compatibility_rules`, then adds:

### `catalog_revision_seals`

One immutable row per catalog revision:

- `catalog_revision_id`;
- `schema_version`;
- `adapter_version`;
- `source_digest`;
- `content_hash` with a uniqueness constraint;
- entity and rule counts;
- actor and timestamp.

A seal proves the revision's complete imported content. Database triggers reject any later insert, update, or delete of that revision's entity revisions or compatibility rules.

### `catalog_validation_results`

Append-only validation history:

- validation result ID;
- catalog revision ID;
- sealed content hash;
- validator ruleset version;
- result `passed` or `failed`;
- deterministic reason-code array;
- actor and timestamp.

A later validation never overwrites an earlier result.

### `catalog_lifecycle_events`

Append-only lifecycle history with states `imported`, `validated`, `activated`, `superseded`, and `withdrawn`.

### `active_catalog_revisions`

Mutable projection keyed by `patch_id + game_mode_external_id`. It points to one validated catalog revision and records activation time. Historical revisions and lifecycle events remain immutable.

The existing immutable `catalog_revisions.status` column is treated as the creation label. Sprint 2B inserts `draft`; current lifecycle is derived from events and the active pointer, never by updating the revision row.

Canonical rows in `game_entities` are also protected from update/delete. Display names and attributes remain revision-specific in `game_entity_revisions`.

## Application boundaries

### Import catalog revision

`importCatalogRevision(pool, command)`:

1. canonicalizes and syntactically validates `CatalogSnapshotV1`;
2. calculates the content hash before opening the transaction;
3. locks the patch row and verifies the latest Patch lifecycle event is `active`;
4. verifies the active Source Policy revision supplied by the command;
5. applies the shared idempotency contract under scope `catalog_import`;
6. inserts the draft revision, canonical entity identities, entity revisions, compatibility rules, seal, lifecycle event, audit event, and outbox event atomically;
7. completes the idempotency record with revision ID and content hash.

The same key and payload returns the recorded result with `replayed: true`. The same key with a different payload returns `IDEMPOTENCY_PAYLOAD_CONFLICT`. Any failure leaves no partial revision, entity revision, rule, seal, audit, outbox, or completed idempotency effect.

### Validate catalog revision

`validateCatalogRevision(pool, command)`:

1. loads the sealed revision and its exact rows;
2. recomputes and verifies the content hash;
3. verifies patch and active Patch lifecycle state;
4. verifies all rule mode, subject, and entity references exist and are active in the same revision;
5. applies deterministic allow/deny/limit rule-shape checks;
6. writes an immutable validation result, lifecycle event, audit event, and outbox event atomically.

Validation failures are preserved as `failed` results with sorted reason codes. They do not mutate the catalog and do not activate it.

Reason codes are limited to:

- `CATALOG_CONTENT_HASH_MISMATCH`;
- `CATALOG_PATCH_NOT_ACTIVE`;
- `CATALOG_PATCH_MISMATCH`;
- `CATALOG_MODE_MISSING`;
- `CATALOG_ENTITY_REFERENCE_MISSING`;
- `CATALOG_ENTITY_INACTIVE`;
- `CATALOG_RULE_SHAPE_INVALID`;
- `CATALOG_RULE_REFERENCE_MISSING`;
- `CATALOG_SELECTION_LIMIT_INVALID`.

### Activate catalog revision

`activateCatalogRevision(pool, command)`:

1. locks the patch row and active pointer;
2. requires the latest validation result for the sealed content hash to be `passed`;
3. requires an `expectedCurrentCatalogRevisionId` compare-and-swap value, including explicit `null` for first activation;
4. rejects revision/patch/mode mismatch;
5. updates the active pointer;
6. records `superseded` for the previous pointer when present;
7. records `activated`, audit, and outbox events atomically.

Concurrent commands from the same expected pointer cannot both succeed. The loser receives `CATALOG_ACTIVE_POINTER_CONFLICT` and creates no side effect.

### Validate a catalog selection

`validateCatalogSelection(pool, input)` is a read-only boundary for Sprint 3 consumers. It requires:

- patch ID;
- catalog revision ID;
- game mode external ID;
- one champion external ID;
- unique augment external IDs;
- unique item external IDs.

It fails closed unless the supplied revision is the active pointer for the patch and mode. It verifies every selected entity is active in the same revision, then evaluates rules deterministically:

1. patch/revision/mode mismatch;
2. missing or inactive entities;
3. matching `deny` rules;
4. applicable `allow` lists;
5. applicable `limit` rules.

It returns `{ valid, reasonCodes }` with sorted, stable reason codes and performs no write. It does not create a Candidate.

## Audit and outbox

Every successful state-changing command writes audit and outbox rows in the same PostgreSQL transaction.

Event types:

- `CatalogRevisionImported`;
- `CatalogRevisionValidated`;
- `CatalogRevisionActivated`.

Catalog events remain in the PostgreSQL outbox ledger. Sprint 2B does not add them to the `RawObservationIngested` normalization queue and does not pretend they have a consumer. Queue routing for catalog-dependent workers begins with normalization in Sprint 3.

## Error handling and security

- Unknown schema versions fail before any database write.
- A non-active Patch or Source Policy fails closed.
- Failed semantic validation is immutable evidence and cannot be activated.
- A sealed catalog cannot be edited to make validation pass; a new revision is required.
- HTTP endpoints are not added in Sprint 2B.
- Error messages expose reason codes, not SQL, stack traces, credentials, or stored snapshot contents.
- Snapshot payloads contain structured catalog identity only; no source HTML, transcript, comments, or credentials.
- The CI workflow retains `contents: read` and contains no deploy command.

## Testing strategy

All implementation is test-first.

### Migration and immutability

- fresh PostgreSQL 17 migration creates all new tables and constraints;
- seal, validation, lifecycle, and canonical entity history reject update/delete;
- inserting entity revisions or rules after seal is rejected;
- migration checksums remain locked.

### Import

- valid snapshot imports atomically;
- syntactically invalid snapshot creates zero rows;
- injected failure rolls back revision, entity revisions, rules, seal, audit, outbox, and idempotency completion;
- same idempotency key plus same payload replays;
- same key plus different payload conflicts;
- equivalent array ordering produces the same content hash.

### Validation and activation

- missing rule references yield a failed immutable result;
- a failed revision cannot activate;
- a passed revision activates;
- wrong patch or mode cannot activate;
- stale expected pointer loses the concurrency race with zero side effects;
- a new active revision records superseded and activated lifecycle events.

### Selection validation

- the active revision accepts a valid champion/augment/item selection;
- a revision from another patch fails with `CATALOG_REVISION_NOT_ACTIVE`;
- missing and inactive IDs fail closed;
- deny overrides allow;
- limit overflow fails deterministically;
- the boundary performs no mutation.

### Regression gate

The repository gate runs PostgreSQL 17 and Redis 7 and must retain:

- all existing frontend validation, lint, tests, and GitHub Pages build;
- all 25 Sprint 2A backend tests;
- new catalog migration, import, validation, activation, concurrency, and selection tests;
- backend typecheck and build;
- repository cleanliness and deployment guard.

No test uses production data or an external network.

## Definition of Done

- Deterministic catalog snapshots can be imported, sealed, validated, and activated.
- Patch, Source Policy, and catalog revision inputs are pinned.
- Sealed catalog content cannot be mutated or extended.
- Failed validations remain immutable and cannot activate.
- Active pointer updates are compare-and-swap safe.
- Read-only selection validation rejects wrong-patch catalogs and enforces allow/deny/limit rules.
- Every successful mutation creates atomic audit and outbox records.
- Existing frontend and Sprint 2A gates remain green.
- No external adapter, normalization, Candidate, Evidence, AI, Publication, credential, merge, or deploy is introduced.

## Roadmap after Sprint 2B

1. **Sprint 3A — Deterministic Normalization and Candidate Registry:** persist normalized observations against the active catalog; implement origin-independent fingerprints, provenance, T3 atomicity, S1, S12, and S21.
2. **Sprint 3B — Evidence v3 and Human Review persistence:** claims, associations, patch-pinned Evidence decisions, review quorum, and immutable decision history.
3. **Sprint 3C — Moderation and Eligibility:** no implicit `clear`, signal snapshot pinning, re-moderation, and stale-input guards.
4. **Sprint 4 — Publication aggregate and public read path:** immutable publication versions, per-item rollback, monitoring projection, and static snapshot export.
5. **Sprint 5 — Production readiness:** managed PostgreSQL/Redis selection, secrets, backup/restore rehearsal, observability, staged migration, and explicit deployment approval.

## Self-review

- Completeness scan: every requirement, state, and deferred boundary is explicit.
- Consistency: PostgreSQL remains authoritative; Redis is not involved in catalog commands.
- Scope: the design ends before normalization and Candidate creation.
- Authority: active catalog activation cannot bypass immutable validation.
- Integration: Sprint 2B remains stacked on the frozen Sprint 2A checkpoint and does not alter the public frontend read path.
