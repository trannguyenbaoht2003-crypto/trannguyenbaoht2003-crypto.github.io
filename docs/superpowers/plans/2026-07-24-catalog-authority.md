# Sprint 2B Catalog Authority Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a deterministic, patch-bound catalog authority that imports immutable catalog revisions, records validation history, activates revisions with compare-and-swap safety, and validates champion/augment/item selections against the active revision.

**Architecture:** Extend the Sprint 2A modular monolith with a `catalog` module. PostgreSQL stores canonical entity identities, immutable per-revision rows, seals, validation results, lifecycle events, and the active pointer; application commands own import, validation, and activation transactions. The frontend remains on its current static data path, and Redis is not used by catalog commands.

**Tech Stack:** Node.js 22.13+, TypeScript 5.9.3, PostgreSQL 17, `pg` 8.22.0, Node test runner, existing canonical JSON hashing and transaction helpers.

## Global Constraints

- Base every change on `16ab189b96041b3b00355a25c07689f487b844ff`.
- Work only on `feat/2b-catalog-authority`.
- Keep the pull request stacked on `feat/2a-production-foundation`.
- PostgreSQL is the system of record.
- Accept only `CatalogSnapshotV1` with `gameModeExternalId: "aram_mayhem"`.
- Require an active Patch and the exact active Source Policy revision for import.
- A sealed revision and its children are immutable.
- Only the latest validation result for the sealed content hash may authorize activation.
- Active pointer changes require compare-and-swap input.
- Catalog event rows remain in PostgreSQL and are not routed to the normalization queue.
- Do not add external fetching, normalization, Candidate, Evidence, AI, Publication, credentials, infrastructure, merge, or deployment.
- Preserve all frontend checks and all 25 Sprint 2A backend tests.

---

## File map

- `backend/src/modules/catalog/types.ts`: public catalog types and finite reason-code unions.
- `backend/src/modules/catalog/normalize-catalog-snapshot.ts`: pure syntax validation, deterministic ordering, and hashing.
- `backend/src/modules/catalog/import-catalog-revision.ts`: atomic import, seal, audit, outbox, and idempotency.
- `backend/src/modules/catalog/validate-catalog-revision.ts`: deterministic semantic validation and immutable result recording.
- `backend/src/modules/catalog/activate-catalog-revision.ts`: compare-and-swap active pointer update.
- `backend/src/modules/catalog/validate-catalog-selection.ts`: read-only active-catalog selection validation.
- `backend/migrations/0005_catalog_authority.sql`: catalog seal, validation, lifecycle, pointer, and immutability constraints.
- `backend/test/helpers/catalog.ts`: deterministic fixtures and prerequisite seeding.
- `backend/test/catalog-snapshot.test.ts`: pure snapshot contract tests.
- `backend/test/catalog-migration.test.ts`: database shape and seal immutability tests.
- `backend/test/catalog-import.test.ts`: import atomicity and idempotency tests.
- `backend/test/catalog-validation.test.ts`: semantic validation and activation tests.
- `backend/test/catalog-selection.test.ts`: read-only selection tests.
- `.github/workflows/backend-production-foundation.yml`: rename the gate for Sprint 2B and retain the deploy guard.
- `backend/README.md`: add catalog import/validation/activation operational boundaries.

---

### Task 1: Catalog snapshot contract and deterministic hash

**Files:**
- Create: `backend/src/modules/catalog/types.ts`
- Create: `backend/src/modules/catalog/normalize-catalog-snapshot.ts`
- Create: `backend/test/catalog-snapshot.test.ts`

**Interfaces:**
- Produces: `CatalogSnapshotV1`
- Produces: `NormalizedCatalogSnapshot`
- Produces: `normalizeCatalogSnapshot(snapshot: CatalogSnapshotV1): NormalizedCatalogSnapshot`
- Produces: `CatalogValidationReasonCode`
- Produces: `CatalogSelectionReasonCode`

- [ ] **Step 1: Write the failing snapshot tests**

Create `backend/test/catalog-snapshot.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizeCatalogSnapshot,
} from '../src/modules/catalog/normalize-catalog-snapshot.js';
import type { CatalogSnapshotV1 } from '../src/modules/catalog/types.js';

function snapshot(): CatalogSnapshotV1 {
  return {
    schemaVersion: 1,
    patchKey: '26.15',
    gameModeExternalId: 'aram_mayhem',
    source: {
      adapterVersion: 'communitydragon-v1',
      sourceDigest: 'a'.repeat(64),
    },
    entities: [
      {
        entityType: 'mode',
        externalId: 'aram_mayhem',
        displayName: 'ARAM: Mayhem',
        active: true,
        attributes: {},
      },
      {
        entityType: 'champion',
        externalId: 'samira',
        displayName: 'Samira',
        active: true,
        attributes: { icon: 'https://example.invalid/samira.png' },
      },
      {
        entityType: 'augment',
        externalId: '1194',
        displayName: 'Ma Pháp Mê Hoặc',
        active: true,
        attributes: {},
      },
      {
        entityType: 'item',
        externalId: '6672',
        displayName: 'Nỏ Tử Thủ',
        active: true,
        attributes: {},
      },
      {
        entityType: 'item',
        externalId: '3006',
        displayName: 'Giày Cuồng Nộ',
        active: true,
        attributes: {},
      },
    ],
    rules: [
      {
        ruleKey: 'aram-augment-limit',
        constraintType: 'limit',
        definition: {
          modeExternalId: 'aram_mayhem',
          entityType: 'augment',
          maxSelections: 3,
        },
      },
    ],
  };
}

test('equivalent entity and rule ordering produces the same content hash', () => {
  const left = snapshot();
  const right = {
    ...snapshot(),
    entities: [...snapshot().entities].reverse(),
    rules: [...snapshot().rules].reverse(),
  };
  assert.equal(
    normalizeCatalogSnapshot(left).contentHash,
    normalizeCatalogSnapshot(right).contentHash,
  );
});

test('duplicate entity identity is rejected before persistence', () => {
  const value = snapshot();
  value.entities.push({ ...value.entities[1]! });
  assert.throws(
    () => normalizeCatalogSnapshot(value),
    /CATALOG_DUPLICATE_ENTITY/,
  );
});

test('exactly one active aram_mayhem mode entity is required', () => {
  const value = snapshot();
  value.entities = value.entities.filter((entry) => entry.entityType !== 'mode');
  assert.throws(
    () => normalizeCatalogSnapshot(value),
    /CATALOG_MODE_REQUIRED/,
  );
});

test('source digest must be lowercase hexadecimal sha256', () => {
  const value = snapshot();
  value.source.sourceDigest = 'not-a-digest';
  assert.throws(
    () => normalizeCatalogSnapshot(value),
    /CATALOG_SOURCE_DIGEST_INVALID/,
  );
});
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
cd backend
node --import tsx --test test/catalog-snapshot.test.ts
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for the catalog module.

- [ ] **Step 3: Define the exact catalog types**

Create `backend/src/modules/catalog/types.ts`:

```ts
export type CatalogEntityType = 'champion' | 'item' | 'augment' | 'mode';
export type SelectableCatalogEntityType = Exclude<CatalogEntityType, 'mode'>;
export type CatalogConstraintType = 'allow' | 'deny' | 'limit';

