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
  RollbackPublicationCommand,
  RollbackPublicationResult,
} from './types.js';

export type {
  RollbackPublicationCommand,
  RollbackPublicationResult,
} from './types.js';

const COMMAND_KEYS = [
  'publicationId',
  'targetPublicationVersionId',
  'activationId',
  'expectedActivePublicationVersionId',
  'authorization',
  'auditId',
  'outboxEventId',
  'correlationId',
  'idempotencyKey',
  'occurredAt',
] as const;
const AUTHORIZATION_KEYS = ['actorId', 'permissions'] as const;

function compareCanonical(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function requireExactKeys(
  value: unknown,
  expectedKeys: readonly string[],
): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('PUBLICATION_COMMAND_INVALID');
  }
  const actual = Object.keys(value).sort(compareCanonical);
  const expected = [...expectedKeys].sort(compareCanonical);
  if (
    actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])
  ) {
    throw new Error('PUBLICATION_COMMAND_INVALID');
  }
}

function requireIsoTimestamp(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error('PUBLICATION_COMMAND_INVALID');
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new Error('PUBLICATION_COMMAND_INVALID');
  }
  return value;
}

function normalizeCommand(
  input: RollbackPublicationCommand,
): RollbackPublicationCommand {
  try {
    requireExactKeys(input, COMMAND_KEYS);
    requireExactKeys(input.authorization, AUTHORIZATION_KEYS);
    if (
      !Array.isArray(input.authorization.permissions)
      || input.authorization.permissions.length !== 1
      || input.authorization.permissions[0] !== 'publisher'
    ) {
      throw new Error('PUBLISHER_PERMISSION_REQUIRED');
    }
    return {
      publicationId: requireUuid(input.publicationId, 'publicationId'),
      targetPublicationVersionId: requireUuid(
        input.targetPublicationVersionId,
        'targetPublicationVersionId',
      ),
      activationId: requireUuid(input.activationId, 'activationId'),
      expectedActivePublicationVersionId: requireUuid(
        input.expectedActivePublicationVersionId,
        'expectedActivePublicationVersionId',
      ),
      authorization: {
        actorId: requireBoundedText(
          input.authorization.actorId,
          'actorId',
          256,
        ),
        permissions: ['publisher'],
      },
      auditId: requireUuid(input.auditId, 'auditId'),
      outboxEventId: requireUuid(
        input.outboxEventId,
        'outboxEventId',
      ),
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
      occurredAt: requireIsoTimestamp(input.occurredAt),
    };
  } catch (error) {
    if (
      error instanceof Error
      && error.message === 'PUBLISHER_PERMISSION_REQUIRED'
    ) {
      throw error;
    }
    throw new Error('PUBLICATION_COMMAND_INVALID', { cause: error });
  }
}

interface TargetVersionRow {
  publication_id: string;
  candidate_id: string;
  candidate_revision_id: string;
  eligibility_policy_revision_id: string;
  candidate_eligibility_evaluation_id: string;
  payload_hash: string;
  version_number: number;
}

