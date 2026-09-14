import assert from 'node:assert/strict';
import test from 'node:test';

import type { Pool } from 'pg';

import { registerPatchEvent, type RegisterPatchEventCommand } from '../src/modules/patch/register-patch-event.js';

const command: RegisterPatchEventCommand = {
  actorId: 'patch-operator', correlationId: 'patch-identity-check',
  patchId: '20000000-0000-4000-8000-000000000001', patchKey: '16.18', displayLabel: '26.18',
  eventId: '20000000-0000-4000-8000-000000000002', lifecycleState: 'active',
  occurredAt: new Date('2026-09-09T18:00:00.000Z'), reason: 'Register verified patch identity',
};

// Only the external database boundary is replaced. The real transaction and
// patch authority run here; SQL behavior is covered by the database suite.
function poolWithLockedIdentity(patchKey: string, displayLabel: string): Pool {
  const client = {
    async query(sql: string) {
      return sql.includes('from patches')
        ? { rowCount: 1, rows: [{ patch_id: command.patchId, patch_key: patchKey, display_label: displayLabel }] }
        : { rowCount: 0, rows: [] };
    },
    release() {},
  };
  return { async connect() { return client; } } as unknown as Pool;
}

test('patch authority rejects mismatched metadata on an already locked patch identity', async () => {
  for (const [patchKey, displayLabel] of [['16.17', '26.18'], ['16.18', '26.17']]) {
    await assert.rejects(registerPatchEvent(poolWithLockedIdentity(patchKey!, displayLabel!), command),
      /^Error: PATCH_IDENTITY_CONFLICT$/u);
  }
  assert.deepEqual(await registerPatchEvent(poolWithLockedIdentity('16.18', '26.18'), command),
    { eventId: command.eventId });
});
