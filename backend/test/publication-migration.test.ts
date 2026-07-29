import assert from 'node:assert/strict';
import test from 'node:test';

import { resetDatabase } from './helpers/database.js';
import type {
  DirectPublicationMutation,
} from './helpers/publication.js';
import {
  insertDirectPublicationGraph,
  seedEligiblePublicationContext,
} from './helpers/publication.js';

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


async function assertPublicationCommitRejected(
  mutation: DirectPublicationMutation,
  expected: RegExp,
): Promise<void> {
  const pool = await resetDatabase();
  await seedEligiblePublicationContext(pool);
  const client = await pool.connect();
  let transactionOpen = false;
  try {
    await client.query('begin');
    transactionOpen = true;
    await insertDirectPublicationGraph(client, mutation);
    const commit = client.query('commit').finally(() => {
      transactionOpen = false;
    });
    await assert.rejects(commit, expected);
  } finally {
    if (transactionOpen) {
      await client.query('rollback');
    }
    client.release();
    await pool.end();
  }
}

test('publication migration rejects a payload forged away from CandidateRevision authority', async () => {
  await assertPublicationCommitRejected(
    {
      payload: {
        schemaVersion: 1,
        mode: 'aram_mayhem',
        patchKey: 'forged-patch',
        catalogRevisionId: '40000000-0000-4000-8000-000000000005',
        championExternalId: 'samira',
        augmentExternalIds: ['1194'],
        itemExternalIds: ['3006', '6672'],
      },
    },
    /publication version seal mismatch/,
  );
});

test('publication migration rejects omission of a required Claim member', async () => {
  await assertPublicationCommitRejected(
    { omitRequiredMembers: true },
    /publication required Claim membership mismatch/,
  );
});

test('publication migration rejects a first version that skips version one', async () => {
  await assertPublicationCommitRejected(
    { versionNumber: 2 },
    /publication version sequence mismatch/,
  );
});

test('publication migration rejects rollback as the first activation', async () => {
  await assertPublicationCommitRejected(
    { activationKind: 'rolled_back' },
    /publication activation transition mismatch/,
  );
});
