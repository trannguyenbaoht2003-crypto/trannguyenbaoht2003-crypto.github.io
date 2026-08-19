import assert from 'node:assert/strict';
import test from 'node:test';

import { readAiOperationsSnapshot } from '../src/modules/ai-operations/read-ai-operations-snapshot.js';
import { resetDatabase } from './helpers/database.js';

test('Sprint 8D adds safe automation metadata to the AI operations snapshot', async () => {
  const pool = await resetDatabase();
  try {
    const snapshot = await readAiOperationsSnapshot(pool);
    assert.ok('automation' in snapshot);
  } finally {
    await pool.end();
  }
});
