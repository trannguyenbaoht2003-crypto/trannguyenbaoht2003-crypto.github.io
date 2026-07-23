import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterEach, test } from 'node:test';

import { Queue, QueueEvents } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Pool } from 'pg';

import {
  createQueueConnection,
  createWorkerConnection,
} from '../src/queue/connection.js';
import { NORMALIZATION_QUEUE_NAME, type OutboxJobData } from '../src/queue/names.js';
import { createNormalizationWorker } from '../src/queue/normalization-worker.js';
import { resetDatabase, tableCount } from './helpers/database.js';

function testRedisUrl(): string {
  const value = process.env.TEST_REDIS_URL;
  if (!value) {
    throw new Error('TEST_REDIS_URL is required for worker tests');
  }
  return value;
}

const redisUrl = testRedisUrl();
let pool: Pool | undefined;
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
  await pool?.end();
  pool = undefined;
});

async function queueHarness() {
  const queueConnection = createQueueConnection(redisUrl);
  const eventsConnection = createWorkerConnection(redisUrl);
  const workerConnection = createWorkerConnection(redisUrl);
  assert.equal(queueConnection.options.maxRetriesPerRequest, 1);
  assert.equal(workerConnection.options.maxRetriesPerRequest, null);
  const queue = new Queue<OutboxJobData>(NORMALIZATION_QUEUE_NAME, {
    connection: queueConnection,
  });
  const events = new QueueEvents(NORMALIZATION_QUEUE_NAME, {
    connection: eventsConnection,
  });
  await events.waitUntilReady();
  cleanups.push(async () => {
    await queue.obliterate({ force: true });
    await events.close();
    await queue.close();
    await Promise.all([
      closeRedis(queueConnection),
      closeRedis(eventsConnection),
      closeRedis(workerConnection),
    ]);
  });
  return { events, queue, workerConnection };
}

async function closeRedis(connection: Redis): Promise<void> {
  if (connection.status !== 'end') {
    await connection.quit();
  }
}

async function seedObservationEvent(database: Pool) {
  const sourceId = randomUUID();
  const policyRevisionId = randomUUID();
  const observationId = randomUUID();
  const eventId = randomUUID();
  await database.query(
    `insert into sources (source_id, source_key, display_name, status)
     values ($1, $2, 'Worker test source', 'active')`,
    [sourceId, `worker-${sourceId}`],
  );
  await database.query(
    `insert into source_policy_revisions
      (source_policy_revision_id, source_id, revision, storage_permission,
       collector_enabled, reason, created_by)
     values ($1, $2, 1, 'reference_only', true, 'worker test', 'test')`,
    [policyRevisionId, sourceId],
  );
  await database.query(
    `insert into raw_observations
      (raw_observation_id, source_id, source_policy_revision_id, adapter_version,
       content_hash, collected_at)
     values ($1, $2, $3, 'test-v1', $4, clock_timestamp())`,
    [observationId, sourceId, policyRevisionId, `hash-${observationId}`],
  );
  await database.query(
    `insert into outbox_events
      (outbox_event_id, aggregate_type, aggregate_id, event_type, payload,
       correlation_id, delivery_state, delivered_at)
     values ($1, 'raw_observation', $2, 'RawObservationIngested', $3::jsonb,
             $4, 'delivered', clock_timestamp())`,
    [
      eventId,
      observationId,
      JSON.stringify({ observationId, sourceId }),
      randomUUID(),
    ],
  );
  return {
    eventId,
    jobData: {
      aggregateId: observationId,
      aggregateType: 'raw_observation',
      correlationId: randomUUID(),
      eventType: 'RawObservationIngested',
      outboxEventId: eventId,
      payload: { observationId, sourceId },
    } satisfies OutboxJobData,
    observationId,
  };
}

test('worker success records one attempt and one normalization effect', async () => {
  pool = await resetDatabase();
  const { eventId, jobData, observationId } = await seedObservationEvent(pool);
  const { events, queue, workerConnection } = await queueHarness();
  let normalizeCalls = 0;
  const worker = createNormalizationWorker({
    connection: workerConnection,
    normalizeObservation: async (receivedObservationId: string) => {
      normalizeCalls += 1;
      assert.equal(receivedObservationId, observationId);
    },
    pool,
  });
  cleanups.push(async () => worker.close());

  const job = await queue.add('RawObservationIngested', jobData, {
    attempts: 2,
    backoff: { delay: 10, type: 'fixed' },
    jobId: eventId,
  });
  const result = await job.waitUntilFinished(events, 5_000);

  assert.deepEqual(result, {
    observationId,
    outcome: 'accepted_for_normalization',
  });
  assert.equal(normalizeCalls, 1);
  assert.equal(await tableCount(pool, 'worker_job_attempts'), 1);
  assert.equal(await tableCount(pool, 'normalization_effects'), 1);
});

