import type { Pool } from 'pg';

import { activateCatalogRevision } from '../modules/catalog/activate-catalog-revision.js';
import { importCatalogRevision } from '../modules/catalog/import-catalog-revision.js';
import type { CatalogSnapshotV1 } from '../modules/catalog/types.js';
import { validateCatalogRevision } from '../modules/catalog/validate-catalog-revision.js';
import { registerNormalizedObservation } from '../modules/candidate/register-normalized-observation.js';
import type { ObservationNormalizationSnapshotV1 } from '../modules/candidate/types.js';
import { ingestObservation } from '../modules/collector/ingest-observation.js';
import { activateEligibilityPolicyRevision } from '../modules/eligibility/activate-eligibility-policy-revision.js';
import { evaluateCandidateEligibility } from '../modules/eligibility/evaluate-candidate-eligibility.js';
import { registerEligibilityPolicyRevision } from '../modules/eligibility/register-eligibility-policy-revision.js';
import { recordCandidateModerationDecision } from '../modules/moderation/record-candidate-moderation-decision.js';
import { registerModerationPolicyRevision } from '../modules/moderation/register-moderation-policy-revision.js';
import { registerPatchEvent } from '../modules/patch/register-patch-event.js';
import { publishCandidateRevision } from '../modules/publication/publish-candidate-revision.js';
import { readActivePublicationById } from '../modules/publication/read-active-publications.js';
import { activateSourcePolicy } from '../modules/source-policy/activate-source-policy.js';
import { completeHumanReview } from '../modules/trust/complete-human-review.js';
import { defineCandidateClaimSet } from '../modules/trust/define-candidate-claim-set.js';
import { recordClaimEvidenceDecision } from '../modules/trust/record-claim-evidence-decision.js';
import { registerTrustPolicyRevision } from '../modules/trust/register-trust-policy-revision.js';

const IDS = {
  sourceId: '8d000000-0000-4000-8000-000000000001',
  sourcePolicyRevisionId: '8d000000-0000-4000-8000-000000000002',
  patchId: '8d000000-0000-4000-8000-000000000003',
  patchEventId: '8d000000-0000-4000-8000-000000000004',
  catalogRevisionId: '8d000000-0000-4000-8000-000000000005',
  catalogValidationResultId: '8d000000-0000-4000-8000-000000000006',
  rawObservationId: '8d000000-0000-4000-8000-000000000007',
  normalizedObservationId: '8d000000-0000-4000-8000-000000000008',
  candidateId: '8d000000-0000-4000-8000-000000000009',
  candidateRevisionId: '8d000000-0000-4000-8000-000000000010',
  provenanceId: '8d000000-0000-4000-8000-000000000011',
  requiredClaimId: '8d000000-0000-4000-8000-000000000012',
  evidencePolicyRevisionId: '8d000000-0000-4000-8000-000000000013',
  evidenceId: '8d000000-0000-4000-8000-000000000014',
  evidenceAssociationId: '8d000000-0000-4000-8000-000000000015',
  evidenceInputSnapshotId: '8d000000-0000-4000-8000-000000000016',
  evidenceDecisionId: '8d000000-0000-4000-8000-000000000017',
  reviewPolicyRevisionId: '8d000000-0000-4000-8000-000000000018',
  reviewInputSnapshotIdA: '8d000000-0000-4000-8000-000000000019',
  humanReviewIdA: '8d000000-0000-4000-8000-000000000020',
  reviewQuorumEvaluationIdA: '8d000000-0000-4000-8000-000000000021',
  reviewInputSnapshotIdB: '8d000000-0000-4000-8000-000000000022',
  humanReviewIdB: '8d000000-0000-4000-8000-000000000023',
  reviewQuorumEvaluationIdB: '8d000000-0000-4000-8000-000000000024',
  moderationPolicyRevisionId: '8d000000-0000-4000-8000-000000000025',
  moderationInputSnapshotId: '8d000000-0000-4000-8000-000000000026',
  moderationDecisionId: '8d000000-0000-4000-8000-000000000027',
  eligibilityPolicyRevisionId: '8d000000-0000-4000-8000-000000000028',
  eligibilityInputSnapshotId: '8d000000-0000-4000-8000-000000000029',
  eligibilityEvaluationId: '8d000000-0000-4000-8000-000000000030',
  publicationId: '8d000000-0000-4000-8000-000000000031',
  publicationVersionIdV1: '8d000000-0000-4000-8000-000000000032',
  publicationActivationIdV1: '8d000000-0000-4000-8000-000000000033',
  publicationAuditIdV1: '8d000000-0000-4000-8000-000000000034',
  publicationOutboxEventIdV1: '8d000000-0000-4000-8000-000000000035',
} as const;

