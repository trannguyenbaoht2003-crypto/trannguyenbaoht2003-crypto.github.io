import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterEach, test } from 'node:test';

import { Queue, QueueEvents } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Pool } from 'pg';

import {
  publishCandidateRevision,
} from '../src/modules/publication/publish-candidate-revision.js';
import {
  readActivePublicationById,
} from '../src/modules/publication/read-active-publications.js';
import {
  rollbackPublication,
} from '../src/modules/publication/rollback-publication.js';
import type {
  PublishCandidateRevisionCommand,
  RollbackPublicationCommand,
} from '../src/modules/publication/types.js';
import {
  createQueueConnection,
  createWorkerConnection,
} from '../src/queue/connection.js';
import {
  createPublicationProjectionWorker,
} from '../src/queue/publication-projection-worker.js';
import {
  PUBLICATION_QUEUE_NAME,
  type OutboxJobData,
} from '../src/queue/names.js';
import { resetDatabase, tableCount } from './helpers/database.js';
import { GATE_IDS } from './helpers/gate.js';
import {
  PUBLICATION_IDS,
  seedEligiblePublicationContext,
} from './helpers/publication.js';

const SECOND_VERSION_IDS = {
  publicationVersionId: '7a000000-0000-4000-8000-000000000001',
  activationId: '7a000000-0000-4000-8000-000000000002',
  auditId: '7a000000-0000-4000-8000-000000000003',
  outboxEventId: '7a000000-0000-4000-8000-000000000004',
} as const;

const ROLLBACK_IDS = {
  activationId: '7b000000-0000-4000-8000-000000000001',
  auditId: '7b000000-0000-4000-8000-000000000002',
  outboxEventId: '7b000000-0000-4000-8000-000000000003',
} as const;

