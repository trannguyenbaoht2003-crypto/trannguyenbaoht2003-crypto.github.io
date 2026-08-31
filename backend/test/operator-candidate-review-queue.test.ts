import assert from 'node:assert/strict';
import test from 'node:test';

import type { Pool } from 'pg';

import { activateCatalogRevision } from '../src/modules/catalog/activate-catalog-revision.js';
import { importCatalogRevision } from '../src/modules/catalog/import-catalog-revision.js';
import { validateCatalogRevision } from '../src/modules/catalog/validate-catalog-revision.js';
import { registerNormalizedObservation } from '../src/modules/candidate/register-normalized-observation.js';
import {
  evaluateCandidateConfidence,
} from '../src/modules/confidence/evaluate-candidate-confidence.js';
import { activateEligibilityPolicyRevision } from '../src/modules/eligibility/activate-eligibility-policy-revision.js';
import { registerEligibilityPolicyRevision } from '../src/modules/eligibility/register-eligibility-policy-revision.js';
import {
  readOperatorCandidateReviewQueue,
} from '../src/modules/operator/read-candidate-review-queue.js';
import {
  completeHumanReview,
} from '../src/modules/trust/complete-human-review.js';
import { defineCandidateClaimSet } from '../src/modules/trust/define-candidate-claim-set.js';
import { recordClaimEvidenceDecision } from '../src/modules/trust/record-claim-evidence-decision.js';
import { registerTrustPolicyRevision } from '../src/modules/trust/register-trust-policy-revision.js';
import {
  CANDIDATE_IDS,
  registrationCommand,
  seedRawObservation,
} from './helpers/candidate.js';
import {
  CATALOG_IDS,
  validCatalogSnapshot,
} from './helpers/catalog.js';
import { resetDatabase, tableCount } from './helpers/database.js';
import {
  activationCommand,
  eligibilityPolicyCommand,
  GATE_IDS,
  seedActivatedGateContext,
} from './helpers/gate.js';
import {
  claimSetCommand,
  evidenceDecisionCommand,
  humanReviewCommand,
  requiredClaim,
  seedSecondTrustCandidate,
  TRUST_IDS,
} from './helpers/trust.js';

const IDS = {
  candidateA: '91000000-0000-4000-8000-000000000001',
  revisionA: '91000000-0000-4000-8000-000000000002',
  candidateB: '91000000-0000-4000-8000-000000000003',
  revisionB: '91000000-0000-4000-8000-000000000004',
  patch: '91000000-0000-4000-8000-000000000005',
  catalog: '91000000-0000-4000-8000-000000000006',
  reviewPolicy: '91000000-0000-4000-8000-000000000007',
  reviewEvaluation: '91000000-0000-4000-8000-000000000008',
  confidenceScore: '91000000-0000-4000-8000-000000000009',
} as const;

const DATABASE_IDS = {
  secondCatalogRevision: '91000000-0000-4000-8000-000000000020',
  secondCatalogValidation: '91000000-0000-4000-8000-000000000021',
  secondCatalogRawObservation: '91000000-0000-4000-8000-000000000022',
  secondCatalogObservation: '91000000-0000-4000-8000-000000000023',
  secondCatalogProvenance: '91000000-0000-4000-8000-000000000024',
  secondCatalogRevisionCandidate: '91000000-0000-4000-8000-000000000025',
  secondCatalogClaim: '91000000-0000-4000-8000-000000000026',
  activeReviewPolicyV2: '91000000-0000-4000-8000-000000000027',
  activeEligibilityPolicyV2: '91000000-0000-4000-8000-000000000028',
  rankedCollectorCandidate: '91000000-0000-4000-8000-000000000030',
  rankedCollectorRevision: '91000000-0000-4000-8000-000000000031',
  rankedCollectorObservation: '91000000-0000-4000-8000-000000000032',
  rankedCollectorProvenance: '91000000-0000-4000-8000-000000000033',
  rankedCollectorRaw: '91000000-0000-4000-8000-000000000034',
  rankedCollectorClaim: '91000000-0000-4000-8000-000000000035',
  rankedEditorialClaim: '91000000-0000-4000-8000-000000000036',
  rankedEditorialEvidence: '91000000-0000-4000-8000-000000000037',
  rankedEditorialAssociation: '91000000-0000-4000-8000-000000000038',
  rankedEditorialSnapshot: '91000000-0000-4000-8000-000000000039',
  rankedEditorialDecision: '91000000-0000-4000-8000-000000000043',
  unscoredOlderCandidate: '91000000-0000-4000-8000-000000000040',
  unscoredOlderRevision: '91000000-0000-4000-8000-000000000041',
  unscoredOlderClaim: '91000000-0000-4000-8000-000000000042',
  unscoredTieCandidateA: '91000000-0000-4000-8000-000000000050',
  unscoredTieRevisionA: '91000000-0000-4000-8000-000000000051',
  unscoredTieClaimA: '91000000-0000-4000-8000-000000000052',
  unscoredTieCandidateB: '91000000-0000-4000-8000-000000000060',
  unscoredTieRevisionB: '91000000-0000-4000-8000-000000000061',
  unscoredTieClaimB: '91000000-0000-4000-8000-000000000062',
} as const;

