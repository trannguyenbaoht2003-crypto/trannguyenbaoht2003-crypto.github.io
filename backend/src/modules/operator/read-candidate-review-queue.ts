import type { Pool } from 'pg';

import type {
  OperatorCandidateConfidence,
  OperatorCandidateReviewQueue,
  OperatorCandidateReviewQueueItem,
  OperatorCandidateReviewQueueOptions,
} from './types.js';

interface ActiveReviewPolicyRow {
  minimum_confirmed_reviews: number;
  review_policy_revision_id: string;
}

interface CandidateReviewQueueRow {
  band: 'low' | 'medium' | 'high' | 'very_high' | null;
  candidate_confidence_score_id: string | null;
  candidate_id: string;
  candidate_revision_id: string;
  canonical_payload: unknown;
  catalog_revision_id: string;
  confidence_created_at: Date | string | null;
  counted_review_count: number | null;
  created_at: Date | string;
  evaluated_at: Date | string | null;
  evidence_diversity_score: number | null;
  freshness_score: number | null;
  patch_alignment_score: number | null;
  patch_id: string;
  provenance_quality_score: number | null;
  required_confirmed_count: number | null;
  review_quorum_evaluation_id: string | null;
  revision: number;
  score: number | null;
  scoring_version: string | null;
  subject_external_id: string;
}

interface CandidateSelectionPayloadV1 {
  schemaVersion: 1;
  augmentExternalIds: string[];
  itemExternalIds: string[];
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function invalidRow(): never {
  throw new Error('OPERATOR_CANDIDATE_QUEUE_ROW_INVALID');
}

function boundedLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 50;
  return Math.min(100, Math.max(1, Math.trunc(value)));
}

function requireUuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) invalidRow();
  return value;
}

function requireNonEmptyText(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) invalidRow();
  return value;
}

function requireInteger(
  value: unknown,
  allowed: readonly number[] | null = null,
): number {
  if (!Number.isInteger(value)) invalidRow();
  const integer = value as number;
  if (allowed !== null && !allowed.includes(integer)) invalidRow();
  return integer;
}

function requireIsoTimestamp(value: unknown): string {
  const parsed = value instanceof Date
    ? value
    : typeof value === 'string'
      ? new Date(value)
      : null;
  if (parsed === null || Number.isNaN(parsed.getTime())) invalidRow();
  const iso = parsed.toISOString();
  if (typeof value === 'string' && value !== iso) invalidRow();
  return iso;
}

function requireIdArray(value: unknown): string[] {
  if (!Array.isArray(value)) invalidRow();
  const ids = value.map(requireNonEmptyText);
  if (new Set(ids).size !== ids.length) invalidRow();
  return ids;
}

function requireSelection(value: unknown): CandidateSelectionPayloadV1 {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    invalidRow();
  }
  const object = value as Record<string, unknown>;
  const keys = Object.keys(object).sort();
  if (
    keys.length !== 3
    || keys[0] !== 'augmentExternalIds'
    || keys[1] !== 'itemExternalIds'
    || keys[2] !== 'schemaVersion'
    || object.schemaVersion !== 1
  ) {
    invalidRow();
  }
  return {
    schemaVersion: 1,
    augmentExternalIds: requireIdArray(object.augmentExternalIds),
    itemExternalIds: requireIdArray(object.itemExternalIds),
  };
}

function expectedBand(score: number): OperatorCandidateConfidence['band'] {
  if (score <= 39) return 'low';
  if (score <= 69) return 'medium';
  if (score <= 89) return 'high';
  if (score === 90) return 'very_high';
  return invalidRow();
}

