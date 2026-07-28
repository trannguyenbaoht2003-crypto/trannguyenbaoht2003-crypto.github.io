import assert from 'node:assert/strict';
import test from 'node:test';

import { activateSourcePolicy } from '../src/modules/source-policy/activate-source-policy.js';
import { resetDatabase, tableCount } from './helpers/database.js';

test('source policy activation atomically creates history, pointer, audit, and outbox', async () => {
  const pool = await resetDatabase();
  await pool.query(`
    insert into sources (source_id, source_key, display_name)
    values ('10000000-0000-4000-8000-000000000001', 'bilibili', 'Bilibili')
  `);

  await activateSourcePolicy(pool, {
    actorId: 'operator-1',
    collectorEnabled: true,
    correlationId: 'correlation-policy-1',
    reason: 'approved public metadata',
    revision: 1,
    revisionId: '10000000-0000-4000-8000-000000000002',
    sourceId: '10000000-0000-4000-8000-000000000001',
    storagePermission: 'reference_only',
  });

  assert.equal(await tableCount(pool, 'source_policy_revisions'), 1);
  assert.equal(await tableCount(pool, 'active_source_policies'), 1);
  assert.equal(await tableCount(pool, 'audit_events'), 1);
  assert.equal(await tableCount(pool, 'outbox_events'), 1);
  await pool.end();
});

test('failed policy activation leaves no partial history', async () => {
  const pool = await resetDatabase();
  await pool.query(`
    insert into sources (source_id, source_key, display_name)
    values ('10000000-0000-4000-8000-000000000011', 'source-test', 'Source test')
  `);
  const command = {
    actorId: 'operator-1',
    collectorEnabled: true,
    correlationId: 'correlation-policy-2',
    reason: 'test',
    revision: 1,
    revisionId: '10000000-0000-4000-8000-000000000012',
    sourceId: '10000000-0000-4000-8000-000000000011',
    storagePermission: 'reference_only' as const,
  };
  await activateSourcePolicy(pool, command);
  await assert.rejects(activateSourcePolicy(pool, command));
  assert.equal(await tableCount(pool, 'source_policy_revisions'), 1);
  assert.equal(await tableCount(pool, 'audit_events'), 1);
  assert.equal(await tableCount(pool, 'outbox_events'), 1);
  await pool.end();
});
