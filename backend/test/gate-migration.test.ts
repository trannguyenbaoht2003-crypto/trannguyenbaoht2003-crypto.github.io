import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import {
  evaluateCandidateEligibility,
} from '../src/modules/eligibility/evaluate-candidate-eligibility.js';
import {
  loadEligibilityAuthority,
} from '../src/modules/eligibility/load-eligibility-authority.js';
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

test('PostgreSQL rejects an Eligibility snapshot whose Review becomes stale before commit', async () => {
  const pool = await resetDatabase();
  await seedActivatedGateContext(pool);
  await seedSatisfiedReviewQuorum(pool);

  const staleSnapshotId = randomUUID();
  const rawObservationId = randomUUID();
  const normalizedObservationId = randomUUID();
  const provenanceId = randomUUID();
  const client = await pool.connect();
  let transactionOpen = false;
  try {
    await client.query('begin');
    transactionOpen = true;
    const authority = await loadEligibilityAuthority(
      client,
      CANDIDATE_IDS.candidateId,
      CANDIDATE_IDS.candidateRevisionId,
      { lock: false },
    );
    assert.ok(authority.activePolicy);
    assert.ok(authority.claimSeal);
    assert.ok(authority.inputHash);
    assert.ok(authority.requiredClaimSetHash);
    assert.equal(authority.moderation.decisionId, null);
    assert.equal(authority.review.current, true);

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
       values (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
         $12, $13, $14, $15, $16, $17, $18, $19, $20, $21,
         'direct-sql-attacker'
       )`,
      [
        staleSnapshotId,
        authority.candidate.candidateId,
        authority.candidate.candidateRevisionId,
        authority.candidate.patchId,
        authority.candidate.catalogRevisionId,
        authority.candidate.normalizedSignature,
        authority.claimSeal.candidateClaimSetSealId,
        authority.claimSeal.claimSetHash,
        authority.activePolicy.eligibilityPolicyRevisionId,
        authority.activePolicy.evidencePolicyRevisionId,
        authority.activePolicy.reviewPolicyRevisionId,
        authority.activePolicy.moderationPolicyRevisionId,
        authority.moderation.decisionId,
        authority.moderation.outcome,
        authority.moderation.current,
        authority.review.evaluationId,
        authority.review.quorumSatisfied,
        authority.review.current,
        authority.requiredClaims.length,
        authority.requiredClaimSetHash,
        authority.inputHash,
      ],
    );
    for (
      let index = 0;
      index < authority.requiredClaims.length;
      index += 1
    ) {
      const claim = authority.requiredClaims[index]!;
      await client.query(
        `insert into eligibility_input_snapshot_required_claims
          (eligibility_input_snapshot_id, claim_id,
           candidate_revision_id, claim_key, importance,
           claim_evidence_decision_id, evidence_decision,
           evidence_policy_revision_id, decision_current, ordinal)
         values ($1, $2, $3, $4, 'required', $5, $6, $7, $8, $9)`,
        [
          staleSnapshotId,
          claim.claimId,
          authority.candidate.candidateRevisionId,
          claim.claimKey,
          claim.decisionId,
          claim.decision,
          claim.evidencePolicyRevisionId,
          claim.current,
          index + 1,
        ],
      );
    }
    await client.query(
      `insert into raw_observations
        (raw_observation_id, source_id, source_policy_revision_id,
         adapter_version, external_reference, aggregate_metadata,
         content_hash, raw_blob, patch_hint, observed_at, collected_at)
       select $1, raw.source_id, raw.source_policy_revision_id,
              raw.adapter_version, raw.external_reference,
              raw.aggregate_metadata, raw.content_hash, raw.raw_blob,
              raw.patch_hint, raw.observed_at, raw.collected_at
         from candidate_provenance provenance
         join normalized_observations normalized
           on normalized.normalized_observation_id =
              provenance.normalized_observation_id
         join raw_observations raw
           on raw.raw_observation_id = normalized.raw_observation_id
        where provenance.candidate_revision_id = $2
        order by provenance.created_at
        limit 1`,
      [rawObservationId, CANDIDATE_IDS.candidateRevisionId],
    );
    await client.query(
      `insert into normalized_observations
        (normalized_observation_id, raw_observation_id, patch_id,
         catalog_revision_id, game_mode_external_id,
         subject_game_entity_revision_id, normalizer_version,
         normalized_signature, canonical_payload)
       select $1, $2, normalized.patch_id,
              normalized.catalog_revision_id,
              normalized.game_mode_external_id,
              normalized.subject_game_entity_revision_id,
              normalized.normalizer_version,
              normalized.normalized_signature,
              normalized.canonical_payload
         from candidate_provenance provenance
         join normalized_observations normalized
           on normalized.normalized_observation_id =
              provenance.normalized_observation_id
        where provenance.candidate_revision_id = $3
        order by provenance.created_at
        limit 1`,
      [
        normalizedObservationId,
        rawObservationId,
        CANDIDATE_IDS.candidateRevisionId,
      ],
    );
    await client.query(
      `insert into candidate_provenance
        (candidate_provenance_id, candidate_revision_id,
         normalized_observation_id, origin)
       values ($1, $2, $3, 'collector_detected')`,
      [
        provenanceId,
        CANDIDATE_IDS.candidateRevisionId,
        normalizedObservationId,
      ],
    );

    const commit = client.query('commit').finally(() => {
      transactionOpen = false;
    });
    await assert.rejects(
      commit,
      /eligibility input snapshot seal mismatch/,
    );
  } finally {
    if (transactionOpen) {
      await client.query('rollback');
    }
    client.release();
    await pool.end();
  }
});
