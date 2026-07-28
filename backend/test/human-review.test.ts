import assert from 'node:assert/strict';
import test from 'node:test';

import {
  completeHumanReview,
} from '../src/modules/trust/complete-human-review.js';
import { resetDatabase, tableCount } from './helpers/database.js';
import {
  TRUST_IDS,
  appendAiProvenance,
  evidenceDecisionCommand,
  humanReviewCommand,
  seedTrustReviewContext,
} from './helpers/trust.js';
import {
  recordClaimEvidenceDecision,
} from '../src/modules/trust/record-claim-evidence-decision.js';

async function reviewCounts(
  pool: Awaited<ReturnType<typeof resetDatabase>>,
) {
  const audit = await pool.query<{ count: string }>(
    `select count(*)
       from audit_events
      where action = 'review.human_review_completed'`,
  );
  const outbox = await pool.query<{ count: string }>(
    `select count(*)
       from outbox_events
      where event_type = 'HumanReviewCompleted'`,
  );
  const idempotency = await pool.query<{ count: string }>(
    `select count(*)
       from idempotency_records
      where scope = 'human_review_completion'`,
  );
  return {
    audit: Number(audit.rows[0]?.count ?? 0),
    current: await tableCount(
      pool,
      'current_review_quorum_evaluations',
    ),
    idempotency: Number(idempotency.rows[0]?.count ?? 0),
    outbox: Number(outbox.rows[0]?.count ?? 0),
    quorumEvaluations: await tableCount(
      pool,
      'review_quorum_evaluations',
    ),
    quorumMembers: await tableCount(
      pool,
      'review_quorum_evaluation_reviews',
    ),
    reviewClaimMembers: await tableCount(
      pool,
      'review_input_snapshot_claims',
    ),
    reviewProvenanceMembers: await tableCount(
      pool,
      'review_input_snapshot_provenance',
    ),
    reviews: await tableCount(pool, 'human_reviews'),
    snapshots: await tableCount(pool, 'review_input_snapshots'),
  };
}

test('two distinct confirmed reviewers satisfy quorum without overwriting history', async () => {
  const pool = await resetDatabase();
  await seedTrustReviewContext(pool);

  const first = await completeHumanReview(pool, humanReviewCommand());
  assert.equal(first.confirmedReviewerCount, 1);
  assert.equal(first.requiredConfirmedReviews, 2);
  assert.equal(first.quorumSatisfied, false);

  const second = await completeHumanReview(pool, humanReviewCommand({
    actorId: 'reviewer-b',
    completedAt: '2026-07-28T05:01:00.000Z',
    correlationId: 'human-review-2',
    humanReviewId: TRUST_IDS.secondHumanReviewId,
    idempotencyKey: 'human-review-2',
    reviewInputSnapshotId: TRUST_IDS.secondReviewInputSnapshotId,
    reviewQuorumEvaluationId:
      TRUST_IDS.secondReviewQuorumEvaluationId,
  }));
  assert.equal(second.inputHash, first.inputHash);
  assert.equal(second.confirmedReviewerCount, 2);
  assert.equal(second.quorumSatisfied, true);

  const evaluations = await pool.query<{
    counted_review_count: number;
    current: boolean;
    quorum_satisfied: boolean;
  }>(
    `select evaluation.counted_review_count,
            evaluation.quorum_satisfied,
            current.review_quorum_evaluation_id is not null as current
       from review_quorum_evaluations evaluation
       left join current_review_quorum_evaluations current
         on current.review_quorum_evaluation_id =
            evaluation.review_quorum_evaluation_id
      order by evaluation.counted_review_count`,
  );
  assert.deepEqual(evaluations.rows, [
    {
      counted_review_count: 1,
      current: false,
      quorum_satisfied: false,
    },
    {
      counted_review_count: 2,
      current: true,
      quorum_satisfied: true,
    },
  ]);
  assert.equal(await tableCount(pool, 'human_reviews'), 2);
  assert.equal(await tableCount(pool, 'review_quorum_evaluations'), 2);
  await pool.end();
});