export interface CatalogEntityInput {
  entityType: CatalogEntityType;
  externalId: string;
  displayName: string;
  active: boolean;
  attributes: Record<string, unknown>;
}

export interface CatalogMembershipRuleDefinition {
  modeExternalId: string;
  entityType: SelectableCatalogEntityType;
  entityExternalIds: string[];
  subjectExternalIds?: string[];
}

export interface CatalogLimitRuleDefinition {
  modeExternalId: string;
  entityType: 'item' | 'augment';
  maxSelections: number;
  subjectExternalIds?: string[];
}

export interface CatalogRuleInput {
  ruleKey: string;
  constraintType: CatalogConstraintType;
  definition: CatalogMembershipRuleDefinition | CatalogLimitRuleDefinition;
}

export interface CatalogSnapshotV1 {
  schemaVersion: 1;
  patchKey: string;
  gameModeExternalId: 'aram_mayhem';
  source: {
    adapterVersion: string;
    sourceDigest: string;
  };
  entities: CatalogEntityInput[];
  rules: CatalogRuleInput[];
}

export interface NormalizedCatalogSnapshot {
  contentHash: string;
  snapshot: CatalogSnapshotV1;
}

export type CatalogValidationReasonCode =
  | 'CATALOG_CONTENT_HASH_MISMATCH'
  | 'CATALOG_PATCH_NOT_ACTIVE'
  | 'CATALOG_PATCH_MISMATCH'
  | 'CATALOG_MODE_MISSING'
  | 'CATALOG_ENTITY_REFERENCE_MISSING'
  | 'CATALOG_ENTITY_INACTIVE'
  | 'CATALOG_RULE_SHAPE_INVALID'
  | 'CATALOG_RULE_REFERENCE_MISSING'
  | 'CATALOG_SELECTION_LIMIT_INVALID';

export type CatalogSelectionReasonCode =
  | 'CATALOG_REVISION_NOT_ACTIVE'
  | 'CATALOG_SELECTION_DUPLICATE_ID'
  | 'CATALOG_ENTITY_MISSING'
  | 'CATALOG_ENTITY_INACTIVE'
  | 'CATALOG_SELECTION_DENIED'
  | 'CATALOG_SELECTION_NOT_ALLOWED'
  | 'CATALOG_SELECTION_LIMIT_EXCEEDED';
```

- [ ] **Step 4: Implement deterministic normalization**

Create `backend/src/modules/catalog/normalize-catalog-snapshot.ts`:

```ts
import { hashCanonicalJson } from '../../shared/hash.js';
import type {
  CatalogLimitRuleDefinition,
  CatalogMembershipRuleDefinition,
  CatalogRuleInput,
  CatalogSnapshotV1,
  NormalizedCatalogSnapshot,
} from './types.js';

const SHA256 = /^[a-f0-9]{64}$/;

function requiredText(value: string, code: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(code);
  return normalized;
}

function sortedUnique(values: string[], code: string): string[] {
  const normalized = values.map((value) => requiredText(value, code)).sort();
  if (new Set(normalized).size !== normalized.length) throw new Error(code);
  return normalized;
}

function normalizeRule(rule: CatalogRuleInput): CatalogRuleInput {
  const subjectExternalIds = rule.definition.subjectExternalIds === undefined
    ? undefined
    : sortedUnique(rule.definition.subjectExternalIds, 'CATALOG_DUPLICATE_RULE_REFERENCE');

  if (rule.constraintType === 'limit') {
    const definition = rule.definition as CatalogLimitRuleDefinition;
    if (
      !Number.isInteger(definition.maxSelections)
      || definition.maxSelections <= 0
      || !['item', 'augment'].includes(definition.entityType)
    ) {
      throw new Error('CATALOG_LIMIT_INVALID');
    }
    return {
      ruleKey: requiredText(rule.ruleKey, 'CATALOG_RULE_KEY_REQUIRED'),
      constraintType: 'limit',
      definition: {
        modeExternalId: requiredText(
          definition.modeExternalId,
          'CATALOG_RULE_MODE_REQUIRED',
        ),
        entityType: definition.entityType,
        maxSelections: definition.maxSelections,
        ...(subjectExternalIds === undefined ? {} : { subjectExternalIds }),
      },
    };
  }

  const definition = rule.definition as CatalogMembershipRuleDefinition;
  if (!Array.isArray(definition.entityExternalIds)) {
    throw new Error('CATALOG_RULE_ENTITY_IDS_REQUIRED');
  }
  return {
    ruleKey: requiredText(rule.ruleKey, 'CATALOG_RULE_KEY_REQUIRED'),
    constraintType: rule.constraintType,
    definition: {
      modeExternalId: requiredText(
        definition.modeExternalId,
        'CATALOG_RULE_MODE_REQUIRED',
      ),
      entityType: definition.entityType,
      entityExternalIds: sortedUnique(
        definition.entityExternalIds,
        'CATALOG_DUPLICATE_RULE_REFERENCE',
      ),
      ...(subjectExternalIds === undefined ? {} : { subjectExternalIds }),
    },
  };
}

export function normalizeCatalogSnapshot(
  input: CatalogSnapshotV1,
): NormalizedCatalogSnapshot {
  if (input.schemaVersion !== 1) throw new Error('CATALOG_SCHEMA_UNSUPPORTED');
  if (input.gameModeExternalId !== 'aram_mayhem') {
    throw new Error('CATALOG_MODE_UNSUPPORTED');
  }
  if (!SHA256.test(input.source.sourceDigest)) {
    throw new Error('CATALOG_SOURCE_DIGEST_INVALID');
  }

  const identities = new Set<string>();
  const entities = input.entities.map((entity) => {
    const externalId = requiredText(entity.externalId, 'CATALOG_ENTITY_ID_REQUIRED');
    const identity = entity.entityType + ':' + externalId;
    if (identities.has(identity)) throw new Error('CATALOG_DUPLICATE_ENTITY');
    identities.add(identity);
    return {
      ...entity,
      externalId,
      displayName: requiredText(entity.displayName, 'CATALOG_ENTITY_NAME_REQUIRED'),
    };
  }).sort((left, right) => (
    left.entityType.localeCompare(right.entityType)
    || left.externalId.localeCompare(right.externalId)
  ));

  const modes = entities.filter((entity) => (
    entity.entityType === 'mode'
    && entity.externalId === 'aram_mayhem'
    && entity.active
  ));
  if (modes.length !== 1) throw new Error('CATALOG_MODE_REQUIRED');

  const rules = input.rules
    .map(normalizeRule)
    .sort((left, right) => left.ruleKey.localeCompare(right.ruleKey));
  if (new Set(rules.map((rule) => rule.ruleKey)).size !== rules.length) {
    throw new Error('CATALOG_DUPLICATE_RULE_KEY');
  }

  const snapshot: CatalogSnapshotV1 = {
    schemaVersion: 1,
    patchKey: requiredText(input.patchKey, 'CATALOG_PATCH_KEY_REQUIRED'),
    gameModeExternalId: 'aram_mayhem',
    source: {
      adapterVersion: requiredText(
        input.source.adapterVersion,
        'CATALOG_ADAPTER_VERSION_REQUIRED',
      ),
      sourceDigest: input.source.sourceDigest,
    },
    entities,
    rules,
  };
  return { snapshot, contentHash: hashCanonicalJson(snapshot) };
}
```

- [ ] **Step 5: Run Task 1 gates**

Run:

```bash
cd backend
node --import tsx --test test/catalog-snapshot.test.ts
npm run typecheck
```

Expected: 4 catalog snapshot tests PASS and typecheck exits 0.

- [ ] **Step 6: Commit Task 1**

```bash
git add backend/src/modules/catalog/types.ts \
  backend/src/modules/catalog/normalize-catalog-snapshot.ts \
  backend/test/catalog-snapshot.test.ts
