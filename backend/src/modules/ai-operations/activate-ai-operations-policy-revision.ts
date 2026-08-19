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
  ActivateAiOperationsPolicyRevisionCommand,
  ActivateAiOperationsPolicyRevisionResult,
} from './types.js';

export type {
  ActivateAiOperationsPolicyRevisionCommand,
  ActivateAiOperationsPolicyRevisionResult,
} from './types.js';

const COMMAND_KEYS = [
  'actorId',
  'correlationId',
  'idempotencyKey',
  'aiOperationsPolicyRevisionId',
  'expectedCurrentAiOperationsPolicyRevisionId',
  'reason',
] as const;

function compareCanonical(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function fail(): never {
  throw new Error('AI_OPERATIONS_POLICY_INVALID');
}

function trimmedText(value: string, field: string, maxBytes: number): string {
  const result = requireBoundedText(value, field, maxBytes);
  if (result !== result.trim()) return fail();
  return result;
}

function normalizeCommand(
  input: ActivateAiOperationsPolicyRevisionCommand,
): ActivateAiOperationsPolicyRevisionCommand {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return fail();
  const actual = Object.keys(input).sort(compareCanonical);
  const expected = [...COMMAND_KEYS].sort(compareCanonical);
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
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
      expectedCurrentAiOperationsPolicyRevisionId:
        input.expectedCurrentAiOperationsPolicyRevisionId === null
          ? null
          : requireUuid(
              input.expectedCurrentAiOperationsPolicyRevisionId,
              'expectedCurrentAiOperationsPolicyRevisionId',
            ),
      reason: trimmedText(input.reason, 'reason', 1024),
    };
  } catch {
    return fail();
  }
}

export async function activateAiOperationsPolicyRevision(
  pool: Pool,
  input: ActivateAiOperationsPolicyRevisionCommand,
): Promise<ActivateAiOperationsPolicyRevisionResult> {
  const command = normalizeCommand(input);
  const payloadHash = hashCanonicalTupleV1([
    'ActivateAiOperationsPolicyRevisionCommandV1',
    command.aiOperationsPolicyRevisionId,
    command.expectedCurrentAiOperationsPolicyRevisionId ?? '@null',
    command.actorId,
    command.reason,
  ]);

  return withTransaction(pool, async (client) => {
    const replay = await beginIdempotentCommand<ActivateAiOperationsPolicyRevisionResult>(
      client,
      'ai.operations.policy.activate',
      command.idempotencyKey,
      payloadHash,
    );
    if (replay) return { ...replay, replayed: true };

    const target = await client.query(
      `select ai_operations_policy_revision_id
         from ai_operations_policy_revisions
        where ai_operations_policy_revision_id = $1
        for key share`,
      [command.aiOperationsPolicyRevisionId],
    );
    if (target.rowCount !== 1) return fail();

    await client.query(
      `select pg_advisory_xact_lock(
         hashtextextended('active_ai_operations_policy_revision:ai_discovery_provider', 0)
       )`,
    );
    const active = await client.query<{ ai_operations_policy_revision_id: string }>(
      `select ai_operations_policy_revision_id
         from active_ai_operations_policy_revision
        where scope = 'ai_discovery_provider'
        for update`,
    );
    const previous = active.rows[0]?.ai_operations_policy_revision_id ?? null;
    if (previous !== command.expectedCurrentAiOperationsPolicyRevisionId) {
      throw new Error('AI_OPERATIONS_POLICY_ACTIVE_POINTER_CONFLICT');
    }

    if (previous === null) {
      await client.query(
        `insert into active_ai_operations_policy_revision
          (scope, ai_operations_policy_revision_id)
         values ('ai_discovery_provider', $1)`,
        [command.aiOperationsPolicyRevisionId],
      );
    } else {
      await client.query(
        `update active_ai_operations_policy_revision
            set ai_operations_policy_revision_id = $1,
                updated_at = clock_timestamp()
          where scope = 'ai_discovery_provider'`,
        [command.aiOperationsPolicyRevisionId],
      );
    }

    const eventPayload = {
      currentAiOperationsPolicyRevisionId: command.aiOperationsPolicyRevisionId,
      previousAiOperationsPolicyRevisionId: previous,
    };
    await client.query(
      `insert into audit_events
        (audit_event_id, actor_id, action, reason, correlation_id,
         policy_version, payload)
       values ($1,$2,'ai.operations.policy_revision_activated',$3,$4,$5,$6::jsonb)`,
      [
        randomUUID(),
        command.actorId,
        command.reason,
        command.correlationId,
        command.aiOperationsPolicyRevisionId,
        JSON.stringify(eventPayload),
      ],
    );

    const result: ActivateAiOperationsPolicyRevisionResult = {
      currentAiOperationsPolicyRevisionId: command.aiOperationsPolicyRevisionId,
      previousAiOperationsPolicyRevisionId: previous,
      replayed: false,
    };
    await completeIdempotentCommand(
      client,
      'ai.operations.policy.activate',
      command.idempotencyKey,
      result,
    );
    return result;
  });
}
