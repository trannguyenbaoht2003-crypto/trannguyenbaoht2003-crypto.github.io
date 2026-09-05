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
  readOperatorCandidateReviewDossier,
} from '../src/modules/operator/read-candidate-review-dossier.js';
import {
  completeHumanReview,
} from '../src/modules/trust/complete-human-review.js';
import { defineCandidateClaimSet } from '../src/modules/trust/define-candidate-claim-set.js';
import {
  recordClaimEvidenceDecision,
} from '../src/modules/trust/record-claim-evidence-decision.js';
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
  seedSatisfiedReviewQuorum,
} from './helpers/gate.js';
import {
  claimSetCommand,
  evidenceDecisionCommand,
  humanReviewCommand,
  requiredClaim,
  TRUST_IDS,
} from './helpers/trust.js';

const IDS = {
  candidate: '92000000-0000-4000-8000-000000000001',
  candidateRevision: '92000000-0000-4000-8000-000000000002',
  patch: '92000000-0000-4000-8000-000000000003',
  catalog: '92000000-0000-4000-8000-000000000004',
  reviewPolicy: '92000000-0000-4000-8000-000000000005',
  reviewEvaluation: '92000000-0000-4000-8000-000000000006',
  confidenceScore: '92000000-0000-4000-8000-000000000007',
  claimSetSeal: '92000000-0000-4000-8000-000000000008',
  buildClaim: '92000000-0000-4000-8000-000000000009',
  contextClaim: '92000000-0000-4000-8000-000000000010',
  evidencePolicy: '92000000-0000-4000-8000-000000000011',
  evidenceDecision: '92000000-0000-4000-8000-000000000012',
  evidenceSnapshot: '92000000-0000-4000-8000-000000000013',
  evidenceAssociation: '92000000-0000-4000-8000-000000000014',
  evidence: '92000000-0000-4000-8000-000000000015',
  evidencePatch: '92000000-0000-4000-8000-000000000016',
  evidenceSource: '92000000-0000-4000-8000-000000000017',
  evidenceSourcePolicy: '92000000-0000-4000-8000-000000000018',
  collectorProvenance: '92000000-0000-4000-8000-000000000019',
  aggregateProvenance: '92000000-0000-4000-8000-000000000020',
  aggregateSource: '92000000-0000-4000-8000-000000000021',
  aggregateSourcePolicy: '92000000-0000-4000-8000-000000000022',
} as const;

const CLAIM_SET_HASH = 'a'.repeat(64);
const BUILD_STATEMENT_HASH = 'b'.repeat(64);
const CONTEXT_STATEMENT_HASH = 'c'.repeat(64);

const DATABASE_IDS = {
  secondCatalogRevision: '94000000-0000-4000-8000-000000000001',
  secondCatalogValidation: '94000000-0000-4000-8000-000000000002',
  secondRawObservation: '94000000-0000-4000-8000-000000000003',
  secondNormalizedObservation: '94000000-0000-4000-8000-000000000004',
  secondProvenance: '94000000-0000-4000-8000-000000000005',
  secondCandidate: '94000000-0000-4000-8000-000000000006',
  secondCandidateRevision: '94000000-0000-4000-8000-000000000007',
  secondClaim: '94000000-0000-4000-8000-000000000008',
  reviewPolicyV2: '94000000-0000-4000-8000-000000000009',
  eligibilityPolicyV2: '94000000-0000-4000-8000-000000000010',
} as const;

type FakeRow = Record<string, unknown>;

function policyRows(): FakeRow[] {
  return [{
    minimum_confirmed_reviews: 2,
    review_policy_revision_id: IDS.reviewPolicy,
  }];
}

function headerRows(): FakeRow[] {
  return [{
    band: 'high',
    candidate_claim_set_seal_id: IDS.claimSetSeal,
    candidate_confidence_score_id: IDS.confidenceScore,
    candidate_id: IDS.candidate,
    candidate_revision_id: IDS.candidateRevision,
    canonical_payload: {
      schemaVersion: 1,
      augmentExternalIds: ['1194'],
      itemExternalIds: ['3006', '6672'],
    },
    catalog_revision_id: IDS.catalog,
    claim_count: 2,
    claim_set_hash: CLAIM_SET_HASH,
    confidence_created_at: new Date('2026-09-03T00:31:00.000Z'),
    counted_review_count: 1,
    created_at: new Date('2026-09-03T00:00:00.000Z'),
    evaluated_at: new Date('2026-09-03T00:30:00.000Z'),
    evidence_diversity_score: 25,
    freshness_score: 15,
    patch_alignment_score: 20,
    patch_id: IDS.patch,
    patch_key: '26.18',
    provenance_quality_score: 20,
    required_confirmed_count: 2,
    review_quorum_evaluation_id: IDS.reviewEvaluation,
    revision: 1,
    score: 80,
    scoring_version: 'candidate-confidence-v1',
    subject_external_id: 'samira',
  }];
}

