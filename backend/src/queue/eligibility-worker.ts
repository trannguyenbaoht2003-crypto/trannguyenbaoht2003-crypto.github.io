import { createHash, randomUUID } from 'node:crypto';

import { Worker, type Job } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Pool, PoolClient } from 'pg';

import { withTransaction } from '../database/transaction.js';
import {
  evaluateCandidateEligibility,
} from '../modules/eligibility/evaluate-candidate-eligibility.js';
import { requireUuid } from '../modules/trust/normalize-trust-input.js';
import {
  ELIGIBILITY_QUEUE_NAME,
  type OutboxJobData,
} from './names.js';

const ELIGIBILITY_EVENTS = new Set([
  'CandidateRegistered',
  'CandidateRevisionRegistered',
  'CandidateProvenanceAdded',
  'CandidateClaimSetDefined',
  'ClaimEvidenceDecisionRecorded',
  'HumanReviewCompleted',
  'ModerationDecisionRecorded',
]);

const CANDIDATE_EVENTS = new Set([
  'CandidateRegistered',
  'CandidateRevisionRegistered',
  'CandidateProvenanceAdded',
]);

const CANDIDATE_REVISION_EVENTS = new Set([
  'CandidateClaimSetDefined',
  'HumanReviewCompleted',
  'ModerationDecisionRecorded',
]);

const NOT_EVALUABLE_ERRORS = new Set([
  'CANDIDATE_REVISION_NOT_FOUND',
  'CLAIM_SET_NOT_SEALED',
  'ELIGIBILITY_POLICY_NOT_ACTIVE',
  'ELIGIBILITY_REQUIRED_CLAIMS_MISSING',
]);

interface SourceOutboxRow {
  aggregate_id: string;
  aggregate_type: string;
  candidate_id: string | null;
  candidate_revision_id: string | null;
  correlation_id: string;
  created_at: Date;
  event_type: string;
}

interface EligibilitySource {
  candidateId: string;
  candidateRevisionId: string;
  correlationId: string;
  evaluatedAt: string;
  outboxEventId: string;
}

interface WorkerAttemptContext {
  attemptNumber: number;
  jobId: string;
  outboxEventId: string;
}

export interface EligibilityWorkerResult {
  candidateRevisionId: string;
  outcome: 'evaluated' | 'duplicate_noop' | 'not_evaluable_yet';
}

export interface CreateEligibilityWorkerOptions {
  concurrency?: number;
  connection: Redis;
  pool: Pool;
}

function validateJobEnvelope(job: Job<OutboxJobData>): string {
  if (!ELIGIBILITY_EVENTS.has(job.name)) {
    throw new Error('UNSUPPORTED_ELIGIBILITY_EVENT');
  }
  if (!job.id) {
    throw new Error('ELIGIBILITY_JOB_ID_REQUIRED');
  }
  if (job.data.outboxEventId !== job.id) {
    throw new Error('OUTBOX_JOB_ID_MISMATCH');
  }
  return job.id;
}

