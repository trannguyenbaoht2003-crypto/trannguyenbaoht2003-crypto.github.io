import type { Pool, PoolClient } from 'pg';

import {
  evaluateCandidateEligibility,
} from '../../src/modules/eligibility/evaluate-candidate-eligibility.js';
import {
  buildPublicationPayload,
} from '../../src/modules/publication/build-publication-payload.js';
import type {
  PublicationPayloadAuthority,
  PublicationPayloadV1,
} from '../../src/modules/publication/types.js';
import {
  recordCandidateModerationDecision,
} from '../../src/modules/moderation/record-candidate-moderation-decision.js';
import {
  completeHumanReview,
} from '../../src/modules/trust/complete-human-review.js';
import {
  recordClaimEvidenceDecision,
} from '../../src/modules/trust/record-claim-evidence-decision.js';
import { CANDIDATE_IDS } from './candidate.js';
import {
  GATE_IDS,
  moderationDecisionCommand,
  seedActivatedGateContext,
  seedSatisfiedReviewQuorum,
} from './gate.js';
import {
  CROSS_PATCH_IDS,
  evidenceDecisionCommand,
  humanReviewCommand,
  seedCrossPatchClaimSet,
} from './trust.js';

export const PUBLICATION_IDS = {
  publicationId: '77000000-0000-4000-8000-000000000001',
  publicationVersionId: '77000000-0000-4000-8000-000000000002',
  activationId: '77000000-0000-4000-8000-000000000003',
  auditId: '77000000-0000-4000-8000-000000000004',
  outboxEventId: '77000000-0000-4000-8000-000000000005',
} as const;

export const SECOND_PUBLICATION_CONTEXT_IDS = {
  requiredClaimId: '78000000-0000-4000-8000-000000000001',
  evidenceId: '78000000-0000-4000-8000-000000000002',
  evidenceAssociationId: '78000000-0000-4000-8000-000000000003',
  evidenceInputSnapshotId: '78000000-0000-4000-8000-000000000004',
  evidenceDecisionId: '78000000-0000-4000-8000-000000000005',
  firstReviewInputSnapshotId:
    '78000000-0000-4000-8000-000000000006',
  firstHumanReviewId: '78000000-0000-4000-8000-000000000007',
  firstReviewQuorumEvaluationId:
    '78000000-0000-4000-8000-000000000008',
  secondReviewInputSnapshotId:
    '78000000-0000-4000-8000-000000000009',
  secondHumanReviewId: '78000000-0000-4000-8000-000000000010',
  secondReviewQuorumEvaluationId:
    '78000000-0000-4000-8000-000000000011',
  moderationInputSnapshotId:
    '78000000-0000-4000-8000-000000000012',
  moderationDecisionId: '78000000-0000-4000-8000-000000000013',
  eligibilityInputSnapshotId:
    '78000000-0000-4000-8000-000000000014',
  eligibilityEvaluationId:
    '78000000-0000-4000-8000-000000000015',
  publicationId: '78000000-0000-4000-8000-000000000016',
  publicationVersionId: '78000000-0000-4000-8000-000000000017',
  activationId: '78000000-0000-4000-8000-000000000018',
  auditId: '78000000-0000-4000-8000-000000000019',
  outboxEventId: '78000000-0000-4000-8000-000000000020',
} as const;

export async function seedEligiblePublicationContext(
  pool: Pool,
): Promise<void> {
  await seedActivatedGateContext(pool);
  await recordCandidateModerationDecision(
    pool,
    moderationDecisionCommand(),
  );
  await seedSatisfiedReviewQuorum(pool);
  await evaluateCandidateEligibility(pool, {
    actorId: 'eligibility-evaluator',
    candidateId: CANDIDATE_IDS.candidateId,
    candidateRevisionId: CANDIDATE_IDS.candidateRevisionId,
    correlationId: 'publication-eligibility-v1',
    evaluatedAt: '2026-07-29T01:00:00.000Z',
    evaluationId: GATE_IDS.eligibilityEvaluationId,
    idempotencyKey: 'publication-eligibility-v1',
    inputSnapshotId: GATE_IDS.eligibilityInputSnapshotId,
  });
}

