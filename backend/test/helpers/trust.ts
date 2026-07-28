import type { Pool } from 'pg';

import { registerNormalizedObservation } from '../../src/modules/candidate/register-normalized-observation.js';
import type { DefineCandidateClaimSetCommand } from '../../src/modules/trust/define-candidate-claim-set.js';
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