const NORMALIZATION_SNAPSHOT: ObservationNormalizationSnapshotV1 = {
  schemaVersion: 1,
  patchKey: '26.15',
  gameModeExternalId: 'aram_mayhem',
  origin: 'editorial',
  subjectExternalId: 'samira',
  augmentExternalIds: ['1194'],
  itemExternalIds: ['3006', '6672'],
};

export interface ReleaseRehearsalState {
  publicationId: string;
  activePublicationVersionId: string;
  activeVersionNumber: number;
  championExternalId: string;
  augmentExternalIds: readonly string[];
  itemExternalIds: readonly string[];
}

export function assertReleaseRehearsalEnabled(
  env: NodeJS.ProcessEnv,
): void {
  if (env.STAGING_REHEARSAL_ENABLED !== '1') {
    throw new Error('RELEASE_REHEARSAL_DISABLED');
  }
}

function catalogSnapshot(): CatalogSnapshotV1 {
  return {
    schemaVersion: 1,
    patchKey: '26.15',
    gameModeExternalId: 'aram_mayhem',
    source: {
      adapterVersion: 'release-rehearsal-v1',
      sourceDigest: 'd'.repeat(64),
    },
    entities: [
      { entityType: 'mode', externalId: 'aram_mayhem', displayName: 'ARAM: Mayhem', active: true, attributes: {} },
      { entityType: 'champion', externalId: 'samira', displayName: 'Samira', active: true, attributes: {} },
      { entityType: 'augment', externalId: '1194', displayName: 'Ma Pháp Mê Hoặc', active: true, attributes: {} },
      { entityType: 'item', externalId: '3006', displayName: 'Giày Cuồng Nộ', active: true, attributes: {} },
      { entityType: 'item', externalId: '6672', displayName: 'Nỏ Tử Thủ', active: true, attributes: {} },
    ],
    rules: [
      {
        ruleKey: 'aram-augment-limit',
        constraintType: 'limit',
        definition: {
          modeExternalId: 'aram_mayhem',
          entityType: 'augment',
          maxSelections: 3,
        },
      },
    ],
  };
}

async function createSource(pool: Pool): Promise<void> {
  await pool.query(
    `insert into sources (source_id, source_key, display_name)
     values ($1, 'release-rehearsal', 'Release rehearsal')`,
    [IDS.sourceId],
  );
  await activateSourcePolicy(pool, {
    actorId: 'release-rehearsal',
    collectorEnabled: true,
    correlationId: 'release-rehearsal-source-policy',
    reason: 'Staging-only release rehearsal source.',
    revision: 1,
    revisionId: IDS.sourcePolicyRevisionId,
    sourceId: IDS.sourceId,
    storagePermission: 'aggregate_only',
  });
}

