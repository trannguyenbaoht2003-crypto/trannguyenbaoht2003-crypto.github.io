import type { PoolClient } from 'pg';

import {
  lockCandidateRevisionAuthority,
} from '../trust/load-trust-authority.js';
import {
  hashCanonicalTupleV1,
} from '../trust/normalize-trust-input.js';
import type {
  CandidateRevisionAuthority,
  EvidenceDecision,
} from '../trust/types.js';
import type {
  EligibilityComputationInput,
  ModerationOutcome,
} from './types.js';

interface EligibilityPolicyRow {
  eligibility_policy_revision_id: string;
  evidence_policy_revision_id: string;
  review_policy_revision_id: string;
  moderation_policy_revision_id: string;
}

interface ClaimSealRow {
  candidate_claim_set_seal_id: string;
  claim_set_hash: string;
}

interface RequiredClaimRow {
  claim_id: string;
  claim_key: string;
  claim_evidence_decision_id: string | null;
  decision: EvidenceDecision | null;
  evidence_policy_revision_id: string | null;
}

interface ModerationRow {
  moderation_decision_id: string;
  input_hash: string;
  outcome: ModerationOutcome;
  current: boolean;
}

interface ReviewRow {
  review_quorum_evaluation_id: string;
  input_hash: string;
  review_policy_revision_id: string;
  quorum_satisfied: boolean;
  current: boolean;
}

export interface EligibilityRequiredClaimAuthority {
  claimId: string;
  claimKey: string;
  decisionId: string | null;
  decision: EvidenceDecision | null;
  evidencePolicyRevisionId: string | null;
  current: boolean;
  policyMatches: boolean;
}

export interface EligibilityAuthority {
  activePolicy: {
    eligibilityPolicyRevisionId: string;
    evidencePolicyRevisionId: string;
    reviewPolicyRevisionId: string;
    moderationPolicyRevisionId: string;
  } | null;
  candidate: CandidateRevisionAuthority;
  claimSeal: {
    candidateClaimSetSealId: string;
    claimSetHash: string;
  } | null;
  computationInput: EligibilityComputationInput | null;
  inputHash: string | null;
  moderation: {
    decisionId: string | null;
    inputHash: string | null;
    outcome: ModerationOutcome | null;
    current: boolean;
  };
  requiredClaimSetHash: string | null;
  requiredClaims: EligibilityRequiredClaimAuthority[];
  review: {
    evaluationId: string | null;
    inputHash: string | null;
    present: boolean;
    current: boolean;
    policyMatches: boolean;
    quorumSatisfied: boolean;
  };
}

