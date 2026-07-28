import { randomUUID } from 'node:crypto';

import type { Pool, PoolClient } from 'pg';

import { withTransaction } from '../../database/transaction.js';
import {
  beginIdempotentCommand,
  completeIdempotentCommand,
} from '../../shared/idempotent-command.js';
import { lockCandidateRevisionAuthority } from './load-trust-authority.js';
import {
  hashCanonicalTupleV1,
  requireBoundedText,
  requireUuid,
} from './normalize-trust-input.js';
import type {
  CompleteHumanReviewCommand,
  CompleteHumanReviewResult,
  HumanReviewOutcome,
} from './types.js';

export type {
  CompleteHumanReviewCommand,
  CompleteHumanReviewResult,
} from './types.js';

const COMMAND_KEYS = [
  'actorId',
  'candidateId',
  'candidateRevisionId',
  'completedAt',
  'correlationId',
  'humanReviewId',
  'idempotencyKey',
  'outcome',
  'permissionUsed',
  'reason',
  'reviewInputSnapshotId',
  'reviewPolicyRevisionId',
  'reviewQuorumEvaluationId',
] as const;

const OUTCOMES = new Set<HumanReviewOutcome>([
  'confirmed',
  'changes_requested',
  'declined',
]);

interface ConstraintError {
  code?: string;
  constraint?: string;
}

interface ReviewClaimRow {
  claim_id: string;
  claim_key: string;
  importance: 'required' | 'supporting' | 'informational';
  claim_evidence_decision_id: string | null;
}

interface ReviewProvenanceRow {
  candidate_provenance_id: string;
  origin:
    | 'collector_detected'
    | 'community_submitted'
    | 'editorial'
    | 'ai_generated';
}

interface ClaimSealRow {
  candidate_claim_set_seal_id: string;
  claim_set_hash: string;
}

interface ReviewPolicyRow {
  minimum_confirmed_reviews: number;
  applies_to_ai_provenance: boolean;
}

interface ReviewSnapshotRow {
  review_input_snapshot_id: string;
  input_hash: string;
}

interface ConfirmedReviewRow {
  human_review_id: string;
  candidate_id: string;
  candidate_revision_id: string;
  review_policy_revision_id: string;
  input_hash: string;
  reviewer_actor_id: string;
}

function compareCanonical(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function requireExactKeys(
  value: unknown,
  expectedKeys: readonly string[],
): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('TRUST_OBJECT_KEYS_INVALID:humanReviewCommand');
  }
  const actual = Object.keys(value).sort(compareCanonical);
  const expected = [...expectedKeys].sort(compareCanonical);
  if (
    actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])
  ) {
    throw new Error('TRUST_OBJECT_KEYS_INVALID:humanReviewCommand');
  }
}

function requireIsoTimestamp(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error('REVIEW_INPUT_STALE');
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new Error('REVIEW_INPUT_STALE');
  }
  return value;
}

function normalizeCommand(
  input: CompleteHumanReviewCommand,
): CompleteHumanReviewCommand {
  requireExactKeys(input, COMMAND_KEYS);
  if (input.permissionUsed !== 'reviewer') {
    throw new Error('REVIEW_PERMISSION_REQUIRED');
  }
  if (
    typeof input.outcome !== 'string'
    || !OUTCOMES.has(input.outcome as HumanReviewOutcome)
  ) {
    throw new Error('REVIEW_INPUT_STALE');
  }
  return {
    actorId: requireBoundedText(input.actorId, 'actorId', 256),
    candidateId: requireUuid(input.candidateId, 'candidateId'),
    candidateRevisionId: requireUuid(
      input.candidateRevisionId,
      'candidateRevisionId',
    ),
    completedAt: requireIsoTimestamp(input.completedAt),
    correlationId: requireBoundedText(
      input.correlationId,
      'correlationId',
      256,
    ),
    humanReviewId: requireUuid(input.humanReviewId, 'humanReviewId'),
    idempotencyKey: requireBoundedText(
      input.idempotencyKey,
      'idempotencyKey',
      256,
    ),
    outcome: input.outcome as HumanReviewOutcome,
    permissionUsed: 'reviewer',
    reason: requireBoundedText(input.reason, 'reason', 1024),
    reviewInputSnapshotId: requireUuid(
      input.reviewInputSnapshotId,
      'reviewInputSnapshotId',
    ),
    reviewPolicyRevisionId: requireUuid(
      input.reviewPolicyRevisionId,
      'reviewPolicyRevisionId',
    ),
    reviewQuorumEvaluationId: requireUuid(
      input.reviewQuorumEvaluationId,
      'reviewQuorumEvaluationId',
    ),
  };
}