async function createActiveCatalog(pool: Pool): Promise<void> {
  await registerPatchEvent(pool, {
    actorId: 'release-rehearsal',
    correlationId: 'release-rehearsal-patch',
    displayLabel: '26.15',
    eventId: IDS.patchEventId,
    lifecycleState: 'active',
    occurredAt: new Date('2026-08-12T00:00:00.000Z'),
    patchId: IDS.patchId,
    patchKey: '26.15',
    reason: 'Staging release rehearsal patch.',
  });
  await importCatalogRevision(pool, {
    actorId: 'release-rehearsal',
    catalogRevisionId: IDS.catalogRevisionId,
    correlationId: 'release-rehearsal-catalog-import',
    idempotencyKey: 'release-rehearsal-catalog-import',
    patchId: IDS.patchId,
    revision: 1,
    sourceId: IDS.sourceId,
    sourcePolicyRevisionId: IDS.sourcePolicyRevisionId,
    snapshot: catalogSnapshot(),
  });
  const validation = await validateCatalogRevision(pool, {
    actorId: 'release-rehearsal-validator',
    catalogRevisionId: IDS.catalogRevisionId,
    catalogValidationResultId: IDS.catalogValidationResultId,
    correlationId: 'release-rehearsal-catalog-validation',
    reason: 'Validate staging release rehearsal catalog.',
    validatorRulesetVersion: 'catalog-rules-v1',
  });
  if (validation.result !== 'passed') {
    throw new Error('RELEASE_REHEARSAL_CATALOG_INVALID');
  }
  await activateCatalogRevision(pool, {
    actorId: 'release-rehearsal',
    catalogRevisionId: IDS.catalogRevisionId,
    correlationId: 'release-rehearsal-catalog-activation',
    expectedCurrentCatalogRevisionId: null,
    patchId: IDS.patchId,
    reason: 'Activate staging release rehearsal catalog.',
  });
}

async function createCandidate(pool: Pool): Promise<void> {
  await ingestObservation(pool, {
    actorId: 'release-rehearsal-collector',
    adapterVersion: 'release-rehearsal-v1',
    aggregateMetadata: { normalizationSnapshot: NORMALIZATION_SNAPSHOT },
    collectedAt: new Date('2026-08-12T00:05:00.000Z'),
    correlationId: 'release-rehearsal-observation',
    idempotencyKey: 'release-rehearsal-observation',
    observationId: IDS.rawObservationId,
    sourceId: IDS.sourceId,
  });
  await registerNormalizedObservation(pool, {
    actorId: 'release-rehearsal-normalizer',
    candidateId: IDS.candidateId,
    candidateRevisionId: IDS.candidateRevisionId,
    correlationId: 'release-rehearsal-normalization',
    normalizedObservationId: IDS.normalizedObservationId,
    provenanceId: IDS.provenanceId,
    rawObservationId: IDS.rawObservationId,
    snapshot: NORMALIZATION_SNAPSHOT,
  });
}

