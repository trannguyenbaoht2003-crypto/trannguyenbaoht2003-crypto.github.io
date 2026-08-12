import { randomUUID } from 'node:crypto';

import type { Pool } from 'pg';

import { withTransaction } from '../../database/transaction.js';
import {
  beginIdempotentCommand,
  completeIdempotentCommand,
} from '../../shared/idempotent-command.js';
import {
  hashCanonicalTupleV1,
  normalizePolicyKey,
  requireBoundedText,
  requireUuid,
} from '../trust/normalize-trust-input.js';
import type {
  RegisterModerationPolicyRevisionCommand,
  RegisterModerationPolicyRevisionResult,
} from './types.js';

export type {
  RegisterModerationPolicyRevisionCommand,
  RegisterModerationPolicyRevisionResult,
} from './types.js';

interface ConstraintError {
  code?: string;
  constraint?: string;
}

const COMMAND_KEYS = [
  'actorId',
  'correlationId',
  'idempotencyKey',
  'moderationPolicyRevisionId',
  'policyKey',
  'reason',
  'revision',
  'schemaVersion',
] as const;

function compareCanonical(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function requireExactKeys(
  value: unknown,
): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('GATE_POLICY_INVALID');
  }
  const actual = Object.keys(value).sort(compareCanonical);
  const expected = [...COMMAND_KEYS].sort(compareCanonical);
  if (
    actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])
  ) {
    throw new Error('GATE_POLICY_INVALID');
  }
}

function normalizeCommand(
  input: RegisterModerationPolicyRevisionCommand,
): RegisterModerationPolicyRevisionCommand {
  requireExactKeys(input);
  if (
    !Number.isInteger(input.revision)
    || input.revision < 1
    || input.schemaVersion !== 1
  ) {
    throw new Error('GATE_POLICY_INVALID');
  }
  try {
    return {
      actorId: requireBoundedText(input.actorId, 'actorId', 256),
      correlationId: requireBoundedText(
        input.correlationId,
        'correlationId',
        256,
      ),
      idempotencyKey: requireBoundedText(
        input.idempotencyKey,
        'idempotencyKey',
        256,
      ),
      moderationPolicyRevisionId: requireUuid(
        input.moderationPolicyRevisionId,
        'moderationPolicyRevisionId',
      ),
      policyKey: normalizePolicyKey(input.policyKey),
      reason: requireBoundedText(input.reason, 'reason', 1024),
      revision: input.revision,
      schemaVersion: 1,
    };
  } catch (error) {
    throw new Error('GATE_POLICY_INVALID', { cause: error });
  }
}

function isRevisionConflict(error: unknown): error is ConstraintError {
  if (error === null || typeof error !== 'object') {
    return false;
  }
  const value = error as ConstraintError;
  return value.code === '23505'
    && Boolean(
      value.constraint?.startsWith('moderation_policy_revisions_'),
    );
}

export async function registerModerationPolicyRevision(
  pool: Pool,
  input: RegisterModerationPolicyRevisionCommand,
): Promise<RegisterModerationPolicyRevisionResult> {
  const command = normalizeCommand(input);
  const payloadHash = hashCanonicalTupleV1([
    'TrustTupleV1',
    'ModerationPolicyRevisionV1',
    command.moderationPolicyRevisionId,
    command.policyKey,
    String(command.revision),
    String(command.schemaVersion),
    command.actorId,
    command.reason,
  ]);

  try {
    return await withTransaction(pool, async (client) => {
      const replay = await beginIdempotentCommand<
        RegisterModerationPolicyRevisionResult
      >(
        client,
        'moderation_policy_registration',
        command.idempotencyKey,
        payloadHash,
      );
      if (replay) {
        return { ...replay, replayed: true };
      }

      await client.query(
        `insert into moderation_policy_revisions
          (moderation_policy_revision_id, policy_key, revision,
           schema_version, reason, created_by)
         values ($1, $2, $3, $4, $5, $6)`,
        [
          command.moderationPolicyRevisionId,
          command.policyKey,
          command.revision,
          command.schemaVersion,
          command.reason,
          command.actorId,
        ],
      );
      const eventPayload = {
        moderationPolicyRevisionId:
          command.moderationPolicyRevisionId,
        policyKey: command.policyKey,
        revision: command.revision,
      };
      await client.query(
        `insert into audit_events
          (audit_event_id, actor_id, action, reason, correlation_id,
           policy_version, payload)
         values (
           $1, $2, 'gate.policy_revision_registered', $3, $4, $5,
           $6::jsonb
         )`,
        [
          randomUUID(),
          command.actorId,
          command.reason,
          command.correlationId,
          `${command.policyKey}:${command.revision}`,
          JSON.stringify(eventPayload),
        ],
      );
      await client.query(
        `insert into outbox_events
          (outbox_event_id, aggregate_type, aggregate_id, event_type,
           payload, correlation_id)
         values (
           $1, 'moderation_policy_revision', $2,
           'ModerationPolicyRevisionRegistered', $3::jsonb, $4
         )`,
        [
          randomUUID(),
          command.moderationPolicyRevisionId,
          JSON.stringify(eventPayload),
          command.correlationId,
        ],
      );

      const result: RegisterModerationPolicyRevisionResult = {
        moderationPolicyRevisionId:
          command.moderationPolicyRevisionId,
        replayed: false,
      };
      await completeIdempotentCommand(
        client,
        'moderation_policy_registration',
        command.idempotencyKey,
        result,
      );
      return result;
    });
  } catch (error) {
    if (isRevisionConflict(error)) {
      throw new Error('GATE_POLICY_REVISION_CONFLICT', {
        cause: error,
      });
    }
    throw error;
  }
}
