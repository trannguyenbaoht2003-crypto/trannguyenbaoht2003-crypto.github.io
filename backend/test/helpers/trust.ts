import type { Pool } from 'pg';

import { activateCatalogRevision } from '../../src/modules/catalog/activate-catalog-revision.js';
import { importCatalogRevision } from '../../src/modules/catalog/import-catalog-revision.js';
import { validateCatalogRevision } from '../../src/modules/catalog/validate-catalog-revision.js';
import { registerNormalizedObservation } from '../../src/modules/candidate/register-normalized-observation.js';
import { registerPatchEvent } from '../../src/modules/patch/register-patch-event.js';
import type { DefineCandidateClaimSetCommand } from '../../src/modules/trust/define-candidate-claim-set.js';
import { defineCandidateClaimSet } from '../../src/modules/trust/define-candidate-claim-set.js';
import type { CompleteHumanReviewCommand } from '../../src/modules/trust/complete-human-review.js';
import type { RecordClaimEvidenceDecisionCommand } from '../../src/modules/trust/record-claim-evidence-decision.js';
import { recordClaimEvidenceDecision } from '../../src/modules/trust/record-claim-evidence-decision.js';
import { registerTrustPolicyRevision } from '../../src/modules/trust/register-trust-policy-revision.js';
import type { CandidateClaimInput } from '../../src/modules/trust/types.js';
import {
  CANDIDATE_IDS,
  registrationCommand,
  seedRawObservation,
} from './candidate.js';
import {
  CATALOG_IDS,
  seedActiveCatalog,
  validCatalogSnapshot,
} from './catalog.js';

export const TRUST_IDS = {
  requiredClaimId: '73000000-0000-4000-8000-000000000001',
  supportingClaimId: '73000000-0000-4000-8000-000000000002',
  secondCandidateId: '73000000-0000-4000-8000-000000000003',
  secondCandidateRevisionId: '73000000-0000-4000-8000-000000000004',
  secondNormalizedObservationId: '73000000-0000-4000-8000-000000000005',
  secondProvenanceId: '73000000-0000-4000-8000-000000000006',
  secondRawObservationId: '73000000-0000-4000-8000-000000000007',
  evidencePolicyId: '73000000-0000-4000-8000-000000000008',
  evidenceId: '73000000-0000-4000-8000-000000000009',
  evidenceAssociationId: '73000000-0000-4000-8000-000000000010',
  evidenceInputSnapshotId: '73000000-0000-4000-8000-000000000011',
  evidenceDecisionId: '73000000-0000-4000-8000-000000000012',
  secondEvidenceAssociationId: '73000000-0000-4000-8000-000000000013',
  secondEvidenceInputSnapshotId: '73000000-0000-4000-8000-000000000014',
  secondEvidenceDecisionId: '73000000-0000-4000-8000-000000000015',
  reevaluationInputSnapshotId: '73000000-0000-4000-8000-000000000016',
  reevaluationDecisionId: '73000000-0000-4000-8000-000000000017',
  alternateEvidenceId: '73000000-0000-4000-8000-000000000018',
  alternateAssociationId: '73000000-0000-4000-8000-000000000019',
  reviewPolicyId: '73000000-0000-4000-8000-000000000020',
  reviewInputSnapshotId: '73000000-0000-4000-8000-000000000021',
  humanReviewId: '73000000-0000-4000-8000-000000000022',
  reviewQuorumEvaluationId: '73000000-0000-4000-8000-000000000023',
  secondReviewInputSnapshotId: '73000000-0000-4000-8000-000000000024',
  secondHumanReviewId: '73000000-0000-4000-8000-000000000025',
  secondReviewQuorumEvaluationId:
    '73000000-0000-4000-8000-000000000026',
} as const;