type FakeQueueRow = {
  band: 'low' | 'medium' | 'high' | 'very_high' | null;
  candidate_confidence_score_id: string | null;
  candidate_id: string;
  candidate_revision_id: string;
  canonical_payload: unknown;
  catalog_revision_id: string;
  confidence_created_at: Date | null;
  counted_review_count: number | null;
  created_at: Date;
  evaluated_at: Date | null;
  evidence_diversity_score: 0 | 10 | 25 | null;
  freshness_score: 0 | 5 | 15 | null;
  patch_alignment_score: 0 | 10 | 20 | null;
  patch_id: string;
  provenance_quality_score: 0 | 20 | 30 | null;
  required_confirmed_count: number | null;
  review_quorum_evaluation_id: string | null;
  revision: number;
  score: number | null;
  scoring_version: 'candidate-confidence-v1' | null;
  subject_external_id: string;
};

function scoredRow(overrides: Partial<FakeQueueRow> = {}): FakeQueueRow {
  return {
    band: 'high',
    candidate_confidence_score_id: IDS.confidenceScore,
    candidate_id: IDS.candidateA,
    candidate_revision_id: IDS.revisionA,
    canonical_payload: {
      schemaVersion: 1,
      augmentExternalIds: ['1194'],
      itemExternalIds: ['3006', '6672'],
    },
    catalog_revision_id: IDS.catalog,
    confidence_created_at: new Date('2026-08-28T02:05:00.000Z'),
    counted_review_count: 1,
    created_at: new Date('2026-08-27T01:00:00.000Z'),
    evaluated_at: new Date('2026-08-28T02:00:00.000Z'),
    evidence_diversity_score: 25,
    freshness_score: 15,
    patch_alignment_score: 20,
    patch_id: IDS.patch,
    provenance_quality_score: 20,
    required_confirmed_count: 2,
    review_quorum_evaluation_id: IDS.reviewEvaluation,
    revision: 2,
    score: 80,
    scoring_version: 'candidate-confidence-v1',
    subject_external_id: 'samira',
    ...overrides,
  };
}

function unscoredRow(overrides: Partial<FakeQueueRow> = {}): FakeQueueRow {
  return scoredRow({
    band: null,
    candidate_confidence_score_id: null,
    candidate_id: IDS.candidateB,
    candidate_revision_id: IDS.revisionB,
    confidence_created_at: null,
    counted_review_count: null,
    evaluated_at: null,
    evidence_diversity_score: null,
    freshness_score: null,
    patch_alignment_score: null,
    provenance_quality_score: null,
    required_confirmed_count: null,
    review_quorum_evaluation_id: null,
    revision: 1,
    score: null,
    scoring_version: null,
    subject_external_id: 'ashe',
    ...overrides,
  });
}