function commandPayloadHash(command: CompleteHumanReviewCommand): string {
  return hashCanonicalTupleV1([
    'TrustTupleV1',
    'CompleteHumanReviewCommandV1',
    command.candidateId,
    command.candidateRevisionId,
    command.humanReviewId,
    command.reviewInputSnapshotId,
    command.reviewPolicyRevisionId,
    command.reviewQuorumEvaluationId,
    command.actorId,
    command.permissionUsed,
    command.outcome,
    command.reason,
    command.completedAt,
  ]);
}

async function lockClaims(
  client: PoolClient,
  candidateRevisionId: string,
): Promise<ReviewClaimRow[]> {
  const claims = await client.query<ReviewClaimRow>(
    `select claim.claim_id,
            claim.claim_key,
            claim.importance,
            current.claim_evidence_decision_id
       from candidate_claims claim
       left join current_claim_evidence_decisions current
         on current.claim_id = claim.claim_id
      where claim.candidate_revision_id = $1
      order by claim.claim_key collate "C"
      for update of claim`,
    [candidateRevisionId],
  );
  if (claims.rowCount === 0) {
    throw new Error('CLAIM_SET_NOT_SEALED');
  }
  return claims.rows;
}

async function loadClaimSeal(
  client: PoolClient,
  candidateRevisionId: string,
): Promise<ClaimSealRow> {
  const seal = await client.query<ClaimSealRow>(
    `select candidate_claim_set_seal_id,
            claim_set_hash
       from candidate_claim_set_seals
      where candidate_revision_id = $1`,
    [candidateRevisionId],
  );
  const row = seal.rows[0];
  if (!row) {
    throw new Error('CLAIM_SET_NOT_SEALED');
  }
  return row;
}

async function loadReviewPolicy(
  client: PoolClient,
  reviewPolicyRevisionId: string,
): Promise<ReviewPolicyRow> {
  const policy = await client.query<ReviewPolicyRow>(
    `select minimum_confirmed_reviews,
            applies_to_ai_provenance
       from review_policy_revisions
      where review_policy_revision_id = $1`,
    [reviewPolicyRevisionId],
  );
  const row = policy.rows[0];
  if (!row) {
    throw new Error('REVIEW_INPUT_STALE');
  }
  return row;
}

async function loadProvenance(
  client: PoolClient,
  candidateRevisionId: string,
): Promise<ReviewProvenanceRow[]> {
  const provenance = await client.query<ReviewProvenanceRow>(
    `select candidate_provenance_id,
            origin
       from candidate_provenance
      where candidate_revision_id = $1
      order by candidate_provenance_id::text collate "C"`,
    [candidateRevisionId],
  );
  if (provenance.rowCount === 0) {
    throw new Error('REVIEW_INPUT_STALE');
  }
  return provenance.rows;
}