export const CROSS_PATCH_IDS = {
  patchId: '74000000-0000-4000-8000-000000000001',
  patchEventId: '74000000-0000-4000-8000-000000000002',
  catalogRevisionId: '74000000-0000-4000-8000-000000000003',
  catalogValidationResultId: '74000000-0000-4000-8000-000000000004',
  rawObservationId: '74000000-0000-4000-8000-000000000005',
  normalizedObservationId: '74000000-0000-4000-8000-000000000006',
  candidateId: '74000000-0000-4000-8000-000000000007',
  candidateRevisionId: '74000000-0000-4000-8000-000000000008',
  provenanceId: '74000000-0000-4000-8000-000000000009',
  claimId: '74000000-0000-4000-8000-000000000010',
  associationId: '74000000-0000-4000-8000-000000000011',
  inputSnapshotId: '74000000-0000-4000-8000-000000000012',
  decisionId: '74000000-0000-4000-8000-000000000013',
} as const;

export function requiredClaim(
  overrides: Partial<CandidateClaimInput> = {},
): CandidateClaimInput {
  return {
    claimId: TRUST_IDS.requiredClaimId,
    claimKey: 'build-core',
    claimType: 'build_effectiveness',
    importance: 'required',
    statement: 'The selected build is effective for this patch.',
    ...overrides,
  };
}

export function supportingClaim(
  overrides: Partial<CandidateClaimInput> = {},
): CandidateClaimInput {
  return {
    claimId: TRUST_IDS.supportingClaimId,
    claimKey: 'context-note',
    claimType: 'playstyle_hypothesis',
    importance: 'supporting',
    statement: 'The selection favors aggressive resets.',
    ...overrides,
  };
}

export function claimSetCommand(
  overrides: Partial<DefineCandidateClaimSetCommand> = {},
): DefineCandidateClaimSetCommand {
  return {
    actorId: 'claim-editor',
    candidateId: CANDIDATE_IDS.candidateId,
    candidateRevisionId: CANDIDATE_IDS.candidateRevisionId,
    claims: [requiredClaim(), supportingClaim()],
    correlationId: 'candidate-claim-set-1',
    idempotencyKey: 'candidate-claim-set-1',
    ...overrides,
  };
}

export async function seedTrustCandidate(pool: Pool): Promise<void> {
  await seedActiveCatalog(pool);
  await seedRawObservation(pool);
  await registerNormalizedObservation(pool, registrationCommand());
}

export async function seedSecondTrustCandidate(pool: Pool): Promise<void> {
  await seedRawObservation(pool, TRUST_IDS.secondRawObservationId);
  await registerNormalizedObservation(pool, registrationCommand({
    candidateId: TRUST_IDS.secondCandidateId,
    candidateRevisionId: TRUST_IDS.secondCandidateRevisionId,
    normalizedObservationId: TRUST_IDS.secondNormalizedObservationId,
    provenanceId: TRUST_IDS.secondProvenanceId,
    rawObservationId: TRUST_IDS.secondRawObservationId,
    snapshot: {
      schemaVersion: 1,
      patchKey: '26.15',
      gameModeExternalId: 'aram_mayhem',
      origin: 'editorial',
      subjectExternalId: 'samira',
      augmentExternalIds: ['1194'],
      itemExternalIds: ['3006'],
    },
  }));
}

export async function seedTrustClaimSet(pool: Pool): Promise<void> {
  await seedTrustCandidate(pool);
  await defineCandidateClaimSet(pool, claimSetCommand());
  await registerTrustPolicyRevision(pool, {
    actorId: 'trust-operator',
    correlationId: 'trust-evidence-policy',
    idempotencyKey: 'trust-evidence-policy',
    policyKey: 'evidence-v3',
    policyKind: 'evidence',
    policyRevisionId: TRUST_IDS.evidencePolicyId,
    reason: 'Claim-level Evidence v3 structural policy',
    revision: 1,
    schemaVersion: 1,
  });
}