function fakePool(options: {
  policyRows?: Array<{
    minimum_confirmed_reviews: number;
    review_policy_revision_id: string;
  }>;
  queueRows?: FakeQueueRow[];
  queueError?: Error;
} = {}) {
  const calls: Array<{ sql: string; values: unknown[] | undefined }> = [];
  let released = 0;
  const client = {
    async query(sql: string, values?: unknown[]) {
      calls.push({ sql, values });
      if (sql.includes('from active_eligibility_policy_revision')) {
        const rows = options.policyRows ?? [{
          minimum_confirmed_reviews: 2,
          review_policy_revision_id: IDS.reviewPolicy,
        }];
        return { rows, rowCount: rows.length };
      }
      if (sql.includes('with latest_active_revisions')) {
        if (options.queueError) throw options.queueError;
        const rows = options.queueRows ?? [scoredRow(), unscoredRow()];
        return { rows, rowCount: rows.length };
      }
      return { rows: [], rowCount: 0 };
    },
    release() {
      released += 1;
    },
  };
  return {
    calls,
    client,
    pool: {
      async connect() {
        return client;
      },
    } as unknown as Pool,
    released: () => released,
  };
}

function transactionBoundaries(calls: Array<{ sql: string }>): string[] {
  return calls
    .map(({ sql }) => sql)
    .filter((sql) => /^(?:BEGIN|COMMIT|ROLLBACK)/.test(sql));
}

async function activateSecondCatalogRevision(pool: Pool): Promise<void> {
  const snapshot = validCatalogSnapshot();
  snapshot.source.sourceDigest = 'e'.repeat(64);
  const subject = snapshot.entities.find((entity) => (
    entity.entityType === 'champion' && entity.externalId === 'samira'
  ));
  assert.ok(subject);
  subject.attributes = { ...subject.attributes, catalogRevision: 2 };

  await importCatalogRevision(pool, {
    actorId: 'operator-queue-catalog',
    catalogRevisionId: DATABASE_IDS.secondCatalogRevision,
    correlationId: 'operator-queue-catalog-import-2',
    idempotencyKey: 'operator-queue-catalog-import-2',
    patchId: CATALOG_IDS.patchId,
    revision: 2,
    sourceId: CATALOG_IDS.sourceId,
    sourcePolicyRevisionId: CATALOG_IDS.sourcePolicyRevisionId,
    snapshot,
  });
  const validation = await validateCatalogRevision(pool, {
    actorId: 'operator-queue-validator',
    catalogRevisionId: DATABASE_IDS.secondCatalogRevision,
    catalogValidationResultId: DATABASE_IDS.secondCatalogValidation,
    correlationId: 'operator-queue-catalog-validation-2',
    reason: 'Validate the second catalog for operator queue coverage.',
    validatorRulesetVersion: 'catalog-rules-v1',
  });
  assert.equal(validation.result, 'passed');
  await activateCatalogRevision(pool, {
    actorId: 'operator-queue-catalog',
    catalogRevisionId: DATABASE_IDS.secondCatalogRevision,
    correlationId: 'operator-queue-catalog-activation-2',
    expectedCurrentCatalogRevisionId: CATALOG_IDS.catalogRevisionId,
    patchId: CATALOG_IDS.patchId,
    reason: 'Activate the second catalog for operator queue coverage.',
  });
}

async function sealRevision(
  pool: Pool,
  candidateId: string,
  candidateRevisionId: string,
  claimId: string,
): Promise<void> {
  await defineCandidateClaimSet(pool, claimSetCommand({
    candidateId,
    candidateRevisionId,
    claims: [requiredClaim({ claimId })],
    correlationId: `operator-queue-claim-${claimId}`,
    idempotencyKey: `operator-queue-claim-${claimId}`,
  }));
}

async function registerRankedCollectorCandidate(pool: Pool): Promise<void> {
  await seedRawObservation(pool, DATABASE_IDS.rankedCollectorRaw);
  await registerNormalizedObservation(pool, registrationCommand({
    candidateId: DATABASE_IDS.rankedCollectorCandidate,
    candidateRevisionId: DATABASE_IDS.rankedCollectorRevision,
    normalizedObservationId: DATABASE_IDS.rankedCollectorObservation,
    provenanceId: DATABASE_IDS.rankedCollectorProvenance,
    rawObservationId: DATABASE_IDS.rankedCollectorRaw,
    snapshot: {
      schemaVersion: 1,
      patchKey: '26.15',
      gameModeExternalId: 'aram_mayhem',
      origin: 'collector_detected',
      subjectExternalId: 'samira',
      augmentExternalIds: [],
      itemExternalIds: ['6672'],
    },
  }));
  await sealRevision(
    pool,
    DATABASE_IDS.rankedCollectorCandidate,
    DATABASE_IDS.rankedCollectorRevision,
    DATABASE_IDS.rankedCollectorClaim,
  );
}