git commit -m "feat(2b): define deterministic catalog snapshots"
```

---

### Task 2: Catalog authority migration and seal invariants

**Files:**
- Create: `backend/migrations/0005_catalog_authority.sql`
- Create: `backend/test/catalog-migration.test.ts`
- Modify: `backend/test/migration.test.ts`

**Interfaces:**
- Produces tables: `catalog_revision_seals`
- Produces tables: `catalog_validation_results`
- Produces tables: `catalog_lifecycle_events`
- Produces tables: `active_catalog_revisions`
- Produces database guard: sealed revisions reject child inserts

- [ ] **Step 1: Extend the migration contract and add failing seal tests**

Add these names in alphabetical order to `expectedTables` in
`backend/test/migration.test.ts`:

```ts
'active_catalog_revisions',
'catalog_lifecycle_events',
'catalog_revision_seals',
'catalog_validation_results',
```

Create `backend/test/catalog-migration.test.ts` with tests that:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool } from 'pg';

import { resetDatabase } from './helpers/database.js';

async function seedMinimalSealedCatalog(pool: Pool): Promise<void> {
  await pool.query(`
    insert into sources values
      ('30000000-0000-4000-8000-000000000001', 'catalog-source', 'Catalog source', 'active', clock_timestamp());
    insert into source_policy_revisions
      (source_policy_revision_id, source_id, revision, storage_permission,
       collector_enabled, reason, created_by)
    values
      ('30000000-0000-4000-8000-000000000002',
       '30000000-0000-4000-8000-000000000001',
       1, 'reference_only', true, 'test', 'test');
    insert into patches (patch_id, patch_key, display_label)
    values ('30000000-0000-4000-8000-000000000003', '26.15', '26.15');
    insert into catalog_revisions
      (catalog_revision_id, patch_id, revision, status, source_policy_revision_id)
    values
      ('30000000-0000-4000-8000-000000000004',
       '30000000-0000-4000-8000-000000000003',
       1, 'draft',
       '30000000-0000-4000-8000-000000000002');
    insert into catalog_revision_seals
      (catalog_revision_id, schema_version, adapter_version, source_digest,
       game_mode_external_id, content_hash, entity_count, rule_count, sealed_by)
    values
      ('30000000-0000-4000-8000-000000000004',
       1, 'test', repeat('a', 64), 'aram_mayhem', repeat('b', 64), 0, 0, 'test');
    insert into catalog_validation_results
      (catalog_validation_result_id, catalog_revision_id, sealed_content_hash,
       validator_ruleset_version, result, reason_codes, validated_by)
    values
      ('30000000-0000-4000-8000-000000000007',
       '30000000-0000-4000-8000-000000000004',
       repeat('b', 64), 'catalog-rules-v1', 'passed', array[]::text[], 'test');
  `);
}

test('sealed catalog rejects later entity revision and rule inserts', async () => {
  const pool = await resetDatabase();
  await seedMinimalSealedCatalog(pool);

  await assert.rejects(
    pool.query(`
      insert into game_entities
        (game_entity_id, entity_type, canonical_external_id)
      values
        ('30000000-0000-4000-8000-000000000005', 'champion', 'samira');
      insert into game_entity_revisions
        (game_entity_revision_id, game_entity_id, catalog_revision_id,
         display_name, active)
      values
        ('30000000-0000-4000-8000-000000000006',
         '30000000-0000-4000-8000-000000000005',
         '30000000-0000-4000-8000-000000000004',
         'Samira', true);
    `),
    /sealed/,
  );
  await pool.end();
});

test('catalog seals and validation history reject update and delete', async () => {
  const pool = await resetDatabase();
  await seedMinimalSealedCatalog(pool);
  await assert.rejects(
    pool.query(`update catalog_revision_seals set sealed_by = 'changed'`),
    /immutable/,
  );
  await assert.rejects(
    pool.query(`delete from catalog_revision_seals`),
    /immutable/,
  );
  await assert.rejects(
    pool.query(`delete from catalog_validation_results`),
    /immutable/,
  );
  await pool.end();
});
```

- [ ] **Step 2: Run migration tests and verify RED**

Run:

```bash
cd backend
TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/hai_dau_test \
  node --import tsx --test --test-concurrency=1 \
  test/migration.test.ts test/catalog-migration.test.ts
```

Expected: FAIL because migration `0005_catalog_authority.sql` does not exist.

- [ ] **Step 3: Add the catalog authority migration**

Create `backend/migrations/0005_catalog_authority.sql`:

