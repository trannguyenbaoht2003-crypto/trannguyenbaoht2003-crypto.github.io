import assert from 'node:assert/strict';
import test from 'node:test';

import { resetDatabase } from './helpers/database.js';

const PUBLICATION_TABLES = [
  'active_publication_versions',
  'publication_activation_history',
  'publication_projection_effects',
  'publication_version_input_required_claims',
  'publication_versions',
  'publications',
] as const;

const IMMUTABLE_PUBLICATION_TABLES = [
  'publication_activation_history',
  'publication_version_input_required_claims',
  'publication_versions',
  'publications',
] as const;

test('Publication schema creates the exact Sprint 4B authority tables', async () => {
  const pool = await resetDatabase();
  try {
    const result = await pool.query<{ table_name: string }>(
      `select table_name
         from information_schema.tables
        where table_schema = 'public'
          and table_name = any($1::text[])
        order by table_name`,
      [[...PUBLICATION_TABLES]],
    );

    assert.deepEqual(
      result.rows.map((row) => row.table_name),
      [...PUBLICATION_TABLES].sort(),
    );
    const migration = await pool.query<{ checksum: string }>(
      `select checksum
         from schema_migrations
        where version = '0009_publication_authority.sql'`,
    );
    assert.equal(migration.rowCount, 1);
    assert.match(migration.rows[0]!.checksum, /^[a-f0-9]{64}$/);
  } finally {
    await pool.end();
  }
});

test('Publication identity, versions, membership, and activation history are immutable', async () => {
  const pool = await resetDatabase();
  try {
    const result = await pool.query<{ table_name: string }>(
      `select distinct event_object_table as table_name
         from information_schema.triggers
        where trigger_schema = 'public'
          and event_object_table = any($1::text[])
          and action_statement like '%reject_immutable_change%'
        order by event_object_table`,
      [[...IMMUTABLE_PUBLICATION_TABLES]],
    );

    assert.deepEqual(
      result.rows.map((row) => row.table_name),
      [...IMMUTABLE_PUBLICATION_TABLES].sort(),
    );
  } finally {
    await pool.end();
  }
});

test('Publication active pointer remains narrow mutable state', async () => {
  const pool = await resetDatabase();
  try {
    const result = await pool.query<{ table_name: string }>(
      `select distinct event_object_table as table_name
         from information_schema.triggers
        where trigger_schema = 'public'
          and event_object_table = 'active_publication_versions'
          and action_statement like '%reject_immutable_change%'`,
    );
    assert.deepEqual(result.rows, []);
  } finally {
    await pool.end();
  }
});