async function insertUnscoredCandidate(
  pool: Pool,
  fixture: {
    candidateId: string;
    candidateRevisionId: string;
    claimId: string;
    createdAt: string;
    fingerprintCharacter: string;
    itemExternalIds: string[];
  },
): Promise<void> {
  await pool.query(
    `insert into candidates
      (candidate_id, fingerprint, patch_id, game_mode_external_id,
       subject_game_entity_id, created_at)
     select $1, $2, patch_id, game_mode_external_id,
            subject_game_entity_id, $3::timestamptz
       from candidates
      where candidate_id = $4`,
    [
      fixture.candidateId,
      fixture.fingerprintCharacter.repeat(64),
      fixture.createdAt,
      CANDIDATE_IDS.candidateId,
    ],
  );
  await pool.query(
    `insert into candidate_revisions
      (candidate_revision_id, candidate_id, revision, patch_id,
       catalog_revision_id, normalized_signature, canonical_payload,
       created_at)
     values ($1, $2, 1, $3, $4, $5, $6::jsonb, $7::timestamptz)`,
    [
      fixture.candidateRevisionId,
      fixture.candidateId,
      CATALOG_IDS.patchId,
      CATALOG_IDS.catalogRevisionId,
      fixture.fingerprintCharacter.repeat(64),
      JSON.stringify({
        schemaVersion: 1,
        augmentExternalIds: [],
        itemExternalIds: fixture.itemExternalIds,
      }),
      fixture.createdAt,
    ],
  );
  await sealRevision(
    pool,
    fixture.candidateId,
    fixture.candidateRevisionId,
    fixture.claimId,
  );
}

async function activateReviewPolicyV2(pool: Pool): Promise<void> {
  await registerTrustPolicyRevision(pool, {
    actorId: 'operator-queue-policy',
    appliesToAiProvenance: true,
    correlationId: 'operator-queue-review-policy-v2',
    idempotencyKey: 'operator-queue-review-policy-v2',
    minimumConfirmedReviews: 2,
    policyKey: 'human-review-v1',
    policyKind: 'human_review',
    policyRevisionId: DATABASE_IDS.activeReviewPolicyV2,
    reason: 'Second active review policy for isolation coverage.',
    requireDistinctReviewers: true,
    requiredPermission: 'reviewer',
    revision: 2,
  });
  await registerEligibilityPolicyRevision(pool, eligibilityPolicyCommand({
    correlationId: 'operator-queue-eligibility-policy-v2',
    eligibilityPolicyRevisionId: DATABASE_IDS.activeEligibilityPolicyV2,
    idempotencyKey: 'operator-queue-eligibility-policy-v2',
    reviewPolicyRevisionId: DATABASE_IDS.activeReviewPolicyV2,
    revision: 2,
  }));
  await activateEligibilityPolicyRevision(pool, activationCommand({
    correlationId: 'operator-queue-eligibility-activation-v2',
    eligibilityPolicyRevisionId: DATABASE_IDS.activeEligibilityPolicyV2,
    expectedCurrentEligibilityPolicyRevisionId: GATE_IDS.eligibilityPolicyId,
    idempotencyKey: 'operator-queue-eligibility-activation-v2',
  }));
}