async function createTrustAuthority(pool: Pool): Promise<void> {
  await defineCandidateClaimSet(pool, {
    actorId: 'release-rehearsal-claim-editor',
    candidateId: IDS.candidateId,
    candidateRevisionId: IDS.candidateRevisionId,
    claims: [
      {
        claimId: IDS.requiredClaimId,
        claimKey: 'build-core',
        claimType: 'build_effectiveness',
        importance: 'required',
        statement: 'The selected build is valid for the staging rehearsal.',
      },
    ],
    correlationId: 'release-rehearsal-claim-set',
    idempotencyKey: 'release-rehearsal-claim-set',
  });
  await registerTrustPolicyRevision(pool, {
    actorId: 'release-rehearsal-trust-operator',
    correlationId: 'release-rehearsal-evidence-policy',
    idempotencyKey: 'release-rehearsal-evidence-policy',
    policyKey: 'release-rehearsal-evidence-v1',
    policyKind: 'evidence',
    policyRevisionId: IDS.evidencePolicyRevisionId,
    reason: 'Release rehearsal Evidence policy.',
    revision: 1,
    schemaVersion: 1,
  });
  await registerTrustPolicyRevision(pool, {
    actorId: 'release-rehearsal-trust-operator',
    appliesToAiProvenance: true,
    correlationId: 'release-rehearsal-review-policy',
    idempotencyKey: 'release-rehearsal-review-policy',
    minimumConfirmedReviews: 2,
    policyKey: 'release-rehearsal-review-v1',
    policyKind: 'human_review',
    policyRevisionId: IDS.reviewPolicyRevisionId,
    reason: 'Release rehearsal Human Review policy.',
    requireDistinctReviewers: true,
    requiredPermission: 'reviewer',
    revision: 1,
  });
  await recordClaimEvidenceDecision(pool, {
    actorId: 'release-rehearsal-evidence-evaluator',
    associations: [
      {
        associationId: IDS.evidenceAssociationId,
        crossPatchRevalidated: false,
        evidenceId: IDS.evidenceId,
        normalizedObservationId: IDS.normalizedObservationId,
        revalidationReason: null,
        stance: 'supports',
      },
    ],
    candidateId: IDS.candidateId,
    candidateRevisionId: IDS.candidateRevisionId,
    claimId: IDS.requiredClaimId,
    correlationId: 'release-rehearsal-evidence-decision',
    decision: 'supported',
    decisionId: IDS.evidenceDecisionId,
    evaluatedAt: '2026-08-12T00:10:00.000Z',
    evidenceInputSnapshotId: IDS.evidenceInputSnapshotId,
    evidencePolicyRevisionId: IDS.evidencePolicyRevisionId,
    idempotencyKey: 'release-rehearsal-evidence-decision',
    reason: 'The governed staging observation supports the required claim.',
  });
  await completeHumanReview(pool, {
    actorId: 'release-rehearsal-reviewer-a',
    candidateId: IDS.candidateId,
    candidateRevisionId: IDS.candidateRevisionId,
    completedAt: '2026-08-12T00:15:00.000Z',
    correlationId: 'release-rehearsal-review-a',
    humanReviewId: IDS.humanReviewIdA,
    idempotencyKey: 'release-rehearsal-review-a',
    outcome: 'confirmed',
    permissionUsed: 'reviewer',
    reason: 'Reviewer A confirmed the release rehearsal authority.',
    reviewInputSnapshotId: IDS.reviewInputSnapshotIdA,
    reviewPolicyRevisionId: IDS.reviewPolicyRevisionId,
    reviewQuorumEvaluationId: IDS.reviewQuorumEvaluationIdA,
  });
  await completeHumanReview(pool, {
    actorId: 'release-rehearsal-reviewer-b',
    candidateId: IDS.candidateId,
    candidateRevisionId: IDS.candidateRevisionId,
    completedAt: '2026-08-12T00:16:00.000Z',
    correlationId: 'release-rehearsal-review-b',
    humanReviewId: IDS.humanReviewIdB,
    idempotencyKey: 'release-rehearsal-review-b',
    outcome: 'confirmed',
    permissionUsed: 'reviewer',
    reason: 'Reviewer B confirmed the release rehearsal authority.',
    reviewInputSnapshotId: IDS.reviewInputSnapshotIdB,
    reviewPolicyRevisionId: IDS.reviewPolicyRevisionId,
    reviewQuorumEvaluationId: IDS.reviewQuorumEvaluationIdB,
  });
}

