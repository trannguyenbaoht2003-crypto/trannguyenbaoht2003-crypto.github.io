import assert from 'node:assert/strict';
import test from 'node:test';

import {
  computeEligibility,
} from '../src/modules/eligibility/compute-eligibility.js';
import type {
  EligibilityComputationInput,
} from '../src/modules/eligibility/types.js';

function eligibleInput(): EligibilityComputationInput {
  return {
    moderation: {
      current: true,
      outcome: 'clear',
    },
    requiredClaims: [
      {
        claimId: '73000000-0000-4000-8000-000000000001',
        claimKey: 'build-core',
        current: true,
        decision: 'supported',
        policyMatches: true,
      },
    ],
    review: {
      current: true,
      policyMatches: true,
      present: true,
      quorumSatisfied: true,
    },
  };
}

test('complete fresh trust graph is eligible', () => {
  assert.deepEqual(computeEligibility(eligibleInput()), {
    outcome: 'eligible',
    reasons: ['all_requirements_satisfied'],
  });
});

test('blocked Moderation outranks missing lower-layer inputs', () => {
  const input = eligibleInput();
  input.moderation.outcome = 'blocked';
  input.requiredClaims[0]!.decision = null;
  input.review.present = false;

  assert.deepEqual(computeEligibility(input), {
    outcome: 'ineligible',
    reasons: ['moderation_blocked'],
  });
});

test('contradicted required Claim is ineligible', () => {
  const input = eligibleInput();
  input.requiredClaims[0]!.decision = 'contradicted';

  assert.deepEqual(computeEligibility(input), {
    outcome: 'ineligible',
    reasons: ['required_claim_contradicted'],
  });
});

test('missing Moderation cannot become eligible', () => {
  const input = eligibleInput();
  input.moderation = { current: false, outcome: null };

  assert.deepEqual(computeEligibility(input), {
    outcome: 'needs_review',
    reasons: ['moderation_missing'],
  });
});

test('stale clear Moderation cannot remain eligible', () => {
  const input = eligibleInput();
  input.moderation.current = false;

  assert.deepEqual(computeEligibility(input), {
    outcome: 'needs_review',
    reasons: ['moderation_stale'],
  });
});

test('unresolved Moderation cannot become eligible', () => {
  const input = eligibleInput();
  input.moderation.outcome = 'needs_review';

  assert.deepEqual(computeEligibility(input), {
    outcome: 'needs_review',
    reasons: ['moderation_needs_review'],
  });
});

test('missing required Claim decision cannot become eligible', () => {
  const input = eligibleInput();
  input.requiredClaims[0]!.decision = null;

  assert.deepEqual(computeEligibility(input), {
    outcome: 'needs_review',
    reasons: ['required_claim_decision_missing'],
  });
});

test('stale required Claim decision cannot remain eligible', () => {
  const input = eligibleInput();
  input.requiredClaims[0]!.current = false;

  assert.deepEqual(computeEligibility(input), {
    outcome: 'needs_review',
    reasons: ['required_claim_decision_stale'],
  });
});

test('wrong Evidence policy cannot become eligible', () => {
  const input = eligibleInput();
  input.requiredClaims[0]!.policyMatches = false;

  assert.deepEqual(computeEligibility(input), {
    outcome: 'needs_review',
    reasons: ['required_claim_policy_mismatch'],
  });
});

test('insufficient required Claim cannot become eligible', () => {
  const input = eligibleInput();
  input.requiredClaims[0]!.decision = 'insufficient';

  assert.deepEqual(computeEligibility(input), {
    outcome: 'needs_review',
    reasons: ['required_claim_insufficient'],
  });
});

test('missing Review quorum cannot become eligible', () => {
  const input = eligibleInput();
  input.review.present = false;

  assert.deepEqual(computeEligibility(input), {
    outcome: 'needs_review',
    reasons: ['review_quorum_missing'],
  });
});

test('stale Review quorum cannot remain eligible', () => {
  const input = eligibleInput();
  input.review.current = false;

  assert.deepEqual(computeEligibility(input), {
    outcome: 'needs_review',
    reasons: ['review_quorum_stale'],
  });
});

test('wrong Review policy cannot become eligible', () => {
  const input = eligibleInput();
  input.review.policyMatches = false;

  assert.deepEqual(computeEligibility(input), {
    outcome: 'needs_review',
    reasons: ['review_policy_mismatch'],
  });
});

test('unsatisfied Review quorum cannot become eligible', () => {
  const input = eligibleInput();
  input.review.quorumSatisfied = false;

  assert.deepEqual(computeEligibility(input), {
    outcome: 'needs_review',
    reasons: ['review_quorum_unsatisfied'],
  });
});

test('needs-review reasons are unique and canonically ordered', () => {
  const input = eligibleInput();
  input.moderation.current = false;
  input.requiredClaims.push({
    ...input.requiredClaims[0]!,
    claimId: '73000000-0000-4000-8000-000000000002',
    claimKey: 'second-required',
  });
  input.requiredClaims[0]!.decision = 'insufficient';
  input.requiredClaims[1]!.decision = 'insufficient';
  input.review.quorumSatisfied = false;

  assert.deepEqual(computeEligibility(input), {
    outcome: 'needs_review',
    reasons: [
      'moderation_stale',
      'required_claim_insufficient',
      'review_quorum_unsatisfied',
    ],
  });
});

test('required Claim collection cannot be empty', () => {
  const input = eligibleInput();
  input.requiredClaims = [];

  assert.throws(
    () => computeEligibility(input),
    /ELIGIBILITY_REQUIRED_CLAIMS_MISSING/,
  );
});