test('candidate queue maps closed DTOs and uses one repeatable-read read-only transaction', async () => {
  const db = fakePool();
  const now = new Date('2026-08-28T03:00:00.000Z');

  const queue = await readOperatorCandidateReviewQueue(db.pool, {
    limit: 25,
    now,
  });

  assert.deepEqual(transactionBoundaries(db.calls), [
    'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
    'COMMIT',
  ]);
  assert.equal(db.released(), 1);
  assert.equal(queue.schemaVersion, 1);
  assert.equal(queue.generatedAt, now.toISOString());
  assert.equal(queue.activeReviewPolicyRevisionId, IDS.reviewPolicy);
  assert.equal(queue.limit, 25);
  assert.deepEqual(queue.summary, {
    returned: 2,
    unreviewed: 1,
    inProgress: 1,
    unscored: 1,
    low: 0,
    medium: 0,
    high: 1,
    veryHigh: 0,
  });
  assert.deepEqual(queue.items[0], {
    candidateId: IDS.candidateA,
    candidateRevisionId: IDS.revisionA,
    revision: 2,
    patchId: IDS.patch,
    catalogRevisionId: IDS.catalog,
    subjectExternalId: 'samira',
    selection: {
      augmentExternalIds: ['1194'],
      itemExternalIds: ['3006', '6672'],
    },
    createdAt: '2026-08-27T01:00:00.000Z',
    review: {
      state: 'in_progress',
      confirmedCount: 1,
      requiredCount: 2,
    },
    confidence: {
      scoreId: IDS.confidenceScore,
      scoringVersion: 'candidate-confidence-v1',
      score: 80,
      band: 'high',
      components: {
        provenanceQualityScore: 20,
        evidenceDiversityScore: 25,
        patchAlignmentScore: 20,
        freshnessScore: 15,
      },
      evaluatedAt: '2026-08-28T02:00:00.000Z',
      createdAt: '2026-08-28T02:05:00.000Z',
    },
  });
  assert.equal(queue.items[1]?.review.state, 'unreviewed');
  assert.equal(queue.items[1]?.review.confirmedCount, 0);
  assert.equal(queue.items[1]?.review.requiredCount, 2);
  assert.equal(queue.items[1]?.confidence, null);

  const queueSelect = db.calls.find(({ sql }) =>
    sql.includes('with latest_active_revisions'));
  assert.deepEqual(queueSelect?.values, [IDS.reviewPolicy, 25]);
});

test('candidate queue fails closed when active review policy is unavailable', async () => {
  const db = fakePool({ policyRows: [] });

  await assert.rejects(
    readOperatorCandidateReviewQueue(db.pool),
    /OPERATOR_ACTIVE_REVIEW_POLICY_UNAVAILABLE/,
  );

  assert.deepEqual(transactionBoundaries(db.calls), [
    'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
    'ROLLBACK',
  ]);
  assert.equal(db.released(), 1);
});

test('candidate queue rejects invalid candidate payload instead of omitting the row', async () => {
  const db = fakePool({
    queueRows: [scoredRow({
      canonical_payload: {
        schemaVersion: 1,
        augmentExternalIds: ['1194'],
        itemExternalIds: ['3006', '6672'],
        rawEvidence: 'must not escape',
      },
    })],
  });

  await assert.rejects(
    readOperatorCandidateReviewQueue(db.pool),
    /OPERATOR_CANDIDATE_QUEUE_ROW_INVALID/,
  );
  assert.deepEqual(transactionBoundaries(db.calls), [
    'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
    'ROLLBACK',
  ]);
});

test('candidate queue rejects confidence totals that do not match components', async () => {
  const db = fakePool({ queueRows: [scoredRow({ score: 79 })] });

  await assert.rejects(
    readOperatorCandidateReviewQueue(db.pool),
    /OPERATOR_CANDIDATE_QUEUE_ROW_INVALID/,
  );
  assert.deepEqual(transactionBoundaries(db.calls), [
    'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
    'ROLLBACK',
  ]);
});

test('candidate queue rolls back and releases when PostgreSQL read fails', async () => {
  const db = fakePool({ queueError: new Error('database unavailable') });

  await assert.rejects(
    readOperatorCandidateReviewQueue(db.pool),
    /database unavailable/,
  );
  assert.deepEqual(transactionBoundaries(db.calls), [
    'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
    'ROLLBACK',
  ]);
  assert.equal(db.released(), 1);
});