function reviewInputHashes(
  candidateId: string,
  candidateRevisionId: string,
  patchId: string,
  catalogRevisionId: string,
  normalizedSignature: string,
  claimSetHash: string,
  reviewPolicyRevisionId: string,
  claims: ReviewClaimRow[],
  provenance: ReviewProvenanceRow[],
): {
  claimDecisionSetHash: string;
  inputHash: string;
  provenanceSetHash: string;
} {
  const claimTokens = claims.flatMap((claim) => [
    claim.claim_id,
    claim.importance,
    claim.claim_evidence_decision_id ?? '@null',
  ]);
  const provenanceTokens = provenance.flatMap((entry) => [
    entry.candidate_provenance_id,
    entry.origin,
  ]);
  const claimDecisionSetHash = hashCanonicalTupleV1([
    'TrustTupleV1',
    'ReviewClaimDecisionSetV1',
    candidateRevisionId,
    String(claims.length),
    ...claimTokens,
  ]);
  const provenanceSetHash = hashCanonicalTupleV1([
    'TrustTupleV1',
    'ReviewProvenanceSetV1',
    candidateRevisionId,
    String(provenance.length),
    ...provenanceTokens,
  ]);
  const inputHash = hashCanonicalTupleV1([
    'TrustTupleV1',
    'ReviewInputSnapshotV1',
    candidateId,
    candidateRevisionId,
    patchId,
    catalogRevisionId,
    normalizedSignature,
    claimSetHash,
    reviewPolicyRevisionId,
    String(claims.length),
    ...claimTokens,
    String(provenance.length),
    ...provenanceTokens,
  ]);
  return {
    claimDecisionSetHash,
    inputHash,
    provenanceSetHash,
  };
}

async function resolveReviewSnapshot(
  client: PoolClient,
  command: CompleteHumanReviewCommand,
  authority: Awaited<
    ReturnType<typeof lockCandidateRevisionAuthority>
  >,
  seal: ClaimSealRow,
  claims: ReviewClaimRow[],
  provenance: ReviewProvenanceRow[],
): Promise<ReviewSnapshotRow> {
  const hashes = reviewInputHashes(
    authority.candidateId,
    authority.candidateRevisionId,
    authority.patchId,
    authority.catalogRevisionId,
    authority.normalizedSignature,
    seal.claim_set_hash,
    command.reviewPolicyRevisionId,
    claims,
    provenance,
  );
  const existing = await client.query<ReviewSnapshotRow>(
    `select review_input_snapshot_id,
            input_hash
       from review_input_snapshots
      where candidate_revision_id = $1
        and review_policy_revision_id = $2
        and input_hash = $3`,
    [
      authority.candidateRevisionId,
      command.reviewPolicyRevisionId,
      hashes.inputHash,
    ],
  );
  const snapshot = existing.rows[0];
  if (snapshot) {
    return snapshot;
  }

  await client.query(
    `insert into review_input_snapshots
      (review_input_snapshot_id, candidate_id, candidate_revision_id,
       patch_id, catalog_revision_id, candidate_normalized_signature,
       candidate_claim_set_seal_id, claim_set_hash, claim_count,
       provenance_count, provenance_set_hash,
       claim_decision_set_hash, review_policy_revision_id,
       input_hash, created_by)
     values (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
       $14, $15
     )`,
    [
      command.reviewInputSnapshotId,
      authority.candidateId,
      authority.candidateRevisionId,
      authority.patchId,
      authority.catalogRevisionId,
      authority.normalizedSignature,
      seal.candidate_claim_set_seal_id,
      seal.claim_set_hash,
      claims.length,
      provenance.length,
      hashes.provenanceSetHash,
      hashes.claimDecisionSetHash,
      command.reviewPolicyRevisionId,
      hashes.inputHash,
      command.actorId,
    ],
  );
  for (let index = 0; index < claims.length; index += 1) {
    const claim = claims[index]!;
    await client.query(
      `insert into review_input_snapshot_claims
        (review_input_snapshot_id, claim_id,
         candidate_revision_id, importance,
         claim_evidence_decision_id, ordinal)
       values ($1, $2, $3, $4, $5, $6)`,
      [
        command.reviewInputSnapshotId,
        claim.claim_id,
        authority.candidateRevisionId,
        claim.importance,
        claim.claim_evidence_decision_id,
        index + 1,
      ],
    );
  }
  for (let index = 0; index < provenance.length; index += 1) {
    const entry = provenance[index]!;
    await client.query(
      `insert into review_input_snapshot_provenance
        (review_input_snapshot_id, candidate_provenance_id,
         candidate_revision_id, origin, ordinal)
       values ($1, $2, $3, $4, $5)`,
      [
        command.reviewInputSnapshotId,
        entry.candidate_provenance_id,
        authority.candidateRevisionId,
        entry.origin,
        index + 1,
      ],
    );
  }
  return {
    review_input_snapshot_id: command.reviewInputSnapshotId,
    input_hash: hashes.inputHash,
  };
}