function testRedisUrl(): string {
  const value = process.env.TEST_REDIS_URL;
  if (!value) {
    throw new Error(
      'TEST_REDIS_URL is required for Publication projection tests',
    );
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

async function closeRedis(connection: Redis): Promise<void> {
  if (connection.status !== 'end') {
    await connection.quit();
  }
}

async function publicationHarness() {
  const queueConnection = createQueueConnection(redisUrl);
  const eventsConnection = createWorkerConnection(redisUrl);
  const workerConnection = createWorkerConnection(redisUrl);
  const queue = new Queue<OutboxJobData>(PUBLICATION_QUEUE_NAME, {
    connection: queueConnection,
  });
  const events = new QueueEvents(PUBLICATION_QUEUE_NAME, {
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

function publishCommand(
  overrides: Partial<PublishCandidateRevisionCommand> = {},
): PublishCandidateRevisionCommand {
  return {
    publicationId: PUBLICATION_IDS.publicationId,
    publicationVersionId: PUBLICATION_IDS.publicationVersionId,
    activationId: PUBLICATION_IDS.activationId,
    candidateRevisionId: '62000000-0000-4000-8000-000000000002',
    expectedActiveEligibilityPolicyRevisionId:
      GATE_IDS.eligibilityPolicyId,
    expectedEligibilityEvaluationId: GATE_IDS.eligibilityEvaluationId,
    expectedModerationDecisionId: GATE_IDS.moderationDecisionId,
    expectedActivePublicationVersionId: null,
    authorization: {
      actorId: 'publication-editor',
      permissions: ['publisher'],
    },
    auditId: PUBLICATION_IDS.auditId,
    outboxEventId: PUBLICATION_IDS.outboxEventId,
    correlationId: 'publication-publish-v1',
    idempotencyKey: 'publication-publish-v1',
    occurredAt: '2026-07-29T02:00:00.000Z',
    ...overrides,
  };
}

function secondPublishCommand(): PublishCandidateRevisionCommand {
  return publishCommand({
    publicationVersionId: SECOND_VERSION_IDS.publicationVersionId,
    activationId: SECOND_VERSION_IDS.activationId,
    expectedActivePublicationVersionId:
      PUBLICATION_IDS.publicationVersionId,
    auditId: SECOND_VERSION_IDS.auditId,
    outboxEventId: SECOND_VERSION_IDS.outboxEventId,
    correlationId: 'publication-publish-v2',
    idempotencyKey: 'publication-publish-v2',
    occurredAt: '2026-07-29T02:10:00.000Z',
  });
}

function rollbackCommand(): RollbackPublicationCommand {
  return {
    publicationId: PUBLICATION_IDS.publicationId,
    targetPublicationVersionId: PUBLICATION_IDS.publicationVersionId,
    activationId: ROLLBACK_IDS.activationId,
    expectedActivePublicationVersionId:
      SECOND_VERSION_IDS.publicationVersionId,
    authorization: {
      actorId: 'publication-editor',
      permissions: ['publisher'],
    },
    auditId: ROLLBACK_IDS.auditId,
    outboxEventId: ROLLBACK_IDS.outboxEventId,
    correlationId: 'publication-rollback-v1',
    idempotencyKey: 'publication-rollback-v1',
    occurredAt: '2026-07-29T02:20:00.000Z',
  };
}

async function loadJobData(
  database: Pool,
  eventType: 'PublicationPublished' | 'PublicationRolledBack',
): Promise<{ eventId: string; jobData: OutboxJobData }> {
  const result = await database.query<{ outbox_event_id: string }>(
    `select outbox_event_id
       from outbox_events
      where event_type = $1
      order by created_at desc
      limit 1`,
    [eventType],
  );
  const eventId = result.rows[0]!.outbox_event_id;
  return {
    eventId,
    jobData: {
      aggregateId: randomUUID(),
      aggregateType: 'tampered',
      correlationId: randomUUID(),
      eventType,
      outboxEventId: eventId,
      payload: {
        activationId: randomUUID(),
        candidateId: randomUUID(),
        candidateRevisionId: randomUUID(),
        publicationId: randomUUID(),
        publicationVersionId: randomUUID(),
      },
    },
  };
}

test('Publication projection reloads PostgreSQL authority and public read does not wait for the worker', async () => {
  pool = await resetDatabase();
  await seedEligiblePublicationContext(pool);
  await publishCandidateRevision(pool, publishCommand());
  const before = await readActivePublicationById(
    pool,
    PUBLICATION_IDS.publicationId,
  );
  assert.equal(
    before?.publicationVersionId,
    PUBLICATION_IDS.publicationVersionId,
  );
  assert.equal(await tableCount(pool, 'publication_projection_effects'), 0);

  const source = await loadJobData(pool, 'PublicationPublished');
  const { events, queue, workerConnection } = await publicationHarness();
  const worker = createPublicationProjectionWorker({
    connection: workerConnection,
    pool,
  });
  cleanups.push(async () => worker.close());

  const job = await queue.add(
    'PublicationPublished',
    source.jobData,
    { attempts: 1, jobId: source.eventId },
  );
  const result = await job.waitUntilFinished(events, 5_000);

  assert.deepEqual(result, {
    outboxEventId: PUBLICATION_IDS.outboxEventId,
    outcome: 'projected',
  });
  const effect = await pool.query<{
    event_type: string;
    projected_state: string;
    publication_id: string;
    publication_version_id: string;
  }>(
    `select event_type, projected_state, publication_id,
            publication_version_id
       from publication_projection_effects
      where outbox_event_id = $1`,
    [PUBLICATION_IDS.outboxEventId],
  );
  assert.deepEqual(effect.rows[0], {
    event_type: 'PublicationPublished',
    projected_state: 'active',
    publication_id: PUBLICATION_IDS.publicationId,
    publication_version_id: PUBLICATION_IDS.publicationVersionId,
  });
  assert.deepEqual(
    await readActivePublicationById(pool, PUBLICATION_IDS.publicationId),
    before,
  );
});

test('Publication projection duplicate delivery is a replay-safe no-op', async () => {
  pool = await resetDatabase();
  await seedEligiblePublicationContext(pool);
  await publishCandidateRevision(pool, publishCommand());
  const source = await loadJobData(pool, 'PublicationPublished');
  const { events, queue, workerConnection } = await publicationHarness();
  const worker = createPublicationProjectionWorker({
    connection: workerConnection,
    pool,
  });
  cleanups.push(async () => worker.close());

  const first = await queue.add(
    'PublicationPublished',
    source.jobData,
    { attempts: 1, jobId: source.eventId, removeOnComplete: true },
  );
  await first.waitUntilFinished(events, 5_000);
  const replayJob = await queue.add(
    'PublicationPublished',
    source.jobData,
    { attempts: 1, jobId: source.eventId },
  );
  const replay = await replayJob.waitUntilFinished(events, 5_000);

  assert.deepEqual(replay, {
    outboxEventId: PUBLICATION_IDS.outboxEventId,
    outcome: 'duplicate_noop',
  });
  assert.equal(await tableCount(pool, 'publication_projection_effects'), 1);
});

test('PublicationRolledBack projects metadata without changing the active pointer', async () => {
  pool = await resetDatabase();
  await seedEligiblePublicationContext(pool);
  await publishCandidateRevision(pool, publishCommand());
  await publishCandidateRevision(pool, secondPublishCommand());
  await rollbackPublication(pool, rollbackCommand());
  const before = await readActivePublicationById(
    pool,
    PUBLICATION_IDS.publicationId,
  );
  assert.equal(
    before?.publicationVersionId,
    PUBLICATION_IDS.publicationVersionId,
  );
  const source = await loadJobData(pool, 'PublicationRolledBack');
  const { events, queue, workerConnection } = await publicationHarness();
  const worker = createPublicationProjectionWorker({
    connection: workerConnection,
    pool,
  });
  cleanups.push(async () => worker.close());

  const job = await queue.add(
    'PublicationRolledBack',
    source.jobData,
    { attempts: 1, jobId: source.eventId },
  );
  const result = await job.waitUntilFinished(events, 5_000);

  assert.deepEqual(result, {
    outboxEventId: ROLLBACK_IDS.outboxEventId,
    outcome: 'projected',
  });
  const effect = await pool.query<{
    projected_state: string;
    publication_version_id: string;
  }>(
    `select projected_state, publication_version_id
       from publication_projection_effects
      where outbox_event_id = $1`,
    [ROLLBACK_IDS.outboxEventId],
  );
  assert.deepEqual(effect.rows[0], {
    projected_state: 'rolled_back',
    publication_version_id: PUBLICATION_IDS.publicationVersionId,
  });
  assert.deepEqual(
    await readActivePublicationById(pool, PUBLICATION_IDS.publicationId),
    before,
  );
});

test('Publication projection rejects malformed authoritative events', async () => {
  pool = await resetDatabase();
  const eventId = randomUUID();
  const publicationId = randomUUID();
  await pool.query(
    `insert into outbox_events
      (outbox_event_id, aggregate_type, aggregate_id, event_type,
       payload, correlation_id)
     values ($1, 'Publication', $2, 'PublicationPublished',
             $3::jsonb, $4)`,
    [
      eventId,
      publicationId,
      JSON.stringify({
        activationId: randomUUID(),
        candidateId: randomUUID(),
        candidateRevisionId: randomUUID(),
        eligibilityEvaluationId: randomUUID(),
        eligibilityPolicyRevisionId: randomUUID(),
        payloadHash: 'a'.repeat(64),
        publicationId,
        publicationVersionId: randomUUID(),
        versionNumber: 1,
      }),
      randomUUID(),
    ],
  );
  const { events, queue, workerConnection } = await publicationHarness();
  const worker = createPublicationProjectionWorker({
    connection: workerConnection,
    pool,
  });
  cleanups.push(async () => worker.close());
  const jobData: OutboxJobData = {
    aggregateId: randomUUID(),
    aggregateType: 'tampered',
    correlationId: randomUUID(),
    eventType: 'PublicationPublished',
    outboxEventId: eventId,
    payload: {},
  };

  const job = await queue.add(
    'PublicationPublished',
    jobData,
    { attempts: 1, jobId: eventId },
  );
  await assert.rejects(
    job.waitUntilFinished(events, 5_000),
    /INVALID_PUBLICATION_SOURCE_EVENT/,
  );
  assert.equal(await tableCount(pool, 'publication_projection_effects'), 0);
  const attempt = await pool.query<{ error_code: string }>(
    `select error_code
       from worker_job_attempts
      where outbox_event_id = $1`,
    [eventId],
  );
  assert.equal(
    attempt.rows[0]?.error_code,
    'PUBLICATION_PROJECTION_FAILED',
  );
});

test('Publication projection rejects Eligibility events', async () => {
  pool = await resetDatabase();
  const eventId = randomUUID();
  await pool.query(
    `insert into outbox_events
      (outbox_event_id, aggregate_type, aggregate_id, event_type,
       payload, correlation_id)
     values ($1, 'candidate_revision', $2,
             'ModerationDecisionRecorded', '{}'::jsonb, $3)`,
    [eventId, randomUUID(), randomUUID()],
  );
  const { events, queue, workerConnection } = await publicationHarness();
  const worker = createPublicationProjectionWorker({
    connection: workerConnection,
    pool,
  });
  cleanups.push(async () => worker.close());
  const jobData: OutboxJobData = {
    aggregateId: randomUUID(),
    aggregateType: 'candidate_revision',
    correlationId: randomUUID(),
    eventType: 'ModerationDecisionRecorded',
    outboxEventId: eventId,
    payload: {},
  };

  const job = await queue.add(
    'ModerationDecisionRecorded',
    jobData,
    { attempts: 1, jobId: eventId },
  );
  await assert.rejects(
    job.waitUntilFinished(events, 5_000),
    /UNSUPPORTED_PUBLICATION_EVENT/,
  );
  assert.equal(await tableCount(pool, 'publication_projection_effects'), 0);
});