export async function seedSecondEligiblePublicationContext(
  pool: Pool,
): Promise<void> {
  await seedCrossPatchClaimSet(pool);
  await recordClaimEvidenceDecision(pool, evidenceDecisionCommand({
    actorId: 'second-publication-evidence-evaluator',
    associations: [
      {
        associationId: CROSS_PATCH_IDS.associationId,
        crossPatchRevalidated: false,
        evidenceId: SECOND_PUBLICATION_CONTEXT_IDS.evidenceId,
        normalizedObservationId: CROSS_PATCH_IDS.normalizedObservationId,
        revalidationReason: null,
        stance: 'supports',
      },
    ],
    candidateId: CROSS_PATCH_IDS.candidateId,
    candidateRevisionId: CROSS_PATCH_IDS.candidateRevisionId,
    claimId: CROSS_PATCH_IDS.claimId,
    correlationId: 'second-publication-evidence',
    decisionId: SECOND_PUBLICATION_CONTEXT_IDS.evidenceDecisionId,
    evaluatedAt: '2026-07-29T00:30:00.000Z',
    evidenceInputSnapshotId:
      SECOND_PUBLICATION_CONTEXT_IDS.evidenceInputSnapshotId,
    idempotencyKey: 'second-publication-evidence',
    reason: 'Second CandidateRevision Evidence is supported.',
  }));
  await completeHumanReview(pool, humanReviewCommand({
    actorId: 'second-publication-reviewer-a',
    candidateId: CROSS_PATCH_IDS.candidateId,
    candidateRevisionId: CROSS_PATCH_IDS.candidateRevisionId,
    completedAt: '2026-07-29T01:05:00.000Z',
    correlationId: 'second-publication-review-a',
    humanReviewId:
      SECOND_PUBLICATION_CONTEXT_IDS.firstHumanReviewId,
    idempotencyKey: 'second-publication-review-a',
    reason: 'First reviewer confirmed the second CandidateRevision.',
    reviewInputSnapshotId:
      SECOND_PUBLICATION_CONTEXT_IDS.firstReviewInputSnapshotId,
    reviewQuorumEvaluationId:
      SECOND_PUBLICATION_CONTEXT_IDS.firstReviewQuorumEvaluationId,
  }));
  await completeHumanReview(pool, humanReviewCommand({
    actorId: 'second-publication-reviewer-b',
    candidateId: CROSS_PATCH_IDS.candidateId,
    candidateRevisionId: CROSS_PATCH_IDS.candidateRevisionId,
    completedAt: '2026-07-29T01:06:00.000Z',
    correlationId: 'second-publication-review-b',
    humanReviewId:
      SECOND_PUBLICATION_CONTEXT_IDS.secondHumanReviewId,
    idempotencyKey: 'second-publication-review-b',
    reason: 'Second reviewer confirmed the second CandidateRevision.',
    reviewInputSnapshotId:
      SECOND_PUBLICATION_CONTEXT_IDS.secondReviewInputSnapshotId,
    reviewQuorumEvaluationId:
      SECOND_PUBLICATION_CONTEXT_IDS.secondReviewQuorumEvaluationId,
  }));
  await recordCandidateModerationDecision(
    pool,
    moderationDecisionCommand({
      actorId: 'second-publication-moderator',
      candidateId: CROSS_PATCH_IDS.candidateId,
      candidateRevisionId: CROSS_PATCH_IDS.candidateRevisionId,
      correlationId: 'second-publication-moderation',
      decisionId: SECOND_PUBLICATION_CONTEXT_IDS.moderationDecisionId,
      evaluatedAt: '2026-07-29T01:10:00.000Z',
      idempotencyKey: 'second-publication-moderation',
      inputSnapshotId:
        SECOND_PUBLICATION_CONTEXT_IDS.moderationInputSnapshotId,
      reason: 'Second CandidateRevision passed Moderation.',
    }),
  );
  const evaluation = await evaluateCandidateEligibility(pool, {
    actorId: 'second-publication-eligibility-evaluator',
    candidateId: CROSS_PATCH_IDS.candidateId,
    candidateRevisionId: CROSS_PATCH_IDS.candidateRevisionId,
    correlationId: 'second-publication-eligibility',
    evaluatedAt: '2026-07-29T01:20:00.000Z',
    evaluationId:
      SECOND_PUBLICATION_CONTEXT_IDS.eligibilityEvaluationId,
    idempotencyKey: 'second-publication-eligibility',
    inputSnapshotId:
      SECOND_PUBLICATION_CONTEXT_IDS.eligibilityInputSnapshotId,
  });
  if (evaluation.outcome !== 'eligible') {
    throw new Error('second publication fixture is not eligible');
  }
}

interface DirectPublicationAuthorityRow {
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
  eligibility_input_hash: string;
  moderation_policy_revision_id: string;
  moderation_decision_id: string;
  moderation_input_hash: string;
}

export interface DirectPublicationMutation {
  activationKind?: 'published' | 'rolled_back';
  omitRequiredMembers?: boolean;
  payload?: PublicationPayloadV1;
  versionNumber?: number;
}