function isDuplicateReviewer(error: unknown): error is ConstraintError {
  if (error === null || typeof error !== 'object') {
    return false;
  }
  const value = error as ConstraintError;
  return value.code === '23505'
    && Boolean(
      value.constraint?.startsWith(
        'human_reviews_reviewer_actor_id_',
      ),
    );
}

export async function completeHumanReview(
  pool: Pool,
  input: CompleteHumanReviewCommand,
): Promise<CompleteHumanReviewResult> {
  const command = normalizeCommand(input);
  const payloadHash = commandPayloadHash(command);
  try {
    return await withTransaction(pool, async (client) => {
      const authority = await lockCandidateRevisionAuthority(
        client,
        command.candidateId,
        command.candidateRevisionId,
      );
      const claims = await lockClaims(
        client,
        authority.candidateRevisionId,
      );
      const seal = await loadClaimSeal(
        client,
        authority.candidateRevisionId,
      );
      const policy = await loadReviewPolicy(
        client,
        command.reviewPolicyRevisionId,
      );
      const replay = await beginIdempotentCommand<
        CompleteHumanReviewResult
      >(
        client,
        'human_review_completion',
        command.idempotencyKey,
        payloadHash,
      );
      if (replay) {
        return {
          ...replay,
          replayed: true,
        };
      }

      const provenance = await loadProvenance(
        client,
        authority.candidateRevisionId,
      );
      if (
        provenance.some((entry) => entry.origin === 'ai_generated')
        && !policy.applies_to_ai_provenance
      ) {
        throw new Error('REVIEW_INPUT_STALE');
      }
      const snapshot = await resolveReviewSnapshot(
        client,
        command,
        authority,
        seal,
        claims,
        provenance,
      );

      await client.query(
        `insert into human_reviews
          (human_review_id, candidate_id, candidate_revision_id,
           review_input_snapshot_id, input_hash,
           review_policy_revision_id, reviewer_actor_id, status,
           outcome, permission_used, reason, correlation_id,
           completed_at)
         values (
           $1, $2, $3, $4, $5, $6, $7, 'completed', $8,
           'reviewer', $9, $10, $11
         )`,
        [
          command.humanReviewId,
          authority.candidateId,
          authority.candidateRevisionId,
          snapshot.review_input_snapshot_id,
          snapshot.input_hash,
          command.reviewPolicyRevisionId,
          command.actorId,
          command.outcome,
          command.reason,
          command.correlationId,
          command.completedAt,
        ],
      );
      const confirmed = await client.query<ConfirmedReviewRow>(
        `select human_review_id,
                candidate_id,
                candidate_revision_id,
                review_policy_revision_id,
                input_hash,
                reviewer_actor_id
           from human_reviews
          where candidate_revision_id = $1
            and review_policy_revision_id = $2
            and input_hash = $3
            and status = 'completed'
            and outcome = 'confirmed'
            and permission_used = 'reviewer'
          order by completed_at,
                   human_review_id::text collate "C"`,
        [
          authority.candidateRevisionId,
          command.reviewPolicyRevisionId,
          snapshot.input_hash,
        ],
      );
      const confirmedReviewerCount = confirmed.rows.length;
      const quorumSatisfied = confirmedReviewerCount
        >= policy.minimum_confirmed_reviews;
      await client.query(
        `insert into review_quorum_evaluations
          (review_quorum_evaluation_id, candidate_id,
           candidate_revision_id, review_input_snapshot_id,
           input_hash, review_policy_revision_id,
           required_confirmed_count, counted_review_count,
           quorum_satisfied, evaluated_at)
         values (
           $1, $2, $3, $4, $5, $6, $7, $8, $9,
           clock_timestamp()
         )`,
        [
          command.reviewQuorumEvaluationId,
          authority.candidateId,
          authority.candidateRevisionId,
          snapshot.review_input_snapshot_id,
          snapshot.input_hash,
          command.reviewPolicyRevisionId,
          policy.minimum_confirmed_reviews,
          confirmedReviewerCount,
          quorumSatisfied,
        ],
      );
      for (let index = 0; index < confirmed.rows.length; index += 1) {
        const review = confirmed.rows[index]!;
        await client.query(
          `insert into review_quorum_evaluation_reviews
            (review_quorum_evaluation_id, human_review_id,
             candidate_id, candidate_revision_id,
             review_policy_revision_id, input_hash,
             reviewer_actor_id, ordinal)
           values ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            command.reviewQuorumEvaluationId,
            review.human_review_id,
            review.candidate_id,
            review.candidate_revision_id,
            review.review_policy_revision_id,
            review.input_hash,
            review.reviewer_actor_id,
            index + 1,
          ],
        );
      }
      await client.query(
        `insert into current_review_quorum_evaluations
          (candidate_revision_id, review_policy_revision_id,
           candidate_id, input_hash,
           review_quorum_evaluation_id)
         values ($1, $2, $3, $4, $5)
         on conflict (
           candidate_revision_id,
           review_policy_revision_id
         ) do update
         set input_hash = excluded.input_hash,
             review_quorum_evaluation_id =
               excluded.review_quorum_evaluation_id,
             updated_at = clock_timestamp()`,
        [
          authority.candidateRevisionId,
          command.reviewPolicyRevisionId,
          authority.candidateId,
          snapshot.input_hash,
          command.reviewQuorumEvaluationId,
        ],
      );

      const eventPayload = {
        candidateId: authority.candidateId,
        candidateRevisionId: authority.candidateRevisionId,
        confirmedReviewerCount,
        humanReviewId: command.humanReviewId,
        inputHash: snapshot.input_hash,
        outcome: command.outcome,
        quorumEvaluationId: command.reviewQuorumEvaluationId,
        quorumSatisfied,
        requiredConfirmedReviews:
          policy.minimum_confirmed_reviews,
        reviewPolicyRevisionId: command.reviewPolicyRevisionId,
      };
      await client.query(
        `insert into audit_events
          (audit_event_id, actor_id, action, reason, correlation_id,
           policy_version, payload)
         values (
           $1, $2, 'review.human_review_completed', $3, $4, $5,
           $6::jsonb
         )`,
        [
          randomUUID(),
          command.actorId,
          command.reason,
          command.correlationId,
          command.reviewPolicyRevisionId,
          JSON.stringify(eventPayload),
        ],
      );
      await client.query(
        `insert into outbox_events
          (outbox_event_id, aggregate_type, aggregate_id, event_type,
           payload, correlation_id)
         values (
           $1, 'candidate_revision', $2,
           'HumanReviewCompleted', $3::jsonb, $4
         )`,
        [
          randomUUID(),
          authority.candidateRevisionId,
          JSON.stringify(eventPayload),
          command.correlationId,
        ],
      );

      const result: CompleteHumanReviewResult = {
        candidateRevisionId: authority.candidateRevisionId,
        humanReviewId: command.humanReviewId,
        inputHash: snapshot.input_hash,
        quorumEvaluationId: command.reviewQuorumEvaluationId,
        confirmedReviewerCount,
        requiredConfirmedReviews:
          policy.minimum_confirmed_reviews,
        quorumSatisfied,
        replayed: false,
      };
      await completeIdempotentCommand(
        client,
        'human_review_completion',
        command.idempotencyKey,
        result,
      );
      return result;
    });
  } catch (error) {
    if (isDuplicateReviewer(error)) {
      throw new Error('REVIEW_ALREADY_COMPLETED', { cause: error });
    }
    throw error;
  }
}
