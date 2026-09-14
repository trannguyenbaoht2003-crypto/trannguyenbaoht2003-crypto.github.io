import assert from 'node:assert/strict';
import test from 'node:test';

import { runCatalogOperationsCli } from '../src/catalog-operations-cli.js';
import type { CatalogOperationsInput } from '../src/modules/catalog/catalog-operations-input.js';
import { validateCatalogSelection } from '../src/modules/catalog/validate-catalog-selection.js';
import { CATALOG_IDS, seedCatalogPrerequisites, validCatalogSnapshot } from './helpers/catalog.js';
import { resetDatabase, tableCount, testDatabaseUrl } from './helpers/database.js';

const PATCH = '47000000-0000-4000-8000-000000000001';
const EVENT = '47000000-0000-4000-8000-000000000002';
const VALIDATION = '47000000-0000-4000-8000-000000000003';
const common = { actorId: 'catalog-operator-test', correlationId: 'catalog-operations-test' };

async function run(input: unknown) {
  return runCatalogOperationsCli(JSON.stringify(input), { DATABASE_URL: testDatabaseUrl() });
}

function importInput(): Extract<CatalogOperationsInput, { action: 'import' }> {
  return {
    ...common, action: 'import', catalogRevisionId: CATALOG_IDS.catalogRevisionId,
    patchId: CATALOG_IDS.patchId, revision: 1, sourceId: CATALOG_IDS.sourceId,
    sourcePolicyRevisionId: CATALOG_IDS.sourcePolicyRevisionId,
    idempotencyKey: 'catalog-operations-import', snapshot: validCatalogSnapshot(),
  };
}

function validationInput() {
  return {
    ...common, action: 'validate', catalogRevisionId: CATALOG_IDS.catalogRevisionId,
    catalogValidationResultId: VALIDATION, validatorRulesetVersion: 'catalog-rules-v1',
    reason: 'Test catalog validation',
  };
}

function activationInput() {
  return {
    ...common, action: 'activate', catalogRevisionId: CATALOG_IDS.catalogRevisionId,
    patchId: CATALOG_IDS.patchId, expectedCurrentCatalogRevisionId: null,
    reason: 'Test catalog activation',
  };
}

test('catalog CLI registers a patch, replays imports, validates, and explicitly activates', async () => {
  const pool = await resetDatabase();
  try {
    await seedCatalogPrerequisites(pool);
    const patch = await run({
      ...common, action: 'register-patch', patchId: PATCH, patchKey: '16.18',
      displayLabel: '26.18', eventId: EVENT, lifecycleState: 'active',
      occurredAt: '2026-09-09T18:00:00.000Z', reason: 'Isolated test patch',
    });
    assert.equal(patch.exitCode, 0, patch.stderr);
    const registered = await pool.query('select patch_key,display_label from patches where patch_id=$1', [PATCH]);
    assert.deepEqual(registered.rows, [{ patch_key: '16.18', display_label: '26.18' }]);

    const input = importInput();
    input.patchId = PATCH;
    input.snapshot.patchKey = '16.18';
    const imported = await run(input);
    assert.equal(imported.exitCode, 0, imported.stderr);
    assert.equal(JSON.parse(imported.stdout).replayed, false);
    const replay = await run(input);
    assert.equal(replay.exitCode, 0, replay.stderr);
    assert.equal(JSON.parse(replay.stdout).replayed, true);
    assert.equal(await tableCount(pool, 'catalog_revisions'), 1);
    assert.equal(await tableCount(pool, 'catalog_revision_seals'), 1);

    const premature = await run({ ...activationInput(), patchId: PATCH });
    assert.equal(premature.exitCode, 1);
    assert.equal(premature.stderr, 'CATALOG_VALIDATION_REQUIRED\n');
    const validated = await run(validationInput());
    assert.equal(validated.exitCode, 0, validated.stderr);
    assert.equal(JSON.parse(validated.stdout).result, 'passed');
    assert.equal(await tableCount(pool, 'active_catalog_revisions'), 0);

    const activated = await run({ ...activationInput(), patchId: PATCH });
    assert.equal(activated.exitCode, 0, activated.stderr);
    assert.equal(JSON.parse(activated.stdout).activeCatalogRevisionId, CATALOG_IDS.catalogRevisionId);
    const selection = await validateCatalogSelection(pool, {
      patchId: PATCH, catalogRevisionId: CATALOG_IDS.catalogRevisionId,
      gameModeExternalId: 'aram_mayhem', championExternalId: 'samira',
      augmentExternalIds: ['1194'], itemExternalIds: ['3006', '6672'],
    });
    assert.deepEqual(selection, { valid: true, reasonCodes: [] });
    assert.equal(await tableCount(pool, 'candidate_revisions'), 0);
    assert.equal(await tableCount(pool, 'publication_versions'), 0);
    assert.equal(await tableCount(pool, 'autonomous_ai_review_runs'), 0);

    const auditBefore = await tableCount(pool, 'audit_events');
    const staleActivation = await run({ ...activationInput(), patchId: PATCH });
    assert.equal(staleActivation.exitCode, 1);
    assert.equal(staleActivation.stderr, 'CATALOG_ACTIVE_POINTER_CONFLICT\n');
    assert.equal(await tableCount(pool, 'audit_events'), auditBefore);
    assert.equal(await tableCount(pool, 'active_catalog_revisions'), 1);
  } finally { await pool.end(); }
});