export function evidenceDecisionCommand(
  overrides: Partial<RecordClaimEvidenceDecisionCommand> = {},
): RecordClaimEvidenceDecisionCommand {
  return {
    actorId: 'evidence-evaluator',
    associations: [
      {
        associationId: TRUST_IDS.evidenceAssociationId,
        crossPatchRevalidated: false,
        evidenceId: TRUST_IDS.evidenceId,
        normalizedObservationId: CANDIDATE_IDS.normalizedObservationId,
        revalidationReason: null,
        stance: 'supports',
      },
    ],
    candidateId: CANDIDATE_IDS.candidateId,
    candidateRevisionId: CANDIDATE_IDS.candidateRevisionId,
    claimId: TRUST_IDS.requiredClaimId,
    correlationId: 'evidence-decision-1',
    decision: 'supported',
    decisionId: TRUST_IDS.evidenceDecisionId,
    evaluatedAt: '2026-07-28T02:00:00.000Z',
    evidenceInputSnapshotId: TRUST_IDS.evidenceInputSnapshotId,
    evidencePolicyRevisionId: TRUST_IDS.evidencePolicyId,
    idempotencyKey: 'evidence-decision-1',
    reason: 'Authoritative normalized observation supports the Claim.',
    ...overrides,
  };
}

export async function seedTrustReviewContext(
  pool: Pool,
  includeEvidence = true,
): Promise<void> {
  await seedTrustClaimSet(pool);
  await registerTrustPolicyRevision(pool, {
    actorId: 'trust-operator',
    appliesToAiProvenance: true,
    correlationId: 'trust-review-policy',
    idempotencyKey: 'trust-review-policy',
    minimumConfirmedReviews: 2,
    policyKey: 'human-review-v1',
    policyKind: 'human_review',
    policyRevisionId: TRUST_IDS.reviewPolicyId,
    reason: 'Two distinct confirmed reviewers are required.',
    requireDistinctReviewers: true,
    requiredPermission: 'reviewer',
    revision: 1,
  });
  if (includeEvidence) {
    await recordClaimEvidenceDecision(pool, evidenceDecisionCommand());
  }
}

export function humanReviewCommand(
  overrides: Partial<CompleteHumanReviewCommand> = {},
): CompleteHumanReviewCommand {
  return {
    actorId: 'reviewer-a',
    candidateId: CANDIDATE_IDS.candidateId,
    candidateRevisionId: CANDIDATE_IDS.candidateRevisionId,
    completedAt: '2026-07-28T05:00:00.000Z',
    correlationId: 'human-review-1',
    humanReviewId: TRUST_IDS.humanReviewId,
    idempotencyKey: 'human-review-1',
    outcome: 'confirmed',
    permissionUsed: 'reviewer',
    reason: 'Candidate and Claim evidence inputs were checked.',
    reviewInputSnapshotId: TRUST_IDS.reviewInputSnapshotId,
    reviewPolicyRevisionId: TRUST_IDS.reviewPolicyId,
    reviewQuorumEvaluationId: TRUST_IDS.reviewQuorumEvaluationId,
    ...overrides,
  };
}

export async function appendAiProvenance(pool: Pool): Promise<void> {
  await seedRawObservation(pool, TRUST_IDS.secondRawObservationId);
  await registerNormalizedObservation(pool, registrationCommand({
    candidateId: TRUST_IDS.secondCandidateId,
    candidateRevisionId: TRUST_IDS.secondCandidateRevisionId,
    normalizedObservationId: TRUST_IDS.secondNormalizedObservationId,
    provenanceId: TRUST_IDS.secondProvenanceId,
    rawObservationId: TRUST_IDS.secondRawObservationId,
    snapshot: {
      schemaVersion: 1,
      patchKey: '26.15',
      gameModeExternalId: 'aram_mayhem',
      origin: 'ai_generated',
      subjectExternalId: 'samira',
      augmentExternalIds: ['1194'],
      itemExternalIds: ['6672', '3006'],
    },
  }));
}

