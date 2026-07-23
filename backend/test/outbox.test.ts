import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterEach, test } from 'node:test';

import { Queue } from 'bullmq';
import type { Pool } from 'pg';

import { createQueueConnection } from '../src/queue/connection.js';
import { NORMALIZATION_QUEUE_NAME } from '../src/queue/names.js';
import { dispatchOutbox } from '../src/queue/outbox-dispatcher.js';
import { resetDatabase } from './helpers/database.js';

const redisUrl = process.env.TEST_REDIS_URL;
if (!redisUrl) {
  throw new Error('TEST_REDIS_URL is required for outbox tests');
}

let pool: Pool | undefined;
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
  await pool?.end();
  pool = undefined;
});

test('dispatch retry creates one BullMQ job and marks the outbox event delivered', async () => {
  pool = await resetDatabase();
  const connection = createQueueConnection(redisUrl);
  assert.equal(connection.options.maxRetriesPerRequest, 1);
  const queue = new Queue(NORMALIZATION_QUEUE_NAME, { connection });
  cleanups.push(async () => {
    await queue.obliterate({ force: true });
    await queue.close();
    await connection.quit();
  });

  const eventId = randomUUID();
  const observationId = randomUUID();
  const correlationId = randomUUID();
  const payload = { observationId, sourceId: randomUUID() };
  await pool.query(
    `insert into outbox_events
      (outbox_event_id, aggregate_type, aggregate_id, event_type, payload, correlation_id)
     values ($1, 'raw_observation', $2, 'RawObservationIngested', $3::jsonb, $4)`,
    [eventId, observationId, JSON.stringify(payload), correlationId],
  );
  await queue.add(
    'RawObservationIngested',
    {
      aggregateId: observationId,
      aggregateType: 'raw_observation',
      correlationId,
      eventType: 'RawObservationIngested',
      outboxEventId: eventId,
      payload,
    },
    { jobId: eventId },
  );

  const first = await dispatchOutbox({ pool, queue });
  const second = await dispatchOutbox({ pool, queue });

  assert.deepEqual(first, { claimed: 1, delivered: 1, failed: 0 });
  assert.deepEqual(second, { claimed: 0, delivered: 0, failed: 0 });
  const job = await queue.getJob(eventId);
  assert.ok(job);
  assert.equal(job.id, eventId);
  assert.equal(await queue.getJobCountByTypes('waiting', 'delayed', 'active', 'completed'), 1);

  const delivery = await pool.query<{
    attempt_count: number;
    delivery_state: string;
    payload: typeof payload;
  }>(
    `select attempt_count, delivery_state, payload
       from outbox_events
      where outbox_event_id = $1`,
    [eventId],
  );
  assert.equal(delivery.rows[0]?.delivery_state, 'delivered');
  assert.equal(delivery.rows[0]?.attempt_count, 1);
  assert.deepEqual(delivery.rows[0]?.payload, payload);
  await assert.rejects(
    pool.query(
      `update outbox_events
          set payload = '{}'::jsonb
        where outbox_event_id = $1`,
      [eventId],
    ),
    /immutable/,
  );
});

test('queue failure keeps the immutable payload and schedules a database-backed retry', async () => {
  pool = await resetDatabase();
  const eventId = randomUUID();
  const observationId = randomUUID();
  const payload = { observationId, sourceId: randomUUID() };
  await pool.query(
    `insert into outbox_events
      (outbox_event_id, aggregate_type, aggregate_id, event_type, payload, correlation_id)
     values ($1, 'raw_observation', $2, 'RawObservationIngested', $3::jsonb, $4)`,
    [eventId, observationId, JSON.stringify(payload), randomUUID()],
  );

  const result = await dispatchOutbox({
    pool,
    queue: {
      async add() {
        throw new Error('injected Redis outage');
      },
    },
    retryDelayMs: 10,
  });

  assert.deepEqual(result, { claimed: 1, delivered: 0, failed: 1 });
  const delivery = await pool.query<{
    attempt_count: number;
    available: boolean;
    delivery_state: string;
    last_error_code: string;
    lease_token: string | null;
    payload: typeof payload;
  }>(
    `select attempt_count,
            available_at > created_at as available,
            delivery_state,
            last_error_code,
            lease_token,
            payload
       from outbox_events
      where outbox_event_id = $1`,
    [eventId],
  );
  assert.equal(delivery.rows[0]?.delivery_state, 'retryable_failed');
  assert.equal(delivery.rows[0]?.attempt_count, 1);
  assert.equal(delivery.rows[0]?.last_error_code, 'QUEUE_ENQUEUE_FAILED');
  assert.equal(delivery.rows[0]?.available, true);
  assert.equal(delivery.rows[0]?.lease_token, null);
  assert.deepEqual(delivery.rows[0]?.payload, payload);
});
