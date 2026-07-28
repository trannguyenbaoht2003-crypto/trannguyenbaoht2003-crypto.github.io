import { randomUUID } from 'node:crypto';

import type { Pool, PoolClient } from 'pg';

import { withTransaction } from '../../database/transaction.js';
import {
  beginIdempotentCommand,
  completeIdempotentCommand,
} from '../../shared/idempotent-command.js';
import {
  lockCandidateRevisionAuthority,
} from '../trust/load-trust-authority.js';
import {
  hashCanonicalTupleV1,
  requireBoundedText,
  requireUuid,
} from '../trust/normalize-trust-input.js';
import type {
  ModerationOutcome,
  RecordCandidateModerationDecisionCommand,
  RecordCandidateModerationDecisionResult,
} from './types.js';

export type {
  RecordCandidateModerationDecisionCommand,
  RecordCandidateModerationDecisionResult,
} from './types.js';

interface ConstraintError {
  code?: string;
  constraint?: string;
}

interface ClaimSealRow {
  candidate_claim_set_seal_id: string;
  claim_count: number;
  claim_set_hash: string;
}

interface ProvenanceRow {
  candidate_provenance_id: string;
  origin: string;
}

interface SnapshotRow {
  moderation_input_snapshot_id: string;
}

const OUTCOMES = new Set<ModerationOutcome>([
  'clear',
  'needs_review',
  'blocked',
]);

const COMMAND_KEYS = [
  'actorId',
  'candidateId',
  'candidateRevisionId',
  'correlationId',
  'decisionId',
  'evaluatedAt',
  'idempotencyKey',
  'inputSnapshotId',
  'moderationPolicyRevisionId',
  'outcome',
  'reason',
] as const;

function compareCanonical(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function requireIsoTimestamp(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error('MODERATION_DECISION_CONFLICT');
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new Error('MODERATION_DECISION_CONFLICT');
  }
  return value;
}

function normalizeCommand(
  input: RecordCandidateModerationDecisionCommand,
): RecordCandidateModerationDecisionCommand {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('MODERATION_DECISION_CONFLICT');
  }
  const actual = Object.keys(input).sort(compareCanonical);
  const expected = [...COMMAND_KEYS].sort(compareCanonical);
  if (
    actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])
    || typeof input.outcome !== 'string'
    || !OUTCOMES.has(input.outcome as ModerationOutcome)
  ) {
    throw new Error('MODERATION_DECISION_CONFLICT');
  }
  try {
    return {
      actorId: requireBoundedText(input.actorId, 'actorId', 256),
      candidateId: requireUuid(input.candidateId, 'candidateId'),
      candidateRevisionId: requireUuid(
        input.candidateRevisionId,
        'candidateRevisionId',
      ),
      correlationId: requireBoundedText(
        input.correlationId,
        'correlationId',
        256,
      ),
      decisionId: requireUuid(input.decisionId, 'decisionId'),
      evaluatedAt: requireIsoTimestamp(input.evaluatedAt),
      idempotencyKey: requireBoundedText(
        input.idempotencyKey,
        'idempotencyKey',
        256,
      ),
      inputSnapshotId: requireUuid(
        input.inputSnapshotId,
        'inputSnapshotId',
      ),
      moderationPolicyRevisionId: requireUuid(
        input.moderationPolicyRevisionId,
        'moderationPolicyRevisionId',
      ),
      outcome: input.outcome as ModerationOutcome,
      reason: requireBoundedText(input.reason, 'reason', 1024),
    };
  } catch (error) {
    throw new Error('MODERATION_DECISION_CONFLICT', {
      cause: error,
    });
  }
}

async function loadClaimSeal(
  client: PoolClient,
  candidateRevisionId: string,
): Promise<ClaimSealRow> {
  const claims = await client.query(
    `select claim_id
       from candidate_claims
      where candidate_revision_id = $1
      order by claim_key collate "C"
      for update`,
    [candidateRevisionId],
  );
  if (claims.rowCount === 0) {
    throw new Error('CLAIM_SET_NOT_SEALED');
  }
  const seal = await client.query<ClaimSealRow>(
    `select candidate_claim_set_seal_id,
            claim_count,
            claim_set_hash
       from candidate_claim_set_seals
      where candidate_revision_id = $1`,
    [candidateRevisionId],
  );
  const row = seal.rows[0];
  if (!row || row.claim_count !== claims.rowCount) {
    throw new Error('CLAIM_SET_NOT_SEALED');
  }
  return row;
}

