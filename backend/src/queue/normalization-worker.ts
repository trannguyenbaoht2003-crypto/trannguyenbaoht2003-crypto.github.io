import { randomUUID } from 'node:crypto';

import { Worker, type Job } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Pool, PoolClient } from 'pg';

import { withTransaction } from '../database/transaction.js';
import { NORMALIZATION_QUEUE_NAME, type OutboxJobData } from './names.js';

export interface NormalizationWorkerResult {
  observationId: string;
  outcome:
    | 'accepted_for_normalization'
    | 'duplicate_noop'
    | 'not_normalizable';
}

export interface NormalizationSourceContext {
  correlationId: string;
  observationId: string;
  outboxEventId: string;
}

interface WorkerHookContext {
  attemptNumber: number;
  jobId: string;
  outboxEventId: string;
}

interface SourceOutboxEvent {
  aggregate_id: string;
  aggregate_type: string;
  correlation_id: string;
  event_type: string;
  normalizable: boolean;
  payload_observation_id: string | null;
}

interface LoadedNormalizationSource {
  context: NormalizationSourceContext;
  normalizable: boolean;
}

export interface CreateNormalizationWorkerOptions {
  afterCommit?: (context: WorkerHookContext) => Promise<void>;
  beforeCommit?: (context: WorkerHookContext) => Promise<void>;
  concurrency?: number;
  connection: Redis;
  normalizeObservation: (
    client: PoolClient,
    source: NormalizationSourceContext,
  ) => Promise<unknown>;
  pool: Pool;
}

function validateJobEnvelope(job: Job<OutboxJobData>): string {
  if (job.name !== 'RawObservationIngested') {
    throw new Error('UNSUPPORTED_NORMALIZATION_EVENT');
  }
  if (!job.id) {
    throw new Error('NORMALIZATION_JOB_ID_REQUIRED');
  }
  if (job.data.outboxEventId !== job.id) {
    throw new Error('OUTBOX_JOB_ID_MISMATCH');
  }
  return job.id;
}

async function loadObservationSource(
  client: PoolClient,
  outboxEventId: string,
): Promise<LoadedNormalizationSource> {
  const result = await client.query<SourceOutboxEvent>(
    `select event.aggregate_id,
            event.aggregate_type,
            event.correlation_id,
            event.event_type,
            event.payload ->> 'observationId' as payload_observation_id,
            (
              policy.storage_permission in (
                'aggregate_only',
                'blob_allowed'
              )
              and observation.aggregate_metadata is not null
              and jsonb_typeof(observation.aggregate_metadata) = 'object'
              and observation.aggregate_metadata ? 'normalizationSnapshot'
            ) as normalizable
       from outbox_events event
       join raw_observations observation
         on observation.raw_observation_id = event.aggregate_id
       join source_policy_revisions policy
         on policy.source_policy_revision_id =
            observation.source_policy_revision_id
      where event.outbox_event_id = $1
      for key share of event, observation, policy`,
    [outboxEventId],
  );
  const event = result.rows[0];
  if (
    !event ||
    event.aggregate_type !== 'raw_observation' ||
    event.event_type !== 'RawObservationIngested' ||
    event.payload_observation_id !== event.aggregate_id
  ) {
    throw new Error('INVALID_SOURCE_OUTBOX_EVENT');
  }
  return {
    context: {
      correlationId: event.correlation_id,
      observationId: event.aggregate_id,
      outboxEventId,
    },
    normalizable: event.normalizable,
  };
}

async function recordAttempt(
  client: PoolClient,
  context: WorkerHookContext,
  status: 'succeeded' | 'duplicate_noop' | 'not_normalizable',
): Promise<void> {
  await client.query(
    `insert into worker_job_attempts
      (worker_job_attempt_id, queue_name, job_id, attempt_number,
       outbox_event_id, status)
     values ($1, $2, $3, $4, $5, $6)`,
    [
      randomUUID(),
      NORMALIZATION_QUEUE_NAME,
      context.jobId,
      context.attemptNumber,
      context.outboxEventId,
      status,
    ],
  );
}

async function recordRetryableFailure(
  pool: Pool,
  context: WorkerHookContext,
): Promise<void> {
  try {
    await pool.query(
      `insert into worker_job_attempts
        (worker_job_attempt_id, queue_name, job_id, attempt_number,
         outbox_event_id, status, error_code)
       values ($1, $2, $3, $4, $5, 'failed_retryable', 'NORMALIZATION_FAILED')
       on conflict (queue_name, job_id, attempt_number) do nothing`,
      [
        randomUUID(),
        NORMALIZATION_QUEUE_NAME,
        context.jobId,
        context.attemptNumber,
        context.outboxEventId,
      ],
    );
  } catch {
    // A database outage can prevent recording its own failure. BullMQ still
    // receives the original error and PostgreSQL remains the system of record.
  }
}

export function createNormalizationWorker(
  options: CreateNormalizationWorkerOptions,
): Worker<OutboxJobData, NormalizationWorkerResult> {
  return new Worker<OutboxJobData, NormalizationWorkerResult>(
    NORMALIZATION_QUEUE_NAME,
    async (job) => {
      const jobId = validateJobEnvelope(job);
      const context: WorkerHookContext = {
        attemptNumber: job.attemptsMade + 1,
        jobId,
        outboxEventId: job.data.outboxEventId,
      };

      try {
        const result = await withTransaction(options.pool, async (client) => {
          const loadedSource = await loadObservationSource(
            client,
            context.outboxEventId,
          );
          const source = loadedSource.context;
          if (!loadedSource.normalizable) {
            await recordAttempt(client, context, 'not_normalizable');
            return {
              observationId: source.observationId,
              outcome: 'not_normalizable' as const,
            };
          }
          const reserved = await client.query(
            `insert into normalization_effects
              (outbox_event_id, raw_observation_id, effect_state)
             values ($1, $2, 'accepted_for_normalization')
             on conflict (outbox_event_id) do nothing
             returning outbox_event_id`,
            [context.outboxEventId, source.observationId],
          );

          if (reserved.rowCount === 0) {
            await recordAttempt(client, context, 'duplicate_noop');
            return {
              observationId: source.observationId,
              outcome: 'duplicate_noop' as const,
            };
          }

          await options.normalizeObservation(client, source);
          await options.beforeCommit?.(context);
          await recordAttempt(client, context, 'succeeded');
          return {
            observationId: source.observationId,
            outcome: 'accepted_for_normalization' as const,
          };
        });
        await options.afterCommit?.(context);
        return result;
      } catch (error) {
        await recordRetryableFailure(options.pool, context);
        throw error;
      }
    },
    {
      concurrency: options.concurrency ?? 4,
      connection: options.connection,
    },
  );
}