function deterministicUuid(namespace: string, value: string): string {
  const bytes = Buffer.from(
    createHash('sha256').update(`${namespace}:${value}`).digest('hex').slice(0, 32),
    'hex',
  );
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

function invalidSource(error?: unknown): never {
  throw new Error('INVALID_ELIGIBILITY_SOURCE_EVENT', {
    cause: error,
  });
}

async function loadEligibilitySource(
  client: PoolClient,
  outboxEventId: string,
  expectedEventType: string,
): Promise<EligibilitySource> {
  const result = await client.query<SourceOutboxRow>(
    `select aggregate_id,
            aggregate_type,
            correlation_id,
            event_type,
            created_at,
            payload ->> 'candidateId' as candidate_id,
            payload ->> 'candidateRevisionId' as candidate_revision_id
       from outbox_events
      where outbox_event_id = $1
      for key share`,
    [outboxEventId],
  );
  const row = result.rows[0];
  if (
    !row
    || row.event_type !== expectedEventType
    || !ELIGIBILITY_EVENTS.has(row.event_type)
  ) {
    invalidSource();
  }

  let candidateId: string;
  let candidateRevisionId: string;
  try {
    if (
      typeof row.candidate_id !== 'string'
      || typeof row.candidate_revision_id !== 'string'
    ) {
      invalidSource();
    }
    candidateId = requireUuid(row.candidate_id, 'candidateId');
    candidateRevisionId = requireUuid(
      row.candidate_revision_id,
      'candidateRevisionId',
    );
  } catch (error) {
    invalidSource(error);
  }

  const revision = await client.query(
    `select 1
       from candidate_revisions
      where candidate_revision_id = $1
        and candidate_id = $2`,
    [candidateRevisionId, candidateId],
  );
  if (revision.rowCount !== 1) {
    invalidSource();
  }

  if (CANDIDATE_EVENTS.has(row.event_type)) {
    if (
      row.aggregate_type !== 'candidate'
      || row.aggregate_id !== candidateId
    ) {
      invalidSource();
    }
  } else if (CANDIDATE_REVISION_EVENTS.has(row.event_type)) {
    if (
      row.aggregate_type !== 'candidate_revision'
      || row.aggregate_id !== candidateRevisionId
    ) {
      invalidSource();
    }
  } else if (row.event_type === 'ClaimEvidenceDecisionRecorded') {
    const claim = await client.query(
      `select 1
         from candidate_claims
        where claim_id = $1
          and candidate_revision_id = $2
          and candidate_id = $3`,
      [row.aggregate_id, candidateRevisionId, candidateId],
    );
    if (row.aggregate_type !== 'candidate_claim' || claim.rowCount !== 1) {
      invalidSource();
    }
  } else {
    invalidSource();
  }

  return {
    candidateId,
    candidateRevisionId,
    correlationId: row.correlation_id,
    evaluatedAt: row.created_at.toISOString(),
    outboxEventId,
  };
}

async function loadEffect(
  client: PoolClient,
  outboxEventId: string,
): Promise<{ candidate_revision_id: string } | null> {
  const result = await client.query<{ candidate_revision_id: string }>(
    `select candidate_revision_id
       from eligibility_recalculation_effects
      where outbox_event_id = $1`,
    [outboxEventId],
  );
  return result.rows[0] ?? null;
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
      ELIGIBILITY_QUEUE_NAME,
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
               'ELIGIBILITY_EVALUATION_FAILED')
       on conflict (queue_name, job_id, attempt_number) do nothing`,
      [
        randomUUID(),
        ELIGIBILITY_QUEUE_NAME,
        context.jobId,
        context.attemptNumber,
        context.outboxEventId,
      ],
    );
  } catch {
    // BullMQ still receives the original error if PostgreSQL cannot record it.
  }
}

async function recordNotEvaluable(
  pool: Pool,
  source: EligibilitySource,
  context: WorkerAttemptContext,
  snapshotId: string,
  evaluationId: string,
): Promise<void> {
  await withTransaction(pool, async (client) => {
    await client.query(
      `insert into eligibility_recalculation_effects
        (outbox_event_id, candidate_revision_id, effect_state,
         eligibility_input_snapshot_id,
         candidate_eligibility_evaluation_id)
       values ($1, $2, 'not_evaluable_yet', $3, $4)
       on conflict (outbox_event_id) do nothing`,
      [
        source.outboxEventId,
        source.candidateRevisionId,
        snapshotId,
        evaluationId,
      ],
    );
    await recordAttempt(client, context, 'succeeded');
  });
}

export function createEligibilityWorker(
  options: CreateEligibilityWorkerOptions,
): Worker<OutboxJobData, EligibilityWorkerResult> {
  return new Worker<OutboxJobData, EligibilityWorkerResult>(
    ELIGIBILITY_QUEUE_NAME,
    async (job) => {
      const jobId = validateJobEnvelope(job);
      const context: WorkerAttemptContext = {
        attemptNumber: job.attemptsMade + 1,
        jobId,
        outboxEventId: job.data.outboxEventId,
      };

      try {
        const source = await withTransaction(options.pool, async (client) => {
          const loaded = await loadEligibilitySource(
            client,
            context.outboxEventId,
            job.name,
          );
          const effect = await loadEffect(client, context.outboxEventId);
          if (effect) {
            await recordAttempt(client, context, 'duplicate_noop');
            return {
              duplicate: true as const,
              source: loaded,
            };
          }
          return {
            duplicate: false as const,
            source: loaded,
          };
        });

        if (source.duplicate) {
          return {
            candidateRevisionId: source.source.candidateRevisionId,
            outcome: 'duplicate_noop',
          };
        }

        const snapshotId = deterministicUuid(
          'eligibility-input-snapshot',
          context.outboxEventId,
        );
        const evaluationId = deterministicUuid(
          'candidate-eligibility-evaluation',
          context.outboxEventId,
        );
        let evaluation;
        try {
          evaluation = await evaluateCandidateEligibility(options.pool, {
            actorId: 'eligibility-worker',
            candidateId: source.source.candidateId,
            candidateRevisionId: source.source.candidateRevisionId,
            correlationId: source.source.correlationId,
            evaluatedAt: source.source.evaluatedAt,
            evaluationId,
            idempotencyKey: `eligibility-recalculation:${context.outboxEventId}`,
            inputSnapshotId: snapshotId,
          });
        } catch (error) {
          if (
            error instanceof Error
            && NOT_EVALUABLE_ERRORS.has(error.message)
          ) {
            await recordNotEvaluable(
              options.pool,
              source.source,
              context,
              snapshotId,
              evaluationId,
            );
            return {
              candidateRevisionId: source.source.candidateRevisionId,
              outcome: 'not_evaluable_yet',
            };
          }
          throw error;
        }

        await withTransaction(options.pool, async (client) => {
          const snapshot = await client.query<{
            eligibility_input_snapshot_id: string;
          }>(
            `select eligibility_input_snapshot_id
               from candidate_eligibility_evaluations
              where candidate_eligibility_evaluation_id = $1`,
            [evaluation.evaluationId],
          );
          await client.query(
            `insert into eligibility_recalculation_effects
              (outbox_event_id, candidate_revision_id, effect_state,
               eligibility_input_snapshot_id,
               candidate_eligibility_evaluation_id)
             values ($1, $2, 'evaluated', $3, $4)
             on conflict (outbox_event_id) do nothing`,
            [
              source.source.outboxEventId,
              source.source.candidateRevisionId,
              snapshot.rows[0]!.eligibility_input_snapshot_id,
              evaluation.evaluationId,
            ],
          );
          await recordAttempt(client, context, 'succeeded');
        });
        return {
          candidateRevisionId: source.source.candidateRevisionId,
          outcome: 'evaluated',
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
