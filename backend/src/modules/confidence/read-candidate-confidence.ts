import type { PgQueryable } from '../../database/queryable.js';
import type {
  CandidateConfidenceBand,
  CandidateConfidenceView,
  CandidateProvenanceQuality,
} from './types.js';

interface CandidateConfidenceRow {
  band: CandidateConfidenceBand;
  candidate_confidence_input_snapshot_id: string;
  candidate_confidence_score_id: string;
  candidate_id: string;
  candidate_revision_id: string;
  created_at: Date;
  evaluated_at: Date;
  evidence_diversity_score: 0 | 10 | 25;
  freshness_score: 0 | 5 | 15;
  input_hash: string;
  patch_alignment_score: 0 | 10 | 20;
  provenance_quality_score: CandidateProvenanceQuality;
  score: number;
  scoring_version: 'candidate-confidence-v1';
}

export async function readCandidateConfidence(
  queryable: PgQueryable,
  candidateRevisionId: string,
): Promise<CandidateConfidenceView | null> {
  const result = await queryable.query<CandidateConfidenceRow>(
    `select score.candidate_confidence_score_id,
            score.candidate_confidence_input_snapshot_id,
            score.candidate_id,
            score.candidate_revision_id,
            score.scoring_version,
            score.input_hash,
            score.provenance_quality_score,
            score.evidence_diversity_score,
            score.patch_alignment_score,
            score.freshness_score,
            score.score,
            score.band,
            score.evaluated_at,
            score.created_at
       from current_candidate_confidence_scores current_score
       join candidate_confidence_scores score
         on score.candidate_confidence_score_id =
            current_score.candidate_confidence_score_id
      where current_score.candidate_revision_id = $1`,
    [candidateRevisionId],
  );
  const row = result.rows[0];
  if (!row) {
    return null;
  }

  return {
    band: row.band,
    candidateId: row.candidate_id,
    candidateRevisionId: row.candidate_revision_id,
    components: {
      evidenceDiversityScore: row.evidence_diversity_score,
      freshnessScore: row.freshness_score,
      patchAlignmentScore: row.patch_alignment_score,
      provenanceQualityScore: row.provenance_quality_score,
    },
    createdAt: row.created_at,
    evaluatedAt: row.evaluated_at,
    inputHash: row.input_hash,
    inputSnapshotId: row.candidate_confidence_input_snapshot_id,
    score: row.score,
    scoreId: row.candidate_confidence_score_id,
    scoringVersion: row.scoring_version,
  };
}
