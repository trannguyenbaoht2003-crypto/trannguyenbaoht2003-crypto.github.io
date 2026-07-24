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
    augmentExternalIds: ['1194'],
    catalogRevisionId: CATALOG_IDS.catalogRevisionId,
    championExternalId: 'samira',
    gameModeExternalId: 'aram_mayhem' as const,
    itemExternalIds: ['3006', '6672'],
    patchId: CATALOG_IDS.patchId,
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

async function writeCounts(pool: Pool) {
  return {
    audit: await tableCount(pool, 'audit_events'),
    lifecycle: await tableCount(pool, 'catalog_lifecycle_events'),
    outbox: await tableCount(pool, 'outbox_events'),
    validation: await tableCount(pool, 'catalog_validation_results'),
  };
}

test('valid selection passes against the active catalog without writes', async () => {
  const pool = await resetDatabase();
  await seedActiveCatalog(pool, validCatalogSnapshot());
  const before = await writeCounts(pool);

  const result = await validateCatalogSelection(pool, validSelection());

  assert.deepEqual(result, { valid: true, reasonCodes: [] });
  assert.deepEqual(await writeCounts(pool), before);
  await pool.end();
});

test('wrong revision fails closed before all entity validation', async () => {
  const pool = await resetDatabase();
  await seedActiveCatalog(pool, validCatalogSnapshot());

  const result = await validateCatalogSelection(pool, {
    ...validSelection(),
    augmentExternalIds: ['missing', 'missing'],
    catalogRevisionId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
    championExternalId: 'missing',
  });

  assert.deepEqual(result, {
    valid: false,
    reasonCodes: ['CATALOG_REVISION_NOT_ACTIVE'],
  });
  await pool.end();
});

test('duplicate item or augment identifiers produce one stable reason', async () => {
  const pool = await resetDatabase();
  await seedActiveCatalog(pool, validCatalogSnapshot());

  const result = await validateCatalogSelection(pool, {
    ...validSelection(),
    augmentExternalIds: ['1194', '1194'],
    itemExternalIds: ['3006', '3006', '6672'],
  });

  assert.deepEqual(result.reasonCodes, ['CATALOG_SELECTION_DUPLICATE_ID']);
  await pool.end();
});

test('missing and inactive selections fail closed with stable reasons', async () => {
  const pool = await resetDatabase();
  const snapshot = validCatalogSnapshot();
  const inactive = snapshot.entities.find((entity) => (
    entity.entityType === 'item' && entity.externalId === '6672'
  ));
  assert.ok(inactive);
  inactive.active = false;
  await seedActiveCatalog(pool, snapshot);

  const result = await validateCatalogSelection(pool, {
    ...validSelection(),
    augmentExternalIds: ['missing-augment'],
  });

  assert.deepEqual(result.reasonCodes, [
    'CATALOG_ENTITY_INACTIVE',
    'CATALOG_ENTITY_MISSING',
  ]);
  await pool.end();
});

test('applicable allow rules reject selections outside their union', async () => {
  const pool = await resetDatabase();
  const snapshot = validCatalogSnapshot();
  snapshot.rules = [
    {
      constraintType: 'allow',
      definition: {
        entityExternalIds: ['3006'],
        entityType: 'item',
        modeExternalId: 'aram_mayhem',
      },
      ruleKey: 'allowed-items',
    },
  ];
  await seedActiveCatalog(pool, snapshot);

  const result = await validateCatalogSelection(pool, validSelection());

  assert.deepEqual(
    result.reasonCodes,
    ['CATALOG_SELECTION_NOT_ALLOWED'],
  );
  await pool.end();
});

test('deny overrides allow and limit overflow is stable', async () => {
  const pool = await resetDatabase();
  const snapshot = validCatalogSnapshot();
  snapshot.entities.push({
    active: true,
    attributes: {},
    displayName: 'Lõi thử nghiệm',
    entityType: 'augment',
    externalId: '2001',
  });
  snapshot.rules = [
    {
      constraintType: 'allow',
      definition: {
        entityExternalIds: ['3006', '6672'],
        entityType: 'item',
        modeExternalId: 'aram_mayhem',
      },
      ruleKey: 'allowed-items',
    },
    {
      constraintType: 'deny',
      definition: {
        entityExternalIds: ['6672'],
        entityType: 'item',
        modeExternalId: 'aram_mayhem',
      },
      ruleKey: 'denied-item',
    },
    {
      constraintType: 'limit',
      definition: {
        entityType: 'augment',
        maxSelections: 1,
        modeExternalId: 'aram_mayhem',
      },
      ruleKey: 'one-augment',
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
