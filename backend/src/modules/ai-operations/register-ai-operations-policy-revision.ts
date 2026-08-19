import { randomUUID } from 'node:crypto';

import type { Pool } from 'pg';

import { withTransaction } from '../../database/transaction.js';
import {
  beginIdempotentCommand,
  completeIdempotentCommand,
} from '../../shared/idempotent-command.js';
import {
  hashCanonicalTupleV1,
  requireBoundedText,
  requireUuid,
} from '../trust/normalize-trust-input.js';
import type {
  RegisterAiOperationsPolicyRevisionCommand,
  RegisterAiOperationsPolicyRevisionResult,
} from './types.js';

export type {
  RegisterAiOperationsPolicyRevisionCommand,
  RegisterAiOperationsPolicyRevisionResult,
} from './types.js';

const COMMAND_KEYS = [
  'actorId',
  'correlationId',
  'idempotencyKey',
  'aiOperationsPolicyRevisionId',
  'revision',
  'enabled',
  'maxRunsPerUtcDay',
  'minIntervalSeconds',
  'maxProposalsPerRun',
  'reason',
] as const;

function compareCanonical(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function fail(): never {
  throw new Error('AI_OPERATIONS_POLICY_INVALID');
}

function requireExactKeys(value: unknown): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return fail();
  const actual = Object.keys(value).sort(compareCanonical);
  const expected = [...COMMAND_KEYS].sort(compareCanonical);
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    return fail();
  }
}

function trimmedText(value: string, field: string, maxBytes: number): string {
  const result = requireBoundedText(value, field, maxBytes);
  if (result !== result.trim()) return fail();
  return result;
}

function normalizeCommand(
  input: RegisterAiOperationsPolicyRevisionCommand,
): RegisterAiOperationsPolicyRevisionCommand {
  requireExactKeys(input);
  if (
    !Number.isInteger(input.revision)
    || input.revision < 1
    || typeof input.enabled !== 'boolean'
    || !Number.isInteger(input.maxRunsPerUtcDay)
    || input.maxRunsPerUtcDay < 0
    || input.maxRunsPerUtcDay > 64
    || (input.enabled && input.maxRunsPerUtcDay < 1)
    || !Number.isInteger(input.minIntervalSeconds)
    || input.minIntervalSeconds < 0
    || input.minIntervalSeconds > 86_400
    || !Number.isInteger(input.maxProposalsPerRun)
    || input.maxProposalsPerRun < 1
    || input.maxProposalsPerRun > 64
  ) {
    return fail();
  }
  try {
    return {
      actorId: trimmedText(input.actorId, 'actorId', 256),
      correlationId: trimmedText(input.correlationId, 'correlationId', 256),
      idempotencyKey: trimmedText(input.idempotencyKey, 'idempotencyKey', 256),
      aiOperationsPolicyRevisionId: requireUuid(
        input.aiOperationsPolicyRevisionId,
        'aiOperationsPolicyRevisionId',
      ),
      revision: input.revision,
      enabled: input.enabled,
      maxRunsPerUtcDay: input.maxRunsPerUtcDay,
      minIntervalSeconds: input.minIntervalSeconds,
      maxProposalsPerRun: input.maxProposalsPerRun,
      reason: trimmedText(input.reason, 'reason', 1024),
    };
  } catch {
    return fail();
  }
}

export async function registerAiOperationsPolicyRevision(
  pool: Pool,
  input: RegisterAiOperationsPolicyRevisionCommand,
): Promise<RegisterAiOperationsPolicyRevisionResult> {
  const command = normalizeCommand(input);
  const payloadHash = hashCanonicalTupleV1([
    'AiOperationsPolicyRevisionV1',
    command.aiOperationsPolicyRevisionId,
    String(command.revision),
    String(command.enabled),
    String(command.maxRunsPerUtcDay),
    String(command.minIntervalSeconds),
    String(command.maxProposalsPerRun),
    'aram_mayhem',
    command.actorId,
    command.reason,
  ]);

  try {
    return await withTransaction(pool, async (client) => {
      const replay = await beginIdempotentCommand<RegisterAiOperationsPolicyRevisionResult>(
        client,
        'ai.operations.policy.register',
        command.idempotencyKey,
        payloadHash,
      );
      if (replay) return { ...replay, replayed: true };

      await client.query(
        `insert into ai_operations_policy_revisions
          (ai_operations_policy_revision_id, revision, enabled,
           max_runs_per_utc_day, min_interval_seconds, max_proposals_per_run,
           game_mode_external_id, reason, created_by)
         values ($1,$2,$3,$4,$5,$6,'aram_mayhem',$7,$8)`,
        [
          command.aiOperationsPolicyRevisionId,
          command.revision,
          command.enabled,
          command.maxRunsPerUtcDay,
          command.minIntervalSeconds,
          command.maxProposalsPerRun,
          command.reason,
          command.actorId,
        ],
      );

      const eventPayload = {
        aiOperationsPolicyRevisionId: command.aiOperationsPolicyRevisionId,
        revision: command.revision,
        enabled: command.enabled,
        maxRunsPerUtcDay: command.maxRunsPerUtcDay,
        minIntervalSeconds: command.minIntervalSeconds,
        maxProposalsPerRun: command.maxProposalsPerRun,
        gameModeExternalId: 'aram_mayhem',
      } as const;
      await client.query(
        `insert into audit_events
          (audit_event_id, actor_id, action, reason, correlation_id,
           policy_version, payload)
         values ($1,$2,'ai.operations.policy_revision_registered',$3,$4,$5,$6::jsonb)`,
        [
          randomUUID(),
          command.actorId,
          command.reason,
          command.correlationId,
          `${command.revision}`,
          JSON.stringify(eventPayload),
        ],
      );

      const result: RegisterAiOperationsPolicyRevisionResult = {
        aiOperationsPolicyRevisionId: command.aiOperationsPolicyRevisionId,
        revision: command.revision,
        replayed: false,
      };
      await completeIdempotentCommand(
        client,
        'ai.operations.policy.register',
        command.idempotencyKey,
        result,
      );
      return result;
    });
  } catch (error) {
    if (
      error !== null
      && typeof error === 'object'
      && 'code' in error
      && (error as { code?: string }).code === '23505'
    ) {
      throw new Error('AI_OPERATIONS_POLICY_CONFLICT');
    }
    throw error;
  }
}
