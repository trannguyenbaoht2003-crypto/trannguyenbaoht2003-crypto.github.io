import assert from 'node:assert/strict';
import test from 'node:test';

import { createPool } from '../src/database/pool.js';
import { migrate } from '../src/database/migrate.js';
import { withTransaction } from '../src/database/transaction.js';

function testDatabaseUrl(): string {
  const value = process.env.TEST_DATABASE_URL;
  if (!value) {
    throw new Error('TEST_DATABASE_URL is required for migration tests');
  }
  return value;
}

const expectedTables = [
  'active_source_policies',
  'audit_events',
  'catalog_revisions',
  'compatibility_rules',
  'game_entities',
  'game_entity_revisions',
  'idempotency_records',
  'outbox_events',
  'patch_lifecycle_events',
  'patches',
  'raw_observations',
  'schema_migrations',
  'source_policy_revisions',
  'sources',
];

test('migration creates the production foundation tables from an empty schema', async () => {
  const pool = createPool(testDatabaseUrl());
  await pool.query('drop schema public cascade; create schema public');

  await migrate(pool);

  const result = await pool.query<{ table_name: string }>(
    `select table_name
       from information_schema.tables
      where table_schema = 'public'
      order by table_name`,
  );
  assert.deepEqual(
    result.rows.map((row) => row.table_name),
    expectedTables,
  );
  await pool.end();
});

test('migration refuses an applied version whose checksum changed', async () => {
  const pool = createPool(testDatabaseUrl());
  await pool.query('drop schema public cascade; create schema public');
  await migrate(pool);
  await pool.query(
    `update schema_migrations
        set checksum = 'invalid'
      where version = '0001_production_foundation.sql'`,
  );

  await assert.rejects(migrate(pool), /checksum mismatch/);
  await pool.end();
});

test('append-only audit history rejects update and delete', async () => {
  const pool = createPool(testDatabaseUrl());
  await pool.query('drop schema public cascade; create schema public');
  await migrate(pool);
  await pool.query(
    `insert into audit_events
      (audit_event_id, actor_id, action, reason, correlation_id, payload)
     values
      ('00000000-0000-4000-8000-000000000001',
       'actor-test',
       'test.created',
       'migration invariant',
       'correlation-test',
       '{}'::jsonb)`,
  );

  await assert.rejects(
    pool.query(`update audit_events set action = 'test.changed'`),
    /immutable/,
  );
  await assert.rejects(pool.query('delete from audit_events'), /immutable/);
  await pool.end();
});

test('transaction helper rolls back every write after an error', async () => {
  const pool = createPool(testDatabaseUrl());
  await pool.query('drop schema public cascade; create schema public');
  await migrate(pool);

  await assert.rejects(
    withTransaction(pool, async (client) => {
      await client.query(
        `insert into sources (source_id, source_key, display_name)
         values ('00000000-0000-4000-8000-000000000002', 'rollback-test', 'Rollback test')`,
      );
      throw new Error('boom');
    }),
    /boom/,
  );
  const result = await pool.query<{ count: string }>('select count(*) from sources');
  assert.equal(result.rows[0]?.count, '0');
  await pool.end();
});
