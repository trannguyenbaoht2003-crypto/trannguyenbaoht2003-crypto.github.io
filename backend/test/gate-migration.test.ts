import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import {
  evaluateCandidateEligibility,
} from '../src/modules/eligibility/evaluate-candidate-eligibility.js';
import {
  recordCandidateModerationDecision,
} from '../src/modules/moderation/record-candidate-moderation-decision.js';
import { CANDIDATE_IDS } from './helpers/candidate.js';
import { resetDatabase } from './helpers/database.js';
import {
  GATE_IDS,
  moderationDecisionCommand,
  seedActivatedGateContext,
  seedSatisfiedReviewQuorum,
} from './helpers/gate.js';

const GATE_POLICY_TABLES = [
  'active_eligibility_policy_revision',
  'candidate_eligibility_evaluation_reasons',
  'candidate_eligibility_evaluations',
  'current_candidate_eligibility_evaluations',
  'eligibility_input_snapshot_required_claims',
  'eligibility_input_snapshots',
  'eligibility_policy_revisions',
  'eligibility_recalculation_effects',
  'moderation_decisions',
  'moderation_input_snapshot_provenance',
  'moderation_input_snapshots',
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

async function seedEligibilitySnapshot(
  outcome: 'clear' | 'blocked' = 'clear',
) {
  const pool = await resetDatabase();
  await seedActivatedGateContext(pool);
  await recordCandidateModerationDecision(
    pool,
    moderationDecisionCommand({ outcome }),
  );
  if (outcome === 'clear') {
    await seedSatisfiedReviewQuorum(pool);
  }
  await evaluateCandidateEligibility(pool, {
    actorId: 'gate-migration-test',
    candidateId: CANDIDATE_IDS.candidateId,
    candidateRevisionId: CANDIDATE_IDS.candidateRevisionId,
    correlationId: `gate-migration-${outcome}`,
    evaluatedAt: '2026-07-28T13:00:00.000Z',
    evaluationId: GATE_IDS.eligibilityEvaluationId,
    idempotencyKey: `gate-migration-${outcome}`,
    inputSnapshotId: GATE_IDS.eligibilityInputSnapshotId,
  });
  return pool;
}

test('PostgreSQL rejects Eligibility when a required Claim member is omitted', async () => {
  const pool = await seedEligibilitySnapshot();
  const client = await pool.connect();
  await client.query('begin');
  await client.query(
    `insert into eligibility_input_snapshots
      (eligibility_input_snapshot_id, candidate_id,
       candidate_revision_id, patch_id, catalog_revision_id,
       candidate_normalized_signature, candidate_claim_set_seal_id,
       claim_set_hash, eligibility_policy_revision_id,
       evidence_policy_revision_id, review_policy_revision_id,
       moderation_policy_revision_id, moderation_decision_id,
       moderation_outcome, moderation_current,
       review_quorum_evaluation_id, review_quorum_satisfied,
       review_current, required_claim_count, required_claim_set_hash,
       input_hash, created_by)
     select $1, candidate_id, candidate_revision_id, patch_id,
            catalog_revision_id, candidate_normalized_signature,
            candidate_claim_set_seal_id, claim_set_hash,
            eligibility_policy_revision_id, evidence_policy_revision_id,
            review_policy_revision_id, moderation_policy_revision_id,
            moderation_decision_id, moderation_outcome,
            moderation_current, review_quorum_evaluation_id,
            review_quorum_satisfied, review_current,
            required_claim_count, required_claim_set_hash,
            repeat('f', 64), 'direct-sql-attacker'
       from eligibility_input_snapshots
      where eligibility_input_snapshot_id = $2`,
    [randomUUID(), GATE_IDS.eligibilityInputSnapshotId],
  );

  try {
    await assert.rejects(
      client.query('commit'),
      /eligibility input snapshot required Claim membership mismatch/,
    );
  } finally {
    client.release();
    await pool.end();
  }
});

test('PostgreSQL rejects eligible with an unsatisfied Review quorum and forged all_requirements_satisfied reason', async () => {
  const pool = await seedEligibilitySnapshot('blocked');
  const snapshot = await pool.query<{
    eligibility_input_snapshot_id: string;
    input_hash: string;
  }>(
    `select eligibility_input_snapshot_id, input_hash
       from eligibility_input_snapshots
      where candidate_revision_id = $1`,
    [CANDIDATE_IDS.candidateRevisionId],
  );
  const evaluationId = randomUUID();
  const client = await pool.connect();
  await client.query('begin');
  await client.query(
    `insert into candidate_eligibility_evaluations
      (candidate_eligibility_evaluation_id, candidate_id,
       candidate_revision_id, eligibility_input_snapshot_id,
       input_hash, eligibility_policy_revision_id, outcome,
       reason_count, evaluator_actor_id, correlation_id, evaluated_at)
     values ($1, $2, $3, $4, $5, $6, 'eligible', 1,
             'direct-sql-attacker', 'forged-eligibility',
             '2026-07-28T13:01:00.000Z')`,
    [
      evaluationId,
      CANDIDATE_IDS.candidateId,
      CANDIDATE_IDS.candidateRevisionId,
      snapshot.rows[0]!.eligibility_input_snapshot_id,
      snapshot.rows[0]!.input_hash,
      GATE_IDS.eligibilityPolicyId,
    ],
  );
  await client.query(
    `insert into candidate_eligibility_evaluation_reasons
      (candidate_eligibility_evaluation_id, reason_code, ordinal)
     values ($1, 'all_requirements_satisfied', 1)`,
    [evaluationId],
  );

  try {
    await assert.rejects(
      client.query('commit'),
      /eligibility evaluation result mismatch/,
    );
  } finally {
    client.release();
    await pool.end();
  }
});