```sql
alter table catalog_revisions
  add constraint catalog_revisions_revision_patch_unique
  unique (catalog_revision_id, patch_id);

create table catalog_revision_seals (
  catalog_revision_id uuid primary key references catalog_revisions(catalog_revision_id),
  schema_version integer not null check (schema_version = 1),
  adapter_version text not null check (length(btrim(adapter_version)) > 0),
  source_digest text not null check (source_digest ~ '^[a-f0-9]{64}$'),
  game_mode_external_id text not null check (game_mode_external_id = 'aram_mayhem'),
  content_hash text not null unique check (content_hash ~ '^[a-f0-9]{64}$'),
  entity_count integer not null check (entity_count >= 0),
  rule_count integer not null check (rule_count >= 0),
  sealed_by text not null,
  sealed_at timestamptz not null default clock_timestamp()
);

create table catalog_validation_results (
  catalog_validation_result_id uuid primary key,
  catalog_revision_id uuid not null references catalog_revision_seals(catalog_revision_id),
  sealed_content_hash text not null check (sealed_content_hash ~ '^[a-f0-9]{64}$'),
  validator_ruleset_version text not null,
  result text not null check (result in ('passed', 'failed')),
  reason_codes text[] not null,
  validated_by text not null,
  validated_at timestamptz not null default clock_timestamp()
);

create index catalog_validation_results_latest_idx
  on catalog_validation_results (catalog_revision_id, validated_at desc);

create table catalog_lifecycle_events (
  catalog_lifecycle_event_id uuid primary key,
  catalog_revision_id uuid not null references catalog_revision_seals(catalog_revision_id),
  lifecycle_state text not null
    check (lifecycle_state in ('imported', 'validated', 'activated', 'superseded', 'withdrawn')),
  reason text not null,
  actor_id text not null,
  correlation_id text not null,
  occurred_at timestamptz not null default clock_timestamp(),
  created_at timestamptz not null default clock_timestamp()
);

create table active_catalog_revisions (
  patch_id uuid not null references patches(patch_id),
  game_mode_external_id text not null check (game_mode_external_id = 'aram_mayhem'),
  catalog_revision_id uuid not null,
  activated_at timestamptz not null default clock_timestamp(),
  primary key (patch_id, game_mode_external_id),
  foreign key (catalog_revision_id, patch_id)
    references catalog_revisions(catalog_revision_id, patch_id)
);

create trigger game_entities_immutable
before update or delete on game_entities
for each row execute function reject_immutable_change();

create trigger catalog_revision_seals_immutable
before update or delete on catalog_revision_seals
for each row execute function reject_immutable_change();

create trigger catalog_validation_results_immutable
before update or delete on catalog_validation_results
for each row execute function reject_immutable_change();

create trigger catalog_lifecycle_events_immutable
before update or delete on catalog_lifecycle_events
for each row execute function reject_immutable_change();

create or replace function reject_sealed_catalog_child_insert()
returns trigger
language plpgsql
as $$
begin
  if exists (
    select 1
      from catalog_revision_seals
     where catalog_revision_id = new.catalog_revision_id
  ) then
    raise exception 'catalog revision % is sealed', new.catalog_revision_id
      using errcode = '55000';
  end if;
  return new;
end;
$$;

create trigger game_entity_revisions_sealed_insert
before insert on game_entity_revisions
for each row execute function reject_sealed_catalog_child_insert();

create trigger compatibility_rules_sealed_insert
before insert on compatibility_rules
for each row execute function reject_sealed_catalog_child_insert();
```

- [ ] **Step 4: Run Task 2 gates**

Run:

```bash
cd backend
TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/hai_dau_test \
  node --import tsx --test --test-concurrency=1 \
  test/migration.test.ts test/catalog-migration.test.ts
npm run typecheck
```

Expected: migration table list, checksum, seal insertion guard, and immutable
history tests PASS.

- [ ] **Step 5: Commit Task 2**

```bash
git add backend/migrations/0005_catalog_authority.sql \
  backend/test/migration.test.ts \
  backend/test/catalog-migration.test.ts
git commit -m "feat(2b): enforce sealed catalog history"
```

---

### Task 3: Atomic catalog import

**Files:**
- Create: `backend/test/helpers/catalog.ts`
- Create: `backend/test/catalog-import.test.ts`
- Create: `backend/src/modules/catalog/import-catalog-revision.ts`

**Interfaces:**
- Consumes: `normalizeCatalogSnapshot`
- Consumes: `withTransaction`
- Produces: `importCatalogRevision(pool, command): Promise<ImportCatalogRevisionResult>`

- [ ] **Step 1: Create deterministic prerequisites and failing import tests**

`backend/test/helpers/catalog.ts` must export:

```ts
export const CATALOG_IDS = {
  sourceId: '40000000-0000-4000-8000-000000000001',
  sourcePolicyRevisionId: '40000000-0000-4000-8000-000000000002',
  patchId: '40000000-0000-4000-8000-000000000003',
  patchEventId: '40000000-0000-4000-8000-000000000004',
  catalogRevisionId: '40000000-0000-4000-8000-000000000005',
} as const;

export function validCatalogSnapshot(): CatalogSnapshotV1 {
  return {
    schemaVersion: 1,
    patchKey: '26.15',
    gameModeExternalId: 'aram_mayhem',
    source: {
      adapterVersion: 'communitydragon-v1',
      sourceDigest: 'a'.repeat(64),
    },
    entities: [
      {
        entityType: 'mode',
        externalId: 'aram_mayhem',
        displayName: 'ARAM: Mayhem',
        active: true,
        attributes: {},
      },
      {
        entityType: 'champion',
        externalId: 'samira',
        displayName: 'Samira',
        active: true,
        attributes: { icon: 'https://example.invalid/samira.png' },
      },
      {
        entityType: 'augment',
        externalId: '1194',
        displayName: 'Ma Pháp Mê Hoặc',
        active: true,
        attributes: {},
      },
      {
        entityType: 'item',
        externalId: '6672',
        displayName: 'Nỏ Tử Thủ',
        active: true,
        attributes: {},
      },
      {
        entityType: 'item',
        externalId: '3006',
        displayName: 'Giày Cuồng Nộ',
        active: true,
        attributes: {},
      },
    ],
    rules: [
      {
        ruleKey: 'aram-augment-limit',
        constraintType: 'limit',
        definition: {
          modeExternalId: 'aram_mayhem',
          entityType: 'augment',
          maxSelections: 3,
        },
      },
    ],
  };
}

export async function seedCatalogPrerequisites(pool: Pool): Promise<void> {
  await pool.query(`
    insert into sources (source_id, source_key, display_name)
    values ('40000000-0000-4000-8000-000000000001', 'communitydragon', 'CommunityDragon');
  `);
  await activateSourcePolicy(pool, {
    actorId: 'catalog-test',
    collectorEnabled: true,
    correlationId: 'catalog-policy',
    reason: 'catalog test source',
    revision: 1,
    revisionId: CATALOG_IDS.sourcePolicyRevisionId,
    sourceId: CATALOG_IDS.sourceId,
    storagePermission: 'reference_only',
  });
  await registerPatchEvent(pool, {
    actorId: 'catalog-test',
    correlationId: 'catalog-patch',
    displayLabel: '26.15',
    eventId: CATALOG_IDS.patchEventId,
    lifecycleState: 'active',
    occurredAt: new Date('2026-07-24T00:00:00Z'),
    patchId: CATALOG_IDS.patchId,
    patchKey: '26.15',
    reason: 'catalog test patch',
  });
}
```

Create `backend/test/catalog-import.test.ts` with these assertions:

