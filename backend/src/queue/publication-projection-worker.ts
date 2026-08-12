import { randomUUID } from 'node:crypto';

import { Worker, type Job } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Pool, PoolClient } from 'pg';

import { withTransaction } from '../database/transaction.js';
import { requireUuid } from '../modules/trust/normalize-trust-input.js';
import {
  PUBLICATION_QUEUE_NAME,
  type OutboxJobData,
} from './names.js';

const PUBLICATION_EVENTS = new Set([
  'PublicationPublished',
  'PublicationRolledBack',
]);
const PUBLISHED_PAYLOAD_KEYS = [
  'activationId',
  'candidateId',
  'candidateRevisionId',
  'eligibilityEvaluationId',
  'eligibilityPolicyRevisionId',
  'payloadHash',
  'publicationId',
  'publicationVersionId',
  'versionNumber',
] as const;
const ROLLBACK_PAYLOAD_KEYS = [
  ...PUBLISHED_PAYLOAD_KEYS,
  'previousActivePublicationVersionId',
] as const;

interface PublicationSourceRow {
  activation_id: string;
  activation_kind: 'published' | 'rolled_back';
  activated_at: Date;
  activation_correlation_id: string;
  aggregate_id: string;
  aggregate_type: string;
  candidate_eligibility_evaluation_id: string;
  candidate_id: string;
  candidate_revision_id: string;
  eligibility_policy_revision_id: string;
  event_correlation_id: string;
  event_type: string;
  from_publication_version_id: string | null;
  payload: unknown;
  payload_hash: string;
  publication_id: string;
  publication_version_id: string;
  version_number: number;
}

interface PublicationProjectionSource {
  eventType: 'PublicationPublished' | 'PublicationRolledBack';
  outboxEventId: string;
  projectedAt: Date;
  projectedState: 'active' | 'rolled_back';
  publicationId: string;
  publicationVersionId: string;
}

interface ExistingProjectionEffect {
  event_type: string;
  projected_at: Date;
  projected_state: string;
  publication_id: string;
  publication_version_id: string;
}

interface WorkerAttemptContext {
  attemptNumber: number;
  jobId: string;
  outboxEventId: string;
}

export interface PublicationProjectionWorkerResult {
  outboxEventId: string;
  outcome: 'projected' | 'duplicate_noop';
}

export interface CreatePublicationProjectionWorkerOptions {
  concurrency?: number;
  connection: Redis;
  pool: Pool;
}

function compareCanonical(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function requireExactKeys(
  value: unknown,
  expectedKeys: readonly string[],
): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    invalidSource();
  }
  const actual = Object.keys(value).sort(compareCanonical);
  const expected = [...expectedKeys].sort(compareCanonical);
  if (
    actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])
  ) {
    invalidSource();
  }
}

function requireUuidValue(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    invalidSource();
  }
  try {
    return requireUuid(value, field);
  } catch (error) {
    invalidSource(error);
  }
}

function requirePayloadHash(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    invalidSource();
  }
  return value;
}

function requireVersionNumber(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    invalidSource();
  }
  return value as number;
}

function sameTimestamp(left: Date, right: Date): boolean {
  return left.getTime() === right.getTime();
}

function invalidSource(error?: unknown): never {
  throw new Error('INVALID_PUBLICATION_SOURCE_EVENT', {
    cause: error,
  });
}

function validateJobEnvelope(job: Job<OutboxJobData>): string {
  if (!PUBLICATION_EVENTS.has(job.name)) {
    throw new Error('UNSUPPORTED_PUBLICATION_EVENT');
  }
  if (!job.id) {
    throw new Error('PUBLICATION_JOB_ID_REQUIRED');
  }
  if (job.data.outboxEventId !== job.id) {
    throw new Error('OUTBOX_JOB_ID_MISMATCH');
  }
  try {
    return requireUuid(job.id, 'outboxEventId');
  } catch (error) {
    invalidSource(error);
  }
}

