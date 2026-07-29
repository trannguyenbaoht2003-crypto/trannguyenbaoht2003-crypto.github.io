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
  'active_catalog_revisions',
  'active_eligibility_policy_revision',
  'active_publication_versions',
  'active_source_policies',
  'audit_events',
  'candidate_claim_set_seals',
  'candidate_claims',
  'candidate_eligibility_evaluation_reasons',
  'candidate_eligibility_evaluations',
  'candidate_provenance',
  'candidate_revisions',
  'candidates',
  'catalog_lifecycle_events',
  'catalog_revision_seals',
  'catalog_revisions',
  'catalog_validation_results',
  'claim_evidence_decisions',
  'compatibility_rules',
  'current_candidate_eligibility_evaluations',
  'current_candidate_moderation_decisions',
  'current_claim_evidence_decisions',
  'current_review_quorum_evaluations',
  'eligibility_input_snapshot_required_claims',
  'eligibility_input_snapshots',
  'eligibility_policy_revisions',
  'eligibility_recalculation_effects',
  'evidence_associations',
  'evidence_input_snapshot_associations',
  'evidence_input_snapshots',
  'evidence_policy_revisions',
  'evidence_records',
  'game_entities',
  'game_entity_revisions',
  'human_reviews',
  'idempotency_records',
  'moderation_decisions',
  'moderation_input_snapshot_provenance',
  'moderation_input_snapshots',
  'moderation_policy_revisions',
  'normalization_effects',
  'normalized_observations',
  'outbox_events',
  'patch_lifecycle_events',
  'patches',
  'publication_activation_history',
  'publication_projection_effects',
  'publication_version_input_required_claims',
  'publication_versions',
  'publications',
  'raw_observations',
  'review_input_snapshot_claims',
  'review_input_snapshot_provenance',
  'review_input_snapshots',
  'review_policy_revisions',
  'review_quorum_evaluation_reviews',
  'review_quorum_evaluations',
  'schema_migrations',
  'source_policy_revisions',
  'sources',
  'worker_job_attempts',
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