function mapConfidence(
  row: CandidateReviewQueueRow,
): OperatorCandidateConfidence | null {
  const values = [
    row.candidate_confidence_score_id,
    row.scoring_version,
    row.score,
    row.band,
    row.provenance_quality_score,
    row.evidence_diversity_score,
    row.patch_alignment_score,
    row.freshness_score,
    row.evaluated_at,
    row.confidence_created_at,
  ];
  if (values.every((value) => value === null)) return null;
  if (values.some((value) => value === null)) invalidRow();

  if (row.scoring_version !== 'candidate-confidence-v1') invalidRow();
  const provenanceQualityScore = requireInteger(
    row.provenance_quality_score,
    [0, 20, 30],
  ) as 0 | 20 | 30;
  const evidenceDiversityScore = requireInteger(
    row.evidence_diversity_score,
    [0, 10, 25],
  ) as 0 | 10 | 25;
  const patchAlignmentScore = requireInteger(
    row.patch_alignment_score,
    [0, 10, 20],
  ) as 0 | 10 | 20;
  const freshnessScore = requireInteger(
    row.freshness_score,
    [0, 5, 15],
  ) as 0 | 5 | 15;
  const score = requireInteger(row.score);
  if (
    score !== provenanceQualityScore
      + evidenceDiversityScore
      + patchAlignmentScore
      + freshnessScore
    || row.band !== expectedBand(score)
  ) {
    invalidRow();
  }

  return {
    scoreId: requireUuid(row.candidate_confidence_score_id),
    scoringVersion: 'candidate-confidence-v1',
    score,
    band: row.band,
    components: {
      provenanceQualityScore,
      evidenceDiversityScore,
      patchAlignmentScore,
      freshnessScore,
    },
    evaluatedAt: requireIsoTimestamp(row.evaluated_at),
    createdAt: requireIsoTimestamp(row.confidence_created_at),
  };
}

function mapQueueItem(
  row: CandidateReviewQueueRow,
  minimumConfirmedReviews: number,
): OperatorCandidateReviewQueueItem {
  const hasReview = row.review_quorum_evaluation_id !== null;
  let confirmedCount = 0;
  let requiredCount = minimumConfirmedReviews;
  if (hasReview) {
    requireUuid(row.review_quorum_evaluation_id);
    confirmedCount = requireInteger(row.counted_review_count);
    requiredCount = requireInteger(row.required_confirmed_count);
    if (
      confirmedCount < 0
      || requiredCount !== minimumConfirmedReviews
      || confirmedCount >= requiredCount
    ) {
      invalidRow();
    }
  } else if (
    row.counted_review_count !== null
    || row.required_confirmed_count !== null
  ) {
    invalidRow();
  }

  const selection = requireSelection(row.canonical_payload);
  return {
    candidateId: requireUuid(row.candidate_id),
    candidateRevisionId: requireUuid(row.candidate_revision_id),
    revision: requireInteger(row.revision),
    patchId: requireUuid(row.patch_id),
    catalogRevisionId: requireUuid(row.catalog_revision_id),
    subjectExternalId: requireNonEmptyText(row.subject_external_id),
    selection: {
      augmentExternalIds: [...selection.augmentExternalIds],
      itemExternalIds: [...selection.itemExternalIds],
    },
    createdAt: requireIsoTimestamp(row.created_at),
    review: {
      state: hasReview ? 'in_progress' : 'unreviewed',
      confirmedCount,
      requiredCount,
    },
    confidence: mapConfidence(row),
  };
}

function summarize(
  items: OperatorCandidateReviewQueueItem[],
): OperatorCandidateReviewQueue['summary'] {
  return {
    returned: items.length,
    unreviewed: items.filter((item) => item.review.state === 'unreviewed').length,
    inProgress: items.filter((item) => item.review.state === 'in_progress').length,
    unscored: items.filter((item) => item.confidence === null).length,
    low: items.filter((item) => item.confidence?.band === 'low').length,
    medium: items.filter((item) => item.confidence?.band === 'medium').length,
    high: items.filter((item) => item.confidence?.band === 'high').length,
    veryHigh: items.filter((item) => item.confidence?.band === 'very_high').length,
  };
}