test('Review snapshot includes every Claim, explicit absence, and provenance', async () => {
  const pool = await resetDatabase();
  await seedTrustReviewContext(pool);
  await completeHumanReview(pool, humanReviewCommand());

  const claims = await pool.query<{
    claim_evidence_decision_id: string | null;
    claim_key: string;
  }>(
    `select claim.claim_key,
            member.claim_evidence_decision_id
       from review_input_snapshot_claims member
       join candidate_claims claim on claim.claim_id = member.claim_id
      order by member.ordinal`,
  );
  assert.equal(claims.rowCount, 2);
  assert.match(
    claims.rows[0]?.claim_evidence_decision_id ?? '',
    /^[0-9a-f-]{36}$/,
  );
  assert.equal(claims.rows[1]?.claim_evidence_decision_id, null);

  const provenance = await pool.query<{ origin: string }>(
    `select origin
       from review_input_snapshot_provenance
      order by ordinal`,
  );
  assert.deepEqual(provenance.rows, [
    { origin: 'collector_detected' },
  ]);
  await pool.end();
});

test('changes requested and declined Reviews persist but never count', async () => {
  const pool = await resetDatabase();
  await seedTrustReviewContext(pool);

  const changed = await completeHumanReview(pool, humanReviewCommand({
    outcome: 'changes_requested',
  }));
  const declined = await completeHumanReview(pool, humanReviewCommand({
    actorId: 'reviewer-b',
    completedAt: '2026-07-28T05:01:00.000Z',
    correlationId: 'human-review-declined',
    humanReviewId: TRUST_IDS.secondHumanReviewId,
    idempotencyKey: 'human-review-declined',
    outcome: 'declined',
    reviewInputSnapshotId: TRUST_IDS.secondReviewInputSnapshotId,
    reviewQuorumEvaluationId:
      TRUST_IDS.secondReviewQuorumEvaluationId,
  }));

  assert.equal(changed.confirmedReviewerCount, 0);
  assert.equal(declined.confirmedReviewerCount, 0);
  assert.equal(changed.quorumSatisfied, false);
  assert.equal(declined.quorumSatisfied, false);
  assert.equal(await tableCount(pool, 'human_reviews'), 2);
  assert.equal(
    await tableCount(pool, 'review_quorum_evaluation_reviews'),
    0,
  );
  await pool.end();
});

test('same reviewer cannot complete the same exact input twice', async () => {
  const pool = await resetDatabase();
  await seedTrustReviewContext(pool);
  await completeHumanReview(pool, humanReviewCommand());
  const before = await reviewCounts(pool);

  await assert.rejects(
    completeHumanReview(pool, humanReviewCommand({
      correlationId: 'human-review-duplicate',
      humanReviewId: TRUST_IDS.secondHumanReviewId,
      idempotencyKey: 'human-review-duplicate',
      reviewInputSnapshotId: TRUST_IDS.secondReviewInputSnapshotId,
      reviewQuorumEvaluationId:
        TRUST_IDS.secondReviewQuorumEvaluationId,
    })),
    /REVIEW_ALREADY_COMPLETED/,
  );
  assert.deepEqual(await reviewCounts(pool), before);
  await pool.end();
});

test('lost acknowledgement replay creates no duplicate Review effects', async () => {
  const pool = await resetDatabase();
  await seedTrustReviewContext(pool);
  const command = humanReviewCommand();
  const first = await completeHumanReview(pool, command);
  const before = await reviewCounts(pool);

  const replay = await completeHumanReview(pool, command);

  assert.equal(replay.replayed, true);
  assert.equal(replay.humanReviewId, first.humanReviewId);
  assert.equal(replay.quorumEvaluationId, first.quorumEvaluationId);
  assert.deepEqual(await reviewCounts(pool), before);
  await pool.end();
});

