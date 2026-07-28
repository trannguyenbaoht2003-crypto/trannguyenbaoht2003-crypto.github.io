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
import { computeEligibility } from './compute-eligibility.js';
import {
  loadEligibilityAuthority,
} from './load-eligibility-authority.js';
import type {
  EvaluateCandidateEligibilityCommand,
  EvaluateCandidateEligibilityResult,
} from './types.js';

export type {
  EvaluateCandidateEligibilityCommand,
  EvaluateCandidateEligibilityResult,
} from './types.js';

const COMMAND_KEYS = [
  'actorId',
  'candidateId',
  'candidateRevisionId',
  'correlationId',
  'evaluatedAt',
  'evaluationId',
  'idempotencyKey',
  'inputSnapshotId',
] as const;

function compareCanonical(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function requireIsoTimestamp(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error('ELIGIBILITY_EVALUATION_CONFLICT');
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new Error('ELIGIBILITY_EVALUATION_CONFLICT');
  }
  return value;
}

function normalizeCommand(
  input: EvaluateCandidateEligibilityCommand,
): EvaluateCandidateEligibilityCommand {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('ELIGIBILITY_EVALUATION_CONFLICT');
  }
  const actual = Object.keys(input).sort(compareCanonical);
  const expected = [...COMMAND_KEYS].sort(compareCanonical);
  if (
    actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])
  ) {
    throw new Error('ELIGIBILITY_EVALUATION_CONFLICT');
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
      evaluatedAt: requireIsoTimestamp(input.evaluatedAt),
      evaluationId: requireUuid(input.evaluationId, 'evaluationId'),
      idempotencyKey: requireBoundedText(
        input.idempotencyKey,
        'idempotencyKey',
        256,
      ),
      inputSnapshotId: requireUuid(
        input.inputSnapshotId,
        'inputSnapshotId',
      ),
    };
  } catch (error) {
    throw new Error('ELIGIBILITY_EVALUATION_CONFLICT', {
      cause: error,
    });
  }
}

