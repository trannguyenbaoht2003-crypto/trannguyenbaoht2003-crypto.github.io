import type { Pool } from 'pg';

import type {
  RegisterNormalizedObservationCommand,
} from '../../src/modules/candidate/register-normalized-observation.js';
import type {
  CandidateOrigin,
  ObservationNormalizationSnapshotV1,
} from '../../src/modules/candidate/types.js';

export const CANDIDATE_IDS = {
  candidateId: '62000000-0000-4000-8000-000000000001',
  candidateRevisionId: '62000000-0000-4000-8000-000000000002',
  normalizedObservationId: '62000000-0000-4000-8000-000000000003',
  provenanceId: '62000000-0000-4000-8000-000000000004',
  rawObservationId: '62000000-0000-4000-8000-000000000005',
} as const;

const CANDIDATE_SOURCE_IDS = {
  sourceId: '63000000-0000-4000-8000-000000000001',
  sourcePolicyRevisionId: '63000000-0000-4000-8000-000000000002',
} as const;

export function validNormalizationSnapshot(
  origin: CandidateOrigin = 'collector_detected',
): ObservationNormalizationSnapshotV1 {
  return {
    schemaVersion: 1,
    patchKey: '26.15',
    gameModeExternalId: 'aram_mayhem',
    origin,
    subjectExternalId: 'samira',
    augmentExternalIds: ['1194'],
    itemExternalIds: ['6672', '3006'],
  };
}

export async function seedRawObservation(
  pool: Pool,
  rawObservationId: string = CANDIDATE_IDS.rawObservationId,
  aggregateMetadata: Record<string, unknown> | null = null,
): Promise<void> {
  await pool.query(
    `insert into sources (source_id, source_key, display_name)
     values ($1, 'candidate-test-source', 'Candidate test source')
     on conflict (source_id) do nothing`,
    [CANDIDATE_SOURCE_IDS.sourceId],
  );
  await pool.query(
    `insert into source_policy_revisions
      (source_policy_revision_id, source_id, revision, storage_permission,
       collector_enabled, reason, created_by)
     values ($1, $2, 1, 'aggregate_only', true,
             'candidate test aggregate', 'candidate-test')
     on conflict (source_policy_revision_id) do nothing`,
    [
      CANDIDATE_SOURCE_IDS.sourcePolicyRevisionId,
      CANDIDATE_SOURCE_IDS.sourceId,
    ],
  );
  await pool.query(
    `insert into raw_observations
      (raw_observation_id, source_id, source_policy_revision_id,
       adapter_version, aggregate_metadata, content_hash, collected_at)
     values ($1, $2, $3, 'candidate-test-v1', $4::jsonb, $5,
             clock_timestamp())`,
    [
      rawObservationId,
      CANDIDATE_SOURCE_IDS.sourceId,
      CANDIDATE_SOURCE_IDS.sourcePolicyRevisionId,
      aggregateMetadata === null ? null : JSON.stringify(aggregateMetadata),
      `candidate-content-${rawObservationId}`,
    ],
  );
}

export function registrationCommand(
  overrides: Partial<RegisterNormalizedObservationCommand> = {},
): RegisterNormalizedObservationCommand {
  return {
    actorId: 'candidate-normalizer',
    candidateId: CANDIDATE_IDS.candidateId,
    candidateRevisionId: CANDIDATE_IDS.candidateRevisionId,
    correlationId: 'candidate-correlation',
    normalizedObservationId: CANDIDATE_IDS.normalizedObservationId,
    provenanceId: CANDIDATE_IDS.provenanceId,
    rawObservationId: CANDIDATE_IDS.rawObservationId,
    snapshot: validNormalizationSnapshot(),
    ...overrides,
  };
}