export async function readOperatorCandidateReviewQueue(
  pool: Pool,
  options: OperatorCandidateReviewQueueOptions = {},
): Promise<OperatorCandidateReviewQueue> {
  const limit = boundedLimit(options.limit);
  const now = options.now ?? new Date();
  const client = await pool.connect();
  try {
    await client.query(
      'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
    );
    const policyResult = await client.query<ActiveReviewPolicyRow>(
      `select policy.review_policy_revision_id,
              review_policy.minimum_confirmed_reviews
         from active_eligibility_policy_revision active
         join eligibility_policy_revisions policy
           on policy.eligibility_policy_revision_id =
              active.eligibility_policy_revision_id
         join review_policy_revisions review_policy
           on review_policy.review_policy_revision_id =
              policy.review_policy_revision_id
        where active.scope = 'candidate_revision'`,
    );
    if (policyResult.rows.length !== 1) {
      throw new Error('OPERATOR_ACTIVE_REVIEW_POLICY_UNAVAILABLE');
    }
    const policy = policyResult.rows[0]!;
    const reviewPolicyRevisionId = requireUuid(
      policy.review_policy_revision_id,
    );
    const minimumConfirmedReviews = requireInteger(
      policy.minimum_confirmed_reviews,
    );
    if (minimumConfirmedReviews < 1 || minimumConfirmedReviews > 16) {
      invalidRow();
    }

    const queueResult = await client.query<CandidateReviewQueueRow>(
      `with latest_active_revisions as (
         select revision.candidate_id,
                revision.candidate_revision_id,
                revision.revision,
                revision.patch_id,
                revision.catalog_revision_id,
                revision.canonical_payload,
                revision.created_at,
                row_number() over (
                  partition by revision.candidate_id
                  order by revision.revision desc,
                           revision.candidate_revision_id::text
                             collate "C" desc
                ) as candidate_rank
           from candidate_revisions revision
           join candidates candidate
             on candidate.candidate_id = revision.candidate_id
           join active_catalog_revisions active_catalog
             on active_catalog.patch_id = revision.patch_id
            and active_catalog.game_mode_external_id =
                candidate.game_mode_external_id
            and active_catalog.catalog_revision_id =
                revision.catalog_revision_id
       )
       select revision.candidate_id,
              revision.candidate_revision_id,
              revision.revision,
              revision.patch_id,
              revision.catalog_revision_id,
              revision.canonical_payload,
              revision.created_at,
              subject.canonical_external_id as subject_external_id,
              current_review.review_quorum_evaluation_id,
              review.counted_review_count,
              review.required_confirmed_count,
              confidence.candidate_confidence_score_id,
              confidence.scoring_version,
              confidence.provenance_quality_score,
              confidence.evidence_diversity_score,
              confidence.patch_alignment_score,
              confidence.freshness_score,
              confidence.score,
              confidence.band,
              confidence.evaluated_at,
              confidence.created_at as confidence_created_at
         from latest_active_revisions revision
         join candidate_claim_set_seals seal
           on seal.candidate_revision_id = revision.candidate_revision_id
         join candidates candidate
           on candidate.candidate_id = revision.candidate_id
         join game_entities subject
           on subject.game_entity_id = candidate.subject_game_entity_id
         left join current_review_quorum_evaluations current_review
           on current_review.candidate_revision_id =
              revision.candidate_revision_id
          and current_review.review_policy_revision_id = $1
         left join review_quorum_evaluations review
           on review.review_quorum_evaluation_id =
              current_review.review_quorum_evaluation_id
         left join current_candidate_confidence_scores current_confidence
           on current_confidence.candidate_revision_id =
              revision.candidate_revision_id
         left join candidate_confidence_scores confidence
           on confidence.candidate_confidence_score_id =
              current_confidence.candidate_confidence_score_id
          and confidence.candidate_id = revision.candidate_id
          and confidence.candidate_revision_id =
              revision.candidate_revision_id
          and confidence.patch_id = revision.patch_id
          and confidence.catalog_revision_id = revision.catalog_revision_id
        where revision.candidate_rank = 1
          and coalesce(review.quorum_satisfied, false) = false
        order by
          case when current_review.review_quorum_evaluation_id is null
            then 1 else 0 end,
          case confidence.band
            when 'very_high' then 0
            when 'high' then 1
            when 'medium' then 2
            when 'low' then 3
            else 4
          end,
          confidence.score desc nulls last,
          revision.created_at,
          revision.candidate_id::text collate "C",
          revision.candidate_revision_id::text collate "C"
        limit $2`,
      [reviewPolicyRevisionId, limit],
    );
    const items = queueResult.rows.map((row) =>
      mapQueueItem(row, minimumConfirmedReviews));
    const queue: OperatorCandidateReviewQueue = {
      schemaVersion: 1,
      generatedAt: now.toISOString(),
      activeReviewPolicyRevisionId: reviewPolicyRevisionId,
      limit,
      summary: summarize(items),
      items,
    };
    await client.query('COMMIT');
    return queue;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Preserve the original read failure.
    }
    throw error;
  } finally {
    client.release();
  }
}