async function loadCandidate(
  client: PoolClient,
  candidateId: string,
  candidateRevisionId: string,
  lock: boolean,
): Promise<CandidateRevisionAuthority> {
  if (lock) {
    return lockCandidateRevisionAuthority(
      client,
      candidateId,
      candidateRevisionId,
    );
  }
  const result = await client.query<{
    candidate_id: string;
    candidate_revision_id: string;
    patch_id: string;
    catalog_revision_id: string;
    canonical_payload: unknown;
    normalized_signature: string;
  }>(
    `select candidate_id, candidate_revision_id, patch_id,
            catalog_revision_id, canonical_payload,
            normalized_signature
       from candidate_revisions
      where candidate_revision_id = $1
        and candidate_id = $2`,
    [candidateRevisionId, candidateId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error('CANDIDATE_REVISION_NOT_FOUND');
  }
  return {
    candidateId: row.candidate_id,
    candidateRevisionId: row.candidate_revision_id,
    patchId: row.patch_id,
    catalogRevisionId: row.catalog_revision_id,
    canonicalPayload: row.canonical_payload,
    normalizedSignature: row.normalized_signature,
  };
}

async function loadActivePolicy(
  client: PoolClient,
  lock: boolean,
): Promise<EligibilityPolicyRow | null> {
  const result = await client.query<EligibilityPolicyRow>(
    `select policy.eligibility_policy_revision_id,
            policy.evidence_policy_revision_id,
            policy.review_policy_revision_id,
            policy.moderation_policy_revision_id
       from active_eligibility_policy_revision active
       join eligibility_policy_revisions policy
         on policy.eligibility_policy_revision_id =
            active.eligibility_policy_revision_id
      where active.scope = 'candidate_revision'
      ${lock ? 'for share of active, policy' : ''}`,
  );
  return result.rows[0] ?? null;
}

async function loadRequiredClaims(
  client: PoolClient,
  candidateRevisionId: string,
  lock: boolean,
): Promise<RequiredClaimRow[]> {
  const result = await client.query<RequiredClaimRow>(
    `select claim.claim_id,
            claim.claim_key,
            decision.claim_evidence_decision_id,
            decision.decision,
            decision.evidence_policy_revision_id
       from candidate_claims claim
       left join current_claim_evidence_decisions current
         on current.claim_id = claim.claim_id
       left join claim_evidence_decisions decision
         on decision.claim_evidence_decision_id =
            current.claim_evidence_decision_id
      where claim.candidate_revision_id = $1
        and claim.importance = 'required'
      order by claim.claim_key collate "C"
      ${lock ? 'for update of claim' : ''}`,
    [candidateRevisionId],
  );
  if (result.rowCount === 0) {
    throw new Error('ELIGIBILITY_REQUIRED_CLAIMS_MISSING');
  }
  return result.rows;
}

async function loadClaimSeal(
  client: PoolClient,
  candidateRevisionId: string,
): Promise<ClaimSealRow> {
  const result = await client.query<ClaimSealRow>(
    `select candidate_claim_set_seal_id, claim_set_hash
       from candidate_claim_set_seals
      where candidate_revision_id = $1`,
    [candidateRevisionId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error('CLAIM_SET_NOT_SEALED');
  }
  return row;
}

async function loadModeration(
  client: PoolClient,
  candidateRevisionId: string,
  moderationPolicyRevisionId: string,
): Promise<ModerationRow | null> {
  const result = await client.query<ModerationRow>(
    `select decision.moderation_decision_id,
            decision.input_hash,
            decision.outcome,
            (
              not exists (
                select 1
                  from candidate_provenance live
                 where live.candidate_revision_id = $1
                   and not exists (
                     select 1
                       from moderation_input_snapshot_provenance member
                      where member.moderation_input_snapshot_id =
                            decision.moderation_input_snapshot_id
                        and member.candidate_provenance_id =
                            live.candidate_provenance_id
                        and member.origin = live.origin
                   )
              )
              and not exists (
                select 1
                  from moderation_input_snapshot_provenance member
                 where member.moderation_input_snapshot_id =
                       decision.moderation_input_snapshot_id
                   and not exists (
                     select 1
                       from candidate_provenance live
                      where live.candidate_revision_id = $1
                        and live.candidate_provenance_id =
                            member.candidate_provenance_id
                        and live.origin = member.origin
                   )
              )
            ) as current
       from current_candidate_moderation_decisions current
       join moderation_decisions decision
         on decision.moderation_decision_id =
            current.moderation_decision_id
      where current.candidate_revision_id = $1
        and current.moderation_policy_revision_id = $2`,
    [candidateRevisionId, moderationPolicyRevisionId],
  );
  return result.rows[0] ?? null;
}

async function loadReview(
  client: PoolClient,
  candidateRevisionId: string,
  reviewPolicyRevisionId: string,
): Promise<ReviewRow | null> {
  const result = await client.query<ReviewRow>(
    `select evaluation.review_quorum_evaluation_id,
            evaluation.input_hash,
            evaluation.review_policy_revision_id,
            evaluation.quorum_satisfied,
            (
              not exists (
                select 1
                  from candidate_provenance live
                 where live.candidate_revision_id = $1
                   and not exists (
                     select 1
                       from review_input_snapshot_provenance member
                      where member.review_input_snapshot_id =
                            evaluation.review_input_snapshot_id
                        and member.candidate_provenance_id =
                            live.candidate_provenance_id
                        and member.origin = live.origin
                   )
              )
              and not exists (
                select 1
                  from review_input_snapshot_provenance member
                 where member.review_input_snapshot_id =
                       evaluation.review_input_snapshot_id
                   and not exists (
                     select 1
                       from candidate_provenance live
                      where live.candidate_revision_id = $1
                        and live.candidate_provenance_id =
                            member.candidate_provenance_id
                        and live.origin = member.origin
                   )
              )
              and not exists (
                select 1
                  from candidate_claims claim
                  left join current_claim_evidence_decisions current_evidence
                    on current_evidence.claim_id = claim.claim_id
                 where claim.candidate_revision_id = $1
                   and not exists (
                     select 1
                       from review_input_snapshot_claims member
                      where member.review_input_snapshot_id =
                            evaluation.review_input_snapshot_id
                        and member.claim_id = claim.claim_id
                        and member.importance = claim.importance
                        and member.claim_evidence_decision_id
                            is not distinct from
                            current_evidence.claim_evidence_decision_id
                   )
              )
              and not exists (
                select 1
                  from review_input_snapshot_claims member
                 where member.review_input_snapshot_id =
                       evaluation.review_input_snapshot_id
                   and not exists (
                     select 1
                       from candidate_claims claim
                       left join current_claim_evidence_decisions
                         current_evidence
                         on current_evidence.claim_id = claim.claim_id
                      where claim.candidate_revision_id = $1
                        and claim.claim_id = member.claim_id
                        and claim.importance = member.importance
                        and current_evidence.claim_evidence_decision_id
                            is not distinct from
                            member.claim_evidence_decision_id
                   )
              )
            ) as current
       from current_review_quorum_evaluations current
       join review_quorum_evaluations evaluation
         on evaluation.review_quorum_evaluation_id =
            current.review_quorum_evaluation_id
      where current.candidate_revision_id = $1
        and current.review_policy_revision_id = $2`,
    [candidateRevisionId, reviewPolicyRevisionId],
  );
  return result.rows[0] ?? null;
}

export async function loadEligibilityAuthority(
  client: PoolClient,
  candidateId: string,
  candidateRevisionId: string,
  options: { lock: boolean },
): Promise<EligibilityAuthority> {
  const candidate = await loadCandidate(
    client,
    candidateId,
    candidateRevisionId,
    options.lock,
  );
  const policy = await loadActivePolicy(client, options.lock);
  const empty: EligibilityAuthority = {
    activePolicy: null,
    candidate,
    claimSeal: null,
    computationInput: null,
    inputHash: null,
    moderation: {
      decisionId: null,
      inputHash: null,
      outcome: null,
      current: false,
    },
    requiredClaimSetHash: null,
    requiredClaims: [],
    review: {
      evaluationId: null,
      inputHash: null,
      present: false,
      current: false,
      policyMatches: false,
      quorumSatisfied: false,
    },
  };
  if (!policy) {
    return empty;
  }

  const claims = await loadRequiredClaims(
    client,
    candidate.candidateRevisionId,
    options.lock,
  );
  const seal = await loadClaimSeal(
    client,
    candidate.candidateRevisionId,
  );
  const [moderationRow, reviewRow] = await Promise.all([
    loadModeration(
      client,
      candidate.candidateRevisionId,
      policy.moderation_policy_revision_id,
    ),
    loadReview(
      client,
      candidate.candidateRevisionId,
      policy.review_policy_revision_id,
    ),
  ]);
  const requiredClaims = claims.map(
    (claim): EligibilityRequiredClaimAuthority => ({
      claimId: claim.claim_id,
      claimKey: claim.claim_key,
      decisionId: claim.claim_evidence_decision_id,
      decision: claim.decision,
      evidencePolicyRevisionId:
        claim.evidence_policy_revision_id,
      current: claim.claim_evidence_decision_id !== null,
      policyMatches:
        claim.evidence_policy_revision_id
        === policy.evidence_policy_revision_id,
    }),
  );
  const moderation = {
    decisionId: moderationRow?.moderation_decision_id ?? null,
    inputHash: moderationRow?.input_hash ?? null,
    outcome: moderationRow?.outcome ?? null,
    current: moderationRow?.current ?? false,
  };
  const review = {
    evaluationId:
      reviewRow?.review_quorum_evaluation_id ?? null,
    inputHash: reviewRow?.input_hash ?? null,
    present: reviewRow !== null,
    current: reviewRow?.current ?? false,
    policyMatches:
      reviewRow?.review_policy_revision_id
      === policy.review_policy_revision_id,
    quorumSatisfied: reviewRow?.quorum_satisfied ?? false,
  };
  const requiredClaimTokens = requiredClaims.flatMap((claim) => [
    claim.claimId,
    claim.claimKey,
    claim.decisionId ?? '@null',
    claim.decision ?? '@null',
    claim.evidencePolicyRevisionId ?? '@null',
    claim.current ? 'true' : 'false',
  ]);
  const requiredClaimSetHash = hashCanonicalTupleV1([
    'TrustTupleV1',
    'EligibilityRequiredClaimSetV1',
    candidate.candidateRevisionId,
    String(requiredClaims.length),
    ...requiredClaimTokens,
  ]);
  const inputHash = hashCanonicalTupleV1([
    'TrustTupleV1',
    'EligibilityInputSnapshotV1',
    candidate.candidateId,
    candidate.candidateRevisionId,
    candidate.patchId,
    candidate.catalogRevisionId,
    candidate.normalizedSignature,
    seal.candidate_claim_set_seal_id,
    seal.claim_set_hash,
    policy.eligibility_policy_revision_id,
    policy.evidence_policy_revision_id,
    policy.review_policy_revision_id,
    policy.moderation_policy_revision_id,
    moderation.decisionId ?? '@null',
    moderation.inputHash ?? '@null',
    moderation.outcome ?? '@null',
    moderation.current ? 'true' : 'false',
    review.evaluationId ?? '@null',
    review.inputHash ?? '@null',
    review.quorumSatisfied ? 'true' : 'false',
    review.current ? 'true' : 'false',
    String(requiredClaims.length),
    ...requiredClaimTokens,
  ]);
  const computationInput: EligibilityComputationInput = {
    moderation: {
      outcome: moderation.outcome,
      current: moderation.current,
    },
    requiredClaims: requiredClaims.map((claim) => ({
      claimId: claim.claimId,
      claimKey: claim.claimKey,
      decision: claim.decision,
      current: claim.current,
      policyMatches: claim.policyMatches,
    })),
    review: {
      present: review.present,
      current: review.current,
      policyMatches: review.policyMatches,
      quorumSatisfied: review.quorumSatisfied,
    },
  };

  return {
    activePolicy: {
      eligibilityPolicyRevisionId:
        policy.eligibility_policy_revision_id,
      evidencePolicyRevisionId:
        policy.evidence_policy_revision_id,
      reviewPolicyRevisionId:
        policy.review_policy_revision_id,
      moderationPolicyRevisionId:
        policy.moderation_policy_revision_id,
    },
    candidate,
    claimSeal: {
      candidateClaimSetSealId:
        seal.candidate_claim_set_seal_id,
      claimSetHash: seal.claim_set_hash,
    },
    computationInput,
    inputHash,
    moderation,
    requiredClaimSetHash,
    requiredClaims,
    review,
  };
}
