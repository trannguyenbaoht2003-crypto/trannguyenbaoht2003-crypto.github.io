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
} from './normalize-trust-input.js';
import type {
  RegisterTrustPolicyRevisionCommand,
  RegisterTrustPolicyRevisionResult,
} from './types.js';

export type {
  RegisterTrustPolicyRevisionCommand,
  RegisterTrustPolicyRevisionResult,
} from './types.js';

interface ConstraintError {
  code?: string;
  constraint?: string;
}

const EVIDENCE_KEYS = [
  'actorId',
  'correlationId',
  'idempotencyKey',
  'policyKey',
  'policyKind',
  'policyRevisionId',
  'reason',
  'revision',
  'schemaVersion',
] as const;

const REVIEW_KEYS = [
  'actorId',
  'appliesToAiProvenance',
  'correlationId',
  'idempotencyKey',
  'minimumConfirmedReviews',
  'policyKey',
  'policyKind',
  'policyRevisionId',
  'reason',
  'requireDistinctReviewers',
  'requiredPermission',
  'revision',
] as const;

function compareCanonical(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function requireExactKeys(
  value: unknown,
  expected: readonly string[],
): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('TRUST_OBJECT_KEYS_INVALID:trustPolicy');
  }
  const actual = Object.keys(value).sort(compareCanonical);
  const sortedExpected = [...expected].sort(compareCanonical);
  if (
    actual.length !== sortedExpected.length
    || actual.some((key, index) => key !== sortedExpected[index])
  ) {
    throw new Error('TRUST_OBJECT_KEYS_INVALID:trustPolicy');
  }
}

function requirePositiveInteger(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw new Error('TRUST_POLICY_INVALID');
  }
  return value as number;
}

function normalizeCommand(
  command: RegisterTrustPolicyRevisionCommand,
): RegisterTrustPolicyRevisionCommand {
  if (
    command === null
    || typeof command !== 'object'
    || Array.isArray(command)
  ) {
    throw new Error('TRUST_OBJECT_KEYS_INVALID:trustPolicy');
  }
  const policyKind = (command as { policyKind?: unknown }).policyKind;
  if (policyKind === 'evidence' && command.policyKind === 'evidence') {
    requireExactKeys(command, EVIDENCE_KEYS);
    const revision = requirePositiveInteger(command.revision);
    if (command.schemaVersion !== 1) {
      throw new Error('TRUST_POLICY_INVALID');
    }
    return {
      actorId: requireBoundedText(command.actorId, 'actorId', 256),
      correlationId: requireBoundedText(
        command.correlationId,
        'correlationId',
        256,
      ),
      idempotencyKey: requireBoundedText(
        command.idempotencyKey,
        'idempotencyKey',
        256,
      ),
      policyKey: normalizePolicyKey(command.policyKey),
      policyKind,
      policyRevisionId: requireUuid(
        command.policyRevisionId,
        'policyRevisionId',
      ),
      reason: requireBoundedText(command.reason, 'reason', 1024),
      revision,
      schemaVersion: 1,
    };
  }
  if (
    policyKind === 'human_review'
    && command.policyKind === 'human_review'
  ) {
    requireExactKeys(command, REVIEW_KEYS);
    const revision = requirePositiveInteger(command.revision);
    if (
      !Number.isInteger(command.minimumConfirmedReviews)
      || command.minimumConfirmedReviews < 1
      || command.minimumConfirmedReviews > 16
      || command.requireDistinctReviewers !== true
      || command.requiredPermission !== 'reviewer'
      || typeof command.appliesToAiProvenance !== 'boolean'
    ) {
      throw new Error('TRUST_POLICY_INVALID');
    }
    return {
      actorId: requireBoundedText(command.actorId, 'actorId', 256),
      appliesToAiProvenance: command.appliesToAiProvenance,
      correlationId: requireBoundedText(
        command.correlationId,
        'correlationId',
        256,
      ),
      idempotencyKey: requireBoundedText(
        command.idempotencyKey,
        'idempotencyKey',
        256,
      ),
      minimumConfirmedReviews: command.minimumConfirmedReviews,
      policyKey: normalizePolicyKey(command.policyKey),
      policyKind,
      policyRevisionId: requireUuid(
        command.policyRevisionId,
        'policyRevisionId',
      ),
      reason: requireBoundedText(command.reason, 'reason', 1024),
      requireDistinctReviewers: true,
      requiredPermission: 'reviewer',
      revision,
    };
  }
  throw new Error('TRUST_POLICY_INVALID');
}