test('catalog CLI rejects a mismatched patch or inactive source policy without importing', async () => {
  const pool = await resetDatabase();
  try {
    await seedCatalogPrerequisites(pool);
    const input = importInput();
    input.snapshot.patchKey = '16.18';
    const mismatch = await run(input);
    assert.equal(mismatch.exitCode, 1);
    assert.equal(mismatch.stderr, 'CATALOG_PATCH_KEY_MISMATCH\n');
    const inactive = await run({ ...importInput(), sourcePolicyRevisionId: VALIDATION });
    assert.equal(inactive.exitCode, 1);
    assert.equal(inactive.stderr, 'CATALOG_SOURCE_POLICY_NOT_ACTIVE\n');
    assert.equal(await tableCount(pool, 'catalog_revisions'), 0);
    assert.equal(await tableCount(pool, 'game_entities'), 0);
  } finally { await pool.end(); }
});

test('failed catalog validation exits unsuccessfully and remains unable to activate', async () => {
  const pool = await resetDatabase();
  try {
    await seedCatalogPrerequisites(pool);
    const input = importInput();
    input.snapshot.rules.push({
      ruleKey: 'missing-item', constraintType: 'allow',
      definition: { modeExternalId: 'aram_mayhem', entityType: 'item', entityExternalIds: ['unknown-item'] },
    });
    assert.equal((await run(input)).exitCode, 0);
    const validation = await run(validationInput());
    assert.equal(validation.exitCode, 1);
    assert.equal(validation.stderr, '');
    assert.deepEqual(JSON.parse(validation.stdout).reasonCodes, ['CATALOG_RULE_REFERENCE_MISSING']);
    assert.equal(JSON.parse(validation.stdout).result, 'failed');
    const activation = await run(activationInput());
    assert.equal(activation.exitCode, 1);
    assert.equal(activation.stderr, 'CATALOG_VALIDATION_REQUIRED\n');
    assert.equal(await tableCount(pool, 'active_catalog_revisions'), 0);
    assert.equal(await tableCount(pool, 'catalog_validation_results'), 1);
  } finally { await pool.end(); }
});

test('patch registration rejects reusing an identity with different patch metadata', async () => {
  const pool = await resetDatabase();
  try {
    await seedCatalogPrerequisites(pool);
    const auditBefore = await tableCount(pool, 'audit_events');
    for (const changed of [{ patchKey: '16.18', displayLabel: '26.15' }, { patchKey: '26.15', displayLabel: 'Changed label' }]) {
      const result = await run({
        ...common, ...changed, action: 'register-patch', patchId: CATALOG_IDS.patchId,
        eventId: EVENT, lifecycleState: 'withdrawn',
        occurredAt: '2026-09-09T18:00:00.000Z', reason: 'Mismatched identity must not change lifecycle',
      });
      assert.equal(result.exitCode, 1);
      assert.equal(result.stderr, 'PATCH_IDENTITY_CONFLICT\n');
    }
    assert.equal(await tableCount(pool, 'audit_events'), auditBefore);
    assert.equal(await tableCount(pool, 'patch_lifecycle_events'), 1);
  } finally { await pool.end(); }
});
