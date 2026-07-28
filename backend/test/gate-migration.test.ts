import assert from 'node:assert/strict';
import test from 'node:test';

import { resetDatabase } from './helpers/database.js';

const GATE_POLICY_TABLES = [
  'active_eligibility_policy_revision',
  'eligibility_policy_revisions',
  'moderation_policy_revisions',
] as const;

const GATE_POLICY_HISTORY_TABLES = [
  'eligibility_policy_revisions',
  'moderation_policy_revisions',
] as const;

test('migration creates the Sprint 4A gate policy foundation', async () => {
  const pool = await resetDatabase();
  const tables = await pool.query<{ table_name: string }>(
    `select table_name
       from information_schema.tables
      where table_schema = 'public'
        and table_name = any($1::text[])
      order by table_name`,
    [[...GATE_POLICY_TABLES]],
  );

  assert.deepEqual(
    tables.rows.map((row) => row.table_name),
    [...GATE_POLICY_TABLES].sort(),
  );
  const migration = await pool.query<{ checksum: string }>(
    `select checksum
       from schema_migrations
      where version = '0008_moderation_eligibility.sql'`,
  );
  assert.equal(migration.rowCount, 1);
  assert.match(migration.rows[0]!.checksum, /^[a-f0-9]{64}$/);
  await pool.end();
});

test('gate policy history is immutable while the active pointer is narrow mutable state', async () => {
  const pool = await resetDatabase();
  const historyTriggers = await pool.query<{ table_name: string }>(
    `select distinct event_object_table as table_name
       from information_schema.triggers
      where trigger_schema = 'public'
        and event_object_table = any($1::text[])
        and action_statement like '%reject_immutable_change%'
      order by event_object_table`,
    [[...GATE_POLICY_HISTORY_TABLES]],
  );
  assert.deepEqual(
    historyTriggers.rows.map((row) => row.table_name),
    [...GATE_POLICY_HISTORY_TABLES].sort(),
  );

  const pointerTrigger = await pool.query<{ table_name: string }>(
    `select distinct event_object_table as table_name
       from information_schema.triggers
      where trigger_schema = 'public'
        and event_object_table = 'active_eligibility_policy_revision'
        and action_statement like '%reject_immutable_change%'`,
  );
  assert.deepEqual(pointerTrigger.rows, []);
  await pool.end();
});
