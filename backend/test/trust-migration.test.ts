import assert from 'node:assert/strict';
import test from 'node:test';

import { resetDatabase } from './helpers/database.js';

const TRUST_TABLES = [
  'candidate_claim_set_seals',
  'candidate_claims',
  'claim_evidence_decisions',
  'current_claim_evidence_decisions',
  'current_review_quorum_evaluations',
  'evidence_associations',
  'evidence_input_snapshot_associations',
  'evidence_input_snapshots',
  'evidence_policy_revisions',
  'evidence_records',
  'human_reviews',
  'review_input_snapshot_claims',
  'review_input_snapshot_provenance',
  'review_input_snapshots',
  'review_policy_revisions',
  'review_quorum_evaluation_reviews',
  'review_quorum_evaluations',
] as const;

const HISTORY_TABLES = [
  'candidate_claim_set_seals',
  'candidate_claims',
  'claim_evidence_decisions',
  'evidence_associations',
  'evidence_input_snapshot_associations',
  'evidence_input_snapshots',
  'evidence_policy_revisions',
  'evidence_records',
  'human_reviews',
  'review_input_snapshot_claims',
  'review_input_snapshot_provenance',
  'review_input_snapshots',
  'review_policy_revisions',
  'review_quorum_evaluation_reviews',
  'review_quorum_evaluations',
] as const;

test('migration creates the complete Sprint 3B trust schema', async () => {
  const pool = await resetDatabase();
  const tables = await pool.query<{ table_name: string }>(
    `select table_name
       from information_schema.tables
      where table_schema = 'public'
        and table_name = any($1::text[])
      order by table_name`,
    [[...TRUST_TABLES]],
  );

  assert.deepEqual(
    tables.rows.map((row) => row.table_name),
    [...TRUST_TABLES].sort(),
  );
  await pool.end();
});

test('PostgreSQL TrustTupleV1 matches the runtime UTF-8 vectors', async () => {
  const pool = await resetDatabase();
  const hashes = await pool.query<{
    text_hash: string;
    tuple_hash: string;
  }>(
    `select sha256_text_v1('é') as text_hash,
            sha256_text_tuple_v1(
              array['TrustTupleV1', 'known', 'é', '@null']
            ) as tuple_hash`,
  );

  assert.deepEqual(hashes.rows[0], {
    text_hash:
      '4a99557e4033c3539de2eb65472017cad5f9557f7a0625a09f1c3f6e2ba69c4c',
    tuple_hash:
      'e4a0deda3a0813df3ba895e80dda9b76a0cbfef0971ddce825a6644eec2b7ea1',
  });
  await assert.rejects(
    pool.query(
      `select sha256_text_tuple_v1(
         array['TrustTupleV1', null, 'invalid']
       )`,
    ),
    /tuple token cannot be null/,
  );
  await pool.end();
});

test('trust history is immutable and current pointers are narrow mutable state', async () => {
  const pool = await resetDatabase();
  const triggers = await pool.query<{
    table_name: string;
    trigger_name: string;
  }>(
    `select event_object_table as table_name,
            trigger_name
       from information_schema.triggers
      where trigger_schema = 'public'
        and event_object_table = any($1::text[])
        and action_statement like '%reject_immutable_change%'
      order by event_object_table`,
    [[...HISTORY_TABLES]],
  );

  assert.deepEqual(
    [...new Set(triggers.rows.map((row) => row.table_name))],
    [...HISTORY_TABLES].sort(),
  );

  const pointerTriggers = await pool.query<{ table_name: string }>(
    `select distinct event_object_table as table_name
       from information_schema.triggers
      where trigger_schema = 'public'
        and event_object_table = any($1::text[])
        and action_statement like '%reject_immutable_change%'`,
    [[
      'current_claim_evidence_decisions',
      'current_review_quorum_evaluations',
    ]],
  );
  assert.deepEqual(pointerTriggers.rows, []);
  await pool.end();
});

test('trust schema exposes graph and deferred membership guards', async () => {
  const pool = await resetDatabase();
  const functions = await pool.query<{ function_name: string }>(
    `select proname as function_name
       from pg_proc
      where pronamespace = 'public'::regnamespace
        and proname = any($1::text[])
      order by proname`,
    [[
      'enforce_candidate_claim_graph',
      'enforce_candidate_claim_set_seal',
      'enforce_claim_evidence_decision_graph',
      'enforce_current_claim_evidence_decision_graph',
      'enforce_current_review_quorum_graph',
      'enforce_evidence_association_graph',
      'enforce_evidence_snapshot_association_graph',
      'enforce_evidence_source_graph',
      'enforce_human_review_graph',
      'enforce_review_quorum_membership_graph',
      'enforce_review_snapshot_claim_graph',
      'enforce_review_snapshot_provenance_graph',
    ]],
  );

  assert.equal(functions.rowCount, 12);

  const constraints = await pool.query<{ constraint_name: string }>(
    `select conname as constraint_name
       from pg_constraint
      where connamespace = 'public'::regnamespace
        and conname = any($1::text[])
      order by conname`,
    [[
      'candidate_provenance_revision_identity_unique',
      'candidate_revisions_trust_identity_unique',
    ]],
  );
  assert.deepEqual(
    constraints.rows.map((row) => row.constraint_name),
    [
      'candidate_provenance_revision_identity_unique',
      'candidate_revisions_trust_identity_unique',
    ],
  );
  await pool.end();
});
