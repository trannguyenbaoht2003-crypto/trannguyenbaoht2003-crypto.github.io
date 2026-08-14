import type { Pool, PoolClient } from 'pg';

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
import { buildPublicationPayload } from './build-publication-payload.js';
import type {
  PublicationPayloadAuthority,
  PublishCandidateRevisionCommand,
  PublishCandidateRevisionResult,
} from './types.js';

export type {
  PublishCandidateRevisionCommand,
  PublishCandidateRevisionResult,
} from './types.js';

const COMMAND_KEYS = [
  'publicationId',
  'publicationVersionId',
  'activationId',
  'candidateRevisionId',
  'expectedActiveEligibilityPolicyRevisionId',
  'expectedEligibilityEvaluationId',
  'expectedModerationDecisionId',
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
  input: PublishCandidateRevisionCommand,
): PublishCandidateRevisionCommand {
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
      publicationVersionId: requireUuid(
        input.publicationVersionId,
        'publicationVersionId',
      ),
      activationId: requireUuid(input.activationId, 'activationId'),
      candidateRevisionId: requireUuid(
        input.candidateRevisionId,
        'candidateRevisionId',
      ),
      expectedActiveEligibilityPolicyRevisionId: requireUuid(
        input.expectedActiveEligibilityPolicyRevisionId,
        'expectedActiveEligibilityPolicyRevisionId',
      ),
      expectedEligibilityEvaluationId: requireUuid(
        input.expectedEligibilityEvaluationId,
        'expectedEligibilityEvaluationId',
      ),
      expectedModerationDecisionId: requireUuid(
        input.expectedModerationDecisionId,
        'expectedModerationDecisionId',
      ),
      expectedActivePublicationVersionId:
        input.expectedActivePublicationVersionId === null
          ? null
          : requireUuid(
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
      outboxEventId: requireUuid(input.outboxEventId, 'outboxEventId'),
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

interface AuthorityRow {
  candidate_id: string;
  candidate_revision_id: string;
  patch_id: string;
  patch_key: string;
  catalog_revision_id: string;
  game_mode_external_id: 'aram_mayhem';
  champion_external_id: string;
  normalized_signature: string;
  canonical_payload: PublicationPayloadAuthority['canonicalPayload'];
  eligibility_policy_revision_id: string;
  candidate_eligibility_evaluation_id: string;
  eligibility_input_snapshot_id: string;
  eligibility_input_hash: string;
  eligibility_outcome: string;
  moderation_policy_revision_id: string;
  moderation_decision_id: string;
  moderation_input_hash: string;
  moderation_outcome: string;
}

async function loadAuthority(
  client: PoolClient,
  candidateRevisionId: string,
): Promise<AuthorityRow> {
  const result = await client.query<AuthorityRow>(
    `select candidate.candidate_id,
            revision.candidate_revision_id,
            candidate.patch_id,
            patch.patch_key,
            revision.catalog_revision_id,
            candidate.game_mode_external_id,
            entity.canonical_external_id as champion_external_id,
            revision.normalized_signature,
            revision.canonical_payload,
            evaluation.eligibility_policy_revision_id,
            evaluation.candidate_eligibility_evaluation_id,
            evaluation.eligibility_input_snapshot_id,
            evaluation.input_hash as eligibility_input_hash,
            evaluation.outcome as eligibility_outcome,
            moderation.moderation_policy_revision_id,
            moderation.moderation_decision_id,
            moderation.input_hash as moderation_input_hash,
            moderation.outcome as moderation_outcome
       from candidate_revisions revision
       join candidates candidate
         on candidate.candidate_id = revision.candidate_id
       join patches patch
         on patch.patch_id = candidate.patch_id
       join game_entities entity
         on entity.game_entity_id = candidate.subject_game_entity_id
       join active_eligibility_policy_revision active_policy
         on active_policy.scope = 'candidate_revision'
       join current_candidate_eligibility_evaluations current_evaluation
         on current_evaluation.candidate_revision_id = revision.candidate_revision_id
        and current_evaluation.eligibility_policy_revision_id = active_policy.eligibility_policy_revision_id
       join candidate_eligibility_evaluations evaluation
         on evaluation.candidate_eligibility_evaluation_id = current_evaluation.candidate_eligibility_evaluation_id
       join eligibility_input_snapshots snapshot
         on snapshot.eligibility_input_snapshot_id = evaluation.eligibility_input_snapshot_id
       join current_candidate_moderation_decisions current_moderation
         on current_moderation.candidate_revision_id = revision.candidate_revision_id
        and current_moderation.moderation_policy_revision_id = snapshot.moderation_policy_revision_id
       join moderation_decisions moderation
         on moderation.moderation_decision_id = current_moderation.moderation_decision_id
      where revision.candidate_revision_id = $1
      for update of candidate, revision, current_evaluation, current_moderation`,
    [candidateRevisionId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error('CANDIDATE_NOT_ELIGIBLE');
  }
  return row;
}

export async function publishCandidateRevision(
  pool: Pool,
  input: PublishCandidateRevisionCommand,
): Promise<PublishCandidateRevisionResult> {
  const command = normalizeCommand(input);
  const actorId = command.authorization.actorId;
  const commandHash = hashCanonicalTupleV1([
    'PublicationTupleV1',
    'PublishCandidateRevisionCommandV1',
    command.publicationId,
    command.publicationVersionId,
    command.activationId,
    command.candidateRevisionId,
    command.expectedActiveEligibilityPolicyRevisionId,
    command.expectedEligibilityEvaluationId,
    command.expectedModerationDecisionId,
    command.expectedActivePublicationVersionId ?? '@null',
    actorId,
    command.auditId,
    command.outboxEventId,
    command.correlationId,
    command.occurredAt,
  ]);

  return withTransaction(pool, async (client) => {
    const authority = await loadAuthority(client, command.candidateRevisionId);
    await client.query(
      `select pg_advisory_xact_lock(hashtextextended($1::text, 0))`,
      [authority.candidate_id],
    );
    const replay = await beginIdempotentCommand<PublishCandidateRevisionResult>(
      client,
      'publication_publish',
      command.idempotencyKey,
      commandHash,
    );
    if (replay) {
      return { ...replay, replayed: true };
    }

    if (authority.eligibility_policy_revision_id !== command.expectedActiveEligibilityPolicyRevisionId) {
      throw new Error('ACTIVE_ELIGIBILITY_POLICY_MISMATCH');
    }
    if (authority.candidate_eligibility_evaluation_id !== command.expectedEligibilityEvaluationId) {
      throw new Error('STALE_ELIGIBILITY_EVALUATION');
    }
    if (authority.eligibility_outcome !== 'eligible') {
      throw new Error('CANDIDATE_NOT_ELIGIBLE');
    }
    if (authority.moderation_decision_id !== command.expectedModerationDecisionId) {
      throw new Error('STALE_MODERATION_DECISION');
    }
    if (authority.moderation_outcome !== 'clear') {
      throw new Error('MODERATION_NOT_CLEAR');
    }

    const existingPublication = await client.query<{ publication_id: string }>(
      `select publication_id from publications where candidate_id = $1 for update`,
      [authority.candidate_id],
    );
    const ownedPublicationId = existingPublication.rows[0]?.publication_id;
    if (ownedPublicationId && ownedPublicationId !== command.publicationId) {
      throw new Error('PUBLICATION_CANDIDATE_CONFLICT');
    }
    const publicationIdentity = await client.query<{ candidate_id: string }>(
      `select candidate_id from publications where publication_id = $1 for update`,
      [command.publicationId],
    );
    if (
      publicationIdentity.rows[0]
      && publicationIdentity.rows[0].candidate_id !== authority.candidate_id
    ) {
      throw new Error('PUBLICATION_CANDIDATE_CONFLICT');
    }
    if (!ownedPublicationId && publicationIdentity.rowCount === 0) {
      await client.query(
        `insert into publications (publication_id, candidate_id, created_by)
         values ($1, $2, $3)`,
        [command.publicationId, authority.candidate_id, actorId],
      );
    }

    const active = await client.query<{ publication_version_id: string }>(
      `select publication_version_id
         from active_publication_versions
        where publication_id = $1
        for update`,
      [command.publicationId],
    );
    const currentActive = active.rows[0]?.publication_version_id ?? null;
    if (currentActive !== command.expectedActivePublicationVersionId) {
      throw new Error('PUBLICATION_ACTIVE_POINTER_CONFLICT');
    }

    const versionResult = await client.query<{ next_version: number }>(
      `select (coalesce(max(version_number), 0) + 1)::integer as next_version
         from publication_versions
        where publication_id = $1`,
      [command.publicationId],
    );
    const versionNumber = versionResult.rows[0]!.next_version;
    const built = buildPublicationPayload({
      candidateId: authority.candidate_id,
      candidateRevisionId: authority.candidate_revision_id,
      patchKey: authority.patch_key,
      catalogRevisionId: authority.catalog_revision_id,
      gameModeExternalId: authority.game_mode_external_id,
      championExternalId: authority.champion_external_id,
      canonicalPayload: authority.canonical_payload,
    });

    await client.query(
      `insert into publication_versions
         (publication_version_id, publication_id, candidate_id,
          candidate_revision_id, patch_id, catalog_revision_id,
          candidate_normalized_signature,
          eligibility_policy_revision_id,
          candidate_eligibility_evaluation_id,
          eligibility_input_hash, moderation_policy_revision_id,
          moderation_decision_id, moderation_input_hash,
          version_number, publication_payload, payload_hash,
          published_by, correlation_id, published_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
               $11, $12, $13, $14, $15::jsonb, $16, $17, $18, $19)`,
      [
        command.publicationVersionId,
        command.publicationId,
        authority.candidate_id,
        authority.candidate_revision_id,
        authority.patch_id,
        authority.catalog_revision_id,
        authority.normalized_signature,
        authority.eligibility_policy_revision_id,
        authority.candidate_eligibility_evaluation_id,
        authority.eligibility_input_hash,
        authority.moderation_policy_revision_id,
        authority.moderation_decision_id,
        authority.moderation_input_hash,
        versionNumber,
        JSON.stringify(built.payload),
        built.payloadHash,
        actorId,
        command.correlationId,
        command.occurredAt,
      ],
    );
    await client.query(
      `insert into publication_version_input_required_claims
         (publication_version_id, publication_id, candidate_id,
          candidate_revision_id, claim_id, importance,
          claim_evidence_decision_id, evidence_decision,
          evidence_policy_revision_id, ordinal)
       select $1, $2, $3, $4, member.claim_id, 'required',
              member.claim_evidence_decision_id, member.evidence_decision,
              member.evidence_policy_revision_id, member.ordinal
         from eligibility_input_snapshot_required_claims member
        where member.eligibility_input_snapshot_id = $5
        order by member.ordinal`,
      [
        command.publicationVersionId,
        command.publicationId,
        authority.candidate_id,
        authority.candidate_revision_id,
        authority.eligibility_input_snapshot_id,
      ],
    );

    const eventPayload = {
      activationId: command.activationId,
      candidateId: authority.candidate_id,
      candidateRevisionId: authority.candidate_revision_id,
      eligibilityEvaluationId: authority.candidate_eligibility_evaluation_id,
      eligibilityPolicyRevisionId: authority.eligibility_policy_revision_id,
      payloadHash: built.payloadHash,
      publicationId: command.publicationId,
      publicationVersionId: command.publicationVersionId,
      versionNumber,
    };
    await client.query(
      `insert into audit_events
         (audit_event_id, actor_id, action, reason, correlation_id,
          policy_version, payload)
       values ($1, $2, 'publication.version_published',
               'Eligible CandidateRevision published', $3, $4, $5::jsonb)`,
      [
        command.auditId,
        actorId,
        command.correlationId,
        authority.eligibility_policy_revision_id,
        JSON.stringify(eventPayload),
      ],
    );
    await client.query(
      `insert into outbox_events
         (outbox_event_id, aggregate_type, aggregate_id, event_type,
          payload, correlation_id)
       values ($1, 'Publication', $2, 'PublicationPublished', $3::jsonb, $4)`,
      [
        command.outboxEventId,
        command.publicationId,
        JSON.stringify(eventPayload),
        command.correlationId,
      ],
    );
    const activation = await client.query<{ activation_sequence: string }>(
      `insert into publication_activation_history
         (activation_id, publication_id, activation_kind,
          from_publication_version_id, to_publication_version_id,
          actor_id, audit_event_id, outbox_event_id,
          correlation_id, activated_at)
       values ($1, $2, 'published', $3, $4, $5, $6, $7, $8, $9)
       returning activation_sequence::text`,
      [
        command.activationId,
        command.publicationId,
        currentActive,
        command.publicationVersionId,
        actorId,
        command.auditId,
        command.outboxEventId,
        command.correlationId,
        command.occurredAt,
      ],
    );

    if (currentActive === null) {
      await client.query(
        `insert into active_publication_versions
           (publication_id, publication_version_id, activation_id,
            activation_sequence)
         values ($1, $2, $3, $4::bigint)`,
        [
          command.publicationId,
          command.publicationVersionId,
          command.activationId,
          activation.rows[0]!.activation_sequence,
        ],
      );
    } else {
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
          command.publicationVersionId,
          command.activationId,
          activation.rows[0]!.activation_sequence,
          command.expectedActivePublicationVersionId,
        ],
      );
      if (updated.rowCount !== 1) {
        throw new Error('PUBLICATION_ACTIVE_POINTER_CONFLICT');
      }
    }

    await client.query(
      `insert into outbox_events
         (outbox_event_id, aggregate_type, aggregate_id, event_type,
          payload, correlation_id)
       values (gen_random_uuid(), 'publication', $1,
               'PublicationMonitoringRequested', $2::jsonb, $3)`,
      [
        command.publicationId,
        JSON.stringify({
          activationId: command.activationId,
          publicationId: command.publicationId,
          requestedReason: 'published',
          schemaVersion: 1,
        }),
        command.correlationId,
      ],
    );

    const result: PublishCandidateRevisionResult = {
      publicationId: command.publicationId,
      publicationVersionId: command.publicationVersionId,
      candidateId: authority.candidate_id,
      candidateRevisionId: authority.candidate_revision_id,
      versionNumber,
      activePublicationVersionId: command.publicationVersionId,
      replayed: false,
    };
    await completeIdempotentCommand(
      client,
      'publication_publish',
      command.idempotencyKey,
      result,
    );
    return result;
  });
}
