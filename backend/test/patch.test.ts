import assert from 'node:assert/strict';
import test from 'node:test';

import { registerPatchEvent } from '../src/modules/patch/register-patch-event.js';
import { resetDatabase, tableCount } from './helpers/database.js';

test('patch registration owns identity and appends lifecycle, audit, and outbox records', async () => {
  const pool = await resetDatabase();

  await registerPatchEvent(pool, {
    actorId: 'patch-operator',
    correlationId: 'correlation-patch-1',
    displayLabel: '26.15',
    eventId: '20000000-0000-4000-8000-000000000002',
    lifecycleState: 'announced',
    occurredAt: new Date('2026-07-23T00:00:00Z'),
    patchId: '20000000-0000-4000-8000-000000000001',
    patchKey: '26.15',
    reason: 'Riot patch announcement',
  });

  assert.equal(await tableCount(pool, 'patches'), 1);
  assert.equal(await tableCount(pool, 'patch_lifecycle_events'), 1);
  assert.equal(await tableCount(pool, 'audit_events'), 1);
  assert.equal(await tableCount(pool, 'outbox_events'), 1);
  await assert.rejects(
    pool.query(`update patch_lifecycle_events set reason = 'changed'`),
    /immutable/,
  );
  await pool.end();
});