test('PostgreSQL queue presents the active sealed revision without mutating authority', {
  skip: process.env.TEST_DATABASE_URL === undefined,
}, async () => {
  const pool = await resetDatabase();
  try {
    await seedActivatedGateContext(pool);
    await evaluateCandidateConfidence(pool, {
      actorId: 'confidence-evaluator',
      candidateRevisionId: CANDIDATE_IDS.candidateRevisionId,
      correlationId: 'operator-queue-confidence',
      evaluatedAt: new Date(Date.now() + 1_000),
      reason: 'Persist confidence before the read-only operator queue test.',
    });

    const authorityTables = [
      'candidate_claims',
      'candidate_claim_set_seals',
      'evidence_records',
      'evidence_associations',
      'evidence_input_snapshots',
      'current_claim_evidence_decisions',
      'human_reviews',
      'review_input_snapshots',
      'review_quorum_evaluations',
      'current_review_quorum_evaluations',
      'candidate_confidence_scores',
      'current_candidate_confidence_scores',
      'moderation_decisions',
      'current_candidate_moderation_decisions',
      'candidate_eligibility_evaluations',
      'current_candidate_eligibility_evaluations',
      'publications',
      'publication_versions',
      'publication_activation_history',
      'audit_events',
      'outbox_events',
    ] as const;
    const before = await Promise.all(
      authorityTables.map((table) => tableCount(pool, table)),
    );

    const queue = await readOperatorCandidateReviewQueue(pool, {
      limit: 50,
      now: new Date('2026-08-30T03:00:00.000Z'),
    });

    assert.equal(queue.items.length, 1);
    assert.equal(
      queue.items[0]?.candidateRevisionId,
      CANDIDATE_IDS.candidateRevisionId,
    );
    assert.equal(queue.items[0]?.review.state, 'unreviewed');
    assert.equal(queue.items[0]?.confidence?.band, 'medium');
    assert.equal(queue.items[0]?.confidence?.score, 65);
    const after = await Promise.all(
      authorityTables.map((table) => tableCount(pool, table)),
    );
    assert.deepEqual(after, before);
  } finally {
    await pool.end();
  }
});

test('PostgreSQL queue maps missing persisted confidence to unscored', {
  skip: process.env.TEST_DATABASE_URL === undefined,
}, async () => {
  const pool = await resetDatabase();
  try {
    await seedActivatedGateContext(pool);

    const queue = await readOperatorCandidateReviewQueue(pool);

    assert.equal(queue.items.length, 1);
    assert.equal(queue.items[0]?.candidateRevisionId, CANDIDATE_IDS.candidateRevisionId);
    assert.equal(queue.items[0]?.confidence, null);
    assert.equal(queue.summary.unscored, 1);
  } finally {
    await pool.end();
  }
});

test('PostgreSQL queue selects only the latest sealed revision in the active catalog', {
  skip: process.env.TEST_DATABASE_URL === undefined,
}, async () => {
  const pool = await resetDatabase();
  try {
    await seedActivatedGateContext(pool);
    await activateSecondCatalogRevision(pool);
    await seedRawObservation(pool, DATABASE_IDS.secondCatalogRawObservation);
    const registration = await registerNormalizedObservation(
      pool,
      registrationCommand({
        candidateId: DATABASE_IDS.secondCatalogRevisionCandidate,
        candidateRevisionId: DATABASE_IDS.secondCatalogRevisionCandidate,
        normalizedObservationId: DATABASE_IDS.secondCatalogObservation,
        provenanceId: DATABASE_IDS.secondCatalogProvenance,
        rawObservationId: DATABASE_IDS.secondCatalogRawObservation,
      }),
    );
    assert.equal(registration.candidateId, CANDIDATE_IDS.candidateId);
    await sealRevision(
      pool,
      CANDIDATE_IDS.candidateId,
      DATABASE_IDS.secondCatalogRevisionCandidate,
      DATABASE_IDS.secondCatalogClaim,
    );

    const queue = await readOperatorCandidateReviewQueue(pool);

    assert.deepEqual(
      queue.items.map((item) => item.candidateRevisionId),
      [DATABASE_IDS.secondCatalogRevisionCandidate],
    );
    assert.equal(queue.items[0]?.revision, 2);
    assert.equal(
      queue.items[0]?.catalogRevisionId,
      DATABASE_IDS.secondCatalogRevision,
    );
  } finally {
    await pool.end();
  }
});

