import assert from 'node:assert/strict';
import test from 'node:test';

import { withTransaction } from '../src/database/transaction.js';
import {
  completeHumanReview,
} from '../src/modules/trust/complete-human-review.js';
import {
  hashCanonicalTupleV1,
} from '../src/modules/trust/normalize-trust-input.js';
import {
  recordClaimEvidenceDecision,
} from '../src/modules/trust/record-claim-evidence-decision.js';
import { resetDatabase } from './helpers/database.js';
import {
  TRUST_IDS,
  appendAiProvenance,
  evidenceDecisionCommand,
  humanReviewCommand,
  seedTrustClaimSet,
  seedTrustReviewContext,
} from './helpers/trust.js';

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

test('every populated trust history table rejects actual update and delete', async () => {
  const pool = await resetDatabase();
  await seedTrustReviewContext(pool);
  await completeHumanReview(pool, humanReviewCommand());

  for (const table of HISTORY_TABLES) {
    await assert.rejects(
      pool.query(
        `update ${table}
            set created_at = created_at`,
      ),
      /immutable/,
    );
    await assert.rejects(
      pool.query(`delete from ${table}`),
      /immutable/,
    );
  }
  await pool.end();
});

test('deferred Claim seal rejects late membership and wrong statement hash', async () => {
  const pool = await resetDatabase();
  await seedTrustClaimSet(pool);
  const authority = await pool.query<{
    candidate_id: string;
    candidate_revision_id: string;
    catalog_revision_id: string;
    patch_id: string;
  }>(
    `select candidate_id,
            candidate_revision_id,
            patch_id,
            catalog_revision_id
       from candidate_claims
      where claim_id = $1`,
    [TRUST_IDS.requiredClaimId],
  );
  const row = authority.rows[0];
  assert.ok(row);

  await assert.rejects(
    pool.query(
      `insert into candidate_claims
        (claim_id, candidate_id, candidate_revision_id, patch_id,
         catalog_revision_id, claim_key, claim_type, importance,
         statement, statement_hash, created_by)
       values (
         '75000000-0000-4000-8000-000000000001',
         $1, $2, $3, $4, 'wrong-hash', 'compatibility',
         'informational', 'Exact statement', $5, 'direct-sql'
       )`,
      [
        row.candidate_id,
        row.candidate_revision_id,
        row.patch_id,
        row.catalog_revision_id,
        '0'.repeat(64),
      ],
    ),
    /statement hash mismatch/,
  );

  await assert.rejects(
    withTransaction(pool, async (client) => {
      await client.query(
        `insert into candidate_claims
          (claim_id, candidate_id, candidate_revision_id, patch_id,
           catalog_revision_id, claim_key, claim_type, importance,
           statement, statement_hash, created_by)
         values (
           '75000000-0000-4000-8000-000000000002',
           $1, $2, $3, $4, 'late-member', 'compatibility',
           'informational', 'Exact late statement',
           sha256_text_v1('Exact late statement'), 'direct-sql'
         )`,
        [
          row.candidate_id,
          row.candidate_revision_id,
          row.patch_id,
          row.catalog_revision_id,
        ],
      );
    }),
    /claim set seal mismatch/,
  );
  await pool.end();
});

