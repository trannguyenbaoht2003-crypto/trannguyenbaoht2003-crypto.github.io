import type {
  EligibilityComputation,
  EligibilityComputationInput,
  EligibilityReasonCode,
} from './types.js';

function canonicalReasons(
  values: EligibilityReasonCode[],
): EligibilityReasonCode[] {
  return [...new Set(values)].sort();
}

export function computeEligibility(
  input: EligibilityComputationInput,
): EligibilityComputation {
  if (input.requiredClaims.length === 0) {
    throw new Error('ELIGIBILITY_REQUIRED_CLAIMS_MISSING');
  }

  if (
    input.moderation.current
    && input.moderation.outcome === 'blocked'
  ) {
    return {
      outcome: 'ineligible',
      reasons: ['moderation_blocked'],
    };
  }

  const contradicted = input.requiredClaims.some((claim) => (
    claim.current
    && claim.policyMatches
    && claim.decision === 'contradicted'
  ));
  if (contradicted) {
    return {
      outcome: 'ineligible',
      reasons: ['required_claim_contradicted'],
    };
  }

  const reasons: EligibilityReasonCode[] = [];
  if (input.moderation.outcome === null) {
    reasons.push('moderation_missing');
  } else if (!input.moderation.current) {
    reasons.push('moderation_stale');
  } else if (input.moderation.outcome === 'needs_review') {
    reasons.push('moderation_needs_review');
  }

  for (const claim of input.requiredClaims) {
    if (claim.decision === null) {
      reasons.push('required_claim_decision_missing');
    } else if (!claim.current) {
      reasons.push('required_claim_decision_stale');
    } else if (!claim.policyMatches) {
      reasons.push('required_claim_policy_mismatch');
    } else if (claim.decision === 'insufficient') {
      reasons.push('required_claim_insufficient');
    }
  }

  if (!input.review.present) {
    reasons.push('review_quorum_missing');
  } else if (!input.review.current) {
    reasons.push('review_quorum_stale');
  } else if (!input.review.policyMatches) {
    reasons.push('review_policy_mismatch');
  } else if (!input.review.quorumSatisfied) {
    reasons.push('review_quorum_unsatisfied');
  }

  if (reasons.length > 0) {
    return {
      outcome: 'needs_review',
      reasons: canonicalReasons(reasons),
    };
  }

  return {
    outcome: 'eligible',
    reasons: ['all_requirements_satisfied'],
  };
}
