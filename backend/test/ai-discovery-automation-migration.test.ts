import assert from 'node:assert/strict';
import test from 'node:test';

import { resetDatabase } from './helpers/database.js';

const SCHEDULER_KEY = 'ai-discovery-hourly-v1';

async function withDatabase(run: (pool: Awaited<ReturnType<typeof resetDatabase>>) => Promise<void>) {
  const pool = await resetDatabase();
  try {
    await run(pool);
  } finally {
    await pool.end();
  }
}

test('Sprint 8D adds the durable scheduled tick table with the approved columns', async () => {
  await withDatabase(async (pool) => {
    const table = await pool.query(
      `select to_regclass('public.scheduled_ai_discovery_ticks') as table_name`,
    );
    assert.equal(table.rows[0]?.table_name, 'scheduled_ai_discovery_ticks');

    const columns = await pool.query<{ column_name: string }>(
      `select column_name
         from information_schema.columns
        where table_schema = 'public'
          and table_name = 'scheduled_ai_discovery_ticks'
        order by ordinal_position`,
    );
    assert.deepEqual(columns.rows.map((row) => row.column_name), [
      'scheduled_ai_discovery_tick_id',
      'scheduler_key',
      'utc_hour',
      'status',
      'scheduled_content_hash',
      'ai_discovery_run_id',
      'ai_operations_policy_revision_id',
      'ai_operations_run_budget_reservation_id',
      'created_at',
      'completed_at',
    ]);
  });
});

test('scheduled ticks reject non-hour UTC identity and unapproved status', async () => {
  await withDatabase(async (pool) => {
    await assert.rejects(
      pool.query(
        `insert into scheduled_ai_discovery_ticks
          (scheduled_ai_discovery_tick_id, scheduler_key, utc_hour, status)
         values ($1, $2, $3, 'PROCESSING')`,
        ['00000000-0000-4000-8000-000000000101', SCHEDULER_KEY, '2026-08-19T03:30:00.000Z'],
      ),
      /scheduled_ai_discovery_ticks/i,
    );

    await assert.rejects(
      pool.query(
        `insert into scheduled_ai_discovery_ticks
          (scheduled_ai_discovery_tick_id, scheduler_key, utc_hour, status, completed_at)
         values ($1, $2, $3, 'RETRY_ME', clock_timestamp())`,
        ['00000000-0000-4000-8000-000000000102', SCHEDULER_KEY, '2026-08-19T04:00:00.000Z'],
      ),
      /scheduled_ai_discovery_ticks/i,
    );
  });
});

test('one scheduler owns at most one durable tick per UTC hour', async () => {
  await withDatabase(async (pool) => {
    await pool.query(
      `insert into scheduled_ai_discovery_ticks
        (scheduled_ai_discovery_tick_id, scheduler_key, utc_hour, status)
       values ($1, $2, $3, 'PROCESSING')`,
      ['00000000-0000-4000-8000-000000000103', SCHEDULER_KEY, '2026-08-19T05:00:00.000Z'],
    );
    await assert.rejects(
      pool.query(
        `insert into scheduled_ai_discovery_ticks
          (scheduled_ai_discovery_tick_id, scheduler_key, utc_hour, status)
         values ($1, $2, $3, 'PROCESSING')`,
        ['00000000-0000-4000-8000-000000000104', SCHEDULER_KEY, '2026-08-19T05:00:00.000Z'],
      ),
      /duplicate key|unique/i,
    );
  });
});

test('processing tick permits one-way metadata enrichment then becomes terminal and immutable', async () => {
  await withDatabase(async (pool) => {
    const tickId = '00000000-0000-4000-8000-000000000105';
    const runId = '00000000-0000-4000-8000-000000000205';
    const hash = 'a'.repeat(64);

    await pool.query(
      `insert into scheduled_ai_discovery_ticks
        (scheduled_ai_discovery_tick_id, scheduler_key, utc_hour, status)
       values ($1, $2, $3, 'PROCESSING')`,
      [tickId, SCHEDULER_KEY, '2026-08-19T06:00:00.000Z'],
    );
    await pool.query(
      `update scheduled_ai_discovery_ticks
          set scheduled_content_hash = $2,
              ai_discovery_run_id = $3
        where scheduled_ai_discovery_tick_id = $1`,
      [tickId, hash, runId],
    );

    await assert.rejects(
      pool.query(
        `update scheduled_ai_discovery_ticks
            set scheduled_content_hash = $2
          where scheduled_ai_discovery_tick_id = $1`,
        [tickId, 'b'.repeat(64)],
      ),
      /content hash cannot change/i,
    );

    await pool.query(
      `update scheduled_ai_discovery_ticks
          set status = 'COMPLETED', completed_at = clock_timestamp()
        where scheduled_ai_discovery_tick_id = $1`,
      [tickId],
    );

    await assert.rejects(
      pool.query(
        `update scheduled_ai_discovery_ticks
            set status = 'PROVIDER_FAILED'
          where scheduled_ai_discovery_tick_id = $1`,
        [tickId],
      ),
      /terminal scheduled AI discovery ticks are immutable/i,
    );
    await assert.rejects(
      pool.query(
        `delete from scheduled_ai_discovery_ticks
          where scheduled_ai_discovery_tick_id = $1`,
        [tickId],
      ),
      /cannot be deleted/i,
    );
  });
});