```ts
test('catalog import atomically writes revision, children, seal, audit, and outbox', async () => {
  const pool = await resetDatabase();
  await seedCatalogPrerequisites(pool);
  const beforeAudit = await tableCount(pool, 'audit_events');
  const beforeOutbox = await tableCount(pool, 'outbox_events');

  const result = await importCatalogRevision(pool, importCommand());

  assert.equal(result.replayed, false);
  assert.match(result.contentHash, /^[a-f0-9]{64}$/);
  assert.equal(await tableCount(pool, 'catalog_revisions'), 1);
  assert.equal(await tableCount(pool, 'catalog_revision_seals'), 1);
  assert.equal(await tableCount(pool, 'game_entity_revisions'), 5);
  assert.equal(await tableCount(pool, 'compatibility_rules'), 1);
  assert.equal(await tableCount(pool, 'audit_events'), beforeAudit + 1);
  assert.equal(await tableCount(pool, 'outbox_events'), beforeOutbox + 1);
  await pool.end();
});

test('same import idempotency key replays and conflicting payload is rejected', async () => {
  const pool = await resetDatabase();
  await seedCatalogPrerequisites(pool);
  const command = importCommand();
  const first = await importCatalogRevision(pool, command);
  const replay = await importCatalogRevision(pool, command);
  assert.equal(replay.replayed, true);
  assert.equal(replay.catalogRevisionId, first.catalogRevisionId);

  const changed = {
    ...command,
    snapshot: { ...command.snapshot, patchKey: '26.16' },
  };
  await assert.rejects(
    importCatalogRevision(pool, changed),
    /IDEMPOTENCY_PAYLOAD_CONFLICT|CATALOG_PATCH_KEY_MISMATCH/,
  );
  assert.equal(await tableCount(pool, 'catalog_revisions'), 1);
  await pool.end();
});

test('seal conflict after child inserts rolls back the second revision', async () => {
  const pool = await resetDatabase();
  await seedCatalogPrerequisites(pool);
  await importCatalogRevision(pool, importCommand());
  const beforeConflict = {
    audit: await tableCount(pool, 'audit_events'),
    entityRevisions: await tableCount(pool, 'game_entity_revisions'),
    idempotency: await tableCount(pool, 'idempotency_records'),
    lifecycle: await tableCount(pool, 'catalog_lifecycle_events'),
    outbox: await tableCount(pool, 'outbox_events'),
    revisions: await tableCount(pool, 'catalog_revisions'),
    rules: await tableCount(pool, 'compatibility_rules'),
    seals: await tableCount(pool, 'catalog_revision_seals'),
  };
  const conflicting = importCommand();
  conflicting.catalogRevisionId = '40000000-0000-4000-8000-000000000006';
  conflicting.correlationId = 'catalog-import-correlation-2';
  conflicting.idempotencyKey = 'catalog-import-2';
  conflicting.revision = 2;

  await assert.rejects(
    importCatalogRevision(pool, conflicting),
    /CATALOG_CONTENT_ALREADY_IMPORTED/,
  );
  assert.deepEqual(
    {
      audit: await tableCount(pool, 'audit_events'),
      entityRevisions: await tableCount(pool, 'game_entity_revisions'),
      idempotency: await tableCount(pool, 'idempotency_records'),
      lifecycle: await tableCount(pool, 'catalog_lifecycle_events'),
      outbox: await tableCount(pool, 'outbox_events'),
      revisions: await tableCount(pool, 'catalog_revisions'),
      rules: await tableCount(pool, 'compatibility_rules'),
      seals: await tableCount(pool, 'catalog_revision_seals'),
    },
    beforeConflict,
  );
  await pool.end();
});
```

- [ ] **Step 2: Run import tests and verify RED**

Run:

```bash
cd backend
TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/hai_dau_test \
  node --import tsx --test --test-concurrency=1 test/catalog-import.test.ts
```

Expected: FAIL because `import-catalog-revision.ts` does not exist.

- [ ] **Step 3: Implement the import command**

Create `backend/src/modules/catalog/import-catalog-revision.ts` with:

```ts
export interface ImportCatalogRevisionCommand {
  actorId: string;
  catalogRevisionId: string;
  correlationId: string;
  idempotencyKey: string;
  patchId: string;
  revision: number;
  sourceId: string;
  sourcePolicyRevisionId: string;
  snapshot: CatalogSnapshotV1;
}

export interface ImportCatalogRevisionResult {
  catalogRevisionId: string;
  contentHash: string;
  replayed: boolean;
}

```

Implement the transaction in this exact order:

1. Normalize the snapshot and hash the command identity before the transaction.
2. Lock the patch row and load its latest lifecycle event ordered by
   `occurred_at desc, created_at desc, patch_lifecycle_event_id desc`.
3. Require matching `patch_key` and latest state `active`.
4. Lock the active Source Policy pointer and require exact source and revision.
5. Insert `idempotency_records` under scope `catalog_import`; replay a completed
   matching record and reject a mismatched hash.
6. Insert `catalog_revisions` with status `draft`.
7. For every normalized entity, insert canonical `game_entities` with
   `on conflict (entity_type, canonical_external_id) do nothing`, select the
   canonical ID, then insert `game_entity_revisions`.
8. Insert all compatibility rules.
9. Insert `catalog_revision_seals`; its unique content hash is also the real
   database conflict used to prove rollback after child inserts.
10. Insert `catalog_lifecycle_events` with state `imported`.
11. Insert audit action `catalog.revision_imported`.
12. Insert outbox event `CatalogRevisionImported`.
13. Complete the idempotency record with the result JSON.

Use `randomUUID()` for generated child, lifecycle, audit, and outbox IDs.
Never store the complete snapshot in audit or outbox; store revision ID,
patch ID, mode, content hash, entity count, and rule count.

- [ ] **Step 4: Run Task 3 gates**

Run:

```bash
cd backend
TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/hai_dau_test \
  node --import tsx --test --test-concurrency=1 \
  test/catalog-snapshot.test.ts test/catalog-import.test.ts
npm run typecheck
```

Expected: snapshot and import tests PASS; typecheck exits 0.

- [ ] **Step 5: Commit Task 3**

```bash
git add backend/src/modules/catalog/import-catalog-revision.ts \
  backend/test/helpers/catalog.ts \
  backend/test/catalog-import.test.ts
git commit -m "feat(2b): import and seal catalog revisions"
```

---

### Task 4: Semantic validation and compare-and-swap activation

**Files:**
- Create: `backend/src/modules/catalog/validate-catalog-revision.ts`
- Create: `backend/src/modules/catalog/activate-catalog-revision.ts`
- Create: `backend/test/catalog-validation.test.ts`

**Interfaces:**
- Produces: `validateCatalogRevision(pool, command): Promise<ValidateCatalogRevisionResult>`
- Produces: `activateCatalogRevision(pool, command): Promise<ActivateCatalogRevisionResult>`

- [ ] **Step 1: Write failing validation and activation tests**

`backend/test/catalog-validation.test.ts` must prove:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool } from 'pg';