test('PostgreSQL queue excludes an active-catalog revision until its claim set is sealed', {
  skip: process.env.TEST_DATABASE_URL === undefined,
}, async () => {
  const pool = await resetDatabase();
  try {
    await seedActivatedGateContext(pool);
    await activateSecondCatalogRevision(pool);
    await seedRawObservation(pool, DATABASE_IDS.secondCatalogRawObservation);
    await registerNormalizedObservation(pool, registrationCommand({
      candidateId: DATABASE_IDS.secondCatalogRevisionCandidate,
      candidateRevisionId: DATABASE_IDS.secondCatalogRevisionCandidate,
      normalizedObservationId: DATABASE_IDS.secondCatalogObservation,
      provenanceId: DATABASE_IDS.secondCatalogProvenance,
      rawObservationId: DATABASE_IDS.secondCatalogRawObservation,
    }));

    const queue = await readOperatorCandidateReviewQueue(pool);

    assert.deepEqual(queue.items, []);
  } finally {
    await pool.end();
  }
});

test('PostgreSQL queue ignores completed quorum from a historical review policy', {
  skip: process.env.TEST_DATABASE_URL === undefined,
}, async () => {
  const pool = await resetDatabase();
  try {
    await seedActivatedGateContext(pool);
    await completeHumanReview(pool, humanReviewCommand());
    await completeHumanReview(pool, humanReviewCommand({
      actorId: 'reviewer-b',
      completedAt: '2026-07-28T05:01:00.000Z',
      correlationId: 'operator-queue-historical-review-2',
      humanReviewId: TRUST_IDS.secondHumanReviewId,
      idempotencyKey: 'operator-queue-historical-review-2',
      reviewInputSnapshotId: TRUST_IDS.secondReviewInputSnapshotId,
      reviewQuorumEvaluationId: TRUST_IDS.secondReviewQuorumEvaluationId,
    }));
    await activateReviewPolicyV2(pool);

    const queue = await readOperatorCandidateReviewQueue(pool);

    assert.equal(
      queue.activeReviewPolicyRevisionId,
      DATABASE_IDS.activeReviewPolicyV2,
    );
    assert.deepEqual(queue.items[0]?.review, {
      state: 'unreviewed',
      confirmedCount: 0,
      requiredCount: 2,
    });
  } finally {
    await pool.end();
  }
});

