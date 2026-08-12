import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Pool } from 'pg';

import { resetDatabase } from './helpers/database.js';

interface ReleaseRehearsalState {
  publicationId: string;
  activePublicationVersionId: string;
  activeVersionNumber: number;
  championExternalId: string;
  augmentExternalIds: readonly string[];
  itemExternalIds: readonly string[];
}

type RehearsalModule = {
  assertReleaseRehearsalEnabled?: (env: NodeJS.ProcessEnv) => void;
  seedReleaseRehearsalV1?: (pool: Pool) => Promise<ReleaseRehearsalState>;
  verifyReleaseRehearsal?: (pool: Pool) => Promise<ReleaseRehearsalState>;
};

async function loadRehearsal(): Promise<RehearsalModule> {
  const modulePath = [
    '../src/rehearsal/release-rehearsal-data',
    '.js',
  ].join('');
  return import(modulePath) as Promise<RehearsalModule>;
}

test('release rehearsal fails closed without explicit staging enablement', async () => {
  const rehearsal = await loadRehearsal();
  assert.equal(
    typeof rehearsal.assertReleaseRehearsalEnabled,
    'function',
    'release rehearsal must export assertReleaseRehearsalEnabled',
  );
  assert.throws(
    () => rehearsal.assertReleaseRehearsalEnabled?.({}),
    /RELEASE_REHEARSAL_DISABLED/,
  );
});

test('release rehearsal publishes deterministic V1 visible through the public reader', async () => {
  const rehearsal = await loadRehearsal();
  assert.equal(
    typeof rehearsal.seedReleaseRehearsalV1,
    'function',
    'release rehearsal must export seedReleaseRehearsalV1',
  );
  assert.equal(
    typeof rehearsal.verifyReleaseRehearsal,
    'function',
    'release rehearsal must export verifyReleaseRehearsal',
  );

  const pool = await resetDatabase();
  try {
    const state = await rehearsal.seedReleaseRehearsalV1!(pool);
    assert.equal(state.activeVersionNumber, 1);
    assert.equal(state.championExternalId, 'samira');
    assert.deepEqual(state.augmentExternalIds, ['1194']);
    assert.deepEqual(state.itemExternalIds, ['3006', '6672']);
    assert.deepEqual(await rehearsal.verifyReleaseRehearsal!(pool), state);
  } finally {
    await pool.end();
  }
});