test('two concurrent reviewers produce a deterministic satisfied quorum', async () => {
  const pool = await resetDatabase();
  await seedTrustReviewContext(pool);

  await Promise.all([
    completeHumanReview(pool, humanReviewCommand()),
    completeHumanReview(pool, humanReviewCommand({
      actorId: 'reviewer-b',
      completedAt: '2026-07-28T05:01:00.000Z',
      correlationId: 'human-review-concurrent-b',
      humanReviewId: TRUST_IDS.secondHumanReviewId,
      idempotencyKey: 'human-review-concurrent-b',
      reviewInputSnapshotId: TRUST_IDS.secondReviewInputSnapshotId,
      reviewQuorumEvaluationId:
        TRUST_IDS.secondReviewQuorumEvaluationId,
    })),
  ]);

  const current = await pool.query<{
    counted_review_count: number;
    quorum_satisfied: boolean;
  }>(
    `select evaluation.counted_review_count,
            evaluation.quorum_satisfied
       from current_review_quorum_evaluations current
       join review_quorum_evaluations evaluation
         on evaluation.review_quorum_evaluation_id =
            current.review_quorum_evaluation_id`,
  );
  assert.deepEqual(current.rows[0], {
    counted_review_count: 2,
    quorum_satisfied: true,
  });
  assert.deepEqual(await reviewCounts(pool), {
    audit: 2,
    current: 1,
    idempotency: 2,
    outbox: 2,
    quorumEvaluations: 2,
    quorumMembers: 3,
    reviewClaimMembers: 2,
    reviewProvenanceMembers: 1,
    reviews: 2,
    snapshots: 1,
  });
  await pool.end();
});

test('a new current Evidence decision prevents old and new Reviews combining', async () => {
  const pool = await resetDatabase();
  await seedTrustReviewContext(pool);
  const first = await completeHumanReview(pool, humanReviewCommand());
  await recordClaimEvidenceDecision(pool, evidenceDecisionCommand({
    associations: [],
    claimId: TRUST_IDS.supportingClaimId,
    correlationId: 'review-staleness-evidence',
    decision: 'insufficient',
    decisionId: TRUST_IDS.secondEvidenceDecisionId,
    evidenceInputSnapshotId: TRUST_IDS.secondEvidenceInputSnapshotId,
    idempotencyKey: 'review-staleness-evidence',
    reason: 'The second Claim has no qualifying Evidence.',
  }));

  const second = await completeHumanReview(pool, humanReviewCommand({
    actorId: 'reviewer-b',
    completedAt: '2026-07-28T05:01:00.000Z',
    correlationId: 'human-review-new-evidence-input',
    humanReviewId: TRUST_IDS.secondHumanReviewId,
    idempotencyKey: 'human-review-new-evidence-input',
    reviewInputSnapshotId: TRUST_IDS.secondReviewInputSnapshotId,
    reviewQuorumEvaluationId:
      TRUST_IDS.secondReviewQuorumEvaluationId,
  }));

  assert.notEqual(second.inputHash, first.inputHash);
  assert.equal(second.confirmedReviewerCount, 1);
  assert.equal(second.quorumSatisfied, false);
  assert.equal(await tableCount(pool, 'review_input_snapshots'), 2);
  await pool.end();
});

test('AI provenance changes Review input but never becomes Evidence', async () => {
  const pool = await resetDatabase();
  await seedTrustReviewContext(pool, false);
  const first = await completeHumanReview(pool, humanReviewCommand());
  await appendAiProvenance(pool);
  const second = await completeHumanReview(pool, humanReviewCommand({
    actorId: 'reviewer-b',
    completedAt: '2026-07-28T05:01:00.000Z',
    correlationId: 'human-review-ai-input',
    humanReviewId: TRUST_IDS.secondHumanReviewId,
    idempotencyKey: 'human-review-ai-input',
    reviewInputSnapshotId: TRUST_IDS.secondReviewInputSnapshotId,
    reviewQuorumEvaluationId:
      TRUST_IDS.secondReviewQuorumEvaluationId,
  }));

  assert.notEqual(second.inputHash, first.inputHash);
  assert.equal(second.confirmedReviewerCount, 1);
  assert.equal(await tableCount(pool, 'evidence_records'), 0);
  assert.equal(await tableCount(pool, 'evidence_associations'), 0);
  const origins = await pool.query<{ origin: string }>(
    `select distinct origin
       from review_input_snapshot_provenance
      order by origin`,
  );
  assert.deepEqual(
    origins.rows.map((row) => row.origin),
    ['ai_generated', 'collector_detected'],
  );
  await pool.end();
});