test('deferred Evidence snapshot rejects a forged Claim statement hash', async () => {
  const pool = await resetDatabase();
  await seedTrustClaimSet(pool);

  await assert.rejects(
    withTransaction(pool, async (client) => {
      await client.query(
        `insert into evidence_input_snapshots
          (evidence_input_snapshot_id, claim_id, candidate_id,
           candidate_revision_id, patch_id, catalog_revision_id,
           candidate_claim_set_seal_id, claim_set_hash,
           claim_statement_hash, evidence_policy_revision_id,
           association_count, input_hash, created_by, evaluated_at)
         select
           '75000000-0000-4000-8000-000000000005',
           claim.claim_id, claim.candidate_id,
           claim.candidate_revision_id, claim.patch_id,
           claim.catalog_revision_id,
           seal.candidate_claim_set_seal_id, seal.claim_set_hash,
           $2, $3,
           0,
           sha256_text_tuple_v1(
             array[
               'TrustTupleV1',
               'EvidenceInputSnapshotV1',
               claim.candidate_revision_id::text,
               claim.patch_id::text,
               claim.catalog_revision_id::text,
               claim.claim_id::text,
               seal.claim_set_hash,
               $2,
               $3::uuid::text,
               '0'
             ]
           ),
           'direct-sql',
           '2026-07-28T02:30:00.000Z'
          from candidate_claims claim
          join candidate_claim_set_seals seal
            on seal.candidate_revision_id =
               claim.candidate_revision_id
         where claim.claim_id = $1`,
        [
          TRUST_IDS.requiredClaimId,
          '0'.repeat(64),
          TRUST_IDS.evidencePolicyId,
        ],
      );
    }),
    /claim statement hash mismatch/,
  );
  await pool.end();
});

test('deferred Review snapshot rejects AI provenance under a non-AI policy', async () => {
  const pool = await resetDatabase();
  await seedTrustReviewContext(pool, false);
  await appendAiProvenance(pool);
  await completeHumanReview(pool, humanReviewCommand());

  const sourceResult = await pool.query<{
    candidate_claim_set_seal_id: string;
    candidate_id: string;
    candidate_normalized_signature: string;
    candidate_revision_id: string;
    catalog_revision_id: string;
    claim_decision_set_hash: string;
    claim_set_hash: string;
    patch_id: string;
    provenance_set_hash: string;
  }>(
    `select candidate_id, candidate_revision_id, patch_id,
            catalog_revision_id, candidate_normalized_signature,
            candidate_claim_set_seal_id, claim_set_hash,
            provenance_set_hash, claim_decision_set_hash
       from review_input_snapshots
      where review_input_snapshot_id = $1`,
    [TRUST_IDS.reviewInputSnapshotId],
  );
  const source = sourceResult.rows[0];
  assert.ok(source);

  const claims = await pool.query<{
    claim_evidence_decision_id: string | null;
    claim_id: string;
    importance: string;
  }>(
    `select member.claim_id, member.importance,
            member.claim_evidence_decision_id
       from review_input_snapshot_claims member
       join candidate_claims claim
         on claim.claim_id = member.claim_id
      where member.review_input_snapshot_id = $1
      order by claim.claim_key collate "C"`,
    [TRUST_IDS.reviewInputSnapshotId],
  );
  const provenance = await pool.query<{
    candidate_provenance_id: string;
    origin: string;
  }>(
    `select candidate_provenance_id, origin
       from review_input_snapshot_provenance
      where review_input_snapshot_id = $1
      order by candidate_provenance_id::text collate "C"`,
    [TRUST_IDS.reviewInputSnapshotId],
  );
  assert.equal(provenance.rows.some(
    (entry) => entry.origin === 'ai_generated',
  ), true);

  const nonAiPolicyId = '75000000-0000-4000-8000-000000000006';
  const forgedSnapshotId = '75000000-0000-4000-8000-000000000007';
  const inputHash = hashCanonicalTupleV1([
    'TrustTupleV1',
    'ReviewInputSnapshotV1',
    source.candidate_id,
    source.candidate_revision_id,
    source.patch_id,
    source.catalog_revision_id,
    source.candidate_normalized_signature,
    source.claim_set_hash,
    nonAiPolicyId,
    String(claims.rows.length),
    ...claims.rows.flatMap((claim) => [
      claim.claim_id,
      claim.importance,
      claim.claim_evidence_decision_id ?? '@null',
    ]),
    String(provenance.rows.length),
    ...provenance.rows.flatMap((entry) => [
      entry.candidate_provenance_id,
      entry.origin,
    ]),
  ]);

  await assert.rejects(
    withTransaction(pool, async (client) => {
      await client.query(
        `insert into review_policy_revisions
          (review_policy_revision_id, policy_key, revision,
           minimum_confirmed_reviews, require_distinct_reviewers,
           required_permission, applies_to_ai_provenance,
           reason, created_by)
         values ($1, 'human-review-no-ai', 1, 2, true, 'reviewer',
                 false, 'AI provenance is outside this policy.',
                 'direct-sql')`,
        [nonAiPolicyId],
      );
      await client.query(
        `insert into review_input_snapshots
          (review_input_snapshot_id, candidate_id,
           candidate_revision_id, patch_id, catalog_revision_id,
           candidate_normalized_signature,
           candidate_claim_set_seal_id, claim_set_hash,
           claim_count, provenance_count, provenance_set_hash,
           claim_decision_set_hash, review_policy_revision_id,
           input_hash, created_by)
         values (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
           $13, $14, 'direct-sql'
         )`,
        [
          forgedSnapshotId,
          source.candidate_id,
          source.candidate_revision_id,
          source.patch_id,
          source.catalog_revision_id,
          source.candidate_normalized_signature,
          source.candidate_claim_set_seal_id,
          source.claim_set_hash,
          claims.rows.length,
          provenance.rows.length,
          source.provenance_set_hash,
          source.claim_decision_set_hash,
          nonAiPolicyId,
          inputHash,
        ],
      );
      await client.query(
        `insert into review_input_snapshot_claims
          (review_input_snapshot_id, claim_id,
           candidate_revision_id, importance,
           claim_evidence_decision_id, ordinal)
         select $1, claim_id, candidate_revision_id, importance,
                claim_evidence_decision_id, ordinal
           from review_input_snapshot_claims
          where review_input_snapshot_id = $2`,
        [forgedSnapshotId, TRUST_IDS.reviewInputSnapshotId],
      );
      await client.query(
        `insert into review_input_snapshot_provenance
          (review_input_snapshot_id, candidate_provenance_id,
           candidate_revision_id, origin, ordinal)
         select $1, candidate_provenance_id,
                candidate_revision_id, origin, ordinal
           from review_input_snapshot_provenance
          where review_input_snapshot_id = $2`,
        [forgedSnapshotId, TRUST_IDS.reviewInputSnapshotId],
      );
    }),
    /review policy does not apply to AI provenance/,
  );
  await pool.end();
});

