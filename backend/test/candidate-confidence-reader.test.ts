import assert from 'node:assert/strict';
import test from 'node:test';

import {
  evaluateCandidateConfidence,
} from '../src/modules/confidence/evaluate-candidate-confidence.js';
import {
  readCandidateConfidence,
} from '../src/modules/confidence/read-candidate-confidence.js';
import { CANDIDATE_IDS } from './helpers/candidate.js';
import { resetDatabase } from './helpers/database.js';
import { seedTrustReviewContext } from './helpers/trust.js';

test('confidence reader returns null before any score exists', async () => {
  const pool = await resetDatabase();
  await seedTrustReviewContext(pool);

  assert.equal(
    await readCandidateConfidence(pool, CANDIDATE_IDS.candidateRevisionId),
    null,
  );
  await pool.end();
});

test('confidence reader projects the current immutable score', async () => {
  const pool = await resetDatabase();
  await seedTrustReviewContext(pool);
  const evaluatedAt = new Date(Date.now() + 1_000);
  const persisted = await evaluateCandidateConfidence(pool, {
    actorId: 'confidence-reader-test',
    candidateRevisionId: CANDIDATE_IDS.candidateRevisionId,
    correlationId: 'confidence-reader-test',
    evaluatedAt,
    reason: 'Reader projection test.',
  });

  const current = await readCandidateConfidence(
    pool,
    CANDIDATE_IDS.candidateRevisionId,
  );

  assert.ok(current);
  assert.equal(current.candidateId, CANDIDATE_IDS.candidateId);
  assert.equal(current.candidateRevisionId, CANDIDATE_IDS.candidateRevisionId);
  assert.equal(current.scoreId, persisted.scoreId);
  assert.equal(current.inputSnapshotId, persisted.inputSnapshotId);
  assert.equal(current.inputHash, persisted.inputHash);
  assert.equal(current.score, 65);
  assert.equal(current.band, 'medium');
  assert.equal(current.scoringVersion, 'candidate-confidence-v1');
  assert.deepEqual(current.components, persisted.components);
  assert.equal(current.evaluatedAt.toISOString(), evaluatedAt.toISOString());
  assert.ok(current.createdAt instanceof Date);
  await pool.end();
});
