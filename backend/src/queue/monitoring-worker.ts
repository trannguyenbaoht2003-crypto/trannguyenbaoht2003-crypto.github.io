import { Worker, type Job } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Pool, PoolClient } from 'pg';

import { withTransaction } from '../database/transaction.js';
import {
  evaluatePublicationMonitoring,
} from '../modules/monitoring/evaluate-publication-monitoring.js';
import type {
  PublicationMonitoringAlertCode,
} from '../modules/monitoring/types.js';
import { requireUuid } from '../modules/trust/normalize-trust-input.js';
import {
  MONITORING_QUEUE_NAME,
  type OutboxJobData,
} from './names.js';

const INPUT_EVENTS = new Set([
  'CandidateEligibilityEvaluated',
  'PublicationMonitoringRequested',
]);
const OUTPUT_EVENTS = new Set([
  'PublicationMonitoringAlertOpened',
  'PublicationMonitoringAlertResolved',
]);
const MONITORING_EVENTS = new Set([
  ...INPUT_EVENTS,
  ...OUTPUT_EVENTS,
]);
const ALERT_CODES = new Set<PublicationMonitoringAlertCode>([
  'ACTIVE_PUBLICATION_REVALIDATION_REQUIRED',
  'ACTIVE_PUBLICATION_NEEDS_REVIEW',
  'ACTIVE_PUBLICATION_INELIGIBLE',
]);

export interface MonitoringWorkerResult {
  outboxEventId: string;
  outcome: 'evaluated' | 'not_applicable' | 'duplicate_noop' | 'delivered';
}

export interface CreateMonitoringWorkerOptions {
  concurrency?: number;
  connection: Redis;
  pool: Pool;
}

interface PersistedOutputEvent {
  aggregate_id: string;
  aggregate_type: string;
  event_type: string;
  payload: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  return actual.length === canonical.length
    && actual.every((key, index) => key === canonical[index]);
}

function invalidOutput(error?: unknown): never {
  throw new Error('INVALID_PUBLICATION_MONITORING_OUTPUT_EVENT', {
    cause: error,
  });
}

function validateJobEnvelope(job: Job<OutboxJobData>): string {
  if (!MONITORING_EVENTS.has(job.name)) {
    throw new Error('UNSUPPORTED_MONITORING_EVENT');
  }
  if (!job.id) {
    throw new Error('MONITORING_JOB_ID_REQUIRED');
  }
  if (job.data.outboxEventId !== job.id) {
    throw new Error('OUTBOX_JOB_ID_MISMATCH');
  }
  try {
    return requireUuid(job.id, 'outboxEventId');
  } catch (error) {
    throw new Error('MONITORING_JOB_ID_INVALID', { cause: error });
  }
}

function requirePayloadUuid(
  payload: Record<string, unknown>,
  key: string,
): string {
  const value = payload[key];
  if (typeof value !== 'string') {
    invalidOutput();
  }
  try {
    return requireUuid(value, key);
  } catch (error) {
    invalidOutput(error);
  }
}

function requireAlertCode(value: unknown): PublicationMonitoringAlertCode {
  if (typeof value !== 'string' || !ALERT_CODES.has(value as PublicationMonitoringAlertCode)) {
    invalidOutput();
  }
  return value as PublicationMonitoringAlertCode;
}

async function deliverAlertOutput(
  client: PoolClient,
  outboxEventId: string,
  expectedEventType: string,
): Promise<'delivered' | 'duplicate_noop'> {
  const source = await client.query<PersistedOutputEvent>(
    `select aggregate_id, aggregate_type, event_type, payload
       from outbox_events
      where outbox_event_id = $1
      for key share`,
    [outboxEventId],
  );
  const row = source.rows[0];
  if (
    !row
    || row.event_type !== expectedEventType
    || !OUTPUT_EVENTS.has(row.event_type)
    || row.aggregate_type !== 'publication_monitoring_alert'
    || !isRecord(row.payload)
    || !exactKeys(row.payload, [
      'alertCode',
      'publicationId',
      'publicationMonitoringAlertEventId',
      'schemaVersion',
      'state',
    ])
    || row.payload.schemaVersion !== 1
  ) {
    invalidOutput();
  }

  const alertEventId = requirePayloadUuid(
    row.payload,
    'publicationMonitoringAlertEventId',
  );
  const publicationId = requirePayloadUuid(row.payload, 'publicationId');
  const alertCode = requireAlertCode(row.payload.alertCode);
  const expectedState = expectedEventType === 'PublicationMonitoringAlertOpened'
    ? 'open'
    : 'resolved';
  if (
    row.aggregate_id !== alertEventId
    || row.payload.state !== expectedState
  ) {
    invalidOutput();
  }

  const authority = await client.query(
    `select 1
       from publication_monitoring_alert_events
      where publication_monitoring_alert_event_id = $1
        and publication_id = $2
        and alert_code = $3
        and state = $4
        and outbox_event_id = $5`,
    [
      alertEventId,
      publicationId,
      alertCode,
      expectedState,
      outboxEventId,
    ],
  );
  if (authority.rowCount !== 1) {
    invalidOutput();
  }

  const replay = await client.query(
    `select 1
       from publication_monitoring_delivery_effects
      where outbox_event_id = $1`,
    [outboxEventId],
  );
  if (replay.rowCount === 1) {
    return 'duplicate_noop';
  }

  await client.query(
    `insert into publication_monitoring_delivery_effects
       (outbox_event_id, publication_monitoring_alert_event_id,
        publication_id, event_type)
     values ($1, $2, $3, $4)`,
    [outboxEventId, alertEventId, publicationId, expectedEventType],
  );
  return 'delivered';
}

async function processMonitoringJob(
  pool: Pool,
  job: Job<OutboxJobData>,
): Promise<MonitoringWorkerResult> {
  const outboxEventId = validateJobEnvelope(job);

  if (INPUT_EVENTS.has(job.name)) {
    const expectedEventType = job.name as
      | 'CandidateEligibilityEvaluated'
      | 'PublicationMonitoringRequested';
    const result = await evaluatePublicationMonitoring(pool, {
      sourceOutboxEventId: outboxEventId,
      expectedEventType,
    });
    return {
      outboxEventId,
      outcome: result.outcome,
    };
  }

  const outcome = await withTransaction(pool, async (client) => (
    deliverAlertOutput(client, outboxEventId, job.name)
  ));
  return { outboxEventId, outcome };
}

export function createMonitoringWorker(
  options: CreateMonitoringWorkerOptions,
): Worker<OutboxJobData, MonitoringWorkerResult> {
  return new Worker<OutboxJobData, MonitoringWorkerResult>(
    MONITORING_QUEUE_NAME,
    async (job) => processMonitoringJob(options.pool, job),
    {
      concurrency: options.concurrency ?? 1,
      connection: options.connection,
    },
  );
}