test('Evidence pointer graph rejects another Claim and backward movement', async () => {
  const pool = await resetDatabase();
  await seedTrustClaimSet(pool);
  await recordClaimEvidenceDecision(pool, evidenceDecisionCommand());
  const secondClaim = await pool.query<{
    candidate_id: string;
    candidate_revision_id: string;
    catalog_revision_id: string;
    patch_id: string;
  }>(
    `select candidate_id,
            candidate_revision_id,
            patch_id,
            catalog_revision_id
       from candidate_claims
      where claim_id = $1`,
    [TRUST_IDS.supportingClaimId],
  );
  const second = secondClaim.rows[0];
  assert.ok(second);

  await assert.rejects(
    pool.query(
      `insert into current_claim_evidence_decisions
        (claim_id, candidate_id, candidate_revision_id, patch_id,
         catalog_revision_id, evidence_policy_revision_id,
         claim_evidence_decision_id)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [
        TRUST_IDS.supportingClaimId,
        second.candidate_id,
        second.candidate_revision_id,
        second.patch_id,
        second.catalog_revision_id,
        TRUST_IDS.evidencePolicyId,
        TRUST_IDS.evidenceDecisionId,
      ],
    ),
    /foreign key|unique constraint/,
  );

  await recordClaimEvidenceDecision(pool, evidenceDecisionCommand({
    associations: [],
    correlationId: 'direct-sql-pointer-later',
    decision: 'insufficient',
    decisionId: TRUST_IDS.reevaluationDecisionId,
    evaluatedAt: '2026-07-28T03:00:00.000Z',
    evidenceInputSnapshotId: TRUST_IDS.reevaluationInputSnapshotId,
    idempotencyKey: 'direct-sql-pointer-later',
    reason: 'Later evaluation for pointer rollback contract.',
  }));
  await assert.rejects(
    pool.query(
      `update current_claim_evidence_decisions
          set claim_evidence_decision_id = $2,
              updated_at = clock_timestamp()
        where claim_id = $1`,
      [TRUST_IDS.requiredClaimId, TRUST_IDS.evidenceDecisionId],
    ),
    /cannot move backward/,
  );
  await pool.end();
});

test('Evidence pointer rejects rollback between equal-time decisions', async () => {
  const pool = await resetDatabase();
  await seedTrustClaimSet(pool);
  await recordClaimEvidenceDecision(pool, evidenceDecisionCommand());
  await recordClaimEvidenceDecision(pool, evidenceDecisionCommand({
    associations: [],
    correlationId: 'equal-time-evidence-later',
    decision: 'insufficient',
    decisionId: TRUST_IDS.reevaluationDecisionId,
    evaluatedAt: '2026-07-28T02:00:00.000Z',
    evidenceInputSnapshotId: TRUST_IDS.reevaluationInputSnapshotId,
    idempotencyKey: 'equal-time-evidence-later',
    reason: 'A later immutable evaluation shares the same domain time.',
  }));

  try {
    await assert.rejects(
      pool.query(
        `update current_claim_evidence_decisions
            set claim_evidence_decision_id = $2,
                updated_at = clock_timestamp()
          where claim_id = $1`,
        [TRUST_IDS.requiredClaimId, TRUST_IDS.evidenceDecisionId],
      ),
      /cannot move backward/,
    );
  } finally {
    await pool.end();
  }
});

test('Review pointer rejects rollback between equal-time evaluations', async () => {
  const pool = await resetDatabase();
  await seedTrustReviewContext(pool);
  await completeHumanReview(pool, humanReviewCommand());
  const laterEvaluationId = '75000000-0000-4000-8000-000000000008';

  await withTransaction(pool, async (client) => {
    await client.query(
      `insert into review_quorum_evaluations
        (review_quorum_evaluation_id, candidate_id,
         candidate_revision_id, review_input_snapshot_id,
         input_hash, review_policy_revision_id,
         required_confirmed_count, counted_review_count,
         quorum_satisfied, evaluated_at)
       select $1, candidate_id, candidate_revision_id,
              review_input_snapshot_id, input_hash,
              review_policy_revision_id, required_confirmed_count,
              counted_review_count, quorum_satisfied, evaluated_at
         from review_quorum_evaluations
        where review_quorum_evaluation_id = $2`,
      [laterEvaluationId, TRUST_IDS.reviewQuorumEvaluationId],
    );
    await client.query(
      `insert into review_quorum_evaluation_reviews
        (review_quorum_evaluation_id, human_review_id,
         candidate_id, candidate_revision_id,
         review_policy_revision_id, input_hash,
         reviewer_actor_id, ordinal)
       select $1, human_review_id, candidate_id,
              candidate_revision_id, review_policy_revision_id,
              input_hash, reviewer_actor_id, ordinal
         from review_quorum_evaluation_reviews
        where review_quorum_evaluation_id = $2`,
      [laterEvaluationId, TRUST_IDS.reviewQuorumEvaluationId],
    );
    await client.query(
      `update current_review_quorum_evaluations
          set review_quorum_evaluation_id = $2,
              updated_at = clock_timestamp()
        where candidate_revision_id = (
          select candidate_revision_id
            from review_quorum_evaluations
           where review_quorum_evaluation_id = $1
        )
          and review_policy_revision_id = $3`,
      [
        TRUST_IDS.reviewQuorumEvaluationId,
        laterEvaluationId,
        TRUST_IDS.reviewPolicyId,
      ],
    );
  });

  try {
    await assert.rejects(
      pool.query(
        `update current_review_quorum_evaluations
            set review_quorum_evaluation_id = $2,
                updated_at = clock_timestamp()
          where review_quorum_evaluation_id = $1`,
        [laterEvaluationId, TRUST_IDS.reviewQuorumEvaluationId],
      ),
      /cannot move backward/,
    );
  } finally {
    await pool.end();
  }
});

test('deferred Review snapshot rejects a decision that becomes current before commit', async () => {
  const pool = await resetDatabase();
  await seedTrustReviewContext(pool);
  await completeHumanReview(pool, humanReviewCommand());

  const sourceResult = await pool.query<{
    candidate_claim_set_seal_id: string;
    candidate_id: string;
    candidate_normalized_signature: string;
    candidate_revision_id: string;
    catalog_revision_id: string;
    claim_decision_set_hash: string;
    claim_set_hash: string;
    patch_id: string;
    provenance_set_hash: string;
  }>(
    `select candidate_id, candidate_revision_id, patch_id,
            catalog_revision_id, candidate_normalized_signature,
            candidate_claim_set_seal_id, claim_set_hash,
            provenance_set_hash, claim_decision_set_hash
       from review_input_snapshots
      where review_input_snapshot_id = $1`,
    [TRUST_IDS.reviewInputSnapshotId],
  );
  const source = sourceResult.rows[0];
  assert.ok(source);

  const claims = await pool.query<{
    claim_evidence_decision_id: string | null;
    claim_id: string;
    importance: string;
  }>(
    `select member.claim_id, member.importance,
            member.claim_evidence_decision_id
       from review_input_snapshot_claims member
       join candidate_claims claim
         on claim.claim_id = member.claim_id
      where member.review_input_snapshot_id = $1
      order by claim.claim_key collate "C"`,
    [TRUST_IDS.reviewInputSnapshotId],
  );
  const provenance = await pool.query<{
    candidate_provenance_id: string;
    origin: string;
  }>(
    `select candidate_provenance_id, origin
       from review_input_snapshot_provenance
      where review_input_snapshot_id = $1
      order by candidate_provenance_id::text collate "C"`,
    [TRUST_IDS.reviewInputSnapshotId],
  );
  const supportingResult = await pool.query<{
    candidate_claim_set_seal_id: string;
    candidate_id: string;
    candidate_revision_id: string;
    catalog_revision_id: string;
    claim_set_hash: string;
    patch_id: string;
    statement_hash: string;
  }>(
    `select claim.candidate_id, claim.candidate_revision_id,
            claim.patch_id, claim.catalog_revision_id,
            claim.statement_hash,
            seal.candidate_claim_set_seal_id,
            seal.claim_set_hash
       from candidate_claims claim
       join candidate_claim_set_seals seal
         on seal.candidate_revision_id =
            claim.candidate_revision_id
      where claim.claim_id = $1`,
    [TRUST_IDS.supportingClaimId],
  );
  const supporting = supportingResult.rows[0];
  assert.ok(supporting);
  assert.equal(
    claims.rows.find(
      (claim) => claim.claim_id === TRUST_IDS.supportingClaimId,
    )?.claim_evidence_decision_id,
    null,
  );

  const reviewPolicyId = '75000000-0000-4000-8000-000000000009';
  const reviewSnapshotId = '75000000-0000-4000-8000-000000000010';
  const evidenceSnapshotId = '75000000-0000-4000-8000-000000000011';
  const evidenceDecisionId = '75000000-0000-4000-8000-000000000012';
  const reviewInputHash = hashCanonicalTupleV1([
    'TrustTupleV1',
    'ReviewInputSnapshotV1',
    source.candidate_id,
    source.candidate_revision_id,
    source.patch_id,
    source.catalog_revision_id,
    source.candidate_normalized_signature,
    source.claim_set_hash,
    reviewPolicyId,
    String(claims.rows.length),
    ...claims.rows.flatMap((claim) => [
      claim.claim_id,
      claim.importance,
      claim.claim_evidence_decision_id ?? '@null',
    ]),
    String(provenance.rows.length),
    ...provenance.rows.flatMap((entry) => [
      entry.candidate_provenance_id,
      entry.origin,
    ]),
  ]);
  const evidenceInputHash = hashCanonicalTupleV1([
    'TrustTupleV1',
    'EvidenceInputSnapshotV1',
    supporting.candidate_revision_id,
    supporting.patch_id,
    supporting.catalog_revision_id,
    TRUST_IDS.supportingClaimId,
    supporting.claim_set_hash,
    supporting.statement_hash,
    TRUST_IDS.evidencePolicyId,
    '0',
  ]);

  try {
    await assert.rejects(
      withTransaction(pool, async (client) => {
        await client.query(
          `insert into review_policy_revisions
            (review_policy_revision_id, policy_key, revision,
             minimum_confirmed_reviews, require_distinct_reviewers,
             required_permission, applies_to_ai_provenance,
             reason, created_by)
           values ($1, 'review-current-at-commit', 1, 2, true,
                   'reviewer', true,
                   'Review snapshots must be current at commit.',
                   'direct-sql')`,
          [reviewPolicyId],
        );
        await client.query(
          `insert into review_input_snapshots
            (review_input_snapshot_id, candidate_id,
             candidate_revision_id, patch_id, catalog_revision_id,
             candidate_normalized_signature,
             candidate_claim_set_seal_id, claim_set_hash,
             claim_count, provenance_count, provenance_set_hash,
             claim_decision_set_hash, review_policy_revision_id,
             input_hash, created_by)
           values (
             $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
             $13, $14, 'direct-sql'
           )`,
          [
            reviewSnapshotId,
            source.candidate_id,
            source.candidate_revision_id,
            source.patch_id,
            source.catalog_revision_id,
            source.candidate_normalized_signature,
            source.candidate_claim_set_seal_id,
            source.claim_set_hash,
            claims.rows.length,
            provenance.rows.length,
            source.provenance_set_hash,
            source.claim_decision_set_hash,
            reviewPolicyId,
            reviewInputHash,
          ],
        );
        await client.query(
          `insert into review_input_snapshot_claims
            (review_input_snapshot_id, claim_id,
             candidate_revision_id, importance,
             claim_evidence_decision_id, ordinal)
           select $1, claim_id, candidate_revision_id, importance,
                  claim_evidence_decision_id, ordinal
             from review_input_snapshot_claims
            where review_input_snapshot_id = $2`,
          [reviewSnapshotId, TRUST_IDS.reviewInputSnapshotId],
        );
        await client.query(
          `insert into review_input_snapshot_provenance
            (review_input_snapshot_id, candidate_provenance_id,
             candidate_revision_id, origin, ordinal)
           select $1, candidate_provenance_id,
                  candidate_revision_id, origin, ordinal
             from review_input_snapshot_provenance
            where review_input_snapshot_id = $2`,
          [reviewSnapshotId, TRUST_IDS.reviewInputSnapshotId],
        );
        await client.query(
          `insert into evidence_input_snapshots
            (evidence_input_snapshot_id, claim_id, candidate_id,
             candidate_revision_id, patch_id, catalog_revision_id,
             candidate_claim_set_seal_id, claim_set_hash,
             claim_statement_hash, evidence_policy_revision_id,
             association_count, input_hash, created_by, evaluated_at)
           values (
             $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 0, $11,
             'direct-sql', '2026-07-28T04:00:00.000Z'
           )`,
          [
            evidenceSnapshotId,
            TRUST_IDS.supportingClaimId,
            supporting.candidate_id,
            supporting.candidate_revision_id,
            supporting.patch_id,
            supporting.catalog_revision_id,
            supporting.candidate_claim_set_seal_id,
            supporting.claim_set_hash,
            supporting.statement_hash,
            TRUST_IDS.evidencePolicyId,
            evidenceInputHash,
          ],
        );
        await client.query(
          `insert into claim_evidence_decisions
            (claim_evidence_decision_id, claim_id,
             evidence_input_snapshot_id, candidate_id,
             candidate_revision_id, patch_id, catalog_revision_id,
             evidence_policy_revision_id, decision,
             evaluator_actor_id, reason, correlation_id, evaluated_at)
           values (
             $1, $2, $3, $4, $5, $6, $7, $8, 'insufficient',
             'direct-sql', 'No qualifying Evidence exists.',
             'review-stale-before-commit',
             '2026-07-28T04:00:00.000Z'
           )`,
          [
            evidenceDecisionId,
            TRUST_IDS.supportingClaimId,
            evidenceSnapshotId,
            supporting.candidate_id,
            supporting.candidate_revision_id,
            supporting.patch_id,
            supporting.catalog_revision_id,
            TRUST_IDS.evidencePolicyId,
          ],
        );
        await client.query(
          `insert into current_claim_evidence_decisions
            (claim_id, candidate_id, candidate_revision_id,
             patch_id, catalog_revision_id,
             evidence_policy_revision_id,
             claim_evidence_decision_id)
           values ($1, $2, $3, $4, $5, $6, $7)`,
          [
            TRUST_IDS.supportingClaimId,
            supporting.candidate_id,
            supporting.candidate_revision_id,
            supporting.patch_id,
            supporting.catalog_revision_id,
            TRUST_IDS.evidencePolicyId,
            evidenceDecisionId,
          ],
        );
      }),
      /review snapshot claim decision is not current/,
    );
  } finally {
    await pool.end();
  }
});

test('deferred Review snapshot and quorum headers reject forged membership', async () => {
  const pool = await resetDatabase();
  await seedTrustReviewContext(pool);
  await completeHumanReview(pool, humanReviewCommand());

  await assert.rejects(
    withTransaction(pool, async (client) => {
      await client.query(
        `insert into review_input_snapshots
          (review_input_snapshot_id, candidate_id,
           candidate_revision_id, patch_id, catalog_revision_id,
           candidate_normalized_signature,
           candidate_claim_set_seal_id, claim_set_hash,
           claim_count, provenance_count, provenance_set_hash,
           claim_decision_set_hash, review_policy_revision_id,
           input_hash, created_by)
         select
           '75000000-0000-4000-8000-000000000003',
           candidate_id, candidate_revision_id, patch_id,
           catalog_revision_id, candidate_normalized_signature,
           candidate_claim_set_seal_id, claim_set_hash,
           claim_count, provenance_count, provenance_set_hash,
           claim_decision_set_hash, review_policy_revision_id,
           $1, 'direct-sql'
           from review_input_snapshots
          limit 1`,
        ['1'.repeat(64)],
      );
      await client.query(
        `insert into review_input_snapshot_claims
          (review_input_snapshot_id, claim_id,
           candidate_revision_id, importance,
           claim_evidence_decision_id, ordinal)
         select
           '75000000-0000-4000-8000-000000000003',
           claim_id, candidate_revision_id, importance,
           claim_evidence_decision_id, 1
           from review_input_snapshot_claims
          order by ordinal
          limit 1`,
      );
      await client.query(
        `insert into review_input_snapshot_provenance
          (review_input_snapshot_id, candidate_provenance_id,
           candidate_revision_id, origin, ordinal)
         select
           '75000000-0000-4000-8000-000000000003',
           candidate_provenance_id, candidate_revision_id,
           origin, 1
           from review_input_snapshot_provenance
          order by ordinal
          limit 1`,
      );
    }),
    /membership incomplete|snapshot seal mismatch/,
  );

  await assert.rejects(
    withTransaction(pool, async (client) => {
      await client.query(
        `insert into review_quorum_evaluations
          (review_quorum_evaluation_id, candidate_id,
           candidate_revision_id, review_input_snapshot_id,
           input_hash, review_policy_revision_id,
           required_confirmed_count, counted_review_count,
           quorum_satisfied, evaluated_at)
         select
           '75000000-0000-4000-8000-000000000004',
           candidate_id, candidate_revision_id,
           review_input_snapshot_id, input_hash,
           review_policy_revision_id, 2, 2, true,
           clock_timestamp()
           from review_input_snapshots
          limit 1`,
      );
      await client.query(
        `insert into review_quorum_evaluation_reviews
          (review_quorum_evaluation_id, human_review_id,
           candidate_id, candidate_revision_id,
           review_policy_revision_id, input_hash,
           reviewer_actor_id, ordinal)
         select
           '75000000-0000-4000-8000-000000000004',
           human_review_id, candidate_id, candidate_revision_id,
           review_policy_revision_id, input_hash,
           reviewer_actor_id, 1
           from human_reviews
          limit 1`,
      );
    }),
    /quorum result mismatch/,
  );
  await pool.end();
});
