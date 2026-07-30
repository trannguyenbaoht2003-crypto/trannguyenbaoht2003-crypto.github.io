import assert from 'node:assert/strict';
import test from 'node:test';

import { Pool } from 'pg';

import {
  registerNormalizedObservation,
} from '../src/modules/candidate/register-normalized-observation.js';
import {
  completeHumanReview,
} from '../src/modules/trust/complete-human-review.js';
import {
  recordClaimEvidenceDecision,
} from '../src/modules/trust/record-claim-evidence-decision.js';
import type {
  RegisterNormalizedObservationCommand,
} from '../src/modules/candidate/register-normalized-observation.js';
import type {
  CompleteHumanReviewCommand,
} from '../src/modules/trust/complete-human-review.js';
import type {
  RecordClaimEvidenceDecisionCommand,
} from '../src/modules/trust/record-claim-evidence-decision.js';
import { resetDatabase, tableCount } from './helpers/database.js';
import {
  registrationCommand,
  seedRawObservation,
} from './helpers/candidate.js';
import {
  insertDirectPublicationGraph,
  seedEligiblePublicationContext,
} from './helpers/publication.js';
import {
  TRUST_IDS,
  evidenceDecisionCommand,
  humanReviewCommand,
} from './helpers/trust.js';

const TRUST_RACE_IDS = {
  rawObservationId: '7b300000-0000-4000-8000-000000000001',
  normalizedObservationId: '7b300000-0000-4000-8000-000000000002',
  unusedCandidateId: '7b300000-0000-4000-8000-000000000003',
  unusedCandidateRevisionId: '7b300000-0000-4000-8000-000000000004',
  provenanceId: '7b300000-0000-4000-8000-000000000005',
  evidenceInputSnapshotId: '7b400000-0000-4000-8000-000000000002',
  evidenceDecisionId: '7b400000-0000-4000-8000-000000000003',
  reviewInputSnapshotId: '7b500000-0000-4000-8000-000000000001',
  humanReviewId: '7b500000-0000-4000-8000-000000000002',
  reviewQuorumEvaluationId: '7b500000-0000-4000-8000-000000000003',
} as const;

function databaseUrl(): string {
  const value = process.env.TEST_DATABASE_URL;
  if (!value) {
    throw new Error('TEST_DATABASE_URL is required');
  }
  return value;
}

function boundedPool(): Pool {
  return new Pool({
    application_name: 'hai-dau-publication-trust-race',
    connectionString: databaseUrl(),
    max: 1,
    options: '-c lock_timeout=750 -c statement_timeout=4000',
  });
}

function assertSerializedError(error: unknown): boolean {
  assert.ok(error instanceof Error);
  const databaseError = error as Error & { code?: string };
  assert.notEqual(databaseError.code, '40P01');
  assert.doesNotMatch(databaseError.message, /deadlock detected/i);
  assert.ok(
    databaseError.code === '55P03'
    || databaseError.code === '57014',
  );
  return true;
}

async function runSerializedMutation<T>(
  prepare: (pool: Pool) => Promise<void>,
  mutate: (pool: Pool) => Promise<T>,
  verify: (result: T, pool: Pool) => Promise<void>,
): Promise<void> {
  const pool = await resetDatabase();
  await seedEligiblePublicationContext(pool);
  await prepare(pool);
  const publicationClient = await pool.connect();
  const mutationPool = boundedPool();
  let transactionOpen = false;

  try {
    await publicationClient.query('begin');
    transactionOpen = true;
    await publicationClient.query(
      `set local lock_timeout = '3s';
       set local statement_timeout = '15s'`,
    );
    await insertDirectPublicationGraph(publicationClient);
    await assert.rejects(mutate(mutationPool), assertSerializedError);

    await publicationClient.query('rollback');
    transactionOpen = false;
    const result = await mutate(pool);
    await verify(result, pool);
    assert.equal(await tableCount(pool, 'publications'), 0);
    assert.equal(await tableCount(pool, 'publication_versions'), 0);
    assert.equal(await tableCount(pool, 'publication_activation_history'), 0);
    assert.equal(await tableCount(pool, 'active_publication_versions'), 0);
  } finally {
    if (transactionOpen) {
      await publicationClient.query('rollback');
    }
    publicationClient.release();
    await mutationPool.end();
    await pool.end();
  }
}

