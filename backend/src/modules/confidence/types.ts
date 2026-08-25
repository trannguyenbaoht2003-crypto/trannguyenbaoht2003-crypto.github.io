export const CANDIDATE_CONFIDENCE_SCORING_VERSION =
  'candidate-confidence-v1' as const;

export type CandidateConfidenceScoringVersion =
  typeof CANDIDATE_CONFIDENCE_SCORING_VERSION;

export type CandidateConfidenceBand =
  | 'low'
  | 'medium'
  | 'high'
  | 'very_high';

export type CandidateProvenanceQuality = 0 | 20 | 30;

export interface CandidateConfidenceInput {
  evaluatedAt: Date;
  hasExactPatchSupport: boolean;
  hasRevalidatedCrossPatchSupport: boolean;
  newestSupportingEvidenceAt: Date | null;
  provenanceQuality: CandidateProvenanceQuality;
  supportingSourceCount: number;
}

export interface CandidateConfidenceComponents {
  evidenceDiversityScore: 0 | 10 | 25;
  freshnessScore: 0 | 5 | 15;
  patchAlignmentScore: 0 | 10 | 20;
  provenanceQualityScore: CandidateProvenanceQuality;
}

export interface CandidateConfidenceResult {
  band: CandidateConfidenceBand;
  components: CandidateConfidenceComponents;
  score: number;
}

export interface EvaluateCandidateConfidenceCommand {
  actorId: string;
  candidateRevisionId: string;
  correlationId: string;
  evaluatedAt: Date;
  reason: string;
}

export interface EvaluateCandidateConfidenceResult
  extends CandidateConfidenceResult {
  candidateId: string;
  candidateRevisionId: string;
  inputHash: string;
  inputSnapshotId: string;
  replayed: boolean;
  scoreId: string;
  scoringVersion: CandidateConfidenceScoringVersion;
}

export interface CandidateConfidenceView
  extends CandidateConfidenceResult {
  candidateId: string;
  candidateRevisionId: string;
  createdAt: Date;
  evaluatedAt: Date;
  inputHash: string;
  inputSnapshotId: string;
  scoreId: string;
  scoringVersion: CandidateConfidenceScoringVersion;
}