function validateSourceRow(
  row: PublicationSourceRow,
  outboxEventId: string,
  expectedEventType: string,
): PublicationProjectionSource {
  if (
    row.event_type !== expectedEventType
    || !PUBLICATION_EVENTS.has(row.event_type)
    || row.aggregate_type !== 'Publication'
    || row.aggregate_id !== row.publication_id
    || row.event_correlation_id !== row.activation_correlation_id
  ) {
    invalidSource();
  }

  const expectedPayloadKeys = row.event_type === 'PublicationPublished'
    ? PUBLISHED_PAYLOAD_KEYS
    : ROLLBACK_PAYLOAD_KEYS;
  requireExactKeys(row.payload, expectedPayloadKeys);
  const payload = row.payload;
  const activationId = requireUuidValue(payload.activationId, 'activationId');
  const candidateId = requireUuidValue(payload.candidateId, 'candidateId');
  const candidateRevisionId = requireUuidValue(
    payload.candidateRevisionId,
    'candidateRevisionId',
  );
  const eligibilityEvaluationId = requireUuidValue(
    payload.eligibilityEvaluationId,
    'eligibilityEvaluationId',
  );
  const eligibilityPolicyRevisionId = requireUuidValue(
    payload.eligibilityPolicyRevisionId,
    'eligibilityPolicyRevisionId',
  );
  const publicationId = requireUuidValue(
    payload.publicationId,
    'publicationId',
  );
  const publicationVersionId = requireUuidValue(
    payload.publicationVersionId,
    'publicationVersionId',
  );
  const payloadHash = requirePayloadHash(payload.payloadHash);
  const versionNumber = requireVersionNumber(payload.versionNumber);

  if (
    activationId !== row.activation_id
    || candidateId !== row.candidate_id
    || candidateRevisionId !== row.candidate_revision_id
    || eligibilityEvaluationId
       !== row.candidate_eligibility_evaluation_id
    || eligibilityPolicyRevisionId
       !== row.eligibility_policy_revision_id
    || publicationId !== row.publication_id
    || publicationVersionId !== row.publication_version_id
    || payloadHash !== row.payload_hash
    || versionNumber !== row.version_number
  ) {
    invalidSource();
  }

  if (row.event_type === 'PublicationPublished') {
    if (row.activation_kind !== 'published') {
      invalidSource();
    }
    return {
      eventType: 'PublicationPublished',
      outboxEventId,
      projectedAt: row.activated_at,
      projectedState: 'active',
      publicationId,
      publicationVersionId,
    };
  }

  const previousActivePublicationVersionId = requireUuidValue(
    payload.previousActivePublicationVersionId,
    'previousActivePublicationVersionId',
  );
  if (
    row.activation_kind !== 'rolled_back'
    || row.from_publication_version_id
       !== previousActivePublicationVersionId
  ) {
    invalidSource();
  }
  return {
    eventType: 'PublicationRolledBack',
    outboxEventId,
    projectedAt: row.activated_at,
    projectedState: 'rolled_back',
    publicationId,
    publicationVersionId,
  };
}

async function loadPublicationSource(
  client: PoolClient,
  outboxEventId: string,
  expectedEventType: string,
): Promise<PublicationProjectionSource> {
  const result = await client.query<PublicationSourceRow>(
    `select event.aggregate_type,
            event.aggregate_id,
            event.event_type,
            event.payload,
            event.correlation_id as event_correlation_id,
            activation.activation_id,
            activation.activation_kind,
            activation.from_publication_version_id,
            activation.activated_at,
            activation.correlation_id as activation_correlation_id,
            version.publication_id,
            version.publication_version_id,
            version.candidate_id,
            version.candidate_revision_id,
            version.eligibility_policy_revision_id,
            version.candidate_eligibility_evaluation_id,
            version.payload_hash,
            version.version_number
       from outbox_events event
       join publication_activation_history activation
         on activation.outbox_event_id = event.outbox_event_id
       join publication_versions version
         on version.publication_version_id =
            activation.to_publication_version_id
        and version.publication_id = activation.publication_id
      where event.outbox_event_id = $1
      for key share of event, activation, version`,
    [outboxEventId],
  );
  const row = result.rows[0];
  if (!row) {
    invalidSource();
  }
  return validateSourceRow(row, outboxEventId, expectedEventType);
}