export async function evaluateCandidateEligibility(
  pool: Pool,
  input: EvaluateCandidateEligibilityCommand,
): Promise<EvaluateCandidateEligibilityResult> {
  const command = normalizeCommand(input);
  const commandHash = hashCanonicalTupleV1([
    'TrustTupleV1',
    'EvaluateCandidateEligibilityCommandV1',
    command.candidateId,
    command.candidateRevisionId,
    command.evaluationId,
    command.inputSnapshotId,
    command.evaluatedAt,
    command.actorId,
  ]);

  return withTransaction(pool, async (client) => {
    const authority = await loadEligibilityAuthority(
      client,
      command.candidateId,
      command.candidateRevisionId,
      { lock: true },
    );
    const replay = await beginIdempotentCommand<
      EvaluateCandidateEligibilityResult
    >(
      client,
      'candidate_eligibility_evaluation',
      command.idempotencyKey,
      commandHash,
    );
    if (replay) {
      return { ...replay, replayed: true };
    }
    if (
      !authority.activePolicy
      || !authority.claimSeal
      || !authority.computationInput
      || !authority.inputHash
      || !authority.requiredClaimSetHash
    ) {
      throw new Error('ELIGIBILITY_POLICY_NOT_ACTIVE');
    }
    const computation = computeEligibility(
      authority.computationInput,
    );
    const existing = await client.query<{
      eligibility_input_snapshot_id: string;
    }>(
      `select eligibility_input_snapshot_id
         from eligibility_input_snapshots
        where candidate_revision_id = $1
          and eligibility_policy_revision_id = $2
          and input_hash = $3`,
      [
        authority.candidate.candidateRevisionId,
        authority.activePolicy.eligibilityPolicyRevisionId,
        authority.inputHash,
      ],
    );
    const snapshotId = (
      existing.rows[0]?.eligibility_input_snapshot_id
      ?? command.inputSnapshotId
    );
    if (existing.rowCount === 0) {
      await client.query(
        `insert into eligibility_input_snapshots
          (eligibility_input_snapshot_id, candidate_id,
           candidate_revision_id, patch_id, catalog_revision_id,
           candidate_normalized_signature,
           candidate_claim_set_seal_id, claim_set_hash,
           eligibility_policy_revision_id,
           evidence_policy_revision_id, review_policy_revision_id,
           moderation_policy_revision_id, moderation_decision_id,
           moderation_outcome, moderation_current,
           review_quorum_evaluation_id, review_quorum_satisfied,
           review_current, required_claim_count,
           required_claim_set_hash, input_hash, created_by)
         values (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
           $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22
         )`,
        [
          snapshotId,
          authority.candidate.candidateId,
          authority.candidate.candidateRevisionId,
          authority.candidate.patchId,
          authority.candidate.catalogRevisionId,
          authority.candidate.normalizedSignature,
          authority.claimSeal.candidateClaimSetSealId,
          authority.claimSeal.claimSetHash,
          authority.activePolicy.eligibilityPolicyRevisionId,
          authority.activePolicy.evidencePolicyRevisionId,
          authority.activePolicy.reviewPolicyRevisionId,
          authority.activePolicy.moderationPolicyRevisionId,
          authority.moderation.decisionId,
          authority.moderation.outcome,
          authority.moderation.current,
          authority.review.evaluationId,
          authority.review.present
            ? authority.review.quorumSatisfied
            : null,
          authority.review.current,
          authority.requiredClaims.length,
          authority.requiredClaimSetHash,
          authority.inputHash,
          command.actorId,
        ],
      );
      for (
        let index = 0;
        index < authority.requiredClaims.length;
        index += 1
      ) {
        const claim = authority.requiredClaims[index]!;
        await client.query(
          `insert into eligibility_input_snapshot_required_claims
            (eligibility_input_snapshot_id, claim_id,
             candidate_revision_id, claim_key, importance,
             claim_evidence_decision_id, evidence_decision,
             evidence_policy_revision_id, decision_current, ordinal)
           values ($1, $2, $3, $4, 'required', $5, $6, $7, $8, $9)`,
          [
            snapshotId,
            claim.claimId,
            authority.candidate.candidateRevisionId,
            claim.claimKey,
            claim.decisionId,
            claim.decision,
            claim.evidencePolicyRevisionId,
            claim.current,
            index + 1,
          ],
        );
      }
    }

    await client.query(
      `insert into candidate_eligibility_evaluations
        (candidate_eligibility_evaluation_id, candidate_id,
         candidate_revision_id, eligibility_input_snapshot_id,
         input_hash, eligibility_policy_revision_id, outcome,
         reason_count, evaluator_actor_id, correlation_id,
         evaluated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        command.evaluationId,
        authority.candidate.candidateId,
        authority.candidate.candidateRevisionId,
        snapshotId,
        authority.inputHash,
        authority.activePolicy.eligibilityPolicyRevisionId,
        computation.outcome,
        computation.reasons.length,
        command.actorId,
        command.correlationId,
        command.evaluatedAt,
      ],
    );
    for (let index = 0; index < computation.reasons.length; index += 1) {
      await client.query(
        `insert into candidate_eligibility_evaluation_reasons
          (candidate_eligibility_evaluation_id, reason_code, ordinal)
         values ($1, $2, $3)`,
        [
          command.evaluationId,
          computation.reasons[index],
          index + 1,
        ],
      );
    }
    await client.query(
      `insert into current_candidate_eligibility_evaluations
        (candidate_revision_id, eligibility_policy_revision_id,
         candidate_id, input_hash,
         candidate_eligibility_evaluation_id)
       values ($1, $2, $3, $4, $5)
       on conflict (
         candidate_revision_id,
         eligibility_policy_revision_id
       ) do update
       set candidate_id = excluded.candidate_id,
           input_hash = excluded.input_hash,
           candidate_eligibility_evaluation_id =
             excluded.candidate_eligibility_evaluation_id,
           updated_at = clock_timestamp()`,
      [
        authority.candidate.candidateRevisionId,
        authority.activePolicy.eligibilityPolicyRevisionId,
        authority.candidate.candidateId,
        authority.inputHash,
        command.evaluationId,
      ],
    );

    const eventPayload = {
      candidateId: authority.candidate.candidateId,
      candidateRevisionId: authority.candidate.candidateRevisionId,
      eligibilityPolicyRevisionId:
        authority.activePolicy.eligibilityPolicyRevisionId,
      evaluationId: command.evaluationId,
      inputHash: authority.inputHash,
      outcome: computation.outcome,
      reasons: computation.reasons,
    };
    await client.query(
      `insert into audit_events
        (audit_event_id, actor_id, action, reason, correlation_id,
         policy_version, payload)
       values (
         $1, $2, 'gate.candidate_eligibility_evaluated',
         $3, $4, $5, $6::jsonb
       )`,
      [
        randomUUID(),
        command.actorId,
        `Eligibility evaluated: ${computation.reasons.join(',')}`,
        command.correlationId,
        authority.activePolicy.eligibilityPolicyRevisionId,
        JSON.stringify(eventPayload),
      ],
    );
    await client.query(
      `insert into outbox_events
        (outbox_event_id, aggregate_type, aggregate_id, event_type,
         payload, correlation_id)
       values (
         $1, 'candidate_revision', $2,
         'CandidateEligibilityEvaluated', $3::jsonb, $4
       )`,
      [
        randomUUID(),
        authority.candidate.candidateRevisionId,
        JSON.stringify(eventPayload),
        command.correlationId,
      ],
    );

    const result: EvaluateCandidateEligibilityResult = {
      candidateRevisionId: authority.candidate.candidateRevisionId,
      eligibilityPolicyRevisionId:
        authority.activePolicy.eligibilityPolicyRevisionId,
      evaluationId: command.evaluationId,
      inputHash: authority.inputHash,
      outcome: computation.outcome,
      reasons: computation.reasons,
      replayed: false,
    };
    await completeIdempotentCommand(
      client,
      'candidate_eligibility_evaluation',
      command.idempotencyKey,
      result,
    );
    return result;
  });
}
