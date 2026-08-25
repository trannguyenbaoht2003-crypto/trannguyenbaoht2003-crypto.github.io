import assert from 'node:assert/strict';
import test from 'node:test';

import {
  evaluateCandidateConfidence,
} from '../src/modules/confidence/evaluate-candidate-confidence.js';
import type {
  EvaluateCandidateConfidenceCommand,
} from '../src/modules/confidence/types.js';
import { CANDIDATE_IDS } from './helpers/candidate.js';
import { resetDatabase, tableCount } from './helpers/database.js';
import { seedTrustReviewContext } from './helpers/trust.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function command(
  evaluatedAt: Date,
  overrides: Partial<EvaluateCandidateConfidenceCommand> = {},
): EvaluateCandidateConfidenceCommand {
  return {
    actorId: 'confidence-evaluator',
    candidateRevisionId: CANDIDATE_IDS.candidateRevisionId,
    correlationId: 'confidence-evaluation-v1',
    evaluatedAt,
    reason: 'Prioritize HumanReview using deterministic authoritative facts.',
    ...overrides,
  };
}

test('authoritative current supported Evidence produces the expected confidence score', async () => {
  const pool = await resetDatabase();
  await seedTrustReviewContext(pool);
  const evaluatedAt = new Date(Date.now() + 1_000);

  const result = await evaluateCandidateConfidence(pool, command(evaluatedAt));

  assert.equal(result.candidateId, CANDIDATE_IDS.candidateId);
  assert.equal(result.candidateRevisionId, CANDIDATE_IDS.candidateRevisionId);
  assert.equal(result.scoringVersion, 'candidate-confidence-v1');
  assert.equal(result.replayed, false);
  assert.deepEqual(result.components, {
    evidenceDiversityScore: 10,
    freshnessScore: 15,
    patchAlignmentScore: 20,
    provenanceQualityScore: 20,
  });
  assert.equal(result.score, 65);
  assert.equal(result.band, 'medium');
  assert.match(result.inputHash, /^[a-f0-9]{64}$/);
  assert.equal(await tableCount(pool, 'candidate_confidence_input_snapshots'), 1);
  assert.equal(await tableCount(pool, 'candidate_confidence_scores'), 1);
  assert.equal(await tableCount(pool, 'current_candidate_confidence_scores'), 1);

  const audit = await pool.query<{ count: string }>(
    `select count(*)
       from audit_events
      where action = 'candidate_confidence.created'
        and correlation_id = $1`,
    ['confidence-evaluation-v1'],
  );
  assert.equal(Number(audit.rows[0]?.count ?? 0), 1);
  await pool.end();
});

test('identical replay returns the existing score without duplicate audit effects', async () => {
  const pool = await resetDatabase();
  await seedTrustReviewContext(pool);
  const evaluatedAt = new Date(Date.now() + 1_000);
  const evaluation = command(evaluatedAt);

  const first = await evaluateCandidateConfidence(pool, evaluation);
  const replay = await evaluateCandidateConfidence(pool, evaluation);

  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  assert.equal(replay.scoreId, first.scoreId);
  assert.equal(replay.inputSnapshotId, first.inputSnapshotId);
  assert.equal(replay.inputHash, first.inputHash);
  assert.equal(await tableCount(pool, 'candidate_confidence_input_snapshots'), 1);
  assert.equal(await tableCount(pool, 'candidate_confidence_scores'), 1);
  const audit = await pool.query<{ count: string }>(
    `select count(*)
       from audit_events
      where action = 'candidate_confidence.created'`,
  );
  assert.equal(Number(audit.rows[0]?.count ?? 0), 1);
  await pool.end();
});

test('newer evaluation advances current pointer while a later-created stale evaluation cannot move it backwards', async () => {
  const pool = await resetDatabase();
  await seedTrustReviewContext(pool);
  const base = new Date(Date.now() + 1_000);

  const first = await evaluateCandidateConfidence(pool, command(base, {
    correlationId: 'confidence-base',
  }));
  const newer = await evaluateCandidateConfidence(pool, command(
    new Date(base.getTime() + 8 * DAY_MS),
    { correlationId: 'confidence-newer' },
  ));
  const stale = await evaluateCandidateConfidence(pool, command(
    new Date(base.getTime() + DAY_MS),
    { correlationId: 'confidence-stale' },
  ));

  assert.equal(first.score, 65);
  assert.equal(newer.score, 55);
  assert.equal(stale.score, 65);
  assert.equal(await tableCount(pool, 'candidate_confidence_scores'), 3);

  const current = await pool.query<{
    candidate_confidence_score_id: string;
    evaluated_at: Date;
  }>(
    `select candidate_confidence_score_id, evaluated_at
       from current_candidate_confidence_scores
      where candidate_revision_id = $1`,
    [CANDIDATE_IDS.candidateRevisionId],
  );
  assert.equal(current.rows[0]?.candidate_confidence_score_id, newer.scoreId);
  assert.equal(
    current.rows[0]?.evaluated_at.toISOString(),
    new Date(base.getTime() + 8 * DAY_MS).toISOString(),
  );
  await pool.end();
});

test('concurrent identical evaluations converge on one immutable score and one audit event', async () => {
  const pool = await resetDatabase();
  await seedTrustReviewContext(pool);
  const evaluatedAt = new Date(Date.now() + 1_000);
  const evaluation = command(evaluatedAt, {
    correlationId: 'confidence-concurrent',
  });

  const [left, right] = await Promise.all([
    evaluateCandidateConfidence(pool, evaluation),
    evaluateCandidateConfidence(pool, evaluation),
  ]);

  assert.equal(left.scoreId, right.scoreId);
  assert.equal(left.inputSnapshotId, right.inputSnapshotId);
  assert.equal(await tableCount(pool, 'candidate_confidence_input_snapshots'), 1);
  assert.equal(await tableCount(pool, 'candidate_confidence_scores'), 1);
  const audit = await pool.query<{ count: string }>(
    `select count(*)
       from audit_events
      where action = 'candidate_confidence.created'
        and correlation_id = 'confidence-concurrent'`,
  );
  assert.equal(Number(audit.rows[0]?.count ?? 0), 1);
  await pool.end();
});
