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
  ActivateEligibilityPolicyRevisionCommand,
  ActivateEligibilityPolicyRevisionResult,
} from './types.js';

export type {
  ActivateEligibilityPolicyRevisionCommand,
  ActivateEligibilityPolicyRevisionResult,
} from './types.js';

const COMMAND_KEYS = [
  'actorId',
  'correlationId',
  'eligibilityPolicyRevisionId',
  'expectedCurrentEligibilityPolicyRevisionId',
  'idempotencyKey',
  'reason',
] as const;

function compareCanonical(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeCommand(
  input: ActivateEligibilityPolicyRevisionCommand,
): ActivateEligibilityPolicyRevisionCommand {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('GATE_POLICY_INVALID');
  }
  const actual = Object.keys(input).sort(compareCanonical);
  const expected = [...COMMAND_KEYS].sort(compareCanonical);
  if (
    actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])
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
      eligibilityPolicyRevisionId: requireUuid(
        input.eligibilityPolicyRevisionId,
        'eligibilityPolicyRevisionId',
      ),
      expectedCurrentEligibilityPolicyRevisionId:
        input.expectedCurrentEligibilityPolicyRevisionId === null
          ? null
          : requireUuid(
              input.expectedCurrentEligibilityPolicyRevisionId,
              'expectedCurrentEligibilityPolicyRevisionId',
            ),
      idempotencyKey: requireBoundedText(
        input.idempotencyKey,
        'idempotencyKey',
        256,
      ),
      reason: requireBoundedText(input.reason, 'reason', 1024),
    };
  } catch (error) {
    throw new Error('GATE_POLICY_INVALID', { cause: error });
  }
}

export async function activateEligibilityPolicyRevision(
  pool: Pool,
  input: ActivateEligibilityPolicyRevisionCommand,
): Promise<ActivateEligibilityPolicyRevisionResult> {
  const command = normalizeCommand(input);
  const payloadHash = hashCanonicalTupleV1([
    'TrustTupleV1',
    'ActivateEligibilityPolicyRevisionCommandV1',
    command.eligibilityPolicyRevisionId,
    command.expectedCurrentEligibilityPolicyRevisionId ?? '@null',
    command.actorId,
    command.reason,
  ]);

  return withTransaction(pool, async (client) => {
    const replay = await beginIdempotentCommand<
      ActivateEligibilityPolicyRevisionResult
    >(
      client,
      'eligibility_policy_activation',
      command.idempotencyKey,
      payloadHash,
    );
    if (replay) {
      return { ...replay, replayed: true };
    }

    const target = await client.query(
      `select eligibility_policy_revision_id
         from eligibility_policy_revisions
        where eligibility_policy_revision_id = $1
        for key share`,
      [command.eligibilityPolicyRevisionId],
    );
    if (target.rowCount !== 1) {
      throw new Error('GATE_POLICY_INVALID');
    }

    await client.query(
      `select pg_advisory_xact_lock(
         hashtextextended(
           'active_eligibility_policy_revision:candidate_revision',
           0
         )
       )`,
    );
    const active = await client.query<{
      eligibility_policy_revision_id: string;
    }>(
      `select eligibility_policy_revision_id
         from active_eligibility_policy_revision
        where scope = 'candidate_revision'
        for update`,
    );
    const previous = (
      active.rows[0]?.eligibility_policy_revision_id ?? null
    );
    if (
      previous
      !== command.expectedCurrentEligibilityPolicyRevisionId
    ) {
      throw new Error(
        'ELIGIBILITY_POLICY_ACTIVE_POINTER_CONFLICT',
      );
    }

    if (previous === null) {
      await client.query(
        `insert into active_eligibility_policy_revision
          (scope, eligibility_policy_revision_id)
         values ('candidate_revision', $1)`,
        [command.eligibilityPolicyRevisionId],
      );
    } else {
      await client.query(
        `update active_eligibility_policy_revision
            set eligibility_policy_revision_id = $1,
                updated_at = clock_timestamp()
          where scope = 'candidate_revision'`,
        [command.eligibilityPolicyRevisionId],
      );
    }

    const eventPayload = {
      currentEligibilityPolicyRevisionId:
        command.eligibilityPolicyRevisionId,
      previousEligibilityPolicyRevisionId: previous,
    };
    await client.query(
      `insert into audit_events
        (audit_event_id, actor_id, action, reason, correlation_id,
         policy_version, payload)
       values (
         $1, $2, 'gate.eligibility_policy_activated', $3, $4, $5,
         $6::jsonb
       )`,
      [
        randomUUID(),
        command.actorId,
        command.reason,
        command.correlationId,
        command.eligibilityPolicyRevisionId,
        JSON.stringify(eventPayload),
      ],
    );
    await client.query(
      `insert into outbox_events
        (outbox_event_id, aggregate_type, aggregate_id, event_type,
         payload, correlation_id)
       values (
         $1, 'eligibility_policy_revision', $2,
         'EligibilityPolicyRevisionActivated', $3::jsonb, $4
       )`,
      [
        randomUUID(),
        command.eligibilityPolicyRevisionId,
        JSON.stringify(eventPayload),
        command.correlationId,
      ],
    );

    const result: ActivateEligibilityPolicyRevisionResult = {
      currentEligibilityPolicyRevisionId:
        command.eligibilityPolicyRevisionId,
      previousEligibilityPolicyRevisionId: previous,
      replayed: false,
    };
    await completeIdempotentCommand(
      client,
      'eligibility_policy_activation',
      command.idempotencyKey,
      result,
    );
    return result;
  });
}