import { activateCatalogRevision } from '../src/modules/catalog/activate-catalog-revision.js';
import {
  importCatalogRevision,
  type ImportCatalogRevisionCommand,
} from '../src/modules/catalog/import-catalog-revision.js';
import { validateCatalogRevision } from '../src/modules/catalog/validate-catalog-revision.js';
import {
  CATALOG_IDS,
  seedCatalogPrerequisites,
  validCatalogSnapshot,
} from './helpers/catalog.js';
import { resetDatabase, tableCount } from './helpers/database.js';

const REVISION_2 = '40000000-0000-4000-8000-000000000006';

function importCommand(
  catalogRevisionId = CATALOG_IDS.catalogRevisionId,
  revision = 1,
  idempotencyKey = 'catalog-import-1',
): ImportCatalogRevisionCommand {
  const snapshot = validCatalogSnapshot();
  if (revision === 2) snapshot.source.sourceDigest = 'c'.repeat(64);
  return {
    actorId: 'catalog-test',
    catalogRevisionId,
    correlationId: 'catalog-import-correlation-' + revision,
    idempotencyKey,
    patchId: CATALOG_IDS.patchId,
    revision,
    sourceId: CATALOG_IDS.sourceId,
    sourcePolicyRevisionId: CATALOG_IDS.sourcePolicyRevisionId,
    snapshot,
  };
}

function validationCommand(
  catalogRevisionId = CATALOG_IDS.catalogRevisionId,
  resultId = '41000000-0000-4000-8000-000000000001',
) {
  return {
    actorId: 'catalog-validator',
    catalogRevisionId,
    catalogValidationResultId: resultId,
    correlationId: 'catalog-validation-' + catalogRevisionId,
    reason: 'catalog rules v1 verification',
    validatorRulesetVersion: 'catalog-rules-v1' as const,
  };
}

function activationCommand(
  catalogRevisionId: string,
  expectedCurrentCatalogRevisionId: string | null,
) {
  return {
    actorId: 'catalog-operator',
    catalogRevisionId,
    correlationId: 'catalog-activation-' + catalogRevisionId,
    expectedCurrentCatalogRevisionId,
    patchId: CATALOG_IDS.patchId,
    reason: 'activate validated catalog',
  };
}

async function importAndValidate(
  pool: Pool,
  command = importCommand(),
  resultId = '41000000-0000-4000-8000-000000000001',
) {
  await importCatalogRevision(pool, command);
  return validateCatalogRevision(
    pool,
    validationCommand(command.catalogRevisionId, resultId),
  );
}

test('missing rule reference records failed validation and cannot activate', async () => {
  const pool = await resetDatabase();
  await seedCatalogPrerequisites(pool);
  const command = importCommand();
  command.snapshot.rules = [{
    ruleKey: 'missing-item-allow',
    constraintType: 'allow',
    definition: {
      modeExternalId: 'aram_mayhem',
      entityType: 'item',
      entityExternalIds: ['missing-item'],
    },
  }];
  await importCatalogRevision(pool, command);
  const validation = await validateCatalogRevision(pool, validationCommand());
  assert.equal(validation.result, 'failed');
  assert.deepEqual(validation.reasonCodes, ['CATALOG_RULE_REFERENCE_MISSING']);
  await assert.rejects(
    activateCatalogRevision(
      pool,
      activationCommand(CATALOG_IDS.catalogRevisionId, null),
    ),
    /CATALOG_VALIDATION_REQUIRED/,
  );
  await pool.end();
});

test('passed revision activates and emits immutable lifecycle, audit, and outbox', async () => {
  const pool = await resetDatabase();
  await seedCatalogPrerequisites(pool);
  const validation = await importAndValidate(pool);
  assert.equal(validation.result, 'passed');
  const activated = await activateCatalogRevision(
    pool,
    activationCommand(CATALOG_IDS.catalogRevisionId, null),
  );
  assert.equal(activated.previousCatalogRevisionId, null);
  const pointer = await pool.query(
    `select catalog_revision_id from active_catalog_revisions
      where patch_id = $1 and game_mode_external_id = 'aram_mayhem'`,
    [CATALOG_IDS.patchId],
  );
  assert.equal(pointer.rows[0]?.catalog_revision_id, CATALOG_IDS.catalogRevisionId);
  await pool.end();
});

test('stale expected pointer loses without a second activation side effect', async () => {
  const pool = await resetDatabase();
  await seedCatalogPrerequisites(pool);
  await importAndValidate(pool);
  await activateCatalogRevision(
    pool,
    activationCommand(CATALOG_IDS.catalogRevisionId, null),
  );

  await importAndValidate(
    pool,
    importCommand(REVISION_2, 2, 'catalog-import-2'),
    '41000000-0000-4000-8000-000000000002',
  );
  const first = await activateCatalogRevision(
    pool,
    activationCommand(REVISION_2, CATALOG_IDS.catalogRevisionId),
  );
  assert.equal(first.previousCatalogRevisionId, CATALOG_IDS.catalogRevisionId);
  const afterFirst = {
    audit: await tableCount(pool, 'audit_events'),
    lifecycle: await tableCount(pool, 'catalog_lifecycle_events'),
    outbox: await tableCount(pool, 'outbox_events'),
  };
  await assert.rejects(
    activateCatalogRevision(
      pool,
      activationCommand(REVISION_2, CATALOG_IDS.catalogRevisionId),
    ),
    /CATALOG_ACTIVE_POINTER_CONFLICT/,
  );
  assert.deepEqual(
    {
      audit: await tableCount(pool, 'audit_events'),
      lifecycle: await tableCount(pool, 'catalog_lifecycle_events'),
      outbox: await tableCount(pool, 'outbox_events'),
    },
    afterFirst,
  );
  assert.equal(await tableCount(pool, 'active_catalog_revisions'), 1);
  await pool.end();
});
```

- [ ] **Step 2: Run validation tests and verify RED**

Run:

```bash
cd backend
TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/hai_dau_test \
  node --import tsx --test --test-concurrency=1 test/catalog-validation.test.ts
```

Expected: FAIL because validation and activation modules do not exist.

- [ ] **Step 3: Implement semantic validation**

Create `backend/src/modules/catalog/validate-catalog-revision.ts`.

The command is:

```ts
export interface ValidateCatalogRevisionCommand {
  actorId: string;
  catalogRevisionId: string;
  catalogValidationResultId: string;
  correlationId: string;
  reason: string;
  validatorRulesetVersion: 'catalog-rules-v1';
}
```

Inside one transaction:

- lock the revision and seal;
- reconstruct the canonical snapshot from the revision, patch, seal, entity
  rows, and rule rows;
- recompute `contentHash`;
- load the latest Patch state;
- build maps by `entityType + externalId`;
- validate the mode entity, active entity references, rule shape, rule mode,
  membership references, optional subject champion references, and positive
  selection limits;
- sort and deduplicate reason codes;
- write `catalog_validation_results`;
- write lifecycle state `validated`;
- write audit action `catalog.revision_validated`;
- write outbox event `CatalogRevisionValidated`;
- return `{ result, reasonCodes, contentHash }`.

Use `passed` only when the reason-code array is empty. A failed validation is a
successful command that records immutable evidence.

- [ ] **Step 4: Implement compare-and-swap activation**

Create `backend/src/modules/catalog/activate-catalog-revision.ts`:

```ts
export interface ActivateCatalogRevisionCommand {
  actorId: string;
  catalogRevisionId: string;
  correlationId: string;
  expectedCurrentCatalogRevisionId: string | null;
  patchId: string;
  reason: string;
}

