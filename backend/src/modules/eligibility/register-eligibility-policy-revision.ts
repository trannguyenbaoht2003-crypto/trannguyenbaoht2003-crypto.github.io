import { randomUUID } from 'node:crypto';

import type { Pool, PoolClient } from 'pg';

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
  RegisterEligibilityPolicyRevisionCommand,
  RegisterEligibilityPolicyRevisionResult,
} from './types.js';

export type {
  RegisterEligibilityPolicyRevisionCommand,
  RegisterEligibilityPolicyRevisionResult,
} from './types.js';

interface ConstraintError {
  code?: string;
  constraint?: string;
}

const COMMAND_KEYS = [
  'actorId',
  'correlationId',
  'eligibilityPolicyRevisionId',
  'evidencePolicyRevisionId',
  'idempotencyKey',
  'moderationPolicyRevisionId',
  'policyKey',
  'reason',
  'reviewPolicyRevisionId',
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
  input: RegisterEligibilityPolicyRevisionCommand,
): RegisterEligibilityPolicyRevisionCommand {
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
      eligibilityPolicyRevisionId: requireUuid(
        input.eligibilityPolicyRevisionId,
        'eligibilityPolicyRevisionId',
      ),
      evidencePolicyRevisionId: requireUuid(
        input.evidencePolicyRevisionId,
        'evidencePolicyRevisionId',
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
      reviewPolicyRevisionId: requireUuid(
        input.reviewPolicyRevisionId,
        'reviewPolicyRevisionId',
      ),
      revision: input.revision,
      schemaVersion: 1,
    };
  } catch (error) {
    throw new Error('GATE_POLICY_INVALID', { cause: error });
  }
}

async function requireSubordinatePolicies(
  client: PoolClient,
  command: RegisterEligibilityPolicyRevisionCommand,
): Promise<void> {
  const result = await client.query(
    `select
       exists (
         select 1 from evidence_policy_revisions
          where evidence_policy_revision_id = $1
       ) as evidence_exists,
       exists (
         select 1 from review_policy_revisions
          where review_policy_revision_id = $2
       ) as review_exists,
       exists (
         select 1 from moderation_policy_revisions
          where moderation_policy_revision_id = $3
       ) as moderation_exists`,
    [
      command.evidencePolicyRevisionId,
      command.reviewPolicyRevisionId,
      command.moderationPolicyRevisionId,
    ],
  );
  const row = result.rows[0] as
    | {
        evidence_exists: boolean;
        moderation_exists: boolean;
        review_exists: boolean;
      }
    | undefined;
  if (
    !row?.evidence_exists
    || !row.review_exists
    || !row.moderation_exists
  ) {
    throw new Error('GATE_POLICY_INVALID');
  }
}

function isRevisionConflict(error: unknown): error is ConstraintError {
  if (error === null || typeof error !== 'object') {
    return false;
  }
  const value = error as ConstraintError;
  return value.code === '23505'
    && Boolean(
      value.constraint?.startsWith('eligibility_policy_revisions_'),
    );
}

export async function registerEligibilityPolicyRevision(
  pool: Pool,
  input: RegisterEligibilityPolicyRevisionCommand,
): Promise<RegisterEligibilityPolicyRevisionResult> {
  const command = normalizeCommand(input);
  const payloadHash = hashCanonicalTupleV1([
    'TrustTupleV1',
    'EligibilityPolicyRevisionV1',
    command.eligibilityPolicyRevisionId,
    command.policyKey,
    String(command.revision),
    String(command.schemaVersion),
    command.evidencePolicyRevisionId,
    command.reviewPolicyRevisionId,
    command.moderationPolicyRevisionId,
    'true',
    'true',
    'true',
    command.actorId,
    command.reason,
  ]);

  try {
    return await withTransaction(pool, async (client) => {
      const replay = await beginIdempotentCommand<
        RegisterEligibilityPolicyRevisionResult
      >(
        client,
        'eligibility_policy_registration',
        command.idempotencyKey,
        payloadHash,
      );
      if (replay) {
        return { ...replay, replayed: true };
      }
      await requireSubordinatePolicies(client, command);

      await client.query(
        `insert into eligibility_policy_revisions
          (eligibility_policy_revision_id, policy_key, revision,
           schema_version, evidence_policy_revision_id,
           review_policy_revision_id, moderation_policy_revision_id,
           require_all_required_claims_supported,
           require_review_quorum_satisfied,
           fail_closed_on_stale_input, reason, created_by)
         values (
           $1, $2, $3, $4, $5, $6, $7, true, true, true, $8, $9
         )`,
        [
          command.eligibilityPolicyRevisionId,
          command.policyKey,
          command.revision,
          command.schemaVersion,
          command.evidencePolicyRevisionId,
          command.reviewPolicyRevisionId,
          command.moderationPolicyRevisionId,
          command.reason,
          command.actorId,
        ],
      );
      const eventPayload = {
        eligibilityPolicyRevisionId:
          command.eligibilityPolicyRevisionId,
        evidencePolicyRevisionId:
          command.evidencePolicyRevisionId,
        moderationPolicyRevisionId:
          command.moderationPolicyRevisionId,
        policyKey: command.policyKey,
        reviewPolicyRevisionId:
          command.reviewPolicyRevisionId,
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
           $1, 'eligibility_policy_revision', $2,
           'EligibilityPolicyRevisionRegistered', $3::jsonb, $4
         )`,
        [
          randomUUID(),
          command.eligibilityPolicyRevisionId,
          JSON.stringify(eventPayload),
          command.correlationId,
        ],
      );

      const result: RegisterEligibilityPolicyRevisionResult = {
        eligibilityPolicyRevisionId:
          command.eligibilityPolicyRevisionId,
        replayed: false,
      };
      await completeIdempotentCommand(
        client,
        'eligibility_policy_registration',
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
