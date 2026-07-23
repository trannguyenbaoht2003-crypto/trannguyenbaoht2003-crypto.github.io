import { randomUUID } from 'node:crypto';

import { Worker, type Job } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Pool, PoolClient } from 'pg';

import { withTransaction } from '../database/transaction.js';
import { NORMALIZATION_QUEUE_NAME, type OutboxJobData } from './names.js';

export interface NormalizationWorkerResult {
  observationId: string;
  outcome: 'accepted_for_normalization' | 'duplicate_noop';
}

interface WorkerHookContext {
  attemptNumber: number;
  jobId: string;
  outboxEventId: string;
}

interface SourceOutboxEvent {
  aggregate_id: string;
  aggregate_type: string;
  event_type: string;
  payload_observation_id: string | null;
}

export interface CreateNormalizationWorkerOptions {
  afterCommit?: (context: WorkerHookContext) => Promise<void>;
  beforeCommit?: (context: WorkerHookContext) => Promise<void>;
  concurrency?: number;
  connection: Redis;
  normalizeObservation: (observationId: string) => Promise<void>;
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

async function loadObservationId(
  client: PoolClient,
  outboxEventId: string,
): Promise<string> {
  const result = await client.query<SourceOutboxEvent>(
    `select aggregate_id,
            aggregate_type,
            event_type,
            payload ->> 'observationId' as payload_observation_id
       from outbox_events
      where outbox_event_id = $1
      for key share`,
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
  return event.aggregate_id;
}

async function recordAttempt(
  client: PoolClient,
  context: WorkerHookContext,
  status: 'succeeded' | 'duplicate_noop',
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
          const observationId = await loadObservationId(client, context.outboxEventId);
          const reserved = await client.query(
            `insert into normalization_effects
              (outbox_event_id, raw_observation_id, effect_state)
             values ($1, $2, 'accepted_for_normalization')
             on conflict (outbox_event_id) do nothing
             returning outbox_event_id`,
            [context.outboxEventId, observationId],
          );

          if (reserved.rowCount === 0) {
            await recordAttempt(client, context, 'duplicate_noop');
            return {
              observationId,
              outcome: 'duplicate_noop' as const,
            };
          }

          await options.normalizeObservation(observationId);
          await options.beforeCommit?.(context);
          await recordAttempt(client, context, 'succeeded');
          return {
            observationId,
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