function projectionMatches(
  effect: ExistingProjectionEffect,
  source: PublicationProjectionSource,
): boolean {
  return effect.event_type === source.eventType
    && effect.projected_state === source.projectedState
    && effect.publication_id === source.publicationId
    && effect.publication_version_id === source.publicationVersionId
    && sameTimestamp(effect.projected_at, source.projectedAt);
}

async function recordAttempt(
  client: PoolClient,
  context: WorkerAttemptContext,
  status: 'succeeded' | 'duplicate_noop',
): Promise<void> {
  await client.query(
    `insert into worker_job_attempts
      (worker_job_attempt_id, queue_name, job_id, attempt_number,
       outbox_event_id, status)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (queue_name, job_id, attempt_number) do nothing`,
    [
      randomUUID(),
      PUBLICATION_QUEUE_NAME,
      context.jobId,
      context.attemptNumber,
      context.outboxEventId,
      status,
    ],
  );
}

async function recordRetryableFailure(
  pool: Pool,
  context: WorkerAttemptContext,
): Promise<void> {
  try {
    await pool.query(
      `insert into worker_job_attempts
        (worker_job_attempt_id, queue_name, job_id, attempt_number,
         outbox_event_id, status, error_code)
       values ($1, $2, $3, $4, $5, 'failed_retryable',
               'PUBLICATION_PROJECTION_FAILED')
       on conflict (queue_name, job_id, attempt_number) do nothing`,
      [
        randomUUID(),
        PUBLICATION_QUEUE_NAME,
        context.jobId,
        context.attemptNumber,
        context.outboxEventId,
      ],
    );
  } catch {
    // BullMQ still receives the original error if PostgreSQL cannot record it.
  }
}

async function applyProjection(
  client: PoolClient,
  source: PublicationProjectionSource,
  context: WorkerAttemptContext,
): Promise<'projected' | 'duplicate_noop'> {
  const inserted = await client.query(
    `insert into publication_projection_effects
      (outbox_event_id, publication_id, publication_version_id,
       event_type, projected_state, projected_at)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (outbox_event_id) do nothing
     returning outbox_event_id`,
    [
      source.outboxEventId,
      source.publicationId,
      source.publicationVersionId,
      source.eventType,
      source.projectedState,
      source.projectedAt,
    ],
  );
  if (inserted.rowCount === 1) {
    await recordAttempt(client, context, 'succeeded');
    return 'projected';
  }

  const existing = await client.query<ExistingProjectionEffect>(
    `select publication_id, publication_version_id, event_type,
            projected_state, projected_at
       from publication_projection_effects
      where outbox_event_id = $1
      for key share`,
    [source.outboxEventId],
  );
  const effect = existing.rows[0];
  if (!effect || !projectionMatches(effect, source)) {
    invalidSource();
  }
  await recordAttempt(client, context, 'duplicate_noop');
  return 'duplicate_noop';
}

export function createPublicationProjectionWorker(
  options: CreatePublicationProjectionWorkerOptions,
): Worker<OutboxJobData, PublicationProjectionWorkerResult> {
  return new Worker<OutboxJobData, PublicationProjectionWorkerResult>(
    PUBLICATION_QUEUE_NAME,
    async (job) => {
      const jobId = validateJobEnvelope(job);
      const context: WorkerAttemptContext = {
        attemptNumber: job.attemptsMade + 1,
        jobId,
        outboxEventId: job.data.outboxEventId,
      };

      try {
        const outcome = await withTransaction(options.pool, async (client) => {
          const source = await loadPublicationSource(
            client,
            context.outboxEventId,
            job.name,
          );
          return applyProjection(client, source, context);
        });
        return {
          outboxEventId: context.outboxEventId,
          outcome,
        };
      } catch (error) {
        await recordRetryableFailure(options.pool, context);
        throw error;
      }
    },
    {
      concurrency: options.concurrency ?? 1,
      connection: options.connection,
    },
  );
}
