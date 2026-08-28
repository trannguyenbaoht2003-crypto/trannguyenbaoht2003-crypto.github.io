import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';

import {
  evaluateCandidateConfidence,
} from '../src/modules/confidence/evaluate-candidate-confidence.js';
import { CANDIDATE_IDS } from './helpers/candidate.js';
import { resetDatabase, tableCount } from './helpers/database.js';
import { seedTrustReviewContext } from './helpers/trust.js';

async function authorityCounts(
  pool: Awaited<ReturnType<typeof resetDatabase>>,
) {
  return {
    eligibility: await tableCount(pool, 'candidate_eligibility_evaluations'),
    humanReview: await tableCount(pool, 'human_reviews'),
    moderation: await tableCount(pool, 'moderation_decisions'),
    publication: await tableCount(pool, 'publication_versions'),
  };
}

test('confidence evaluation cannot mutate trust, moderation, eligibility, or publication authority', async () => {
  const pool = await resetDatabase();
  await seedTrustReviewContext(pool);
  const before = await authorityCounts(pool);

  await evaluateCandidateConfidence(pool, {
    actorId: 'confidence-isolation-test',
    candidateRevisionId: CANDIDATE_IDS.candidateRevisionId,
    correlationId: 'confidence-isolation-test',
    evaluatedAt: new Date(Date.now() + 1_000),
    reason: 'Authority-isolation regression test.',
  });

  assert.deepEqual(await authorityCounts(pool), before);
  await pool.end();
});

test('confidence implementation has no imports of authority mutation modules', async () => {
  const confidenceDirectory = resolve(process.cwd(), 'src/modules/confidence');
  const files = [
    'compute-candidate-confidence.ts',
    'evaluate-candidate-confidence.ts',
    'read-candidate-confidence.ts',
    'types.ts',
  ];
  const prohibited = [
    'publish-candidate-revision',
    'record-candidate-moderation-decision',
    'evaluate-candidate-eligibility',
    'complete-human-review',
  ];

  for (const file of files) {
    const source = await readFile(resolve(confidenceDirectory, file), 'utf8');
    for (const importName of prohibited) {
      assert.equal(
        source.includes(importName),
        false,
        `${file} must not import ${importName}`,
      );
    }
  }
});
