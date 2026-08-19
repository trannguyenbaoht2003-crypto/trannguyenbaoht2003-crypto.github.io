import assert from 'node:assert/strict';
import test from 'node:test';

import { resetDatabase } from './helpers/database.js';

test('Sprint 8D adds durable scheduled AI discovery ticks', async () => {
  const pool = await resetDatabase();
  try {
    const result = await pool.query(
      `select to_regclass('public.scheduled_ai_discovery_ticks') as table_name`,
    );
    assert.equal(result.rows[0]?.table_name, 'scheduled_ai_discovery_ticks');
  } finally {
    await pool.end();
  }
});
