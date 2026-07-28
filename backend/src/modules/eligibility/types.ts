import type { EvidenceDecision } from '../trust/types.js';

export type ModerationOutcome = 'clear' | 'needs_review' | 'blocked';

export type EligibilityOutcome =
  | 'eligible'
  | 'needs_review'
  | 'ineligible';

export type EligibilityReasonCode =
  | 'moderation_blocked'
  | 'required_claim_contradicted'
  | 'moderation_missing'
  | 'moderation_stale'
  | 'moderation_needs_review'
  | 'required_claim_decision_missing'
  | 'required_claim_decision_stale'
  | 'required_claim_policy_mismatch'
  | 'required_claim_insufficient'
  | 'review_quorum_missing'
  | 'review_quorum_stale'
  | 'review_policy_mismatch'
  | 'review_quorum_unsatisfied'
  | 'all_requirements_satisfied';

export interface RequiredClaimEligibilityInput {
  claimId: string;
  claimKey: string;
  decision: EvidenceDecision | null;
  current: boolean;
  policyMatches: boolean;
}

export interface EligibilityComputationInput {
  moderation: {
    outcome: ModerationOutcome | null;
    current: boolean;
  };
  requiredClaims: RequiredClaimEligibilityInput[];
  review: {
    present: boolean;
    current: boolean;
    policyMatches: boolean;
    quorumSatisfied: boolean;
  };
}

export interface EligibilityComputation {
  outcome: EligibilityOutcome;
  reasons: EligibilityReasonCode[];
}
