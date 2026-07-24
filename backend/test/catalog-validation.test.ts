import assert from 'node:assert/strict';
import test from 'node:test';

import type { Pool } from 'pg';

import { activateCatalogRevision } from '../src/modules/catalog/activate-catalog-revision.js';
import {
  importCatalogRevision,
  type ImportCatalogRevisionCommand,
} from '../src/modules/catalog/import-catalog-revision.js';
import { validateCatalogRevision } from '../src/modules/catalog/validate-catalog-revision.js';
import { registerPatchEvent } from '../src/modules/patch/register-patch-event.js';
import {
  CATALOG_IDS,
  seedCatalogPrerequisites,
  validCatalogSnapshot,
} from './helpers/catalog.js';
import { resetDatabase, tableCount } from './helpers/database.js';

const REVISION_2 = '40000000-0000-4000-8000-000000000006';
const PATCH_2 = '40000000-0000-4000-8000-000000000007';
const PATCH_2_EVENT = '40000000-0000-4000-8000-000000000008';

function importCommand(
  catalogRevisionId = CATALOG_IDS.catalogRevisionId,
  revision = 1,
  idempotencyKey = 'catalog-import-1',
): ImportCatalogRevisionCommand {
  const snapshot = validCatalogSnapshot();
  if (revision === 2) {
    snapshot.source.sourceDigest = 'c'.repeat(64);
  }
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
  patchId = CATALOG_IDS.patchId,
) {
  return {
    actorId: 'catalog-operator',
    catalogRevisionId,
    correlationId: 'catalog-activation-' + catalogRevisionId,
    expectedCurrentCatalogRevisionId,
    patchId,
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
  command.snapshot.rules = [
    {
      ruleKey: 'missing-item-allow',
      constraintType: 'allow',
      definition: {
        modeExternalId: 'aram_mayhem',
        entityType: 'item',
        entityExternalIds: ['missing-item'],
      },
    },
  ];
  await importCatalogRevision(pool, command);

  const validation = await validateCatalogRevision(
    pool,
    validationCommand(),
  );

  assert.equal(validation.result, 'failed');
  assert.deepEqual(
    validation.reasonCodes,
    ['CATALOG_RULE_REFERENCE_MISSING'],
  );
  assert.equal(await tableCount(pool, 'catalog_validation_results'), 1);
  await assert.rejects(
    activateCatalogRevision(
      pool,
      activationCommand(CATALOG_IDS.catalogRevisionId, null),
    ),
    /CATALOG_VALIDATION_REQUIRED/,
  );
  assert.equal(await tableCount(pool, 'active_catalog_revisions'), 0);
  await pool.end();
});

test('passed revision activates with lifecycle, audit, and outbox records', async () => {
  const pool = await resetDatabase();
  await seedCatalogPrerequisites(pool);
  const validation = await importAndValidate(pool);
  assert.equal(validation.result, 'passed');
  assert.deepEqual(validation.reasonCodes, []);
  const beforeActivation = {
    audit: await tableCount(pool, 'audit_events'),
    lifecycle: await tableCount(pool, 'catalog_lifecycle_events'),
    outbox: await tableCount(pool, 'outbox_events'),
  };

  const activated = await activateCatalogRevision(
    pool,
    activationCommand(CATALOG_IDS.catalogRevisionId, null),
  );

  assert.equal(activated.previousCatalogRevisionId, null);
  assert.equal(
    activated.activeCatalogRevisionId,
    CATALOG_IDS.catalogRevisionId,
  );
  const pointer = await pool.query<{ catalog_revision_id: string }>(
    `select catalog_revision_id
       from active_catalog_revisions
      where patch_id = $1
        and game_mode_external_id = 'aram_mayhem'`,
    [CATALOG_IDS.patchId],
  );
  assert.equal(
    pointer.rows[0]?.catalog_revision_id,
    CATALOG_IDS.catalogRevisionId,
  );
  assert.deepEqual(
    {
      audit: await tableCount(pool, 'audit_events'),
      lifecycle: await tableCount(pool, 'catalog_lifecycle_events'),
      outbox: await tableCount(pool, 'outbox_events'),
    },
    {
      audit: beforeActivation.audit + 1,
      lifecycle: beforeActivation.lifecycle + 1,
      outbox: beforeActivation.outbox + 1,
    },
  );
  await pool.end();
});

test('validated revision cannot activate under another patch', async () => {
  const pool = await resetDatabase();
  await seedCatalogPrerequisites(pool);
  await importAndValidate(pool);
  await registerPatchEvent(pool, {
    actorId: 'catalog-test',
    correlationId: 'catalog-patch-2',
    displayLabel: '26.16',
    eventId: PATCH_2_EVENT,
    lifecycleState: 'active',
    occurredAt: new Date('2026-07-24T01:00:00Z'),
    patchId: PATCH_2,
    patchKey: '26.16',
    reason: 'second active patch fixture',
  });

  await assert.rejects(
    activateCatalogRevision(
      pool,
      activationCommand(CATALOG_IDS.catalogRevisionId, null, PATCH_2),
    ),
    /CATALOG_PATCH_MISMATCH/,
  );
  assert.equal(await tableCount(pool, 'active_catalog_revisions'), 0);
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
  assert.equal(
    first.previousCatalogRevisionId,
    CATALOG_IDS.catalogRevisionId,
  );
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
  const pointer = await pool.query<{ catalog_revision_id: string }>(
    `select catalog_revision_id
       from active_catalog_revisions
      where patch_id = $1
        and game_mode_external_id = 'aram_mayhem'`,
    [CATALOG_IDS.patchId],
  );
  assert.equal(pointer.rows[0]?.catalog_revision_id, REVISION_2);
  await pool.end();
});