async function loadProvenance(
  client: PoolClient,
  candidateRevisionId: string,
): Promise<ProvenanceRow[]> {
  const result = await client.query<ProvenanceRow>(
    `select candidate_provenance_id, origin
       from candidate_provenance
      where candidate_revision_id = $1
      order by candidate_provenance_id`,
    [candidateRevisionId],
  );
  if (result.rowCount === 0) {
    throw new Error('MODERATION_INPUT_STALE');
  }
  return result.rows;
}

function isDecisionConflict(error: unknown): error is ConstraintError {
  if (error === null || typeof error !== 'object') {
    return false;
  }
  const value = error as ConstraintError;
  return value.code === '23505'
    && Boolean(
      value.constraint?.startsWith('moderation_decisions_')
      || value.constraint?.startsWith('moderation_input_snapshots_'),
    );
}

export async function recordCandidateModerationDecision(
  pool: Pool,
  input: RecordCandidateModerationDecisionCommand,
): Promise<RecordCandidateModerationDecisionResult> {
  const command = normalizeCommand(input);
  const commandHash = hashCanonicalTupleV1([
    'TrustTupleV1',
    'RecordCandidateModerationDecisionCommandV1',
    command.candidateId,
    command.candidateRevisionId,
    command.decisionId,
    command.inputSnapshotId,
    command.moderationPolicyRevisionId,
    command.outcome,
    command.evaluatedAt,
    command.actorId,
    command.reason,
  ]);

  try {
    return await withTransaction(pool, async (client) => {
      const authority = await lockCandidateRevisionAuthority(
        client,
        command.candidateId,
        command.candidateRevisionId,
      );
      const replay = await beginIdempotentCommand<
        RecordCandidateModerationDecisionResult
      >(
        client,
        'moderation_decision',
        command.idempotencyKey,
        commandHash,
      );
      if (replay) {
        return { ...replay, replayed: true };
      }

      const policy = await client.query(
        `select moderation_policy_revision_id
           from moderation_policy_revisions
          where moderation_policy_revision_id = $1
          for key share`,
        [command.moderationPolicyRevisionId],
      );
      if (policy.rowCount !== 1) {
        throw new Error('GATE_POLICY_INVALID');
      }
      const seal = await loadClaimSeal(
        client,
        authority.candidateRevisionId,
      );
      const provenance = await loadProvenance(
        client,
        authority.candidateRevisionId,
      );
      const provenanceTokens = provenance.flatMap((entry) => [
        entry.candidate_provenance_id,
        entry.origin,
      ]);
      const provenanceSetHash = hashCanonicalTupleV1([
        'TrustTupleV1',
        'ModerationProvenanceSetV1',
        authority.candidateRevisionId,
        String(provenance.length),
        ...provenanceTokens,
      ]);
      const inputHash = hashCanonicalTupleV1([
        'TrustTupleV1',
        'ModerationInputSnapshotV1',
        authority.candidateId,
        authority.candidateRevisionId,
        authority.patchId,
        authority.catalogRevisionId,
        authority.normalizedSignature,
        seal.candidate_claim_set_seal_id,
        seal.claim_set_hash,
        String(seal.claim_count),
        command.moderationPolicyRevisionId,
        String(provenance.length),
        ...provenanceTokens,
      ]);

      const existing = await client.query<SnapshotRow>(
        `select moderation_input_snapshot_id
           from moderation_input_snapshots
          where candidate_revision_id = $1
            and moderation_policy_revision_id = $2
            and input_hash = $3`,
        [
          authority.candidateRevisionId,
          command.moderationPolicyRevisionId,
          inputHash,
        ],
      );
      const snapshotId = (
        existing.rows[0]?.moderation_input_snapshot_id
        ?? command.inputSnapshotId
      );
      if (existing.rowCount === 0) {
        await client.query(
          `insert into moderation_input_snapshots
            (moderation_input_snapshot_id, candidate_id,
             candidate_revision_id, patch_id, catalog_revision_id,
             candidate_normalized_signature,
             candidate_claim_set_seal_id, claim_set_hash,
             claim_count, provenance_count, provenance_set_hash,
             moderation_policy_revision_id, input_hash, created_by)
           values (
             $1, $2, $3, $4, $5, $6, $7, $8,
             $9, $10, $11, $12, $13, $14
           )`,
          [
            snapshotId,
            authority.candidateId,
            authority.candidateRevisionId,
            authority.patchId,
            authority.catalogRevisionId,
            authority.normalizedSignature,
            seal.candidate_claim_set_seal_id,
            seal.claim_set_hash,
            seal.claim_count,
            provenance.length,
            provenanceSetHash,
            command.moderationPolicyRevisionId,
            inputHash,
            command.actorId,
          ],
        );
        for (let index = 0; index < provenance.length; index += 1) {
          const entry = provenance[index]!;
          await client.query(
            `insert into moderation_input_snapshot_provenance
              (moderation_input_snapshot_id,
               candidate_provenance_id, candidate_revision_id,
               origin, ordinal)
             values ($1, $2, $3, $4, $5)`,
            [
              snapshotId,
              entry.candidate_provenance_id,
              authority.candidateRevisionId,
              entry.origin,
              index + 1,
            ],
          );
        }
      }

      await client.query(
        `insert into moderation_decisions
          (moderation_decision_id, candidate_id,
           candidate_revision_id, patch_id, catalog_revision_id,
           moderation_input_snapshot_id, input_hash,
           moderation_policy_revision_id, outcome,
           evaluator_actor_id, reason, correlation_id, evaluated_at)
         values (
           $1, $2, $3, $4, $5, $6, $7,
           $8, $9, $10, $11, $12, $13
         )`,
        [
          command.decisionId,
          authority.candidateId,
          authority.candidateRevisionId,
          authority.patchId,
          authority.catalogRevisionId,
          snapshotId,
          inputHash,
          command.moderationPolicyRevisionId,
          command.outcome,
          command.actorId,
          command.reason,
          command.correlationId,
          command.evaluatedAt,
        ],
      );
      await client.query(
        `insert into current_candidate_moderation_decisions
          (candidate_revision_id, moderation_policy_revision_id,
           candidate_id, input_hash, moderation_decision_id)
         values ($1, $2, $3, $4, $5)
         on conflict (
           candidate_revision_id,
           moderation_policy_revision_id
         ) do update
           set candidate_id = excluded.candidate_id,
               input_hash = excluded.input_hash,
               moderation_decision_id =
                 excluded.moderation_decision_id,
               updated_at = clock_timestamp()`,
        [
          authority.candidateRevisionId,
          command.moderationPolicyRevisionId,
          authority.candidateId,
          inputHash,
          command.decisionId,
        ],
      );

      const eventPayload = {
        candidateId: authority.candidateId,
        candidateRevisionId: authority.candidateRevisionId,
        decisionId: command.decisionId,
        inputHash,
        moderationPolicyRevisionId:
          command.moderationPolicyRevisionId,
        outcome: command.outcome,
      };
      await client.query(
        `insert into audit_events
          (audit_event_id, actor_id, action, reason, correlation_id,
           policy_version, payload)
         values (
           $1, $2, 'moderation.decision_recorded', $3, $4, $5,
           $6::jsonb
         )`,
        [
          randomUUID(),
          command.actorId,
          command.reason,
          command.correlationId,
          command.moderationPolicyRevisionId,
          JSON.stringify(eventPayload),
        ],
      );
      await client.query(
        `insert into outbox_events
          (outbox_event_id, aggregate_type, aggregate_id, event_type,
           payload, correlation_id)
         values (
           $1, 'candidate_revision', $2,
           'ModerationDecisionRecorded', $3::jsonb, $4
         )`,
        [
          randomUUID(),
          authority.candidateRevisionId,
          JSON.stringify(eventPayload),
          command.correlationId,
        ],
      );

      const result: RecordCandidateModerationDecisionResult = {
        candidateRevisionId: authority.candidateRevisionId,
        decisionId: command.decisionId,
        inputHash,
        outcome: command.outcome,
        replayed: false,
      };
      await completeIdempotentCommand(
        client,
        'moderation_decision',
        command.idempotencyKey,
        result,
      );
      return result;
    });
  } catch (error) {
    if (isDecisionConflict(error)) {
      throw new Error('MODERATION_DECISION_CONFLICT', {
        cause: error,
      });
    }
    throw error;
  }
}
