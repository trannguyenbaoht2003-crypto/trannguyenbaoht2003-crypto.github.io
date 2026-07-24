import { randomUUID } from 'node:crypto';

import type { PoolClient } from 'pg';

import type {
  NormalizationSourceContext,
} from '../../queue/normalization-worker.js';
import {
  registerNormalizedObservationInTransaction,
  type RegisterNormalizedObservationResult,
} from './register-normalized-observation.js';

interface StoredObservationRow {
  aggregate_metadata: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export async function registerStoredObservationInTransaction(
  client: PoolClient,
  source: NormalizationSourceContext,
): Promise<RegisterNormalizedObservationResult> {
  const result = await client.query<StoredObservationRow>(
    `select aggregate_metadata
       from raw_observations
      where raw_observation_id = $1`,
    [source.observationId],
  );
  const aggregateMetadata = result.rows[0]?.aggregate_metadata;
  if (
    !isRecord(aggregateMetadata)
    || !Object.hasOwn(aggregateMetadata, 'normalizationSnapshot')
  ) {
    throw new Error('NORMALIZATION_SNAPSHOT_UNAVAILABLE');
  }

  return registerNormalizedObservationInTransaction(client, {
    actorId: 'normalization-worker',
    candidateId: randomUUID(),
    candidateRevisionId: randomUUID(),
    correlationId: source.correlationId,
    normalizedObservationId: randomUUID(),
    provenanceId: randomUUID(),
    rawObservationId: source.observationId,
    snapshot: aggregateMetadata.normalizationSnapshot,
  });
}