export async function insertDirectPublicationGraph(
  client: PoolClient,
  mutation: DirectPublicationMutation = {},
): Promise<void> {
  const authorityResult = await client.query<DirectPublicationAuthorityRow>(
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
            evaluation.input_hash as eligibility_input_hash,
            snapshot.moderation_policy_revision_id,
            snapshot.moderation_decision_id,
            moderation.input_hash as moderation_input_hash
       from candidate_revisions revision
       join candidates candidate
         on candidate.candidate_id = revision.candidate_id
       join patches patch
         on patch.patch_id = candidate.patch_id
       join game_entities entity
         on entity.game_entity_id = candidate.subject_game_entity_id
       join current_candidate_eligibility_evaluations current_evaluation
         on current_evaluation.candidate_revision_id =
            revision.candidate_revision_id
       join candidate_eligibility_evaluations evaluation
         on evaluation.candidate_eligibility_evaluation_id =
            current_evaluation.candidate_eligibility_evaluation_id
       join eligibility_input_snapshots snapshot
         on snapshot.eligibility_input_snapshot_id =
            evaluation.eligibility_input_snapshot_id
       join moderation_decisions moderation
         on moderation.moderation_decision_id =
            snapshot.moderation_decision_id
      where revision.candidate_revision_id = $1`,
    [CANDIDATE_IDS.candidateRevisionId],
  );
  const authority = authorityResult.rows[0];
  if (!authority) {
    throw new Error('publication test authority missing');
  }
  const built = buildPublicationPayload({
    candidateId: authority.candidate_id,
    candidateRevisionId: authority.candidate_revision_id,
    patchKey: authority.patch_key,
    catalogRevisionId: authority.catalog_revision_id,
    gameModeExternalId: authority.game_mode_external_id,
    championExternalId: authority.champion_external_id,
    canonicalPayload: authority.canonical_payload,
  });
  const payload = mutation.payload ?? built.payload;

  await client.query(
    `insert into publications
       (publication_id, candidate_id, created_by)
     values ($1, $2, 'direct-sql-test')`,
    [PUBLICATION_IDS.publicationId, authority.candidate_id],
  );
  await client.query(
    `insert into audit_events
       (audit_event_id, actor_id, action, reason, correlation_id, payload)
     values ($1, 'direct-sql-test', 'publication.version_published',
             'publication migration test', 'publication-migration',
             '{}'::jsonb)`,
    [PUBLICATION_IDS.auditId],
  );
  await client.query(
    `insert into outbox_events
       (outbox_event_id, aggregate_type, aggregate_id, event_type,
        payload, correlation_id)
     values ($1, 'Publication', $2, 'PublicationPublished',
             '{}'::jsonb, 'publication-migration')`,
    [PUBLICATION_IDS.outboxEventId, PUBLICATION_IDS.publicationId],
  );
  await client.query(
    `insert into publication_versions
       (publication_version_id, publication_id, candidate_id,
        candidate_revision_id, patch_id, catalog_revision_id,
        candidate_normalized_signature,
        eligibility_policy_revision_id,
        candidate_eligibility_evaluation_id, eligibility_input_hash,
        moderation_policy_revision_id, moderation_decision_id,
        moderation_input_hash, version_number, publication_payload,
        payload_hash, published_by, correlation_id, published_at)
     values
       ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
        $13, $14, $15::jsonb, $16, 'direct-sql-test',
        'publication-migration', '2026-07-29T02:00:00.000Z')`,
    [
      PUBLICATION_IDS.publicationVersionId,
      PUBLICATION_IDS.publicationId,
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
      mutation.versionNumber ?? 1,
      JSON.stringify(payload),
      built.payloadHash,
    ],
  );

  if (!mutation.omitRequiredMembers) {
    await client.query(
      `insert into publication_version_input_required_claims
         (publication_version_id, publication_id, candidate_id,
          candidate_revision_id, claim_id, importance,
          claim_evidence_decision_id, evidence_decision,
          evidence_policy_revision_id, ordinal)
       select $1, $2, $3, $4, member.claim_id, 'required',
              member.claim_evidence_decision_id,
              member.evidence_decision,
              member.evidence_policy_revision_id,
              member.ordinal
         from eligibility_input_snapshot_required_claims member
        where member.eligibility_input_snapshot_id = $5`,
      [
        PUBLICATION_IDS.publicationVersionId,
        PUBLICATION_IDS.publicationId,
        authority.candidate_id,
        authority.candidate_revision_id,
        GATE_IDS.eligibilityInputSnapshotId,
      ],
    );
  }

  const activation = await client.query<{ activation_sequence: string }>(
    `insert into publication_activation_history
       (activation_id, publication_id, activation_kind,
        from_publication_version_id, to_publication_version_id,
        actor_id, audit_event_id, outbox_event_id, correlation_id,
        activated_at)
     values ($1, $2, $3, null, $4, 'direct-sql-test', $5, $6,
             'publication-migration', '2026-07-29T02:00:00.000Z')
     returning activation_sequence::text`,
    [
      PUBLICATION_IDS.activationId,
      PUBLICATION_IDS.publicationId,
      mutation.activationKind ?? 'published',
      PUBLICATION_IDS.publicationVersionId,
      PUBLICATION_IDS.auditId,
      PUBLICATION_IDS.outboxEventId,
    ],
  );
  await client.query(
    `insert into active_publication_versions
       (publication_id, publication_version_id, activation_id,
        activation_sequence)
     values ($1, $2, $3, $4::bigint)`,
    [
      PUBLICATION_IDS.publicationId,
      PUBLICATION_IDS.publicationVersionId,
      PUBLICATION_IDS.activationId,
      activation.rows[0]!.activation_sequence,
    ],
  );
}