export interface ActivateCatalogRevisionResult {
  activeCatalogRevisionId: string;
  previousCatalogRevisionId: string | null;
}
```

Inside one transaction:

- lock the patch row first so an absent pointer is still concurrency-safe;
- require latest Patch state `active`;
- load seal and require patch/mode match;
- load the latest validation result ordered by
  `validated_at desc, catalog_validation_result_id desc`;
- require result `passed` and matching sealed content hash;
- load the active pointer `for update`;
- compare it with `expectedCurrentCatalogRevisionId`;
- insert or update `active_catalog_revisions`;
- when replacing a pointer, append `superseded` for the previous revision;
- append `activated` for the new revision;
- write audit action `catalog.revision_activated`;
- write outbox event `CatalogRevisionActivated`;
- return both pointer IDs.

- [ ] **Step 5: Run Task 4 gates**

Run:

```bash
cd backend
TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/hai_dau_test \
  node --import tsx --test --test-concurrency=1 \
  test/catalog-import.test.ts test/catalog-validation.test.ts
npm run typecheck
```

Expected: failed validation, passed validation, first activation, replacement,
and stale compare-and-swap tests PASS.

- [ ] **Step 6: Commit Task 4**

```bash
git add backend/src/modules/catalog/validate-catalog-revision.ts \
  backend/src/modules/catalog/activate-catalog-revision.ts \
  backend/test/catalog-validation.test.ts
git commit -m "feat(2b): validate and activate catalog revisions"
```

---

### Task 5: Read-only active catalog selection validation

**Files:**
- Create: `backend/src/modules/catalog/validate-catalog-selection.ts`
- Create: `backend/test/catalog-selection.test.ts`

**Interfaces:**
- Produces: `validateCatalogSelection(pool, input): Promise<CatalogSelectionResult>`

- [ ] **Step 1: Write failing selection tests**

Create `backend/test/catalog-selection.test.ts` covering:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool } from 'pg';

import { activateCatalogRevision } from '../src/modules/catalog/activate-catalog-revision.js';
import { importCatalogRevision } from '../src/modules/catalog/import-catalog-revision.js';
import type { CatalogSnapshotV1 } from '../src/modules/catalog/types.js';
import { validateCatalogRevision } from '../src/modules/catalog/validate-catalog-revision.js';
import { validateCatalogSelection } from '../src/modules/catalog/validate-catalog-selection.js';
import {
  CATALOG_IDS,
  seedCatalogPrerequisites,
  validCatalogSnapshot,
} from './helpers/catalog.js';
import { resetDatabase, tableCount } from './helpers/database.js';

function validSelection() {
  return {
    patchId: CATALOG_IDS.patchId,
    catalogRevisionId: CATALOG_IDS.catalogRevisionId,
    gameModeExternalId: 'aram_mayhem' as const,
    championExternalId: 'samira',
    augmentExternalIds: ['1194'],
    itemExternalIds: ['3006', '6672'],
  };
}

async function seedActiveCatalog(
  pool: Pool,
  snapshot: CatalogSnapshotV1,
): Promise<void> {
  await seedCatalogPrerequisites(pool);
  await importCatalogRevision(pool, {
    actorId: 'catalog-test',
    catalogRevisionId: CATALOG_IDS.catalogRevisionId,
    correlationId: 'catalog-selection-import',
    idempotencyKey: 'catalog-selection-import',
    patchId: CATALOG_IDS.patchId,
    revision: 1,
    sourceId: CATALOG_IDS.sourceId,
    sourcePolicyRevisionId: CATALOG_IDS.sourcePolicyRevisionId,
    snapshot,
  });
  const validation = await validateCatalogRevision(pool, {
    actorId: 'catalog-validator',
    catalogRevisionId: CATALOG_IDS.catalogRevisionId,
    catalogValidationResultId: '42000000-0000-4000-8000-000000000001',
    correlationId: 'catalog-selection-validation',
    reason: 'selection test validation',
    validatorRulesetVersion: 'catalog-rules-v1',
  });
  assert.equal(validation.result, 'passed');
  await activateCatalogRevision(pool, {
    actorId: 'catalog-operator',
    catalogRevisionId: CATALOG_IDS.catalogRevisionId,
    correlationId: 'catalog-selection-activation',
    expectedCurrentCatalogRevisionId: null,
    patchId: CATALOG_IDS.patchId,
    reason: 'selection test activation',
  });
}

test('valid selection passes against the active catalog without writes', async () => {
  const pool = await resetDatabase();
  await seedActiveCatalog(pool, validCatalogSnapshot());
  const beforeAudit = await tableCount(pool, 'audit_events');
  const result = await validateCatalogSelection(pool, validSelection());
  assert.deepEqual(result, { valid: true, reasonCodes: [] });
  assert.equal(await tableCount(pool, 'audit_events'), beforeAudit);
  await pool.end();
});

test('wrong revision fails closed before entity validation', async () => {
  const pool = await resetDatabase();
  await seedActiveCatalog(pool, validCatalogSnapshot());
  const result = await validateCatalogSelection(pool, {
    ...validSelection(),
    catalogRevisionId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
  });
  assert.deepEqual(result, {
    valid: false,
    reasonCodes: ['CATALOG_REVISION_NOT_ACTIVE'],
  });
  await pool.end();
});

test('deny overrides allow and limit overflow is stable', async () => {
  const pool = await resetDatabase();
  const snapshot = validCatalogSnapshot();
  snapshot.entities.push({
    entityType: 'augment',
    externalId: '2001',
    displayName: 'Lõi thử nghiệm',
    active: true,
    attributes: {},
  });
  snapshot.rules = [
    {
      ruleKey: 'allowed-items',
      constraintType: 'allow',
      definition: {
        modeExternalId: 'aram_mayhem',
        entityType: 'item',
        entityExternalIds: ['3006', '6672'],
      },
    },
    {
      ruleKey: 'denied-item',
      constraintType: 'deny',
      definition: {
        modeExternalId: 'aram_mayhem',
        entityType: 'item',
        entityExternalIds: ['6672'],
      },
    },
    {
      ruleKey: 'one-augment',
      constraintType: 'limit',
      definition: {
        modeExternalId: 'aram_mayhem',
        entityType: 'augment',
        maxSelections: 1,
      },
    },
  ];
  await seedActiveCatalog(pool, snapshot);
  const result = await validateCatalogSelection(pool, {
    ...validSelection(),
    augmentExternalIds: ['1194', '2001'],
  });
  assert.deepEqual(result.reasonCodes, [
    'CATALOG_SELECTION_DENIED',
    'CATALOG_SELECTION_LIMIT_EXCEEDED',
  ]);
  await pool.end();
});
```

