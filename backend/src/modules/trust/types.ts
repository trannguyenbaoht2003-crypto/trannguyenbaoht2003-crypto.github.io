export type ClaimType =
  | 'meta_trend'
  | 'build_effectiveness'
  | 'compatibility'
  | 'patch_change'
  | 'playstyle_hypothesis'
  | 'translation_assertion'
  | 'ocr_extraction'
  | 'community_report';

export type ClaimImportance = 'required' | 'supporting' | 'informational';

export type EvidenceStance = 'supports' | 'contradicts' | 'context_only';

export type EvidenceDecision =
  | 'supported'
  | 'insufficient'
  | 'contradicted';

export type HumanReviewOutcome =
  | 'confirmed'
  | 'changes_requested'
  | 'declined';

export interface CandidateClaimInput {
  claimId: string;
  claimKey: string;
  claimType: ClaimType;
  importance: ClaimImportance;
  statement: string;
}

export interface NormalizedCandidateClaim extends CandidateClaimInput {
  statementHash: string;
}

export interface NormalizedClaimSet {
  claims: NormalizedCandidateClaim[];
  claimSetHash: string;
}
