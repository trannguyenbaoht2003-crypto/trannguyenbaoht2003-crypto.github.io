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

export type RegisterTrustPolicyRevisionCommand =
  | {
      policyKind: 'evidence';
      policyRevisionId: string;
      policyKey: string;
      revision: number;
      schemaVersion: 1;
      actorId: string;
      reason: string;
      correlationId: string;
      idempotencyKey: string;
    }
  | {
      policyKind: 'human_review';
      policyRevisionId: string;
      policyKey: string;
      revision: number;
      minimumConfirmedReviews: number;
      requireDistinctReviewers: true;
      requiredPermission: 'reviewer';
      appliesToAiProvenance: boolean;
      actorId: string;
      reason: string;
      correlationId: string;
      idempotencyKey: string;
    };

export interface RegisterTrustPolicyRevisionResult {
  policyKind: 'evidence' | 'human_review';
  policyRevisionId: string;
  replayed: boolean;
}

export interface DefineCandidateClaimSetCommand {
  actorId: string;
  candidateId: string;
  candidateRevisionId: string;
  claims: CandidateClaimInput[];
  correlationId: string;
  idempotencyKey: string;
}

export interface DefineCandidateClaimSetResult {
  candidateId: string;
  candidateRevisionId: string;
  claimIds: string[];
  claimSetHash: string;
  replayed: boolean;
}

export interface CandidateRevisionAuthority {
  candidateId: string;
  candidateRevisionId: string;
  patchId: string;
  catalogRevisionId: string;
  canonicalPayload: unknown;
  normalizedSignature: string;
}

export interface EvidenceAssociationInput {
  associationId: string;
  evidenceId: string;
  normalizedObservationId: string;
  stance: EvidenceStance;
  crossPatchRevalidated: boolean;
  revalidationReason: string | null;
}

export interface RecordClaimEvidenceDecisionCommand {
  actorId: string;
  candidateId: string;
  candidateRevisionId: string;
  claimId: string;
  correlationId: string;
  decision: EvidenceDecision;
  decisionId: string;
  evaluatedAt: string;
  evidenceInputSnapshotId: string;
  evidencePolicyRevisionId: string;
  idempotencyKey: string;
  reason: string;
  associations: EvidenceAssociationInput[];
}

export interface RecordClaimEvidenceDecisionResult {
  claimId: string;
  decisionId: string;
  decision: EvidenceDecision;
  evidenceInputSnapshotId: string;
  inputHash: string;
  replayed: boolean;
}