test('worker resolves the observation from PostgreSQL instead of trusting Redis payload', async () => {
  pool = await resetDatabase();
  const { eventId, jobData, observationId } = await seedObservationEvent(pool);
  const { events, queue, workerConnection } = await queueHarness();
  let receivedObservationId: string | undefined;
  const worker = createNormalizationWorker({
    connection: workerConnection,
    normalizeObservation: async (value) => {
      receivedObservationId = value;
    },
    pool,
  });
  cleanups.push(async () => worker.close());

  const job = await queue.add(
    'RawObservationIngested',
    {
      ...jobData,
      aggregateId: randomUUID(),
      payload: { ...jobData.payload, observationId: randomUUID() },
    },
    {
      attempts: 1,
      jobId: eventId,
    },
  );
  await job.waitUntilFinished(events, 5_000);

  assert.equal(receivedObservationId, observationId);
  assert.equal(await tableCount(pool, 'normalization_effects'), 1);
});

test('lost acknowledgement retries the job without duplicating the normalization effect', async () => {
  pool = await resetDatabase();
  const { eventId, jobData } = await seedObservationEvent(pool);
  const { events, queue, workerConnection } = await queueHarness();
  let normalizeCalls = 0;
  let acknowledgements = 0;
  const worker = createNormalizationWorker({
    afterCommit: async () => {
      acknowledgements += 1;
      if (acknowledgements === 1) {
        throw new Error('injected acknowledgement loss');
      }
    },
    connection: workerConnection,
    normalizeObservation: async () => {
      normalizeCalls += 1;
    },
    pool,
  });
  cleanups.push(async () => worker.close());

  const job = await queue.add('RawObservationIngested', jobData, {
    attempts: 2,
    backoff: { delay: 10, type: 'fixed' },
    jobId: eventId,
  });
  await job.waitUntilFinished(events, 5_000);

  assert.equal(normalizeCalls, 1);
  assert.equal(await tableCount(pool, 'normalization_effects'), 1);
  const attempts = await pool.query<{ status: string }>(
    `select status
       from worker_job_attempts
      order by attempt_number`,
  );
  assert.deepEqual(
    attempts.rows.map((row) => row.status),
    ['succeeded', 'duplicate_noop'],
  );
});

test('transaction failure is retried without marking the failed attempt successful', async () => {
  pool = await resetDatabase();
  const { eventId, jobData } = await seedObservationEvent(pool);
  const { events, queue, workerConnection } = await queueHarness();
  let normalizeCalls = 0;
  let transactionAttempts = 0;
  const worker = createNormalizationWorker({
    beforeCommit: async () => {
      transactionAttempts += 1;
      if (transactionAttempts === 1) {
        throw new Error('injected database transaction failure');
      }
    },
    connection: workerConnection,
    normalizeObservation: async () => {
      normalizeCalls += 1;
    },
    pool,
  });
  cleanups.push(async () => worker.close());

  const job = await queue.add('RawObservationIngested', jobData, {
    attempts: 2,
    backoff: { delay: 10, type: 'fixed' },
    jobId: eventId,
  });
  await job.waitUntilFinished(events, 5_000);

  assert.equal(normalizeCalls, 2);
  assert.equal(await tableCount(pool, 'normalization_effects'), 1);
  const attempts = await pool.query<{ attempt_number: number; status: string }>(
    `select attempt_number, status
       from worker_job_attempts
      order by attempt_number`,
  );
  assert.deepEqual(attempts.rows, [
    { attempt_number: 1, status: 'failed_retryable' },
    { attempt_number: 2, status: 'succeeded' },
  ]);
});

test('normalization worker has no publication dependency', async () => {
  const source = await readFile('src/queue/normalization-worker.ts', 'utf8');
  assert.doesNotMatch(source, /publication|publish/i);
});