- [ ] **Step 2: Run selection tests and verify RED**

Run:

```bash
cd backend
TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/hai_dau_test \
  node --import tsx --test --test-concurrency=1 test/catalog-selection.test.ts
```

Expected: FAIL because `validate-catalog-selection.ts` does not exist.

- [ ] **Step 3: Implement selection validation**

Create `backend/src/modules/catalog/validate-catalog-selection.ts`:

```ts
export interface CatalogSelectionInput {
  patchId: string;
  catalogRevisionId: string;
  gameModeExternalId: 'aram_mayhem';
  championExternalId: string;
  augmentExternalIds: string[];
  itemExternalIds: string[];
}

export interface CatalogSelectionResult {
  valid: boolean;
  reasonCodes: CatalogSelectionReasonCode[];
}
```

Implementation order is fixed:

1. Return only `CATALOG_REVISION_NOT_ACTIVE` unless the exact patch, mode, and
   revision match `active_catalog_revisions`.
2. Detect duplicates separately in augment and item arrays.
3. Load the selected champion, augment, and item revisions from the exact
   catalog revision.
4. Add missing and inactive reason codes.
5. Load rules for the revision and apply only rules whose mode matches and whose
   optional `subjectExternalIds` contains the champion.
6. A matching `deny` membership adds `CATALOG_SELECTION_DENIED`.
7. When at least one applicable `allow` rule exists for a type, a selected ID
   outside the union adds `CATALOG_SELECTION_NOT_ALLOWED`.
8. A count above any applicable limit adds
   `CATALOG_SELECTION_LIMIT_EXCEEDED`.
9. Return sorted unique reason codes and perform no write.

- [ ] **Step 4: Run Task 5 gates**

Run:

```bash
cd backend
TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/hai_dau_test \
  node --import tsx --test --test-concurrency=1 \
  test/catalog-selection.test.ts
npm run typecheck
```

Expected: valid, wrong-revision, missing/inactive, allow, deny, limit, duplicate,
and no-write tests PASS.

- [ ] **Step 5: Commit Task 5**

```bash
git add backend/src/modules/catalog/validate-catalog-selection.ts \
  backend/test/catalog-selection.test.ts
git commit -m "feat(2b): validate active catalog selections"
```

---

### Task 6: Runbook, workflow, and full Sprint 2B gate

**Files:**
- Modify: `backend/README.md`
- Modify: `.github/workflows/backend-production-foundation.yml`
- Modify: `README.md`

**Interfaces:**
- Consumes all Sprint 2B commands and tests.
- Produces a durable GitHub Actions quality gate with no deployment authority.

- [ ] **Step 1: Make the workflow contract fail before documentation is added**

Change the workflow name and concurrency group:

```yaml
name: Sprint 2B catalog authority gate

concurrency:
  group: sprint-2b-catalog-authority-${{ github.ref }}
  cancel-in-progress: true
```

Extend the runbook contract check with:

```js
"CatalogSnapshotV1",
"catalog_import",
"CATALOG_ACTIVE_POINTER_CONFLICT",
"CATALOG_REVISION_NOT_ACTIVE",
"No external catalog fetch",
"No normalization",
```

Run the workflow on the branch and confirm it fails only at
`Root orchestration and runbook contract` because the new runbook clauses are
not present.

- [ ] **Step 2: Document the catalog authority operations**

Add to `backend/README.md`:

- `CatalogSnapshotV1` is supplied by a deterministic adapter and contains no
  source HTML, transcript, comments, or credentials.
- Import scope is `catalog_import`; same-payload replay is safe and a changed
  payload conflicts.
- Import requires active Patch and exact active Source Policy revision.
- Seal means a new revision is required for any correction.
- Validation failures remain immutable and cannot activate.
- Activation uses expected-current compare-and-swap and can fail with
  `CATALOG_ACTIVE_POINTER_CONFLICT`.
- Selection validation fails with `CATALOG_REVISION_NOT_ACTIVE` when patch,
  mode, or revision is stale.
- Catalog events are not normalization jobs.
- No external catalog fetch, no normalization, no Candidate/Evidence/AI/
  Publication, no credentials, and no deployment are part of Sprint 2B.

Add one short Sprint 2B pointer to the root `README.md` without changing the
frontend operating commands.

- [ ] **Step 3: Run the complete local gate where services are available**

Run:

```bash
npm run validate:community
npm run lint
npm test
npm run build:pages
npm run backend:typecheck
TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/hai_dau_test \
TEST_REDIS_URL=redis://127.0.0.1:6379 \
  npm run backend:test
npm run backend:build
git diff --check
git status --short
```

Expected:

- frontend validation, lint, 46 existing tests, and Pages build PASS;
- all 25 Sprint 2A backend tests PASS;
- every new Sprint 2B test PASS;
- backend typecheck and build PASS;
- `git diff --check` exits 0;
- only intentional tracked changes appear before commit.

- [ ] **Step 4: Commit Task 6**

```bash
git add .github/workflows/backend-production-foundation.yml \
  backend/README.md README.md
git commit -m "docs(2b): add catalog authority operations gate"
```

- [ ] **Step 5: Run the durable GitHub Actions gate**

Push `feat/2b-catalog-authority`, open a draft pull request with base
`feat/2a-production-foundation`, and require:

- `Sprint 2B catalog authority gate`: SUCCESS;
- `Deploy workflow dry run`: SUCCESS;
- PostgreSQL 17 and Redis 7 services healthy;
- repository cleanliness PASS;
- deployment guard PASS;
- workflow permissions remain `contents: read`;
- no deployment command, production URL, or credential.

- [ ] **Step 6: Review the complete Sprint 2B diff**

Compare `16ab189b96041b3b00355a25c07689f487b844ff` with the Sprint 2B head and
verify:

- only catalog authority, tests, migration, workflow label, and documentation
  changed;
- no frontend generated data changed;
- no external network adapter exists;
- no queue route was added for catalog events;
- no Candidate, Evidence, AI, Publication, infrastructure, merge, or deploy
  path exists;
- every mutation has audit and outbox in the same transaction;
- selection validation is read-only.

## Plan self-review

- Spec coverage: import, seal, validation, activation, selection validation,
  audit/outbox, safety boundary, and regression gate each map to a task.
- Completeness: every task names exact files, interfaces, commands, expected
  failures, and success conditions.
- Type consistency: snapshot, validation, activation, and selection interfaces
  match the design reason-code unions.
- Scope: normalization and Candidate creation begin only after Sprint 2B.