async function createGateAuthority(pool: Pool): Promise<void> {
  await registerModerationPolicyRevision(pool, {
    actorId: 'release-rehearsal-policy-operator',
    correlationId: 'release-rehearsal-moderation-policy',
    idempotencyKey: 'release-rehearsal-moderation-policy',
    moderationPolicyRevisionId: IDS.moderationPolicyRevisionId,
    policyKey: 'release-rehearsal-moderation-v1',
    reason: 'Release rehearsal Moderation policy.',
    revision: 1,
    schemaVersion: 1,
  });
  await registerEligibilityPolicyRevision(pool, {
    actorId: 'release-rehearsal-policy-operator',
    correlationId: 'release-rehearsal-eligibility-policy',
    eligibilityPolicyRevisionId: IDS.eligibilityPolicyRevisionId,
    evidencePolicyRevisionId: IDS.evidencePolicyRevisionId,
    idempotencyKey: 'release-rehearsal-eligibility-policy',
    moderationPolicyRevisionId: IDS.moderationPolicyRevisionId,
    policyKey: 'release-rehearsal-eligibility-v1',
    reason: 'Release rehearsal Eligibility policy.',
    reviewPolicyRevisionId: IDS.reviewPolicyRevisionId,
    revision: 1,
    schemaVersion: 1,
  });
  await activateEligibilityPolicyRevision(pool, {
    actorId: 'release-rehearsal-policy-operator',
    correlationId: 'release-rehearsal-eligibility-activation',
    eligibilityPolicyRevisionId: IDS.eligibilityPolicyRevisionId,
    expectedCurrentEligibilityPolicyRevisionId: null,
    idempotencyKey: 'release-rehearsal-eligibility-activation',
    reason: 'Activate release rehearsal Eligibility policy.',
  });
  await recordCandidateModerationDecision(pool, {
    actorId: 'release-rehearsal-moderator',
    candidateId: IDS.candidateId,
    candidateRevisionId: IDS.candidateRevisionId,
    correlationId: 'release-rehearsal-moderation-decision',
    decisionId: IDS.moderationDecisionId,
    evaluatedAt: '2026-08-12T00:20:00.000Z',
    idempotencyKey: 'release-rehearsal-moderation-decision',
    inputSnapshotId: IDS.moderationInputSnapshotId,
    moderationPolicyRevisionId: IDS.moderationPolicyRevisionId,
    outcome: 'clear',
    reason: 'Release rehearsal CandidateRevision passed Moderation.',
  });
  const eligibility = await evaluateCandidateEligibility(pool, {
    actorId: 'release-rehearsal-eligibility-evaluator',
    candidateId: IDS.candidateId,
    candidateRevisionId: IDS.candidateRevisionId,
    correlationId: 'release-rehearsal-eligibility-evaluation',
    evaluatedAt: '2026-08-12T00:25:00.000Z',
    evaluationId: IDS.eligibilityEvaluationId,
    idempotencyKey: 'release-rehearsal-eligibility-evaluation',
    inputSnapshotId: IDS.eligibilityInputSnapshotId,
  });
  if (eligibility.outcome !== 'eligible') {
    throw new Error('RELEASE_REHEARSAL_NOT_ELIGIBLE');
  }
}

export async function verifyReleaseRehearsal(
  pool: Pool,
): Promise<ReleaseRehearsalState> {
  const active = await readActivePublicationById(pool, IDS.publicationId);
  if (!active) throw new Error('RELEASE_REHEARSAL_PUBLICATION_MISSING');
  return {
    publicationId: active.publicationId,
    activePublicationVersionId: active.publicationVersionId,
    activeVersionNumber: active.versionNumber,
    championExternalId: active.payload.championExternalId,
    augmentExternalIds: [...active.payload.augmentExternalIds],
    itemExternalIds: [...active.payload.itemExternalIds],
  };
}

export async function seedReleaseRehearsalV1(
  pool: Pool,
): Promise<ReleaseRehearsalState> {
  await createSource(pool);
  await createActiveCatalog(pool);
  await createCandidate(pool);
  await createTrustAuthority(pool);
  await createGateAuthority(pool);
  await publishCandidateRevision(pool, {
    publicationId: IDS.publicationId,
    publicationVersionId: IDS.publicationVersionIdV1,
    activationId: IDS.publicationActivationIdV1,
    candidateRevisionId: IDS.candidateRevisionId,
    expectedActiveEligibilityPolicyRevisionId: IDS.eligibilityPolicyRevisionId,
    expectedEligibilityEvaluationId: IDS.eligibilityEvaluationId,
    expectedModerationDecisionId: IDS.moderationDecisionId,
    expectedActivePublicationVersionId: null,
    authorization: { actorId: 'release-rehearsal-publisher', permissions: ['publisher'] },
    auditId: IDS.publicationAuditIdV1,
    outboxEventId: IDS.publicationOutboxEventIdV1,
    correlationId: 'release-rehearsal-publish-v1',
    idempotencyKey: 'release-rehearsal-publish-v1',
    occurredAt: '2026-08-12T00:30:00.000Z',
  });
  return verifyReleaseRehearsal(pool);
}
