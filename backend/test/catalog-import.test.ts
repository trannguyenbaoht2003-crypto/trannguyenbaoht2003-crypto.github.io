import assert from 'node:assert/strict';
import test from 'node:test';

import {
  importCatalogRevision,
  type ImportCatalogRevisionCommand,
} from '../src/modules/catalog/import-catalog-revision.js';
import {
  CATALOG_IDS,
  seedCatalogPrerequisites,
  validCatalogSnapshot,
} from './helpers/catalog.js';
import { resetDatabase, tableCount } from './helpers/database.js';

function importCommand(): ImportCatalogRevisionCommand {
  return {
    actorId: 'catalog-importer',
    catalogRevisionId: CATALOG_IDS.catalogRevisionId,
    correlationId: 'catalog-import-correlation-1',
    idempotencyKey: 'catalog-import-1',
    patchId: CATALOG_IDS.patchId,
    revision: 1,
    sourceId: CATALOG_IDS.sourceId,
    sourcePolicyRevisionId: CATALOG_IDS.sourcePolicyRevisionId,
    snapshot: validCatalogSnapshot(),
  };
}

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
  assert.equal(await tableCount(pool, 'catalog_lifecycle_events'), 1);
  assert.equal(await tableCount(pool, 'game_entities'), 5);
  assert.equal(await tableCount(pool, 'game_entity_revisions'), 5);
  assert.equal(await tableCount(pool, 'compatibility_rules'), 1);
  assert.equal(await tableCount(pool, 'audit_events'), beforeAudit + 1);
  assert.equal(await tableCount(pool, 'outbox_events'), beforeOutbox + 1);
  await pool.end();
});

test('same import idempotency key replays without duplicate side effects', async () => {
  const pool = await resetDatabase();
  await seedCatalogPrerequisites(pool);
  const command = importCommand();
  const first = await importCatalogRevision(pool, command);
  const beforeReplay = {
    audit: await tableCount(pool, 'audit_events'),
    entities: await tableCount(pool, 'game_entity_revisions'),
    lifecycle: await tableCount(pool, 'catalog_lifecycle_events'),
    outbox: await tableCount(pool, 'outbox_events'),
    revisions: await tableCount(pool, 'catalog_revisions'),
  };

  const replay = await importCatalogRevision(pool, command);

  assert.equal(replay.replayed, true);
  assert.equal(replay.catalogRevisionId, first.catalogRevisionId);
  assert.equal(replay.contentHash, first.contentHash);
  assert.deepEqual(
    {
      audit: await tableCount(pool, 'audit_events'),
      entities: await tableCount(pool, 'game_entity_revisions'),
      lifecycle: await tableCount(pool, 'catalog_lifecycle_events'),
      outbox: await tableCount(pool, 'outbox_events'),
      revisions: await tableCount(pool, 'catalog_revisions'),
    },
    beforeReplay,
  );
  await pool.end();
});

test('same import idempotency key rejects a different payload', async () => {
  const pool = await resetDatabase();
  await seedCatalogPrerequisites(pool);
  const command = importCommand();
  await importCatalogRevision(pool, command);
  const conflicting = importCommand();
  conflicting.snapshot.source.sourceDigest = 'b'.repeat(64);
  const beforeConflict = {
    audit: await tableCount(pool, 'audit_events'),
    outbox: await tableCount(pool, 'outbox_events'),
    revisions: await tableCount(pool, 'catalog_revisions'),
  };

  await assert.rejects(
    importCatalogRevision(pool, conflicting),
    /IDEMPOTENCY_PAYLOAD_CONFLICT/,
  );
  assert.deepEqual(
    {
      audit: await tableCount(pool, 'audit_events'),
      outbox: await tableCount(pool, 'outbox_events'),
      revisions: await tableCount(pool, 'catalog_revisions'),
    },
    beforeConflict,
  );
  await pool.end();
});

test('failure after child rows rolls back every import side effect', async () => {
  const pool = await resetDatabase();
  await seedCatalogPrerequisites(pool);
  const beforeAudit = await tableCount(pool, 'audit_events');
  const beforeOutbox = await tableCount(pool, 'outbox_events');

  await assert.rejects(
    importCatalogRevision(pool, importCommand(), {
      afterChildren: async () => {
        throw new Error('injected-catalog-import-failure');
      },
    }),
    /injected-catalog-import-failure/,
  );

  assert.equal(await tableCount(pool, 'catalog_revisions'), 0);
  assert.equal(await tableCount(pool, 'catalog_revision_seals'), 0);
  assert.equal(await tableCount(pool, 'catalog_lifecycle_events'), 0);
  assert.equal(await tableCount(pool, 'game_entities'), 0);
  assert.equal(await tableCount(pool, 'game_entity_revisions'), 0);
  assert.equal(await tableCount(pool, 'compatibility_rules'), 0);
  assert.equal(await tableCount(pool, 'idempotency_records'), 0);
  assert.equal(await tableCount(pool, 'audit_events'), beforeAudit);
  assert.equal(await tableCount(pool, 'outbox_events'), beforeOutbox);
  await pool.end();
});