function claimRows(): FakeRow[] {
  return [{
    association_count: 1,
    candidate_claim_set_seal_id: IDS.claimSetSeal,
    candidate_id: IDS.candidate,
    candidate_revision_id: IDS.candidateRevision,
    catalog_revision_id: IDS.catalog,
    claim_evidence_decision_id: IDS.evidenceDecision,
    claim_id: IDS.buildClaim,
    claim_key: 'build',
    claim_set_hash: CLAIM_SET_HASH,
    claim_statement_hash: BUILD_STATEMENT_HASH,
    claim_type: 'build_effectiveness',
    decision: 'supported',
    decision_candidate_id: IDS.candidate,
    decision_candidate_revision_id: IDS.candidateRevision,
    decision_catalog_revision_id: IDS.catalog,
    decision_patch_id: IDS.patch,
    evaluated_at: new Date('2026-09-03T00:20:00.000Z'),
    evidence_input_snapshot_id: IDS.evidenceSnapshot,
    evidence_policy_revision_id: IDS.evidencePolicy,
    importance: 'required',
    patch_id: IDS.patch,
    reason: 'Current governed Evidence supports this Claim.',
    statement: 'The selected build is effective for this patch.',
    statement_hash: BUILD_STATEMENT_HASH,
  }, {
    association_count: null,
    candidate_claim_set_seal_id: null,
    candidate_id: IDS.candidate,
    candidate_revision_id: IDS.candidateRevision,
    catalog_revision_id: IDS.catalog,
    claim_evidence_decision_id: null,
    claim_id: IDS.contextClaim,
    claim_key: 'context',
    claim_set_hash: null,
    claim_statement_hash: null,
    claim_type: 'playstyle_hypothesis',
    decision: null,
    decision_candidate_id: null,
    decision_candidate_revision_id: null,
    decision_catalog_revision_id: null,
    decision_patch_id: null,
    evaluated_at: null,
    evidence_input_snapshot_id: null,
    evidence_policy_revision_id: null,
    importance: 'supporting',
    patch_id: IDS.patch,
    reason: null,
    statement: 'The selection favors aggressive resets.',
    statement_hash: CONTEXT_STATEMENT_HASH,
  }];
}

function evidenceRows(): FakeRow[] {
  return [{
    association_candidate_id: IDS.candidate,
    association_candidate_revision_id: IDS.candidateRevision,
    association_catalog_revision_id: IDS.catalog,
    association_evidence_patch_id: IDS.evidencePatch,
    claim_evidence_decision_id: IDS.evidenceDecision,
    claim_id: IDS.buildClaim,
    collected_at: new Date('2026-09-02T23:58:00.000Z'),
    cross_patch_revalidated: true,
    decision_patch_id: IDS.patch,
    display_name: 'Bilibili',
    evidence_association_id: IDS.evidenceAssociation,
    evidence_created_at: new Date('2026-09-03T00:05:00.000Z'),
    evidence_id: IDS.evidence,
    evidence_input_snapshot_id: IDS.evidenceSnapshot,
    evidence_patch_id: IDS.evidencePatch,
    evidence_patch_key: '26.17',
    external_reference: {
      url: 'https://www.bilibili.com/video/BV1example',
      platform: 'bilibili',
      author: 'meta-lab',
      publishedAt: '2026-09-02',
      sourceContentId: 'BV1example',
      ignoredHistoricalKey: 'not projected',
    },
    observed_at: new Date('2026-09-02T23:55:00.000Z'),
    ordinal: 1,
    revalidation_reason: 'Revalidated for the current decision patch.',
    source_id: IDS.evidenceSource,
    source_key: 'bilibili-public',
    source_policy_revision_id: IDS.evidenceSourcePolicy,
    source_status: 'active',
    stance: 'supports',
    storage_permission: 'reference_only',
  }];
}

function provenanceRows(): FakeRow[] {
  return [{
    candidate_provenance_id: IDS.collectorProvenance,
    collected_at: new Date('2026-09-02T23:58:00.000Z'),
    display_name: 'Bilibili',
    external_reference: {
      url: 'https://www.bilibili.com/video/BV1example',
      platform: 'bilibili',
    },
    observed_at: new Date('2026-09-02T23:55:00.000Z'),
    origin: 'collector_detected',
    provenance_catalog_revision_id: IDS.catalog,
    provenance_patch_id: IDS.patch,
    source_id: IDS.evidenceSource,
    source_key: 'bilibili-public',
    source_policy_revision_id: IDS.evidenceSourcePolicy,
    source_status: 'active',
    storage_permission: 'reference_only',
  }, {
    candidate_provenance_id: IDS.aggregateProvenance,
    collected_at: new Date('2026-09-03T00:01:00.000Z'),
    display_name: 'Aggregate model input',
    external_reference: null,
    observed_at: null,
    origin: 'ai_generated',
    provenance_catalog_revision_id: IDS.catalog,
    provenance_patch_id: IDS.patch,
    source_id: IDS.aggregateSource,
    source_key: 'ai-discovery',
    source_policy_revision_id: IDS.aggregateSourcePolicy,
    source_status: 'suspended',
    storage_permission: 'aggregate_only',
  }];
}

