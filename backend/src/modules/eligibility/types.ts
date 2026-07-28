import type { EvidenceDecision } from '../trust/types.js';
import type { ModerationOutcome } from '../moderation/types.js';

export type { ModerationOutcome } from '../moderation/types.js';

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

export interface RegisterEligibilityPolicyRevisionCommand {
  actorId: string;
  correlationId: string;
  eligibilityPolicyRevisionId: string;
  evidencePolicyRevisionId: string;
  idempotencyKey: string;
  moderationPolicyRevisionId: string;
  policyKey: string;
  reason: string;
  reviewPolicyRevisionId: string;
  revision: number;
  schemaVersion: 1;
}

export interface RegisterEligibilityPolicyRevisionResult {
  eligibilityPolicyRevisionId: string;
  replayed: boolean;
}

export interface ActivateEligibilityPolicyRevisionCommand {
  actorId: string;
  correlationId: string;
  eligibilityPolicyRevisionId: string;
  expectedCurrentEligibilityPolicyRevisionId: string | null;
  idempotencyKey: string;
  reason: string;
}

export interface ActivateEligibilityPolicyRevisionResult {
  currentEligibilityPolicyRevisionId: string;
  previousEligibilityPolicyRevisionId: string | null;
  replayed: boolean;
}
