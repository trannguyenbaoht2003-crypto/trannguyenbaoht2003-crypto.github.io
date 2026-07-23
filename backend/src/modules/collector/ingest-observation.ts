import { randomUUID } from 'node:crypto';

import type { Pool } from 'pg';

import { withTransaction } from '../../database/transaction.js';
import { hashCanonicalJson } from '../../shared/hash.js';
import type { StoragePermission } from '../source-policy/activate-source-policy.js';

export interface IngestObservationCommand {
  actorId: string;
  adapterVersion: string;
  collectedAt: Date;
  correlationId: string;
  externalReference?: Record<string, unknown>;
  idempotencyKey: string;
  observationId: string;
  rawBlob?: string;
  sourceId: string;
}

export interface IngestObservationResult {
  observationId: string;
  replayed: boolean;
  blobStored: boolean;
}

interface ActivePolicyRow {
  collector_enabled: boolean;
  source_policy_revision_id: string;
  status: string;
  storage_permission: StoragePermission;
}

interface IdempotencyRow {
  payload_hash: string;
  result: IngestObservationResult | null;
  state: string;
}

export async function ingestObservation(
  pool: Pool,
  command: IngestObservationCommand,
): Promise<IngestObservationResult> {
  const payloadHash = hashCanonicalJson(command);

  return withTransaction(pool, async (client) => {
    const policy = await client.query<ActivePolicyRow>(
      `select spr.source_policy_revision_id,
              spr.storage_permission,
              spr.collector_enabled,
              s.status
         from active_source_policies asp
         join source_policy_revisions spr
           on spr.source_policy_revision_id = asp.source_policy_revision_id
         join sources s on s.source_id = asp.source_id
        where asp.source_id = $1
        for update of asp`,
      [command.sourceId],
    );
    const active = policy.rows[0];
    if (!active || !active.collector_enabled || active.status !== 'active') {
      throw new Error('SOURCE_POLICY_NOT_ACTIVE');
    }
    if (active.storage_permission === 'prohibited') {
      throw new Error('SOURCE_POLICY_PROHIBITS_INGEST');
    }

    const inserted = await client.query(
      `insert into idempotency_records
        (scope, idempotency_key, payload_hash, state)
       values ('observation_ingest', $1, $2, 'in_progress')
       on conflict (scope, idempotency_key) do nothing
       returning idempotency_record_id`,
      [command.idempotencyKey, payloadHash],
    );
    if (inserted.rowCount === 0) {
      const existing = await client.query<IdempotencyRow>(
        `select payload_hash, state, result
           from idempotency_records
          where scope = 'observation_ingest' and idempotency_key = $1
          for update`,
        [command.idempotencyKey],
      );
      const record = existing.rows[0];
      if (!record || record.payload_hash !== payloadHash) {
        throw new Error('IDEMPOTENCY_PAYLOAD_CONFLICT');
      }
      if (record.state !== 'completed' || record.result === null) {
        throw new Error('IDEMPOTENCY_OPERATION_IN_PROGRESS');
      }
      return { ...record.result, replayed: true };
    }

    const blobStored = active.storage_permission === 'blob_allowed' && command.rawBlob !== undefined;
    const referenceStored =
      active.storage_permission === 'blob_allowed' ||
      active.storage_permission === 'reference_only';
    await client.query(
      `insert into raw_observations
        (raw_observation_id, source_id, source_policy_revision_id, adapter_version,
         external_reference, content_hash, raw_blob, collected_at)
       values ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)`,
      [
        command.observationId,
        command.sourceId,
        active.source_policy_revision_id,
        command.adapterVersion,
        referenceStored ? JSON.stringify(command.externalReference ?? null) : null,
        payloadHash,
        blobStored ? command.rawBlob : null,
        command.collectedAt,
      ],
    );
    await client.query(
      `insert into audit_events
        (audit_event_id, actor_id, action, reason, correlation_id, policy_version, payload)
       values ($1, $2, 'observation.ingested', 'governed collection intake',
               $3, $4, $5::jsonb)`,
      [
        randomUUID(),
        command.actorId,
        command.correlationId,
        active.source_policy_revision_id,
        JSON.stringify({
          observationId: command.observationId,
          sourceId: command.sourceId,
        }),
      ],
    );
    await client.query(
      `insert into outbox_events
        (outbox_event_id, aggregate_type, aggregate_id, event_type, payload, correlation_id)
       values ($1, 'raw_observation', $2, 'RawObservationIngested', $3::jsonb, $4)`,
      [
        randomUUID(),
        command.observationId,
        JSON.stringify({
          observationId: command.observationId,
          sourceId: command.sourceId,
        }),
        command.correlationId,
      ],
    );
    const result: IngestObservationResult = {
      observationId: command.observationId,
      replayed: false,
      blobStored,
    };
    await client.query(
      `update idempotency_records
          set state = 'completed',
              result = $2::jsonb,
              completed_at = clock_timestamp()
        where scope = 'observation_ingest' and idempotency_key = $1`,
      [command.idempotencyKey, JSON.stringify(result)],
    );
    return result;
  });
}