type FakeDossierOptions = {
  claims?: FakeRow[];
  evidence?: FakeRow[];
  errorOnSql?: string;
  header?: FakeRow[];
  policy?: FakeRow[];
  provenance?: FakeRow[];
  rollbackError?: Error;
};

function fakePool(options: FakeDossierOptions = {}) {
  const calls: Array<{ sql: string; values: unknown[] | undefined }> = [];
  let connected = 0;
  let released = 0;
  const client = {
    async query(sql: string, values?: unknown[]) {
      calls.push({ sql, values });
      if (sql === 'ROLLBACK' && options.rollbackError) {
        throw options.rollbackError;
      }
      if (options.errorOnSql && sql.includes(options.errorOnSql)) {
        throw new Error('planned database read failure');
      }
      if (sql.includes('from active_eligibility_policy_revision')) {
        const rows = options.policy ?? policyRows();
        return { rows, rowCount: rows.length };
      }
      if (sql.includes('with latest_active_revisions')) {
        const rows = options.header ?? headerRows();
        return { rows, rowCount: rows.length };
      }
      if (sql.includes('from candidate_claims claim')) {
        const rows = options.claims ?? claimRows();
        return { rows, rowCount: rows.length };
      }
      if (sql.includes('from evidence_input_snapshot_associations member')) {
        const rows = options.evidence ?? evidenceRows();
        return { rows, rowCount: rows.length };
      }
      if (sql.includes('from candidate_provenance provenance')) {
        const rows = options.provenance ?? provenanceRows();
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
    pool: {
      async connect() {
        connected += 1;
        return client;
      },
    } as unknown as Pool,
    connected: () => connected,
    released: () => released,
  };
}

function transactionBoundaries(calls: Array<{ sql: string }>): string[] {
  return calls
    .map(({ sql }) => sql)
    .filter((sql) => /^(?:BEGIN|COMMIT|ROLLBACK)/.test(sql));
}

function generatedUuid(namespace: number, index: number): string {
  return `${namespace.toString(16).padStart(8, '0')}-0000-4000-8000-${index
    .toString(16)
    .padStart(12, '0')}`;
}

async function activateSecondCatalogAndSealLatestRevision(
  pool: Pool,
): Promise<void> {
  const snapshot = validCatalogSnapshot();
  snapshot.source.sourceDigest = 'e'.repeat(64);
  const subject = snapshot.entities.find((entity) => (
    entity.entityType === 'champion' && entity.externalId === 'samira'
  ));
  assert.ok(subject);
  subject.attributes = { ...subject.attributes, catalogRevision: 2 };
  await importCatalogRevision(pool, {
    actorId: 'operator-dossier-catalog',
    catalogRevisionId: DATABASE_IDS.secondCatalogRevision,
    correlationId: 'operator-dossier-catalog-import-2',
    idempotencyKey: 'operator-dossier-catalog-import-2',
    patchId: CATALOG_IDS.patchId,
    revision: 2,
    sourceId: CATALOG_IDS.sourceId,
    sourcePolicyRevisionId: CATALOG_IDS.sourcePolicyRevisionId,
    snapshot,
  });
  const validation = await validateCatalogRevision(pool, {
    actorId: 'operator-dossier-validator',
    catalogRevisionId: DATABASE_IDS.secondCatalogRevision,
    catalogValidationResultId: DATABASE_IDS.secondCatalogValidation,
    correlationId: 'operator-dossier-catalog-validation-2',
    reason: 'Validate the second catalog for dossier currentness.',
    validatorRulesetVersion: 'catalog-rules-v1',
  });
  assert.equal(validation.result, 'passed');
  await activateCatalogRevision(pool, {
    actorId: 'operator-dossier-catalog',
    catalogRevisionId: DATABASE_IDS.secondCatalogRevision,
    correlationId: 'operator-dossier-catalog-activation-2',
    expectedCurrentCatalogRevisionId: CATALOG_IDS.catalogRevisionId,
    patchId: CATALOG_IDS.patchId,
    reason: 'Activate the second catalog for dossier currentness.',
  });
  await seedRawObservation(pool, DATABASE_IDS.secondRawObservation);
  const registration = await registerNormalizedObservation(
    pool,
    registrationCommand({
      candidateId: DATABASE_IDS.secondCandidate,
      candidateRevisionId: DATABASE_IDS.secondCandidateRevision,
      normalizedObservationId: DATABASE_IDS.secondNormalizedObservation,
      provenanceId: DATABASE_IDS.secondProvenance,
      rawObservationId: DATABASE_IDS.secondRawObservation,
    }),
  );
  assert.equal(registration.candidateId, CANDIDATE_IDS.candidateId);
  await defineCandidateClaimSet(pool, claimSetCommand({
    candidateId: CANDIDATE_IDS.candidateId,
    candidateRevisionId: DATABASE_IDS.secondCandidateRevision,
    claims: [requiredClaim({ claimId: DATABASE_IDS.secondClaim })],
    correlationId: 'operator-dossier-second-claim',
    idempotencyKey: 'operator-dossier-second-claim',
  }));
}

async function activateReviewPolicyV2(pool: Pool): Promise<void> {
  await registerTrustPolicyRevision(pool, {
    actorId: 'operator-dossier-policy',
    appliesToAiProvenance: true,
    correlationId: 'operator-dossier-review-policy-v2',
    idempotencyKey: 'operator-dossier-review-policy-v2',
    minimumConfirmedReviews: 2,
    policyKey: 'human-review-v2',
    policyKind: 'human_review',
    policyRevisionId: DATABASE_IDS.reviewPolicyV2,
    reason: 'Activate a fresh review authority for dossier currentness.',
    requireDistinctReviewers: true,
    requiredPermission: 'reviewer',
    revision: 2,
  });
  await registerEligibilityPolicyRevision(pool, eligibilityPolicyCommand({
    correlationId: 'operator-dossier-eligibility-policy-v2',
    eligibilityPolicyRevisionId: DATABASE_IDS.eligibilityPolicyV2,
    idempotencyKey: 'operator-dossier-eligibility-policy-v2',
    reviewPolicyRevisionId: DATABASE_IDS.reviewPolicyV2,
    revision: 2,
  }));
  await activateEligibilityPolicyRevision(pool, activationCommand({
    correlationId: 'operator-dossier-eligibility-activation-v2',
    eligibilityPolicyRevisionId: DATABASE_IDS.eligibilityPolicyV2,
    expectedCurrentEligibilityPolicyRevisionId: GATE_IDS.eligibilityPolicyId,
    idempotencyKey: 'operator-dossier-eligibility-activation-v2',
  }));
}

test('dossier maps the complete current governed graph in one read-only snapshot', async () => {
  const db = fakePool();

  const dossier = await readOperatorCandidateReviewDossier(
    db.pool,
    IDS.candidateRevision,
    { now: new Date('2026-09-03T01:00:00.000Z') },
  );

  assert.ok(dossier);
  assert.deepEqual(dossier, {
    schemaVersion: 1,
    generatedAt: '2026-09-03T01:00:00.000Z',
    activeReviewPolicyRevisionId: IDS.reviewPolicy,
    candidate: {
      candidateId: IDS.candidate,
      candidateRevisionId: IDS.candidateRevision,
      revision: 1,
      patchId: IDS.patch,
      patchKey: '26.18',
      catalogRevisionId: IDS.catalog,
      subjectExternalId: 'samira',
      selection: {
        augmentExternalIds: ['1194'],
        itemExternalIds: ['3006', '6672'],
      },
      createdAt: '2026-09-03T00:00:00.000Z',
    },
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
      evaluatedAt: '2026-09-03T00:30:00.000Z',
      createdAt: '2026-09-03T00:31:00.000Z',
    },
    claimSet: {
      claimSetSealId: IDS.claimSetSeal,
      claimSetHash: CLAIM_SET_HASH,
      claimCount: 2,
    },
    provenance: [{
      candidateProvenanceId: IDS.collectorProvenance,
      origin: 'collector_detected',
      source: {
        sourceId: IDS.evidenceSource,
        sourceKey: 'bilibili-public',
        displayName: 'Bilibili',
        status: 'active',
        sourcePolicyRevisionId: IDS.evidenceSourcePolicy,
        storagePermission: 'reference_only',
      },
      reference: {
        url: 'https://www.bilibili.com/video/BV1example',
        platform: 'bilibili',
        author: null,
        publishedAt: null,
        sourceContentId: null,
      },
      observedAt: '2026-09-02T23:55:00.000Z',
      collectedAt: '2026-09-02T23:58:00.000Z',
    }, {
      candidateProvenanceId: IDS.aggregateProvenance,
      origin: 'ai_generated',
      source: {
        sourceId: IDS.aggregateSource,
        sourceKey: 'ai-discovery',
        displayName: 'Aggregate model input',
        status: 'suspended',
        sourcePolicyRevisionId: IDS.aggregateSourcePolicy,
        storagePermission: 'aggregate_only',
      },
      reference: null,
      observedAt: null,
      collectedAt: '2026-09-03T00:01:00.000Z',
    }],
    claims: [{
      claimId: IDS.buildClaim,
      claimKey: 'build',
      claimType: 'build_effectiveness',
      importance: 'required',
      statement: 'The selected build is effective for this patch.',
      statementHash: BUILD_STATEMENT_HASH,
      decision: {
        decisionId: IDS.evidenceDecision,
        evidencePolicyRevisionId: IDS.evidencePolicy,
        outcome: 'supported',
        reason: 'Current governed Evidence supports this Claim.',
        evaluatedAt: '2026-09-03T00:20:00.000Z',
        evidence: [{
          evidenceAssociationId: IDS.evidenceAssociation,
          evidenceId: IDS.evidence,
          stance: 'supports',
          crossPatchRevalidated: true,
          revalidationReason: 'Revalidated for the current decision patch.',
          evidencePatchId: IDS.evidencePatch,
          evidencePatchKey: '26.17',
          source: {
            sourceId: IDS.evidenceSource,
            sourceKey: 'bilibili-public',
            displayName: 'Bilibili',
            status: 'active',
            sourcePolicyRevisionId: IDS.evidenceSourcePolicy,
            storagePermission: 'reference_only',
          },
          reference: {
            url: 'https://www.bilibili.com/video/BV1example',
            platform: 'bilibili',
            author: 'meta-lab',
            publishedAt: '2026-09-02',
            sourceContentId: 'BV1example',
          },
          observedAt: '2026-09-02T23:55:00.000Z',
          collectedAt: '2026-09-02T23:58:00.000Z',
          evidenceCreatedAt: '2026-09-03T00:05:00.000Z',
        }],
      },
    }, {
      claimId: IDS.contextClaim,
      claimKey: 'context',
      claimType: 'playstyle_hypothesis',
      importance: 'supporting',
      statement: 'The selection favors aggressive resets.',
      statementHash: CONTEXT_STATEMENT_HASH,
      decision: null,
    }],
  });
  assert.deepEqual(transactionBoundaries(db.calls), [
    'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
    'COMMIT',
  ]);
  assert.equal(db.released(), 1);
});

test('dossier rejects duplicate Evidence and provenance identities', async () => {
  const duplicateEvidence = evidenceRows();
  duplicateEvidence.push({ ...duplicateEvidence[0], ordinal: 2 });
  const claims = claimRows();
  claims[0]!.association_count = 2;

  await assert.rejects(
    readOperatorCandidateReviewDossier(
      fakePool({ claims, evidence: duplicateEvidence }).pool,
      IDS.candidateRevision,
    ),
    /OPERATOR_CANDIDATE_DOSSIER_ROW_INVALID/,
  );

  const duplicateProvenance = provenanceRows();
  duplicateProvenance.push({ ...duplicateProvenance[0] });
  await assert.rejects(
    readOperatorCandidateReviewDossier(
      fakePool({ provenance: duplicateProvenance }).pool,
      IDS.candidateRevision,
    ),
    /OPERATOR_CANDIDATE_DOSSIER_ROW_INVALID/,
  );
});

test('dossier returns null for a revision that is no longer current', async () => {
  const db = fakePool({ header: [] });

  assert.equal(
    await readOperatorCandidateReviewDossier(db.pool, IDS.candidateRevision),
    null,
  );
  assert.deepEqual(transactionBoundaries(db.calls), [
    'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
    'COMMIT',
  ]);
  assert.equal(db.released(), 1);
});

test('dossier fails closed when active review-policy authority is unavailable', async () => {
  for (const policy of [[], [...policyRows(), ...policyRows()]]) {
    const db = fakePool({ policy });
    await assert.rejects(
      readOperatorCandidateReviewDossier(db.pool, IDS.candidateRevision),
      /OPERATOR_ACTIVE_REVIEW_POLICY_UNAVAILABLE/,
    );
    assert.deepEqual(transactionBoundaries(db.calls), [
      'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
      'ROLLBACK',
    ]);
    assert.equal(db.released(), 1);
  }
});

test('dossier maps missing quorum and confidence as unreviewed and unscored', async () => {
  const header = headerRows();
  Object.assign(header[0]!, {
    band: null,
    candidate_confidence_score_id: null,
    confidence_created_at: null,
    counted_review_count: null,
    evaluated_at: null,
    evidence_diversity_score: null,
    freshness_score: null,
    patch_alignment_score: null,
    provenance_quality_score: null,
    required_confirmed_count: null,
    review_quorum_evaluation_id: null,
    score: null,
    scoring_version: null,
  });

  const dossier = await readOperatorCandidateReviewDossier(
    fakePool({ header }).pool,
    IDS.candidateRevision,
  );

  assert.ok(dossier);
  assert.deepEqual(dossier.review, {
    state: 'unreviewed',
    confirmedCount: 0,
    requiredCount: 2,
  });
  assert.equal(dossier.confidence, null);
});

test('dossier preserves undecided and valid zero-association Claim states', async () => {
  const claims = claimRows();
  claims[0]!.association_count = 0;
  const dossier = await readOperatorCandidateReviewDossier(
    fakePool({ claims, evidence: [] }).pool,
    IDS.candidateRevision,
  );

  assert.ok(dossier);
  assert.deepEqual(dossier.claims[0]?.decision?.evidence, []);
  assert.equal(dossier.claims[1]?.decision, null);
});

test('dossier nulls unsafe or invalid references without rejecting safe facts', async () => {
  for (const externalReference of [
    { url: 'javascript:alert(1)' },
    { url: 'https://user:secret@example.com/private' },
    { url: 'not a URL' },
    { url: 'https://example.com', author: '' },
    { url: 'https://example.com', author: null },
    { url: 'https://example.com', publishedAt: null },
    { url: 'https://example.com/' + 'é'.repeat(400) },
  ]) {
    const evidence = evidenceRows();
    evidence[0]!.external_reference = externalReference;
    const dossier = await readOperatorCandidateReviewDossier(
      fakePool({ evidence }).pool,
      IDS.candidateRevision,
    );
    assert.ok(dossier);
    assert.equal(dossier.claims[0]?.decision?.evidence[0]?.reference, null);
  }
});

test('dossier fails closed for malformed current graphs and response bounds', async () => {
  const malformedCases: Array<FakeDossierOptions> = [];

  const claimCountMismatch = headerRows();
  claimCountMismatch[0]!.claim_count = 3;
  malformedCases.push({ header: claimCountMismatch });

  const partialConfidence = headerRows();
  partialConfidence[0]!.band = null;
  malformedCases.push({ header: partialConfidence });

  const nonContiguousEvidence = evidenceRows();
  nonContiguousEvidence[0]!.ordinal = 2;
  malformedCases.push({ evidence: nonContiguousEvidence });

  const wrongCandidateGraph = claimRows();
  wrongCandidateGraph[0]!.decision_candidate_id =
    '92000000-0000-4000-8000-000000000099';
  malformedCases.push({ claims: wrongCandidateGraph });

  const tooManyPerClaim = claimRows();
  tooManyPerClaim[0]!.association_count = 65;
  malformedCases.push({ claims: tooManyPerClaim });

  const invalidSource = evidenceRows();
  invalidSource[0]!.source_status = 'unknown';
  malformedCases.push({ evidence: invalidSource });

  for (const options of malformedCases) {
    await assert.rejects(
      readOperatorCandidateReviewDossier(
        fakePool(options).pool,
        IDS.candidateRevision,
      ),
      /OPERATOR_CANDIDATE_DOSSIER_ROW_INVALID/,
    );
  }
});

test('dossier rejects more than 2,048 exact snapshot members', async () => {
  const claims: FakeRow[] = [];
  const evidence: FakeRow[] = [];
  for (let claimIndex = 1; claimIndex <= 33; claimIndex += 1) {
    const claimId = generatedUuid(0x93000001, claimIndex);
    const decisionId = generatedUuid(0x93000002, claimIndex);
    const snapshotId = generatedUuid(0x93000003, claimIndex);
    claims.push({
      ...claimRows()[0],
      association_count: 64,
      claim_evidence_decision_id: decisionId,
      claim_id: claimId,
      claim_key: `claim-${claimIndex.toString().padStart(2, '0')}`,
      evidence_input_snapshot_id: snapshotId,
    });
    for (let ordinal = 1; ordinal <= 64; ordinal += 1) {
      const memberIndex = (claimIndex - 1) * 64 + ordinal;
      evidence.push({
        ...evidenceRows()[0],
        claim_evidence_decision_id: decisionId,
        claim_id: claimId,
        evidence_association_id: generatedUuid(0x93000004, memberIndex),
        evidence_id: generatedUuid(0x93000005, memberIndex),
        evidence_input_snapshot_id: snapshotId,
        ordinal,
      });
    }
  }
  const header = headerRows();
  header[0]!.claim_count = claims.length;

  await assert.rejects(
    readOperatorCandidateReviewDossier(
      fakePool({ claims, evidence, header }).pool,
      IDS.candidateRevision,
    ),
    /OPERATOR_CANDIDATE_DOSSIER_ROW_INVALID/,
  );
});

test('dossier rejects an empty sealed Claim set and a non-positive revision', async () => {
  const emptySeal = headerRows();
  emptySeal[0]!.claim_count = 0;
  await assert.rejects(
    readOperatorCandidateReviewDossier(
      fakePool({ header: emptySeal, claims: [] }).pool,
      IDS.candidateRevision,
    ),
    /OPERATOR_CANDIDATE_DOSSIER_ROW_INVALID/,
  );

  const invalidRevision = headerRows();
  invalidRevision[0]!.revision = 0;
  await assert.rejects(
    readOperatorCandidateReviewDossier(
      fakePool({ header: invalidRevision }).pool,
      IDS.candidateRevision,
    ),
    /OPERATOR_CANDIDATE_DOSSIER_ROW_INVALID/,
  );
});

test('dossier verifies exact cross-patch revalidation semantics', async () => {
  const samePatchMarkedRevalidated = evidenceRows();
  samePatchMarkedRevalidated[0]!.association_evidence_patch_id = IDS.patch;
  samePatchMarkedRevalidated[0]!.evidence_patch_id = IDS.patch;
  await assert.rejects(
    readOperatorCandidateReviewDossier(
      fakePool({ evidence: samePatchMarkedRevalidated }).pool,
      IDS.candidateRevision,
    ),
    /OPERATOR_CANDIDATE_DOSSIER_ROW_INVALID/,
  );

  const crossPatchNotRevalidated = evidenceRows();
  crossPatchNotRevalidated[0]!.cross_patch_revalidated = false;
  crossPatchNotRevalidated[0]!.revalidation_reason = null;
  await assert.rejects(
    readOperatorCandidateReviewDossier(
      fakePool({ evidence: crossPatchNotRevalidated }).pool,
      IDS.candidateRevision,
    ),
    /OPERATOR_CANDIDATE_DOSSIER_ROW_INVALID/,
  );
});

test('dossier validates caller input before connecting', async () => {
  const invalidIdDb = fakePool();
  await assert.rejects(
    readOperatorCandidateReviewDossier(
      invalidIdDb.pool,
      'A2000000-0000-4000-8000-000000000002',
    ),
    /OPERATOR_CANDIDATE_DOSSIER_ID_INVALID/,
  );
  assert.equal(invalidIdDb.connected(), 0);

  const invalidNowDb = fakePool();
  await assert.rejects(
    readOperatorCandidateReviewDossier(
      invalidNowDb.pool,
      IDS.candidateRevision,
      { now: new Date(Number.NaN) },
    ),
    /OPERATOR_CANDIDATE_DOSSIER_NOW_INVALID/,
  );
  assert.equal(invalidNowDb.connected(), 0);
});

test('dossier preserves the original read failure, rolls back, and releases once', async () => {
  const db = fakePool({
    errorOnSql: 'from candidate_provenance provenance',
    rollbackError: new Error('rollback also failed'),
  });

  await assert.rejects(
    readOperatorCandidateReviewDossier(db.pool, IDS.candidateRevision),
    /planned database read failure/,
  );
  assert.deepEqual(transactionBoundaries(db.calls), [
    'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
    'ROLLBACK',
  ]);
  assert.equal(db.released(), 1);
});

test('PostgreSQL dossier returns the complete graph without mutation effects', {
  skip: process.env.TEST_DATABASE_URL === undefined,
}, async () => {
  const pool = await resetDatabase();
  try {
    await seedActivatedGateContext(pool);
    await evaluateCandidateConfidence(pool, {
      actorId: 'confidence-evaluator',
      candidateRevisionId: CANDIDATE_IDS.candidateRevisionId,
      correlationId: 'operator-dossier-confidence',
      evaluatedAt: new Date(Date.now() + 1_000),
      reason: 'Persist confidence before read-only dossier verification.',
    });
    const authorityTables = [
      'candidate_claims',
      'candidate_claim_set_seals',
      'evidence_records',
      'evidence_associations',
      'evidence_input_snapshots',
      'evidence_input_snapshot_associations',
      'claim_evidence_decisions',
      'current_claim_evidence_decisions',
      'human_reviews',
      'review_input_snapshots',
      'review_quorum_evaluations',
      'current_review_quorum_evaluations',
      'candidate_confidence_input_snapshots',
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
      'idempotency_records',
      'outbox_events',
    ] as const;
    const before = await Promise.all(
      authorityTables.map((table) => tableCount(pool, table)),
    );

    const dossier = await readOperatorCandidateReviewDossier(
      pool,
      CANDIDATE_IDS.candidateRevisionId,
      { now: new Date('2026-09-03T01:00:00.000Z') },
    );

    assert.ok(dossier);
    assert.equal(
      dossier.candidate.candidateRevisionId,
      CANDIDATE_IDS.candidateRevisionId,
    );
    assert.deepEqual(
      dossier.claims.map(({ claimId, claimKey }) => ({ claimId, claimKey })),
      [{
        claimId: TRUST_IDS.requiredClaimId,
        claimKey: 'build-core',
      }, {
        claimId: TRUST_IDS.supportingClaimId,
        claimKey: 'context-note',
      }],
    );
    assert.equal(
      dossier.claims[0]?.decision?.decisionId,
      TRUST_IDS.evidenceDecisionId,
    );
    assert.deepEqual(
      dossier.claims[0]?.decision?.evidence.map((item) => ({
        evidenceAssociationId: item.evidenceAssociationId,
        evidenceId: item.evidenceId,
      })),
      [{
        evidenceAssociationId: TRUST_IDS.evidenceAssociationId,
        evidenceId: TRUST_IDS.evidenceId,
      }],
    );
    assert.equal(dossier.claims[1]?.decision, null);
    assert.equal(dossier.provenance.length, 1);
    assert.equal(
      dossier.provenance[0]?.candidateProvenanceId,
      CANDIDATE_IDS.provenanceId,
    );
    assert.equal(dossier.provenance[0]?.reference, null);
    assert.equal(dossier.confidence?.score, 65);
    const after = await Promise.all(
      authorityTables.map((table) => tableCount(pool, table)),
    );
    assert.deepEqual(after, before);
  } finally {
    await pool.end();
  }
});

test('PostgreSQL dossier excludes historical Evidence after current reevaluation', {
  skip: process.env.TEST_DATABASE_URL === undefined,
}, async () => {
  const pool = await resetDatabase();
  try {
    await seedActivatedGateContext(pool);
    await recordClaimEvidenceDecision(pool, evidenceDecisionCommand({
      associations: [],
      correlationId: 'operator-dossier-current-insufficient',
      decision: 'insufficient',
      decisionId: TRUST_IDS.reevaluationDecisionId,
      evaluatedAt: '2026-07-29T02:00:00.000Z',
      evidenceInputSnapshotId: TRUST_IDS.reevaluationInputSnapshotId,
      idempotencyKey: 'operator-dossier-current-insufficient',
      reason: 'Current governed input no longer contains qualifying Evidence.',
    }));

    const dossier = await readOperatorCandidateReviewDossier(
      pool,
      CANDIDATE_IDS.candidateRevisionId,
    );

    assert.ok(dossier);
    assert.equal(
      dossier.claims[0]?.decision?.decisionId,
      TRUST_IDS.reevaluationDecisionId,
    );
    assert.deepEqual(dossier.claims[0]?.decision?.evidence, []);
    const history = await pool.query<{ claim_evidence_decision_id: string }>(
      `select claim_evidence_decision_id
         from claim_evidence_decisions
        where claim_id = $1
        order by decision_sequence`,
      [TRUST_IDS.requiredClaimId],
    );
    assert.deepEqual(
      history.rows.map(({ claim_evidence_decision_id: id }) => id),
      [TRUST_IDS.evidenceDecisionId, TRUST_IDS.reevaluationDecisionId],
    );
  } finally {
    await pool.end();
  }
});

test('PostgreSQL dossier disappears after active-policy quorum is satisfied', {
  skip: process.env.TEST_DATABASE_URL === undefined,
}, async () => {
  const pool = await resetDatabase();
  try {
    await seedActivatedGateContext(pool);
    await completeHumanReview(pool, humanReviewCommand());
    const inProgress = await readOperatorCandidateReviewDossier(
      pool,
      CANDIDATE_IDS.candidateRevisionId,
    );
    assert.deepEqual(inProgress?.review, {
      state: 'in_progress',
      confirmedCount: 1,
      requiredCount: 2,
    });

    await seedSatisfiedReviewQuorum(pool);
    assert.equal(
      await readOperatorCandidateReviewDossier(
        pool,
        CANDIDATE_IDS.candidateRevisionId,
      ),
      null,
    );
  } finally {
    await pool.end();
  }
});

test('PostgreSQL dossier serves only the latest revision in the active catalog', {
  skip: process.env.TEST_DATABASE_URL === undefined,
}, async () => {
  const pool = await resetDatabase();
  try {
    await seedActivatedGateContext(pool);
    await activateSecondCatalogAndSealLatestRevision(pool);

    assert.equal(
      await readOperatorCandidateReviewDossier(
        pool,
        CANDIDATE_IDS.candidateRevisionId,
      ),
      null,
    );
    const current = await readOperatorCandidateReviewDossier(
      pool,
      DATABASE_IDS.secondCandidateRevision,
    );
    assert.ok(current);
    assert.equal(current.candidate.revision, 2);
    assert.equal(
      current.candidate.catalogRevisionId,
      DATABASE_IDS.secondCatalogRevision,
    );
    assert.deepEqual(
      current.claims.map(({ claimId }) => claimId),
      [DATABASE_IDS.secondClaim],
    );
  } finally {
    await pool.end();
  }
});

test('PostgreSQL dossier ignores quorum completed under a historical policy', {
  skip: process.env.TEST_DATABASE_URL === undefined,
}, async () => {
  const pool = await resetDatabase();
  try {
    await seedActivatedGateContext(pool);
    await seedSatisfiedReviewQuorum(pool);
    await activateReviewPolicyV2(pool);

    const dossier = await readOperatorCandidateReviewDossier(
      pool,
      CANDIDATE_IDS.candidateRevisionId,
    );

    assert.ok(dossier);
    assert.equal(
      dossier.activeReviewPolicyRevisionId,
      DATABASE_IDS.reviewPolicyV2,
    );
    assert.deepEqual(dossier.review, {
      state: 'unreviewed',
      confirmedCount: 0,
      requiredCount: 2,
    });
  } finally {
    await pool.end();
  }
});
