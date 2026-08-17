import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterEach, test } from 'node:test';

import { Queue, QueueEvents } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Pool } from 'pg';

import {
  recordCandidateModerationDecision,
} from '../src/modules/moderation/record-candidate-moderation-decision.js';
import {
  publishCandidateRevision,
} from '../src/modules/publication/publish-candidate-revision.js';
import type {
  PublishCandidateRevisionCommand,
} from '../src/modules/publication/types.js';
import {
  createQueueConnection,
  createWorkerConnection,
} from '../src/queue/connection.js';
import {
  MONITORING_QUEUE_NAME,
  type OutboxJobData,
} from '../src/queue/names.js';
import {
  createMonitoringWorker,
} from '../src/queue/monitoring-worker.js';
import { resetDatabase, tableCount } from './helpers/database.js';
import {
  GATE_IDS,
  moderationDecisionCommand,
} from './helpers/gate.js';
import {
  PUBLICATION_IDS,
  seedEligiblePublicationContext,
} from './helpers/publication.js';

const STALE_IDS = {
  inputSnapshotId: '7d000000-0000-4000-8000-000000000001',
  decisionId: '7d000000-0000-4000-8000-000000000002',
} as const;

function testRedisUrl(): string {
  const value = process.env.TEST_REDIS_URL;
  if (!value) {
    throw new Error('TEST_REDIS_URL is required for monitoring worker tests');
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

async function monitoringHarness() {
  const queueConnection = createQueueConnection(redisUrl);
  const eventsConnection = createWorkerConnection(redisUrl);
  const workerConnection = createWorkerConnection(redisUrl);
  const queue = new Queue<OutboxJobData>(MONITORING_QUEUE_NAME, {
    connection: queueConnection,
  });
  const events = new QueueEvents(MONITORING_QUEUE_NAME, {
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

function publishCommand(): PublishCandidateRevisionCommand {
  return {
    publicationId: PUBLICATION_IDS.publicationId,
    publicationVersionId: PUBLICATION_IDS.publicationVersionId,
    activationId: PUBLICATION_IDS.activationId,
    candidateRevisionId: '62000000-0000-4000-8000-000000000002',
    expectedActiveEligibilityPolicyRevisionId: GATE_IDS.eligibilityPolicyId,
    expectedEligibilityEvaluationId: GATE_IDS.eligibilityEvaluationId,
    expectedModerationDecisionId: GATE_IDS.moderationDecisionId,
    expectedActivePublicationVersionId: null,
    authorization: {
      actorId: 'publication-editor',
      permissions: ['publisher'],
    },
    auditId: PUBLICATION_IDS.auditId,
    outboxEventId: PUBLICATION_IDS.outboxEventId,
    correlationId: 'monitoring-worker-publish',
    idempotencyKey: 'monitoring-worker-publish',
    occurredAt: '2026-08-14T09:20:00.000Z',
  };
}

async function outboxId(
  database: Pool,
  eventType: string,
): Promise<string> {
  const result = await database.query<{ outbox_event_id: string }>(
    `select outbox_event_id
       from outbox_events
      where event_type = $1
      order by created_at desc, outbox_event_id desc
      limit 1`,
    [eventType],
  );
  const value = result.rows[0]?.outbox_event_id;
  assert.ok(value, `missing ${eventType} outbox event`);
  return value;
}

function tamperedJobData(
  eventType: string,
  eventId: string,
): OutboxJobData {
  return {
    aggregateId: randomUUID(),
    aggregateType: 'tampered',
    correlationId: randomUUID(),
    eventType,
    outboxEventId: eventId,
    payload: { tampered: true },
  };
}

test('monitoring worker reloads PostgreSQL lifecycle authority instead of trusting the queue payload', async () => {
  pool = await resetDatabase();
  await seedEligiblePublicationContext(pool);
  await publishCandidateRevision(pool, publishCommand());
  const sourceId = await outboxId(pool, 'PublicationMonitoringRequested');

  const { events, queue, workerConnection } = await monitoringHarness();
  const worker = createMonitoringWorker({ connection: workerConnection, pool });
  cleanups.push(async () => worker.close());

  const job = await queue.add(
    'PublicationMonitoringRequested',
    tamperedJobData('PublicationMonitoringRequested', sourceId),
    { jobId: sourceId, removeOnComplete: false, removeOnFail: false },
  );
  const result = await job.waitUntilFinished(events, 15_000);
  assert.equal(result.outcome, 'evaluated');
  assert.equal(result.outboxEventId, sourceId);
  assert.equal(await tableCount(pool, 'publication_monitoring_effects'), 1);
  assert.equal(await tableCount(pool, 'publication_monitoring_evaluations'), 1);
  assert.equal(await tableCount(pool, 'publication_monitoring_alert_events'), 0);
});

test('monitoring alert output delivery is terminal and replay-safe', async () => {
  pool = await resetDatabase();
  await seedEligiblePublicationContext(pool);
  await publishCandidateRevision(pool, publishCommand());
  await recordCandidateModerationDecision(pool, moderationDecisionCommand({
    correlationId: 'monitoring-worker-stale-moderation',
    decisionId: STALE_IDS.decisionId,
    evaluatedAt: '2026-08-14T09:21:00.000Z',
    idempotencyKey: 'monitoring-worker-stale-moderation',
    inputSnapshotId: STALE_IDS.inputSnapshotId,
    outcome: 'clear',
    reason: 'Make the published Eligibility snapshot stale for monitoring.',
  }));
  const lifecycleId = await outboxId(pool, 'PublicationMonitoringRequested');

  const { events, queue, workerConnection } = await monitoringHarness();
  const worker = createMonitoringWorker({ connection: workerConnection, pool });
  cleanups.push(async () => worker.close());
  const inputJob = await queue.add(
    'PublicationMonitoringRequested',
    tamperedJobData('PublicationMonitoringRequested', lifecycleId),
    { jobId: lifecycleId, removeOnComplete: false, removeOnFail: false },
  );
  await inputJob.waitUntilFinished(events, 15_000);

  const outputId = await outboxId(pool, 'PublicationMonitoringAlertOpened');
  const outputJob = await queue.add(
    'PublicationMonitoringAlertOpened',
    tamperedJobData('PublicationMonitoringAlertOpened', outputId),
    { jobId: outputId, removeOnComplete: false, removeOnFail: false },
  );
  const delivered = await outputJob.waitUntilFinished(events, 15_000);
  assert.equal(delivered.outcome, 'delivered');
  assert.equal(await tableCount(pool, 'publication_monitoring_delivery_effects'), 1);
  assert.equal(Number((await pool.query<{ count: string }>(
    `select count(*) from outbox_events
      where event_type like 'PublicationMonitoringAlert%'`,
  )).rows[0]?.count ?? 0), 1);

  await outputJob.remove();
  const replayJob = await queue.add(
    'PublicationMonitoringAlertOpened',
    tamperedJobData('PublicationMonitoringAlertOpened', outputId),
    { jobId: outputId, removeOnComplete: false, removeOnFail: false },
  );
  const replay = await replayJob.waitUntilFinished(events, 15_000);
  assert.equal(replay.outcome, 'duplicate_noop');
  assert.equal(await tableCount(pool, 'publication_monitoring_delivery_effects'), 1);
});

test('monitoring worker rejects mismatched job and outbox identities', async () => {
  pool = await resetDatabase();
  await seedEligiblePublicationContext(pool);
  await publishCandidateRevision(pool, publishCommand());
  const sourceId = await outboxId(pool, 'PublicationMonitoringRequested');
  const { events, queue, workerConnection } = await monitoringHarness();
  const worker = createMonitoringWorker({ connection: workerConnection, pool });
  cleanups.push(async () => worker.close());

  const jobId = randomUUID();
  const job = await queue.add(
    'PublicationMonitoringRequested',
    tamperedJobData('PublicationMonitoringRequested', sourceId),
    { jobId, removeOnComplete: false, removeOnFail: false, attempts: 1 },
  );
  await assert.rejects(job.waitUntilFinished(events, 15_000), /OUTBOX_JOB_ID_MISMATCH/);
  assert.equal(await tableCount(pool, 'publication_monitoring_effects'), 0);
});