function provenanceCommand(): RegisterNormalizedObservationCommand {
  return registrationCommand({
    actorId: 'publication-race-provenance',
    candidateId: TRUST_RACE_IDS.unusedCandidateId,
    candidateRevisionId: TRUST_RACE_IDS.unusedCandidateRevisionId,
    correlationId: 'publication-race-provenance',
    normalizedObservationId: TRUST_RACE_IDS.normalizedObservationId,
    provenanceId: TRUST_RACE_IDS.provenanceId,
    rawObservationId: TRUST_RACE_IDS.rawObservationId,
  });
}

function reevaluateEvidenceCommand(): RecordClaimEvidenceDecisionCommand {
  return evidenceDecisionCommand({
    actorId: 'publication-race-evidence',
    associations: [],
    correlationId: 'publication-race-evidence',
    decision: 'insufficient',
    decisionId: TRUST_RACE_IDS.evidenceDecisionId,
    evaluatedAt: '2026-07-30T05:00:00.000Z',
    evidenceInputSnapshotId: TRUST_RACE_IDS.evidenceInputSnapshotId,
    idempotencyKey: 'publication-race-evidence',
    reason: 'Evidence reevaluation without qualifying input serialized behind Publication.',
  });
}

function thirdReviewCommand(): CompleteHumanReviewCommand {
  return humanReviewCommand({
    actorId: 'reviewer-c',
    completedAt: '2026-07-30T05:10:00.000Z',
    correlationId: 'publication-race-review',
    humanReviewId: TRUST_RACE_IDS.humanReviewId,
    idempotencyKey: 'publication-race-review',
    reason: 'Additional review serialized behind Publication.',
    reviewInputSnapshotId: TRUST_RACE_IDS.reviewInputSnapshotId,
    reviewQuorumEvaluationId:
      TRUST_RACE_IDS.reviewQuorumEvaluationId,
  });
}

test('Publication and provenance append share a deadlock-free lock order', async () => {
  await runSerializedMutation(
    async (pool) => {
      await seedRawObservation(pool, TRUST_RACE_IDS.rawObservationId);
    },
    (pool) => registerNormalizedObservation(pool, provenanceCommand()),
    async (result, pool) => {
      assert.equal(result.provenanceAdded, true);
      const count = await pool.query<{ count: string }>(
        `select count(*)
           from candidate_provenance
          where candidate_provenance_id = $1`,
        [TRUST_RACE_IDS.provenanceId],
      );
      assert.equal(count.rows[0]?.count, '1');
    },
  );
});

test('Publication and Evidence reevaluation share a deadlock-free lock order', async () => {
  await runSerializedMutation(
    async () => undefined,
    (pool) => recordClaimEvidenceDecision(
      pool,
      reevaluateEvidenceCommand(),
    ),
    async (result, pool) => {
      assert.equal(result.decisionId, TRUST_RACE_IDS.evidenceDecisionId);
      const current = await pool.query<{
        claim_evidence_decision_id: string;
      }>(
        `select claim_evidence_decision_id
           from current_claim_evidence_decisions
          where claim_id = $1`,
        [TRUST_IDS.requiredClaimId],
      );
      assert.equal(
        current.rows[0]?.claim_evidence_decision_id,
        TRUST_RACE_IDS.evidenceDecisionId,
      );
    },
  );
});

test('Publication and Human Review completion share a deadlock-free lock order', async () => {
  await runSerializedMutation(
    async () => undefined,
    (pool) => completeHumanReview(pool, thirdReviewCommand()),
    async (result, pool) => {
      assert.equal(result.humanReviewId, TRUST_RACE_IDS.humanReviewId);
      const review = await pool.query<{ count: string }>(
        `select count(*)
           from human_reviews
          where human_review_id = $1`,
        [TRUST_RACE_IDS.humanReviewId],
      );
      assert.equal(review.rows[0]?.count, '1');
    },
  );
});