export async function rollbackPublication(
  pool: Pool,
  input: RollbackPublicationCommand,
): Promise<RollbackPublicationResult> {
  const command = normalizeCommand(input);
  const actorId = command.authorization.actorId;
  const commandHash = hashCanonicalTupleV1([
    'PublicationTupleV1',
    'RollbackPublicationCommandV1',
    command.publicationId,
    command.targetPublicationVersionId,
    command.activationId,
    command.expectedActivePublicationVersionId,
    actorId,
    command.auditId,
    command.outboxEventId,
    command.correlationId,
    command.occurredAt,
  ]);

  return withTransaction(pool, async (client) => {
    const publication = await client.query(
      `select publication_id
         from publications
        where publication_id = $1
        for update`,
      [command.publicationId],
    );
    if (publication.rowCount !== 1) {
      throw new Error('PUBLICATION_NOT_FOUND');
    }

    const active = await client.query<{
      publication_version_id: string;
    }>(
      `select publication_version_id
         from active_publication_versions
        where publication_id = $1
        for update`,
      [command.publicationId],
    );
    const currentActive = active.rows[0]?.publication_version_id;
    if (!currentActive) {
      throw new Error('PUBLICATION_NOT_FOUND');
    }

    const replay = await beginIdempotentCommand<
      RollbackPublicationResult
    >(
      client,
      'publication_rollback',
      command.idempotencyKey,
      commandHash,
    );
    if (replay) {
      return { ...replay, replayed: true };
    }

    if (
      currentActive !== command.expectedActivePublicationVersionId
    ) {
      throw new Error('PUBLICATION_ACTIVE_POINTER_CONFLICT');
    }
    if (currentActive === command.targetPublicationVersionId) {
      throw new Error('PUBLICATION_VERSION_ALREADY_ACTIVE');
    }

    const target = await client.query<TargetVersionRow>(
      `select publication_id,
              candidate_id,
              candidate_revision_id,
              eligibility_policy_revision_id,
              candidate_eligibility_evaluation_id,
              payload_hash,
              version_number
         from publication_versions
        where publication_version_id = $1
        for key share`,
      [command.targetPublicationVersionId],
    );
    const targetVersion = target.rows[0];
    if (!targetVersion) {
      throw new Error('PUBLICATION_ROLLBACK_TARGET_NOT_FOUND');
    }
    if (targetVersion.publication_id !== command.publicationId) {
      throw new Error('PUBLICATION_ROLLBACK_TARGET_CONFLICT');
    }

    const eventPayload = {
      activationId: command.activationId,
      candidateId: targetVersion.candidate_id,
      candidateRevisionId: targetVersion.candidate_revision_id,
      eligibilityEvaluationId:
        targetVersion.candidate_eligibility_evaluation_id,
      eligibilityPolicyRevisionId:
        targetVersion.eligibility_policy_revision_id,
      payloadHash: targetVersion.payload_hash,
      previousActivePublicationVersionId: currentActive,
      publicationId: command.publicationId,
      publicationVersionId: command.targetPublicationVersionId,
      versionNumber: targetVersion.version_number,
    };
    await client.query(
      `insert into audit_events
         (audit_event_id, actor_id, action, reason, correlation_id,
          policy_version, payload)
       values ($1, $2, 'publication.version_rolled_back',
               'Publication active version rolled back', $3, $4,
               $5::jsonb)`,
      [
        command.auditId,
        actorId,
        command.correlationId,
        targetVersion.eligibility_policy_revision_id,
        JSON.stringify(eventPayload),
      ],
    );
    await client.query(
      `insert into outbox_events
         (outbox_event_id, aggregate_type, aggregate_id, event_type,
          payload, correlation_id)
       values ($1, 'Publication', $2, 'PublicationRolledBack',
               $3::jsonb, $4)`,
      [
        command.outboxEventId,
        command.publicationId,
        JSON.stringify(eventPayload),
        command.correlationId,
      ],
    );
    const activation = await client.query<{
      activation_sequence: string;
    }>(
      `insert into publication_activation_history
         (activation_id, publication_id, activation_kind,
          from_publication_version_id, to_publication_version_id,
          actor_id, audit_event_id, outbox_event_id,
          correlation_id, activated_at)
       values ($1, $2, 'rolled_back', $3, $4, $5, $6, $7, $8, $9)
       returning activation_sequence::text`,
      [
        command.activationId,
        command.publicationId,
        currentActive,
        command.targetPublicationVersionId,
        actorId,
        command.auditId,
        command.outboxEventId,
        command.correlationId,
        command.occurredAt,
      ],
    );
    const updated = await client.query(
      `update active_publication_versions
          set publication_version_id = $2,
              activation_id = $3,
              activation_sequence = $4::bigint,
              updated_at = clock_timestamp()
        where publication_id = $1
          and publication_version_id = $5`,
      [
        command.publicationId,
        command.targetPublicationVersionId,
        command.activationId,
        activation.rows[0]!.activation_sequence,
        command.expectedActivePublicationVersionId,
      ],
    );
    if (updated.rowCount !== 1) {
      throw new Error('PUBLICATION_ACTIVE_POINTER_CONFLICT');
    }

    const result: RollbackPublicationResult = {
      publicationId: command.publicationId,
      previousActivePublicationVersionId: currentActive,
      activePublicationVersionId: command.targetPublicationVersionId,
      replayed: false,
    };
    await completeIdempotentCommand(
      client,
      'publication_rollback',
      command.idempotencyKey,
      result,
    );
    return result;
  });
}