function policyPayloadHash(
  command: RegisterTrustPolicyRevisionCommand,
): string {
  if (command.policyKind === 'evidence') {
    return hashCanonicalTupleV1([
      'TrustTupleV1',
      'TrustPolicyRevisionV1',
      'evidence',
      command.policyRevisionId,
      command.policyKey,
      String(command.revision),
      String(command.schemaVersion),
      command.actorId,
      command.reason,
    ]);
  }
  return hashCanonicalTupleV1([
    'TrustTupleV1',
    'TrustPolicyRevisionV1',
    'human_review',
    command.policyRevisionId,
    command.policyKey,
    String(command.revision),
    String(command.minimumConfirmedReviews),
    String(command.requireDistinctReviewers),
    command.requiredPermission,
    String(command.appliesToAiProvenance),
    command.actorId,
    command.reason,
  ]);
}

function isPolicyConflict(error: unknown): error is ConstraintError {
  if (error === null || typeof error !== 'object') {
    return false;
  }
  const value = error as ConstraintError;
  return value.code === '23505'
    && Boolean(
      value.constraint?.startsWith('evidence_policy_revisions_')
      || value.constraint?.startsWith('review_policy_revisions_'),
    );
}

export async function registerTrustPolicyRevision(
  pool: Pool,
  input: RegisterTrustPolicyRevisionCommand,
): Promise<RegisterTrustPolicyRevisionResult> {
  let command: RegisterTrustPolicyRevisionCommand;
  try {
    command = normalizeCommand(input);
  } catch (error) {
    if (
      error instanceof Error
      && error.message.startsWith('TRUST_OBJECT_KEYS_INVALID')
    ) {
      throw error;
    }
    throw new Error('TRUST_POLICY_INVALID', { cause: error });
  }
  const payloadHash = policyPayloadHash(command);
  try {
    return await withTransaction(pool, async (client) => {
      const replay = await beginIdempotentCommand<
        RegisterTrustPolicyRevisionResult
      >(
        client,
        'trust_policy_registration',
        command.idempotencyKey,
        payloadHash,
      );
      if (replay) {
        return {
          ...replay,
          replayed: true,
        };
      }

      if (command.policyKind === 'evidence') {
        await client.query(
          `insert into evidence_policy_revisions
            (evidence_policy_revision_id, policy_key, revision,
             schema_version, reason, created_by)
           values ($1, $2, $3, $4, $5, $6)`,
          [
            command.policyRevisionId,
            command.policyKey,
            command.revision,
            command.schemaVersion,
            command.reason,
            command.actorId,
          ],
        );
      } else {
        await client.query(
          `insert into review_policy_revisions
            (review_policy_revision_id, policy_key, revision,
             minimum_confirmed_reviews, require_distinct_reviewers,
             required_permission, applies_to_ai_provenance,
             reason, created_by)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            command.policyRevisionId,
            command.policyKey,
            command.revision,
            command.minimumConfirmedReviews,
            command.requireDistinctReviewers,
            command.requiredPermission,
            command.appliesToAiProvenance,
            command.reason,
            command.actorId,
          ],
        );
      }

      const eventPayload = {
        policyKind: command.policyKind,
        policyRevisionId: command.policyRevisionId,
        policyKey: command.policyKey,
        revision: command.revision,
      };
      await client.query(
        `insert into audit_events
          (audit_event_id, actor_id, action, reason, correlation_id,
           policy_version, payload)
         values (
           $1, $2, 'trust.policy_revision_registered', $3, $4, $5,
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
           $1, 'trust_policy_revision', $2,
           'TrustPolicyRevisionRegistered', $3::jsonb, $4
         )`,
        [
          randomUUID(),
          command.policyRevisionId,
          JSON.stringify(eventPayload),
          command.correlationId,
        ],
      );

      const result: RegisterTrustPolicyRevisionResult = {
        policyKind: command.policyKind,
        policyRevisionId: command.policyRevisionId,
        replayed: false,
      };
      await completeIdempotentCommand(
        client,
        'trust_policy_registration',
        command.idempotencyKey,
        result,
      );
      return result;
    });
  } catch (error) {
    if (isPolicyConflict(error)) {
      throw new Error('TRUST_POLICY_REVISION_CONFLICT', {
        cause: error,
      });
    }
    throw error;
  }
}
