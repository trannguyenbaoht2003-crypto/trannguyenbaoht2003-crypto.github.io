import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterEach, test } from 'node:test';

import { Queue, QueueEvents } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Pool, PoolClient } from 'pg';

import {
  registerStoredObservationInTransaction,
} from '../src/modules/candidate/register-stored-observation.js';
import {
  createQueueConnection,
  createWorkerConnection,
} from '../src/queue/connection.js';
import { NORMALIZATION_QUEUE_NAME, type OutboxJobData } from '../src/queue/names.js';
import { createNormalizationWorker } from '../src/queue/normalization-worker.js';
import { seedActiveCatalog } from './helpers/catalog.js';
import {
  seedRawObservation,
  validNormalizationSnapshot,
} from './helpers/candidate.js';
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

async function seedObservationEvent(
  database: Pool,
  storagePermission: 'aggregate_only' | 'reference_only' = 'aggregate_only',
  aggregateMetadata: unknown = storagePermission === 'aggregate_only'
    ? { normalizationSnapshot: {} }
    : null,
) {
  const sourceId = randomUUID();
  const policyRevisionId = randomUUID();
  const observationId = randomUUID();
  const eventId = randomUUID();
  const correlationId = randomUUID();
  await database.query(
    `insert into sources (source_id, source_key, display_name, status)
     values ($1, $2, 'Worker test source', 'active')`,
    [sourceId, `worker-${sourceId}`],
  );
  await database.query(
    `insert into source_policy_revisions
      (source_policy_revision_id, source_id, revision, storage_permission,
       collector_enabled, reason, created_by)
     values ($1, $2, 1, $3, true, 'worker test', 'test')`,
    [policyRevisionId, sourceId, storagePermission],
  );
  await database.query(
    `insert into raw_observations
      (raw_observation_id, source_id, source_policy_revision_id, adapter_version,
       aggregate_metadata, content_hash, collected_at)
     values ($1, $2, $3, 'test-v1', $4::jsonb, $5, clock_timestamp())`,
    [
      observationId,
      sourceId,
      policyRevisionId,
      JSON.stringify(aggregateMetadata),
      `hash-${observationId}`,
    ],
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
      correlationId,
    ],
  );
  return {
    correlationId,
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

async function seedCandidateObservationEvent(
  database: Pool,
  aggregateMetadata: Record<string, unknown> = {
    normalizationSnapshot: validNormalizationSnapshot(),
  },
) {
  await seedActiveCatalog(database);
  const observationId = randomUUID();
  const eventId = randomUUID();
  const correlationId = randomUUID();
  await seedRawObservation(database, observationId, aggregateMetadata);
  await database.query(
    `insert into outbox_events
      (outbox_event_id, aggregate_type, aggregate_id, event_type, payload,
       correlation_id, delivery_state, delivered_at)
     values ($1, 'raw_observation', $2, 'RawObservationIngested', $3::jsonb,
             $4, 'delivered', clock_timestamp())`,
    [
      eventId,
      observationId,
      JSON.stringify({ observationId }),
      correlationId,
    ],
  );
  return {
    eventId,
    jobData: {
      aggregateId: randomUUID(),
      aggregateType: 'tampered',
      correlationId: randomUUID(),
      eventType: 'RawObservationIngested',
      outboxEventId: eventId,
      payload: { observationId: randomUUID() },
    } satisfies OutboxJobData,
    observationId,
  };
}

async function seedDuplicateObservationEvent(
  database: Pool,
  observationId: string,
) {
  const eventId = randomUUID();
  const correlationId = randomUUID();
  await database.query(
    `insert into outbox_events
      (outbox_event_id, aggregate_type, aggregate_id, event_type, payload,
       correlation_id, delivery_state, delivered_at)
     values ($1, 'raw_observation', $2, 'RawObservationIngested', $3::jsonb,
             $4, 'delivered', clock_timestamp())`,
    [
      eventId,
      observationId,
      JSON.stringify({ observationId }),
      correlationId,
    ],
  );
  return {
    eventId,
    jobData: {
      aggregateId: randomUUID(),
      aggregateType: 'tampered',
      correlationId: randomUUID(),
      eventType: 'RawObservationIngested',
      outboxEventId: eventId,
      payload: { observationId: randomUUID() },
    } satisfies OutboxJobData,
  };
}

test('worker success records one attempt and one normalization effect', async () => {
  pool = await resetDatabase();
  const {
    correlationId,
    eventId,
    jobData,
    observationId,
  } = await seedObservationEvent(pool);
  const { events, queue, workerConnection } = await queueHarness();
  let normalizeCalls = 0;
  const worker = createNormalizationWorker({
    connection: workerConnection,
    normalizeObservation: async (
      client: PoolClient,
      source,
    ) => {
      normalizeCalls += 1;
      await client.query('select 1');
      assert.equal(source.observationId, observationId);
      assert.equal(source.outboxEventId, eventId);
      assert.equal(source.correlationId, correlationId);
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
  const {
    correlationId,
    eventId,
    jobData,
    observationId,
  } = await seedObservationEvent(pool);
  const { events, queue, workerConnection } = await queueHarness();
  let receivedSource:
    | {
        correlationId: string;
        observationId: string;
        outboxEventId: string;
      }
    | undefined;
  const worker = createNormalizationWorker({
    connection: workerConnection,
    normalizeObservation: async (_client, source) => {
      receivedSource = source;
    },
    pool,
  });
  cleanups.push(async () => worker.close());

  const job = await queue.add(
    'RawObservationIngested',
    {
      ...jobData,
      aggregateId: randomUUID(),
      correlationId: randomUUID(),
      payload: { ...jobData.payload, observationId: randomUUID() },
    },
    {
      attempts: 1,
      jobId: eventId,
    },
  );
  await job.waitUntilFinished(events, 5_000);

  assert.deepEqual(receivedSource, {
    correlationId,
    observationId,
    outboxEventId: eventId,
  });
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

test('candidate registration rolls back and retries with the normalization effect', async () => {
  pool = await resetDatabase();
  const {
    eventId,
    jobData,
    observationId,
  } = await seedCandidateObservationEvent(pool);
  const { events, queue, workerConnection } = await queueHarness();
  let transactionAttempts = 0;
  const worker = createNormalizationWorker({
    beforeCommit: async () => {
      transactionAttempts += 1;
      if (transactionAttempts === 1) {
        throw new Error('injected candidate transaction failure');
      }
    },
    connection: workerConnection,
    normalizeObservation: registerStoredObservationInTransaction,
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
  assert.equal(await tableCount(pool, 'normalization_effects'), 1);
  assert.equal(await tableCount(pool, 'normalized_observations'), 1);
  assert.equal(await tableCount(pool, 'candidates'), 1);
  assert.equal(await tableCount(pool, 'candidate_revisions'), 1);
  assert.equal(await tableCount(pool, 'candidate_provenance'), 1);
  const candidateEvents = await pool.query<{ count: string }>(
    `select count(*)::text as count
       from outbox_events
      where event_type in (
        'CandidateRegistered',
        'CandidateRevisionRegistered',
        'CandidateProvenanceAdded'
      )`,
  );
  assert.equal(candidateEvents.rows[0]?.count, '1');
  const attempts = await pool.query<{ status: string }>(
    `select status
       from worker_job_attempts
      order by attempt_number`,
  );
  assert.deepEqual(
    attempts.rows.map((row) => row.status),
    ['failed_retryable', 'succeeded'],
  );
});

test('candidate registration survives lost acknowledgement without duplicates', async () => {
  pool = await resetDatabase();
  const {
    eventId,
    jobData,
    observationId,
  } = await seedCandidateObservationEvent(pool);
  const { events, queue, workerConnection } = await queueHarness();
  let acknowledgements = 0;
  const worker = createNormalizationWorker({
    afterCommit: async () => {
      acknowledgements += 1;
      if (acknowledgements === 1) {
        throw new Error('injected candidate acknowledgement loss');
      }
    },
    connection: workerConnection,
    normalizeObservation: registerStoredObservationInTransaction,
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
    outcome: 'duplicate_noop',
  });
  for (const table of [
    'normalization_effects',
    'normalized_observations',
    'candidates',
    'candidate_revisions',
    'candidate_provenance',
  ]) {
    assert.equal(await tableCount(pool, table), 1);
  }
  const candidateEvents = await pool.query<{ count: string }>(
    `select count(*)::text as count
       from outbox_events
      where aggregate_type = 'candidate'`,
  );
  assert.equal(candidateEvents.rows[0]?.count, '1');
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

test('concurrent deliveries for one raw observation serialize before effect reservation', async () => {
  pool = await resetDatabase();
  const first = await seedCandidateObservationEvent(pool);
  const second = await seedDuplicateObservationEvent(
    pool,
    first.observationId,
  );
  const { events, queue, workerConnection } = await queueHarness();
  const secondWorkerConnection = createWorkerConnection(redisUrl);
  let normalizeCalls = 0;
  const normalizeObservation = async (
    client: PoolClient,
    source: Parameters<typeof registerStoredObservationInTransaction>[1],
  ) => {
    normalizeCalls += 1;
    return registerStoredObservationInTransaction(client, source);
  };
  const firstWorker = createNormalizationWorker({
    connection: workerConnection,
    normalizeObservation,
    pool,
  });
  const secondWorker = createNormalizationWorker({
    connection: secondWorkerConnection,
    normalizeObservation,
    pool,
  });
  cleanups.push(async () => {
    await Promise.all([firstWorker.close(), secondWorker.close()]);
    await closeRedis(secondWorkerConnection);
  });
  await Promise.all([
    firstWorker.waitUntilReady(),
    secondWorker.waitUntilReady(),
  ]);

  const [firstJob, secondJob] = await Promise.all([
    queue.add('RawObservationIngested', first.jobData, {
      attempts: 1,
      jobId: first.eventId,
    }),
    queue.add('RawObservationIngested', second.jobData, {
      attempts: 1,
      jobId: second.eventId,
    }),
  ]);
  const results = await Promise.all([
    firstJob.waitUntilFinished(events, 5_000),
    secondJob.waitUntilFinished(events, 5_000),
  ]);

  assert.deepEqual(
    results.map((result) => result.outcome).sort(),
    ['accepted_for_normalization', 'duplicate_noop'],
  );
  assert.equal(normalizeCalls, 1);
  for (const table of [
    'normalization_effects',
    'normalized_observations',
    'candidates',
    'candidate_revisions',
    'candidate_provenance',
  ]) {
    assert.equal(await tableCount(pool, table), 1);
  }
  const attempts = await pool.query<{ status: string }>(
    `select status
       from worker_job_attempts
      order by status`,
  );
  assert.deepEqual(
    attempts.rows.map((row) => row.status),
    ['duplicate_noop', 'succeeded'],
  );
});

test('stored observation handler rejects a noncanonical aggregate wrapper atomically', async () => {
  pool = await resetDatabase();
  const {
    eventId,
    jobData,
  } = await seedCandidateObservationEvent(pool, {
    normalizationSnapshot: validNormalizationSnapshot(),
    retainedSourceText: 'must not enter Candidate history',
  });
  const { events, queue, workerConnection } = await queueHarness();
  const worker = createNormalizationWorker({
    connection: workerConnection,
    normalizeObservation: registerStoredObservationInTransaction,
    pool,
  });
  cleanups.push(async () => worker.close());

  const job = await queue.add('RawObservationIngested', jobData, {
    attempts: 1,
    jobId: eventId,
  });
  await assert.rejects(
    job.waitUntilFinished(events, 5_000),
    /NORMALIZATION_SCHEMA_UNSUPPORTED/,
  );
  for (const table of [
    'normalization_effects',
    'normalized_observations',
    'candidates',
    'candidate_revisions',
    'candidate_provenance',
  ]) {
    assert.equal(await tableCount(pool, table), 0);
  }
  const attempts = await pool.query<{ status: string }>(
    `select status from worker_job_attempts order by attempt_number`,
  );
  assert.deepEqual(
    attempts.rows.map((row) => row.status),
    ['failed_retryable'],
  );
});

test('reference-only observation completes once as non-normalizable', async () => {
  pool = await resetDatabase();
  const {
    eventId,
    jobData,
    observationId,
  } = await seedObservationEvent(pool, 'reference_only');
  const { events, queue, workerConnection } = await queueHarness();
  const worker = createNormalizationWorker({
    connection: workerConnection,
    normalizeObservation: registerStoredObservationInTransaction,
    pool,
  });
  cleanups.push(async () => worker.close());

  const job = await queue.add('RawObservationIngested', jobData, {
    attempts: 3,
    backoff: { delay: 10, type: 'fixed' },
    jobId: eventId,
  });
  const result = await job.waitUntilFinished(events, 5_000);

  assert.deepEqual(result, {
    observationId,
    outcome: 'not_normalizable',
  });
  assert.equal(await tableCount(pool, 'normalization_effects'), 0);
  assert.equal(await tableCount(pool, 'normalized_observations'), 0);
  assert.equal(await tableCount(pool, 'candidates'), 0);
  const attempts = await pool.query<{
    attempt_number: number;
    status: string;
  }>(
    `select attempt_number, status
       from worker_job_attempts
      order by attempt_number`,
  );
  assert.deepEqual(attempts.rows, [
    { attempt_number: 1, status: 'not_normalizable' },
  ]);
});

test('aggregate-only observations without a top-level snapshot are non-normalizable', async () => {
  pool = await resetDatabase();
  const missingMetadata = await seedObservationEvent(
    pool,
    'aggregate_only',
    null,
  );
  const missingSnapshot = await seedObservationEvent(
    pool,
    'aggregate_only',
    { retainedAggregate: true },
  );
  const { events, queue, workerConnection } = await queueHarness();
  let normalizeCalls = 0;
  const worker = createNormalizationWorker({
    connection: workerConnection,
    normalizeObservation: async () => {
      normalizeCalls += 1;
    },
    pool,
  });
  cleanups.push(async () => worker.close());

  const jobs = await Promise.all([
    queue.add('RawObservationIngested', missingMetadata.jobData, {
      attempts: 2,
      jobId: missingMetadata.eventId,
    }),
    queue.add('RawObservationIngested', missingSnapshot.jobData, {
      attempts: 2,
      jobId: missingSnapshot.eventId,
    }),
  ]);
  const results = await Promise.all(
    jobs.map((job) => job.waitUntilFinished(events, 5_000)),
  );

  assert.deepEqual(
    results.map((result) => result.outcome),
    ['not_normalizable', 'not_normalizable'],
  );
  assert.equal(normalizeCalls, 0);
  assert.equal(await tableCount(pool, 'normalization_effects'), 0);
  const attempts = await pool.query<{ status: string }>(
    `select status
       from worker_job_attempts
      order by job_id`,
  );
  assert.deepEqual(
    attempts.rows.map((row) => row.status),
    ['not_normalizable', 'not_normalizable'],
  );
});

test('normalization worker has no publication dependency', async () => {
  const source = await readFile('src/queue/normalization-worker.ts', 'utf8');
  assert.doesNotMatch(source, /publication|publish/i);
});
