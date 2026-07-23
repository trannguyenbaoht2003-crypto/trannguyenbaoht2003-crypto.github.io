import { randomUUID } from 'node:crypto';

import type { JobsOptions } from 'bullmq';
import type { Pool } from 'pg';

import { withTransaction } from '../database/transaction.js';
import type { OutboxJobData } from './names.js';

const DEFAULT_BATCH_SIZE = 25;
const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_RETRY_DELAY_MS = 1_000;
const DISPATCHED_EVENT_TYPES = ['RawObservationIngested'] as const;

interface ClaimedOutboxEvent {
  aggregate_id: string;
  aggregate_type: string;
  correlation_id: string;
  event_type: string;
  outbox_event_id: string;
  payload: Record<string, unknown>;
}

export interface OutboxQueue {
  add(name: string, data: OutboxJobData, options: JobsOptions): Promise<unknown>;
}

export interface DispatchOutboxOptions {
  batchSize?: number;
  leaseMs?: number;
  pool: Pool;
  queue: OutboxQueue;
  retryDelayMs?: number;
}

export interface DispatchOutboxResult {
  claimed: number;
  delivered: number;
  failed: number;
}

async function claimEvents(
  pool: Pool,
  batchSize: number,
  leaseMs: number,
  leaseToken: string,
): Promise<ClaimedOutboxEvent[]> {
  return withTransaction(pool, async (client) => {
    const result = await client.query<ClaimedOutboxEvent>(
      `with candidates as (
         select outbox_event_id
           from outbox_events
          where event_type = any($1::text[])
            and delivery_state in ('pending', 'retryable_failed')
            and available_at <= clock_timestamp()
            and (lease_expires_at is null or lease_expires_at <= clock_timestamp())
          order by available_at, created_at
          for update skip locked
          limit $2
       )
       update outbox_events as event
          set lease_token = $3,
              leased_at = clock_timestamp(),
              lease_expires_at = clock_timestamp() + ($4 * interval '1 millisecond')
         from candidates
        where event.outbox_event_id = candidates.outbox_event_id
       returning event.outbox_event_id,
                 event.aggregate_type,
                 event.aggregate_id,
                 event.event_type,
                 event.payload,
                 event.correlation_id`,
      [DISPATCHED_EVENT_TYPES, batchSize, leaseToken, leaseMs],
    );
    return result.rows;
  });
}

export async function dispatchOutbox(
  options: DispatchOutboxOptions,
): Promise<DispatchOutboxResult> {
  const leaseToken = randomUUID();
  const events = await claimEvents(
    options.pool,
    options.batchSize ?? DEFAULT_BATCH_SIZE,
    options.leaseMs ?? DEFAULT_LEASE_MS,
    leaseToken,
  );
  let delivered = 0;
  let failed = 0;

  for (const event of events) {
    const jobData: OutboxJobData = {
      aggregateId: event.aggregate_id,
      aggregateType: event.aggregate_type,
      correlationId: event.correlation_id,
      eventType: event.event_type,
      outboxEventId: event.outbox_event_id,
      payload: event.payload,
    };

    try {
      await options.queue.add(event.event_type, jobData, {
        attempts: 3,
        backoff: { delay: DEFAULT_RETRY_DELAY_MS, type: 'exponential' },
        jobId: event.outbox_event_id,
        removeOnComplete: false,
        removeOnFail: false,
      });
      const updated = await options.pool.query(
        `update outbox_events
            set delivery_state = 'delivered',
                attempt_count = attempt_count + 1,
                delivered_at = clock_timestamp(),
                last_error_code = null,
                lease_token = null,
                leased_at = null,
                lease_expires_at = null
          where outbox_event_id = $1
            and lease_token = $2`,
        [event.outbox_event_id, leaseToken],
      );
      delivered += updated.rowCount ?? 0;
    } catch {
      const updated = await options.pool.query(
        `update outbox_events
            set delivery_state = 'retryable_failed',
                attempt_count = attempt_count + 1,
                available_at = clock_timestamp() + ($3 * interval '1 millisecond'),
                last_error_code = 'QUEUE_ENQUEUE_FAILED',
                lease_token = null,
                leased_at = null,
                lease_expires_at = null
          where outbox_event_id = $1
            and lease_token = $2`,
        [
          event.outbox_event_id,
          leaseToken,
          options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS,
        ],
      );
      failed += updated.rowCount ?? 0;
    }
  }

  return { claimed: events.length, delivered, failed };
}
