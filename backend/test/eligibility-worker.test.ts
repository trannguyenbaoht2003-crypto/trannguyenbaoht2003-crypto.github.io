import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterEach, test } from 'node:test';

import { Queue, QueueEvents } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Pool } from 'pg';

import {
  readCandidateEligibilityStatus,
} from '../src/modules/eligibility/read-candidate-eligibility-status.js';
import {
  recordCandidateModerationDecision,
} from '../src/modules/moderation/record-candidate-moderation-decision.js';
import {
  createQueueConnection,
  createWorkerConnection,
} from '../src/queue/connection.js';
import {
  createEligibilityWorker,
} from '../src/queue/eligibility-worker.js';
import {
  ELIGIBILITY_QUEUE_NAME,
  type OutboxJobData,
} from '../src/queue/names.js';
import { CANDIDATE_IDS } from './helpers/candidate.js';
import { resetDatabase, tableCount } from './helpers/database.js';
import {
  moderationDecisionCommand,
  seedActivatedGateContext,
  seedSatisfiedReviewQuorum,
} from './helpers/gate.js';
import { seedTrustCandidate } from './helpers/trust.js';

function testRedisUrl(): string {
  const value = process.env.TEST_REDIS_URL;
  if (!value) {
    throw new Error(
      'TEST_REDIS_URL is required for Eligibility worker tests',
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

async function eligibilityHarness() {
  const queueConnection = createQueueConnection(redisUrl);
  const eventsConnection = createWorkerConnection(redisUrl);
  const workerConnection = createWorkerConnection(redisUrl);
  const queue = new Queue<OutboxJobData>(ELIGIBILITY_QUEUE_NAME, {
    connection: queueConnection,
  });
  const events = new QueueEvents(ELIGIBILITY_QUEUE_NAME, {
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

async function loadSourceEvent(
  database: Pool,
  eventType: string,
): Promise<{ eventId: string; jobData: OutboxJobData }> {
  const event = await database.query<{
    outbox_event_id: string;
  }>(
    `select outbox_event_id
       from outbox_events
      where event_type = $1
      order by created_at desc
      limit 1`,
    [eventType],
  );
  const eventId = event.rows[0]!.outbox_event_id;
  return {
    eventId,
    jobData: {
      aggregateId: randomUUID(),
      aggregateType: 'tampered',
      correlationId: randomUUID(),
      eventType,
      outboxEventId: eventId,
      payload: {
        candidateId: randomUUID(),
        candidateRevisionId: randomUUID(),
        eligibilityPolicyRevisionId: randomUUID(),
      },
    },
  };
}

test('Eligibility worker reloads PostgreSQL authority and ignores tampered Redis trust fields', async () => {
  pool = await resetDatabase();
  await seedActivatedGateContext(pool);
  await seedSatisfiedReviewQuorum(pool);
  await recordCandidateModerationDecision(
    pool,
    moderationDecisionCommand(),
  );
  const source = await loadSourceEvent(
    pool,
    'ModerationDecisionRecorded',
  );
  const { events, queue, workerConnection } = await eligibilityHarness();
  const worker = createEligibilityWorker({
    connection: workerConnection,
    pool,
  });
  cleanups.push(async () => worker.close());

  const job = await queue.add(
    'ModerationDecisionRecorded',
    source.jobData,
    { attempts: 1, jobId: source.eventId },
  );
  const result = await job.waitUntilFinished(events, 5_000);

  assert.deepEqual(result, {
    candidateRevisionId: CANDIDATE_IDS.candidateRevisionId,
    outcome: 'evaluated',
  });
  const status = await readCandidateEligibilityStatus(
    pool,
    CANDIDATE_IDS.candidateId,
    CANDIDATE_IDS.candidateRevisionId,
  );
  assert.equal(status.outcome, 'eligible');
  assert.equal(status.stale, false);
  assert.equal(await tableCount(pool, 'eligibility_recalculation_effects'), 1);
});

test('Eligibility duplicate delivery is a no-op with one immutable evaluation', async () => {
  pool = await resetDatabase();
  await seedActivatedGateContext(pool);
  await seedSatisfiedReviewQuorum(pool);
  await recordCandidateModerationDecision(
    pool,
    moderationDecisionCommand(),
  );
  const source = await loadSourceEvent(
    pool,
    'ModerationDecisionRecorded',
  );
  const { events, queue, workerConnection } = await eligibilityHarness();
  const worker = createEligibilityWorker({
    connection: workerConnection,
    pool,
  });
  cleanups.push(async () => worker.close());

  const first = await queue.add(
    'ModerationDecisionRecorded',
    source.jobData,
    { attempts: 1, jobId: source.eventId, removeOnComplete: true },
  );
  await first.waitUntilFinished(events, 5_000);
  const second = await queue.add(
    'ModerationDecisionRecorded',
    source.jobData,
    { attempts: 1, jobId: source.eventId },
  );
  const replay = await second.waitUntilFinished(events, 5_000);

  assert.deepEqual(replay, {
    candidateRevisionId: CANDIDATE_IDS.candidateRevisionId,
    outcome: 'duplicate_noop',
  });
  assert.equal(
    await tableCount(pool, 'candidate_eligibility_evaluations'),
    1,
  );
  assert.equal(await tableCount(pool, 'eligibility_recalculation_effects'), 1);
});

test('Eligibility worker returns not_evaluable_yet before a gate policy is active', async () => {
  pool = await resetDatabase();
  await seedTrustCandidate(pool);
  const source = await loadSourceEvent(pool, 'CandidateRegistered');
  const { events, queue, workerConnection } = await eligibilityHarness();
  const worker = createEligibilityWorker({
    connection: workerConnection,
    pool,
  });
  cleanups.push(async () => worker.close());

  const job = await queue.add(
    'CandidateRegistered',
    source.jobData,
    { attempts: 1, jobId: source.eventId },
  );
  const result = await job.waitUntilFinished(events, 5_000);

  assert.deepEqual(result, {
    candidateRevisionId: CANDIDATE_IDS.candidateRevisionId,
    outcome: 'not_evaluable_yet',
  });
  assert.equal(
    await tableCount(pool, 'candidate_eligibility_evaluations'),
    0,
  );
});

test('Eligibility worker rejects a malformed authoritative source event', async () => {
  pool = await resetDatabase();
  await seedTrustCandidate(pool);
  const eventId = randomUUID();
  await pool.query(
    `insert into outbox_events
      (outbox_event_id, aggregate_type, aggregate_id, event_type,
       payload, correlation_id, delivery_state, delivered_at)
     values ($1, 'candidate_revision', $2,
             'ModerationDecisionRecorded', $3::jsonb, $4,
             'delivered', clock_timestamp())`,
    [
      eventId,
      CANDIDATE_IDS.candidateRevisionId,
      JSON.stringify({ candidateRevisionId: randomUUID() }),
      randomUUID(),
    ],
  );
  const { events, queue, workerConnection } = await eligibilityHarness();
  const worker = createEligibilityWorker({
    connection: workerConnection,
    pool,
  });
  cleanups.push(async () => worker.close());
  const jobData: OutboxJobData = {
    aggregateId: randomUUID(),
    aggregateType: 'tampered',
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
    /INVALID_ELIGIBILITY_SOURCE_EVENT/,
  );
  const attempt = await pool.query<{ error_code: string }>(
    `select error_code
       from worker_job_attempts
      where outbox_event_id = $1`,
    [eventId],
  );
  assert.equal(
    attempt.rows[0]?.error_code,
    'ELIGIBILITY_EVALUATION_FAILED',
  );
});
