import type { Pool } from 'pg';

import { registerNormalizedObservation } from '../../src/modules/candidate/register-normalized-observation.js';
import type { DefineCandidateClaimSetCommand } from '../../src/modules/trust/define-candidate-claim-set.js';
import { defineCandidateClaimSet } from '../../src/modules/trust/define-candidate-claim-set.js';
import type { RecordClaimEvidenceDecisionCommand } from '../../src/modules/trust/record-claim-evidence-decision.js';
import { registerTrustPolicyRevision } from '../../src/modules/trust/register-trust-policy-revision.js';
import type { CandidateClaimInput } from '../../src/modules/trust/types.js';
import {
  CANDIDATE_IDS,
  registrationCommand,
  seedRawObservation,
} from './candidate.js';
import { seedActiveCatalog } from './catalog.js';

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