export async function seedCrossPatchClaimSet(pool: Pool): Promise<void> {
  await registerPatchEvent(pool, {
    actorId: 'cross-patch-operator',
    correlationId: 'cross-patch-event',
    displayLabel: '26.16',
    eventId: CROSS_PATCH_IDS.patchEventId,
    lifecycleState: 'active',
    occurredAt: new Date('2026-07-29T00:00:00.000Z'),
    patchId: CROSS_PATCH_IDS.patchId,
    patchKey: '26.16',
    reason: 'Cross-patch Evidence contract',
  });
  const snapshot = validCatalogSnapshot();
  snapshot.patchKey = '26.16';
  snapshot.source.sourceDigest = 'f'.repeat(64);
  const subject = snapshot.entities.find((entity) => (
    entity.entityType === 'champion'
    && entity.externalId === 'samira'
  ));
  if (!subject) {
    throw new Error('cross-patch subject fixture missing');
  }
  subject.attributes = {
    ...subject.attributes,
    patch: '26.16',
  };
  await importCatalogRevision(pool, {
    actorId: 'cross-patch-catalog',
    catalogRevisionId: CROSS_PATCH_IDS.catalogRevisionId,
    correlationId: 'cross-patch-catalog-import',
    idempotencyKey: 'cross-patch-catalog-import',
    patchId: CROSS_PATCH_IDS.patchId,
    revision: 1,
    sourceId: CATALOG_IDS.sourceId,
    sourcePolicyRevisionId: CATALOG_IDS.sourcePolicyRevisionId,
    snapshot,
  });
  const validation = await validateCatalogRevision(pool, {
    actorId: 'cross-patch-validator',
    catalogRevisionId: CROSS_PATCH_IDS.catalogRevisionId,
    catalogValidationResultId:
      CROSS_PATCH_IDS.catalogValidationResultId,
    correlationId: 'cross-patch-catalog-validation',
    reason: 'Cross-patch catalog validation',
    validatorRulesetVersion: 'catalog-rules-v1',
  });
  if (validation.result !== 'passed') {
    throw new Error('cross-patch catalog fixture invalid');
  }
  await activateCatalogRevision(pool, {
    actorId: 'cross-patch-operator',
    catalogRevisionId: CROSS_PATCH_IDS.catalogRevisionId,
    correlationId: 'cross-patch-catalog-activation',
    expectedCurrentCatalogRevisionId: null,
    patchId: CROSS_PATCH_IDS.patchId,
    reason: 'Cross-patch active catalog',
  });
  await seedRawObservation(pool, CROSS_PATCH_IDS.rawObservationId);
  await registerNormalizedObservation(pool, registrationCommand({
    candidateId: CROSS_PATCH_IDS.candidateId,
    candidateRevisionId: CROSS_PATCH_IDS.candidateRevisionId,
    normalizedObservationId: CROSS_PATCH_IDS.normalizedObservationId,
    provenanceId: CROSS_PATCH_IDS.provenanceId,
    rawObservationId: CROSS_PATCH_IDS.rawObservationId,
    snapshot: {
      schemaVersion: 1,
      patchKey: '26.16',
      gameModeExternalId: 'aram_mayhem',
      origin: 'editorial',
      subjectExternalId: 'samira',
      augmentExternalIds: ['1194'],
      itemExternalIds: ['6672', '3006'],
    },
  }));
  await defineCandidateClaimSet(pool, claimSetCommand({
    candidateId: CROSS_PATCH_IDS.candidateId,
    candidateRevisionId: CROSS_PATCH_IDS.candidateRevisionId,
    claims: [
      requiredClaim({
        claimId: CROSS_PATCH_IDS.claimId,
        claimKey: 'cross-patch-build',
        statement: 'The build is re-evaluated for patch 26.16.',
      }),
    ],
    correlationId: 'cross-patch-claim-set',
    idempotencyKey: 'cross-patch-claim-set',
  }));
}
