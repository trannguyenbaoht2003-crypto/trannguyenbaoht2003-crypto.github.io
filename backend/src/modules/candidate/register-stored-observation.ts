import { randomUUID } from 'node:crypto';

import type { PoolClient } from 'pg';

import type {
  NormalizationSourceContext,
} from '../../queue/normalization-worker.js';
import {
  normalizeObservationAggregateMetadata,
} from './normalize-observation.js';
import {
  registerNormalizedObservationInTransaction,
  type RegisterNormalizedObservationResult,
} from './register-normalized-observation.js';

interface StoredObservationRow {
  aggregate_metadata: unknown;
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
  if (aggregateMetadata === null || aggregateMetadata === undefined) {
    throw new Error('NORMALIZATION_SNAPSHOT_UNAVAILABLE');
  }
  const normalizedMetadata = normalizeObservationAggregateMetadata(
    aggregateMetadata,
  );

  return registerNormalizedObservationInTransaction(client, {
    actorId: 'normalization-worker',
    candidateId: randomUUID(),
    candidateRevisionId: randomUUID(),
    correlationId: source.correlationId,
    normalizedObservationId: randomUUID(),
    provenanceId: randomUUID(),
    rawObservationId: source.observationId,
    snapshot: normalizedMetadata.normalizationSnapshot,
  });
}
