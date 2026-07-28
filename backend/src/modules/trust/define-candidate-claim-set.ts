import { randomUUID } from 'node:crypto';

import type { Pool } from 'pg';

import { withTransaction } from '../../database/transaction.js';
import {
  beginIdempotentCommand,
  completeIdempotentCommand,
} from '../../shared/idempotent-command.js';
import { lockCandidateRevisionAuthority } from './load-trust-authority.js';
import {
  hashCanonicalTupleV1,
  normalizeClaimSet,
  requireBoundedText,
  requireUuid,
} from './normalize-trust-input.js';
import type {
  DefineCandidateClaimSetCommand,
  DefineCandidateClaimSetResult,
} from './types.js';

export type {
  DefineCandidateClaimSetCommand,
  DefineCandidateClaimSetResult,
} from './types.js';

const COMMAND_KEYS = [
  'actorId',
  'candidateId',
  'candidateRevisionId',
  'claims',
  'correlationId',
  'idempotencyKey',
] as const;

function compareCanonical(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeCommand(
  input: DefineCandidateClaimSetCommand,
): DefineCandidateClaimSetCommand {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('TRUST_OBJECT_KEYS_INVALID:claimSetCommand');
  }
  const actual = Object.keys(input).sort(compareCanonical);
  const expected = [...COMMAND_KEYS].sort(compareCanonical);
  if (
    actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])
  ) {
    throw new Error('TRUST_OBJECT_KEYS_INVALID:claimSetCommand');
  }
  return {
    actorId: requireBoundedText(input.actorId, 'actorId', 256),
    candidateId: requireUuid(input.candidateId, 'candidateId'),
    candidateRevisionId: requireUuid(
      input.candidateRevisionId,
      'candidateRevisionId',
    ),
    claims: input.claims,
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
  };
}

export async function defineCandidateClaimSet(
  pool: Pool,
  input: DefineCandidateClaimSetCommand,
): Promise<DefineCandidateClaimSetResult> {
  const command = normalizeCommand(input);
  return withTransaction(pool, async (client) => {
    const authority = await lockCandidateRevisionAuthority(
      client,
      command.candidateId,
      command.candidateRevisionId,
    );
    const normalized = normalizeClaimSet(
      authority.candidateId,
      authority.candidateRevisionId,
      authority.patchId,
      authority.catalogRevisionId,
      command.claims,
    );
    const payloadHash = hashCanonicalTupleV1([
      'TrustTupleV1',
      'CandidateClaimSetCommandV1',
      authority.candidateId,
      authority.candidateRevisionId,
      command.actorId,
      normalized.claimSetHash,
    ]);
    const replay = await beginIdempotentCommand<
      DefineCandidateClaimSetResult
    >(
      client,
      'candidate_claim_set_definition',
      command.idempotencyKey,
      payloadHash,
    );
    if (replay) {
      return {
        ...replay,
        replayed: true,
      };
    }

    const existing = await client.query(
      `select candidate_revision_id
         from candidate_claim_set_seals
        where candidate_revision_id = $1`,
      [authority.candidateRevisionId],
    );
    if (existing.rowCount !== 0) {
      throw new Error('CLAIM_SET_ALREADY_DEFINED');
    }

    for (const claim of normalized.claims) {
      await client.query(
        `insert into candidate_claims
          (claim_id, candidate_id, candidate_revision_id, patch_id,
           catalog_revision_id, claim_key, claim_type, importance,
           statement, statement_hash, created_by)
         values (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11
         )`,
        [
          claim.claimId,
          authority.candidateId,
          authority.candidateRevisionId,
          authority.patchId,
          authority.catalogRevisionId,
          claim.claimKey,
          claim.claimType,
          claim.importance,
          claim.statement,
          claim.statementHash,
          command.actorId,
        ],
      );
    }
    await client.query(
      `insert into candidate_claim_set_seals
        (candidate_id, candidate_revision_id, patch_id,
         catalog_revision_id, claim_count, claim_set_hash, created_by)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [
        authority.candidateId,
        authority.candidateRevisionId,
        authority.patchId,
        authority.catalogRevisionId,
        normalized.claims.length,
        normalized.claimSetHash,
        command.actorId,
      ],
    );

    const claimIds = normalized.claims.map((claim) => claim.claimId);
    const eventPayload = {
      candidateId: authority.candidateId,
      candidateRevisionId: authority.candidateRevisionId,
      claimCount: claimIds.length,
      claimIds,
      claimSetHash: normalized.claimSetHash,
    };
    await client.query(
      `insert into audit_events
        (audit_event_id, actor_id, action, reason, correlation_id,
         payload)
       values (
         $1, $2, 'candidate.claim_set_defined',
         'immutable CandidateRevision claim set', $3, $4::jsonb
       )`,
      [
        randomUUID(),
        command.actorId,
        command.correlationId,
        JSON.stringify(eventPayload),
      ],
    );
    await client.query(
      `insert into outbox_events
        (outbox_event_id, aggregate_type, aggregate_id, event_type,
         payload, correlation_id)
       values (
         $1, 'candidate_revision', $2,
         'CandidateClaimSetDefined', $3::jsonb, $4
       )`,
      [
        randomUUID(),
        authority.candidateRevisionId,
        JSON.stringify(eventPayload),
        command.correlationId,
      ],
    );

    const result: DefineCandidateClaimSetResult = {
      candidateId: authority.candidateId,
      candidateRevisionId: authority.candidateRevisionId,
      claimIds,
      claimSetHash: normalized.claimSetHash,
      replayed: false,
    };
    await completeIdempotentCommand(
      client,
      'candidate_claim_set_definition',
      command.idempotencyKey,
      result,
    );
    return result;
  });
}
