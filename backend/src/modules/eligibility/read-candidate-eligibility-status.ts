import type { Pool } from 'pg';

import { withTransaction } from '../../database/transaction.js';
import {
  requireUuid,
} from '../trust/normalize-trust-input.js';
import { computeEligibility } from './compute-eligibility.js';
import {
  loadEligibilityAuthority,
} from './load-eligibility-authority.js';
import type {
  CandidateEligibilityStatus,
  EligibilityOutcome,
  EligibilityReasonCode,
} from './types.js';

interface CurrentEvaluationRow {
  candidate_eligibility_evaluation_id: string;
  input_hash: string;
  outcome: EligibilityOutcome;
}

export async function readCandidateEligibilityStatus(
  pool: Pool,
  candidateIdInput: string,
  candidateRevisionIdInput: string,
): Promise<CandidateEligibilityStatus> {
  const candidateId = requireUuid(candidateIdInput, 'candidateId');
  const candidateRevisionId = requireUuid(
    candidateRevisionIdInput,
    'candidateRevisionId',
  );
  return withTransaction(pool, async (client) => {
    const authority = await loadEligibilityAuthority(
      client,
      candidateId,
      candidateRevisionId,
      { lock: false },
    );
    if (
      !authority.activePolicy
      || !authority.computationInput
      || !authority.inputHash
    ) {
      return {
        activeEligibilityPolicyRevisionId: null,
        candidateRevisionId,
        currentEvaluationId: null,
        outcome: 'needs_review',
        reasons: ['moderation_missing'],
        stale: true,
      };
    }
    const currentResult = computeEligibility(
      authority.computationInput,
    );
    const current = await client.query<CurrentEvaluationRow>(
      `select evaluation.candidate_eligibility_evaluation_id,
              evaluation.input_hash,
              evaluation.outcome
         from current_candidate_eligibility_evaluations current
         join candidate_eligibility_evaluations evaluation
           on evaluation.candidate_eligibility_evaluation_id =
              current.candidate_eligibility_evaluation_id
        where current.candidate_revision_id = $1
          and current.eligibility_policy_revision_id = $2`,
      [
        candidateRevisionId,
        authority.activePolicy.eligibilityPolicyRevisionId,
      ],
    );
    const row = current.rows[0];
    if (!row) {
      return {
        activeEligibilityPolicyRevisionId:
          authority.activePolicy.eligibilityPolicyRevisionId,
        candidateRevisionId,
        currentEvaluationId: null,
        outcome: 'needs_review',
        reasons: currentResult.outcome === 'eligible'
          ? ['moderation_missing']
          : currentResult.reasons,
        stale: true,
      };
    }
    if (row.input_hash !== authority.inputHash) {
      const staleReasons: EligibilityReasonCode[] = (
        currentResult.outcome === 'eligible'
          ? ['moderation_stale']
          : currentResult.reasons
      );
      return {
        activeEligibilityPolicyRevisionId:
          authority.activePolicy.eligibilityPolicyRevisionId,
        candidateRevisionId,
        currentEvaluationId:
          row.candidate_eligibility_evaluation_id,
        outcome: 'needs_review',
        reasons: staleReasons,
        stale: true,
      };
    }
    const reasons = await client.query<{
      reason_code: EligibilityReasonCode;
    }>(
      `select reason_code
         from candidate_eligibility_evaluation_reasons
        where candidate_eligibility_evaluation_id = $1
        order by ordinal`,
      [row.candidate_eligibility_evaluation_id],
    );
    return {
      activeEligibilityPolicyRevisionId:
        authority.activePolicy.eligibilityPolicyRevisionId,
      candidateRevisionId,
      currentEvaluationId:
        row.candidate_eligibility_evaluation_id,
      outcome: row.outcome,
      reasons: reasons.rows.map((reason) => reason.reason_code),
      stale: false,
    };
  });
}