test('PostgreSQL executes progress, confidence, age, ID, and limit ranking', {
  skip: process.env.TEST_DATABASE_URL === undefined,
}, async () => {
  const pool = await resetDatabase();
  try {
    await seedActivatedGateContext(pool);
    await completeHumanReview(pool, humanReviewCommand());
    const evaluatedAt = new Date(Date.now() + 1_000);
    await evaluateCandidateConfidence(pool, {
      actorId: 'confidence-evaluator',
      candidateRevisionId: CANDIDATE_IDS.candidateRevisionId,
      correlationId: 'operator-queue-rank-seeded',
      evaluatedAt,
      reason: 'Create the ranked in-progress confidence score.',
    });

    await seedSecondTrustCandidate(pool);
    await sealRevision(
      pool,
      TRUST_IDS.secondCandidateId,
      TRUST_IDS.secondCandidateRevisionId,
      DATABASE_IDS.rankedEditorialClaim,
    );
    await recordClaimEvidenceDecision(pool, evidenceDecisionCommand({
      associations: [{
        associationId: DATABASE_IDS.rankedEditorialAssociation,
        crossPatchRevalidated: false,
        evidenceId: DATABASE_IDS.rankedEditorialEvidence,
        normalizedObservationId: TRUST_IDS.secondNormalizedObservationId,
        revalidationReason: null,
        stance: 'supports',
      }],
      candidateId: TRUST_IDS.secondCandidateId,
      candidateRevisionId: TRUST_IDS.secondCandidateRevisionId,
      claimId: DATABASE_IDS.rankedEditorialClaim,
      correlationId: 'operator-queue-rank-editorial-evidence',
      decisionId: DATABASE_IDS.rankedEditorialDecision,
      evidenceInputSnapshotId: DATABASE_IDS.rankedEditorialSnapshot,
      idempotencyKey: 'operator-queue-rank-editorial-evidence',
    }));
    await evaluateCandidateConfidence(pool, {
      actorId: 'confidence-evaluator',
      candidateRevisionId: TRUST_IDS.secondCandidateRevisionId,
      correlationId: 'operator-queue-rank-editorial',
      evaluatedAt: new Date(evaluatedAt.getTime() + 1_000),
      reason: 'Create the higher low-band confidence score.',
    });

    await registerRankedCollectorCandidate(pool);
    await evaluateCandidateConfidence(pool, {
      actorId: 'confidence-evaluator',
      candidateRevisionId: DATABASE_IDS.rankedCollectorRevision,
      correlationId: 'operator-queue-rank-collector',
      evaluatedAt: new Date(evaluatedAt.getTime() + 2_000),
      reason: 'Create the lower low-band confidence score.',
    });

    await insertUnscoredCandidate(pool, {
      candidateId: DATABASE_IDS.unscoredOlderCandidate,
      candidateRevisionId: DATABASE_IDS.unscoredOlderRevision,
      claimId: DATABASE_IDS.unscoredOlderClaim,
      createdAt: '2026-06-01T00:00:00.000Z',
      fingerprintCharacter: 'b',
      itemExternalIds: ['3006'],
    });
    await insertUnscoredCandidate(pool, {
      candidateId: DATABASE_IDS.unscoredTieCandidateB,
      candidateRevisionId: DATABASE_IDS.unscoredTieRevisionB,
      claimId: DATABASE_IDS.unscoredTieClaimB,
      createdAt: '2026-06-02T00:00:00.000Z',
      fingerprintCharacter: 'c',
      itemExternalIds: ['6672'],
    });
    await insertUnscoredCandidate(pool, {
      candidateId: DATABASE_IDS.unscoredTieCandidateA,
      candidateRevisionId: DATABASE_IDS.unscoredTieRevisionA,
      claimId: DATABASE_IDS.unscoredTieClaimA,
      createdAt: '2026-06-02T00:00:00.000Z',
      fingerprintCharacter: 'd',
      itemExternalIds: ['3006', '6672'],
    });

    const queue = await readOperatorCandidateReviewQueue(pool, { limit: 50 });
    const expectedRevisionOrder = [
      CANDIDATE_IDS.candidateRevisionId,
      TRUST_IDS.secondCandidateRevisionId,
      DATABASE_IDS.rankedCollectorRevision,
      DATABASE_IDS.unscoredOlderRevision,
      DATABASE_IDS.unscoredTieRevisionA,
      DATABASE_IDS.unscoredTieRevisionB,
    ];
    assert.deepEqual(
      queue.items.map((item) => item.candidateRevisionId),
      expectedRevisionOrder,
    );
    assert.deepEqual(
      queue.items.slice(0, 3).map((item) => ({
        band: item.confidence?.band,
        score: item.confidence?.score,
        state: item.review.state,
      })),
      [
        { band: 'medium', score: 65, state: 'in_progress' },
        { band: 'high', score: 75, state: 'unreviewed' },
        { band: 'low', score: 20, state: 'unreviewed' },
      ],
    );

    const limited = await readOperatorCandidateReviewQueue(pool, { limit: 2 });
    assert.deepEqual(
      limited.items.map((item) => item.candidateRevisionId),
      expectedRevisionOrder.slice(0, 2),
    );
  } finally {
    await pool.end();
  }
});

test('PostgreSQL queue shows partial active-policy quorum and excludes satisfied quorum', {
  skip: process.env.TEST_DATABASE_URL === undefined,
}, async () => {
  const pool = await resetDatabase();
  try {
    await seedActivatedGateContext(pool);
    await completeHumanReview(pool, humanReviewCommand());

    const partial = await readOperatorCandidateReviewQueue(pool);
    assert.equal(partial.items.length, 1);
    assert.deepEqual(partial.items[0]?.review, {
      state: 'in_progress',
      confirmedCount: 1,
      requiredCount: 2,
    });

    await completeHumanReview(pool, humanReviewCommand({
      actorId: 'reviewer-b',
      completedAt: '2026-07-28T05:01:00.000Z',
      correlationId: 'operator-queue-review-2',
      humanReviewId: '91000000-0000-4000-8000-000000000010',
      idempotencyKey: 'operator-queue-review-2',
      reviewInputSnapshotId: '91000000-0000-4000-8000-000000000011',
      reviewQuorumEvaluationId:
        '91000000-0000-4000-8000-000000000012',
    }));

    const completed = await readOperatorCandidateReviewQueue(pool);
    assert.deepEqual(completed.items, []);
    assert.equal(completed.summary.returned, 0);
  } finally {
    await pool.end();
  }
});
