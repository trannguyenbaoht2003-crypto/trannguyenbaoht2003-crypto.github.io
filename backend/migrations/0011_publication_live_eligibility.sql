create or replace function enforce_publication_live_eligibility()
returns trigger
language plpgsql
as $$
declare
  authority_current boolean;
begin
  select exists (
    select 1
      from candidate_eligibility_evaluations evaluation
      join eligibility_input_snapshots eligibility
        on eligibility.eligibility_input_snapshot_id =
           evaluation.eligibility_input_snapshot_id
       and eligibility.candidate_id = evaluation.candidate_id
       and eligibility.candidate_revision_id =
           evaluation.candidate_revision_id
       and eligibility.eligibility_policy_revision_id =
           evaluation.eligibility_policy_revision_id
       and eligibility.input_hash = evaluation.input_hash
      join active_eligibility_policy_revision active_policy
        on active_policy.scope = 'candidate_revision'
       and active_policy.eligibility_policy_revision_id =
           evaluation.eligibility_policy_revision_id
      join current_candidate_eligibility_evaluations current_eligibility
        on current_eligibility.candidate_revision_id =
           evaluation.candidate_revision_id
       and current_eligibility.eligibility_policy_revision_id =
           evaluation.eligibility_policy_revision_id
       and current_eligibility.candidate_eligibility_evaluation_id =
           evaluation.candidate_eligibility_evaluation_id
       and current_eligibility.input_hash = evaluation.input_hash
      join moderation_decisions moderation
        on moderation.moderation_decision_id =
           eligibility.moderation_decision_id
       and moderation.candidate_id = evaluation.candidate_id
       and moderation.candidate_revision_id =
           evaluation.candidate_revision_id
       and moderation.moderation_policy_revision_id =
           eligibility.moderation_policy_revision_id
      join current_candidate_moderation_decisions current_moderation
        on current_moderation.candidate_revision_id =
           evaluation.candidate_revision_id
       and current_moderation.moderation_policy_revision_id =
           eligibility.moderation_policy_revision_id
       and current_moderation.moderation_decision_id =
           moderation.moderation_decision_id
       and current_moderation.input_hash = moderation.input_hash
      join review_quorum_evaluations review
        on review.review_quorum_evaluation_id =
           eligibility.review_quorum_evaluation_id
       and review.candidate_id = evaluation.candidate_id
       and review.candidate_revision_id =
           evaluation.candidate_revision_id
       and review.review_policy_revision_id =
           eligibility.review_policy_revision_id
      join current_review_quorum_evaluations current_review
        on current_review.candidate_revision_id =
           evaluation.candidate_revision_id
       and current_review.review_policy_revision_id =
           eligibility.review_policy_revision_id
       and current_review.review_quorum_evaluation_id =
           review.review_quorum_evaluation_id
       and current_review.input_hash = review.input_hash
     where evaluation.candidate_eligibility_evaluation_id =
           new.candidate_eligibility_evaluation_id
       and evaluation.candidate_id = new.candidate_id
       and evaluation.candidate_revision_id =
           new.candidate_revision_id
       and evaluation.eligibility_policy_revision_id =
           new.eligibility_policy_revision_id
       and evaluation.input_hash = new.eligibility_input_hash
       and evaluation.outcome = 'eligible'
       and eligibility.moderation_current
       and eligibility.moderation_outcome = 'clear'
       and eligibility.review_current
       and eligibility.review_quorum_satisfied
       and moderation.moderation_decision_id =
           new.moderation_decision_id
       and moderation.moderation_policy_revision_id =
           new.moderation_policy_revision_id
       and moderation.input_hash = new.moderation_input_hash
       and not exists (
         select 1
           from candidate_provenance live
          where live.candidate_revision_id =
                new.candidate_revision_id
            and not exists (
              select 1
                from moderation_input_snapshot_provenance member
               where member.moderation_input_snapshot_id =
                     moderation.moderation_input_snapshot_id
                 and member.candidate_provenance_id =
                     live.candidate_provenance_id
                 and member.origin = live.origin
            )
       )
       and not exists (
         select 1
           from moderation_input_snapshot_provenance member
          where member.moderation_input_snapshot_id =
                moderation.moderation_input_snapshot_id
            and not exists (
              select 1
                from candidate_provenance live
               where live.candidate_revision_id =
                     new.candidate_revision_id
                 and live.candidate_provenance_id =
                     member.candidate_provenance_id
                 and live.origin = member.origin
            )
       )
       and not exists (
         select 1
           from candidate_provenance live
          where live.candidate_revision_id =
                new.candidate_revision_id
            and not exists (
              select 1
                from review_input_snapshot_provenance member
               where member.review_input_snapshot_id =
                     review.review_input_snapshot_id
                 and member.candidate_provenance_id =
                     live.candidate_provenance_id
                 and member.origin = live.origin
            )
       )
       and not exists (
         select 1
           from review_input_snapshot_provenance member
          where member.review_input_snapshot_id =
                review.review_input_snapshot_id
            and not exists (
              select 1
                from candidate_provenance live
               where live.candidate_revision_id =
                     new.candidate_revision_id
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
          where claim.candidate_revision_id =
                new.candidate_revision_id
            and not exists (
              select 1
                from review_input_snapshot_claims member
               where member.review_input_snapshot_id =
                     review.review_input_snapshot_id
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
                review.review_input_snapshot_id
            and not exists (
              select 1
                from candidate_claims claim
                left join current_claim_evidence_decisions current_evidence
                  on current_evidence.claim_id = claim.claim_id
               where claim.candidate_revision_id =
                     new.candidate_revision_id
                 and claim.claim_id = member.claim_id
                 and claim.importance = member.importance
                 and current_evidence.claim_evidence_decision_id
                     is not distinct from
                     member.claim_evidence_decision_id
            )
       )
       and not exists (
         select 1
           from candidate_claims claim
           left join current_claim_evidence_decisions current_evidence
             on current_evidence.claim_id = claim.claim_id
          where claim.candidate_revision_id =
                new.candidate_revision_id
            and claim.importance = 'required'
            and not exists (
              select 1
                from eligibility_input_snapshot_required_claims member
               where member.eligibility_input_snapshot_id =
                     eligibility.eligibility_input_snapshot_id
                 and member.claim_id = claim.claim_id
                 and member.candidate_revision_id =
                     new.candidate_revision_id
                 and member.claim_evidence_decision_id
                     is not distinct from
                     current_evidence.claim_evidence_decision_id
                 and member.decision_current =
                     (current_evidence.claim_evidence_decision_id is not null)
            )
       )
       and not exists (
         select 1
           from eligibility_input_snapshot_required_claims member
          where member.eligibility_input_snapshot_id =
                eligibility.eligibility_input_snapshot_id
            and not exists (
              select 1
                from candidate_claims claim
                left join current_claim_evidence_decisions current_evidence
                  on current_evidence.claim_id = claim.claim_id
               where claim.candidate_revision_id =
                     new.candidate_revision_id
                 and claim.importance = 'required'
                 and claim.claim_id = member.claim_id
                 and member.claim_evidence_decision_id
                     is not distinct from
                     current_evidence.claim_evidence_decision_id
            )
       )
  ) into authority_current;

  if authority_current is distinct from true then
    raise exception 'publication input stale'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create constraint trigger publication_live_eligibility_guard
  after insert on publication_versions
  deferrable initially deferred
  for each row execute function enforce_publication_live_eligibility();
