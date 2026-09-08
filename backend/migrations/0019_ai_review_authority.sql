-- Review authority is explicit; historical policies retain human authority.
alter table review_policy_revisions add column review_authority text not null default 'human';
alter table review_policy_revisions drop constraint review_policy_revisions_required_permission_check;
alter table review_policy_revisions add constraint review_policy_authority_discriminator check (
  (review_authority = 'human' and required_permission = 'reviewer')
  or (review_authority = 'ai' and required_permission = 'ai_reviewer' and minimum_confirmed_reviews = 1)
);
create table ai_review_policy_configs (
  review_policy_revision_id uuid primary key references review_policy_revisions,
  model text not null check (octet_length(model) between 1 and 256),
  prompt_version integer not null check (prompt_version = 1),
  unique (review_policy_revision_id, model, prompt_version)
);
create function enforce_ai_review_policy_config() returns trigger language plpgsql as $$
begin
  if not exists (select 1 from review_policy_revisions where review_policy_revision_id = new.review_policy_revision_id and review_authority = 'ai') then
    raise exception 'AI review policy authority mismatch' using errcode = '23514';
  end if;
  return new;
end; $$;
create trigger ai_review_policy_config_authority before insert on ai_review_policy_configs
for each row execute function enforce_ai_review_policy_config();
create trigger ai_review_policy_configs_immutable before update or delete on ai_review_policy_configs
for each row execute function reject_immutable_change();

create table ai_reviews (
  ai_review_id uuid primary key,
  candidate_id uuid not null,
  candidate_revision_id uuid not null,
  review_input_snapshot_id uuid not null,
  input_hash text not null check (input_hash ~ '^[a-f0-9]{64}$'),
  review_policy_revision_id uuid not null,
  reviewer_actor_id text not null check (reviewer_actor_id = 'system:ai-reviewer'),
  model text not null,
  prompt_version integer not null,
  request_hash text not null check (request_hash ~ '^[a-f0-9]{64}$'),
  response_hash text not null check (response_hash ~ '^[a-f0-9]{64}$'),
  provider_response_id text not null check (octet_length(provider_response_id) between 1 and 256),
  outcome text not null check (outcome in ('confirmed','changes_requested','declined')),
  reason text not null check (octet_length(reason) between 1 and 1024),
  correlation_id text not null check (octet_length(correlation_id) between 1 and 256),
  completed_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp(),
  foreign key (review_policy_revision_id,model,prompt_version)
    references ai_review_policy_configs(review_policy_revision_id,model,prompt_version),
  foreign key (review_input_snapshot_id,candidate_id,candidate_revision_id,review_policy_revision_id,input_hash)
    references review_input_snapshots(review_input_snapshot_id,candidate_id,candidate_revision_id,review_policy_revision_id,input_hash),
  unique (ai_review_id,candidate_id,candidate_revision_id,review_policy_revision_id,input_hash)
);
create unique index ai_reviews_one_confirmation_per_input on ai_reviews(candidate_revision_id,review_policy_revision_id,input_hash) where outcome = 'confirmed';
create trigger ai_reviews_immutable before update or delete on ai_reviews for each row execute function reject_immutable_change();

-- Currentness is evaluated at acceptance only. Immutable receipts remain replayable.
create function ai_review_input_is_current(snapshot_id uuid) returns boolean language sql as $$
select exists (
  select 1 from review_input_snapshots snapshot
  join candidate_revisions revision on revision.candidate_revision_id = snapshot.candidate_revision_id
  join candidates candidate on candidate.candidate_id = revision.candidate_id
  join active_catalog_revisions catalog on catalog.patch_id = revision.patch_id
    and catalog.game_mode_external_id = candidate.game_mode_external_id and catalog.catalog_revision_id = revision.catalog_revision_id
  join active_eligibility_policy_revision active on active.scope = 'candidate_revision'
  join eligibility_policy_revisions policy using (eligibility_policy_revision_id)
  join review_policy_revisions review_policy on review_policy.review_policy_revision_id = policy.review_policy_revision_id
  where snapshot.review_input_snapshot_id = snapshot_id
    and snapshot.review_policy_revision_id = policy.review_policy_revision_id and review_policy.review_authority = 'ai'
    and not exists (
      select 1 from candidate_revisions newer
      join active_catalog_revisions newer_catalog on newer_catalog.patch_id = newer.patch_id
        and newer_catalog.game_mode_external_id = candidate.game_mode_external_id
        and newer_catalog.catalog_revision_id = newer.catalog_revision_id
      where newer.candidate_id = revision.candidate_id
        and (newer.revision > revision.revision or (newer.revision = revision.revision
          and newer.candidate_revision_id::text collate "C" > revision.candidate_revision_id::text collate "C")))
    and exists (select 1 from candidate_claim_set_seals seal where seal.candidate_revision_id = revision.candidate_revision_id
      and seal.candidate_claim_set_seal_id = snapshot.candidate_claim_set_seal_id and seal.claim_set_hash = snapshot.claim_set_hash)
    and not exists (
      (select claim.claim_id,claim.importance,current.claim_evidence_decision_id
       from candidate_claims claim left join current_claim_evidence_decisions current using(claim_id)
       where claim.candidate_revision_id = revision.candidate_revision_id
       except select claim_id,importance,claim_evidence_decision_id from review_input_snapshot_claims where review_input_snapshot_id = snapshot_id)
      union all
      (select claim_id,importance,claim_evidence_decision_id from review_input_snapshot_claims where review_input_snapshot_id = snapshot_id
       except select claim.claim_id,claim.importance,current.claim_evidence_decision_id
       from candidate_claims claim left join current_claim_evidence_decisions current using(claim_id)
       where claim.candidate_revision_id = revision.candidate_revision_id)
    )
    and not exists (
      (select candidate_provenance_id,origin from candidate_provenance where candidate_revision_id = revision.candidate_revision_id
       except select candidate_provenance_id,origin from review_input_snapshot_provenance where review_input_snapshot_id = snapshot_id)
      union all
      (select candidate_provenance_id,origin from review_input_snapshot_provenance where review_input_snapshot_id = snapshot_id
       except select candidate_provenance_id,origin from candidate_provenance where candidate_revision_id = revision.candidate_revision_id)
    )
);
$$;
create function ai_review_required_evidence_supported(snapshot_id uuid) returns boolean language sql as $$
select exists (select 1 from review_input_snapshot_claims where review_input_snapshot_id = snapshot_id and importance = 'required')
and not exists (
  select 1 from review_input_snapshot_claims member
  left join claim_evidence_decisions decision using (claim_evidence_decision_id)
  cross join active_eligibility_policy_revision active
  join eligibility_policy_revisions policy using (eligibility_policy_revision_id)
  where member.review_input_snapshot_id = snapshot_id and member.importance = 'required'
    and active.scope = 'candidate_revision'
    and (decision.decision is distinct from 'supported' or decision.evidence_policy_revision_id is distinct from policy.evidence_policy_revision_id)
);
$$;
create function enforce_ai_review_receipt() returns trigger language plpgsql as $$
declare seed record;
begin
  select revision.patch_id,revision.catalog_revision_id,candidate.game_mode_external_id into seed
    from candidate_revisions revision join candidates candidate using(candidate_id)
    where revision.candidate_revision_id = new.candidate_revision_id and candidate.candidate_id = new.candidate_id;
  perform 1 from patches where patch_id = seed.patch_id for share;
  perform 1 from active_catalog_revisions where patch_id = seed.patch_id and game_mode_external_id = seed.game_mode_external_id for share;
  perform pg_advisory_xact_lock(hashtextextended('active_eligibility_policy_revision:candidate_revision',0));
  perform 1 from candidates where candidate_id = new.candidate_id for update;
  perform 1 from candidate_revisions where candidate_revision_id = new.candidate_revision_id for update;
  if not ai_review_input_is_current(new.review_input_snapshot_id) then
    raise exception 'AI review input stale or authority mismatch' using errcode = '23514';
  end if;
  if new.outcome = 'confirmed' and not ai_review_required_evidence_supported(new.review_input_snapshot_id) then
    raise exception 'AI review required evidence unsupported' using errcode = '23514';
  end if;
  return new;
end; $$;
create trigger ai_review_receipt_authority before insert on ai_reviews for each row execute function enforce_ai_review_receipt();

create function enforce_human_review_authority() returns trigger language plpgsql as $$
begin
  if not exists (select 1 from review_policy_revisions where review_policy_revision_id = new.review_policy_revision_id and review_authority = 'human') then
    raise exception 'human review authority mismatch' using errcode = '23514';
  end if;
  return new;
end; $$;
create trigger human_review_authority before insert on human_reviews for each row execute function enforce_human_review_authority();
create trigger human_quorum_member_authority before insert on review_quorum_evaluation_reviews for each row execute function enforce_human_review_authority();

create table review_quorum_evaluation_ai_reviews (
  review_quorum_evaluation_id uuid not null,
  ai_review_id uuid not null,
  candidate_id uuid not null,
  candidate_revision_id uuid not null,
  review_policy_revision_id uuid not null,
  input_hash text not null,
  ordinal integer not null check (ordinal > 0),
  primary key (review_quorum_evaluation_id,ai_review_id),
  unique (review_quorum_evaluation_id,ordinal),
  foreign key (review_quorum_evaluation_id,candidate_id,candidate_revision_id,review_policy_revision_id,input_hash)
    references review_quorum_evaluations(review_quorum_evaluation_id,candidate_id,candidate_revision_id,review_policy_revision_id,input_hash),
  foreign key (ai_review_id,candidate_id,candidate_revision_id,review_policy_revision_id,input_hash)
    references ai_reviews(ai_review_id,candidate_id,candidate_revision_id,review_policy_revision_id,input_hash)
);
create function enforce_ai_review_quorum_membership() returns trigger language plpgsql as $$
begin
  if not exists (select 1 from ai_reviews review join review_policy_revisions policy using(review_policy_revision_id)
    where review.ai_review_id = new.ai_review_id and review.outcome = 'confirmed' and policy.review_authority = 'ai') then
    raise exception 'AI review quorum membership authority mismatch' using errcode = '23514';
  end if;
  return new;
end; $$;
create trigger ai_review_quorum_member_authority before insert on review_quorum_evaluation_ai_reviews
for each row execute function enforce_ai_review_quorum_membership();
create trigger review_quorum_evaluation_ai_reviews_immutable before update or delete on review_quorum_evaluation_ai_reviews
for each row execute function reject_immutable_change();
create or replace function enforce_review_quorum_result()
returns trigger
language plpgsql
as $$
declare
  evaluation_id uuid;
  evaluation review_quorum_evaluations%rowtype;
  required_count integer;
  actual_count integer;
  eligible_count integer;
  ordinal_mismatch boolean;
  authority text;
begin
  evaluation_id := case
    when tg_table_name = 'review_quorum_evaluations'
      then new.review_quorum_evaluation_id
    else new.review_quorum_evaluation_id
  end;
  select *
    into evaluation
    from review_quorum_evaluations
   where review_quorum_evaluation_id = evaluation_id;
  if not found then
    raise exception 'review quorum evaluation missing'
      using errcode = '23514';
  end if;

  select minimum_confirmed_reviews
    into required_count
    from review_policy_revisions
   where review_policy_revision_id =
         evaluation.review_policy_revision_id;
  select review_authority into authority from review_policy_revisions
    where review_policy_revision_id = evaluation.review_policy_revision_id;
  if authority = 'ai' then
  select count(*)::integer into actual_count
    from review_quorum_evaluation_ai_reviews
   where review_quorum_evaluation_id = evaluation_id;
  select count(*)::integer into eligible_count
    from ai_reviews
   where candidate_revision_id = evaluation.candidate_revision_id
     and review_policy_revision_id = evaluation.review_policy_revision_id
     and input_hash = evaluation.input_hash and outcome = 'confirmed';
  select exists (
    select 1 from (
      select member.ordinal, row_number() over (
        order by review.completed_at, review.ai_review_id::text collate "C"
      )::integer as expected_ordinal
      from review_quorum_evaluation_ai_reviews member
      join ai_reviews review using (ai_review_id)
      where member.review_quorum_evaluation_id = evaluation_id
    ) ordered where ordinal <> expected_ordinal
  ) into ordinal_mismatch;
  else
  select count(*)::integer
    into actual_count
    from review_quorum_evaluation_reviews
   where review_quorum_evaluation_id = evaluation_id;
  select count(distinct reviewer_actor_id)::integer
    into eligible_count
    from human_reviews
   where candidate_revision_id = evaluation.candidate_revision_id
     and review_policy_revision_id =
         evaluation.review_policy_revision_id
     and input_hash = evaluation.input_hash
     and status = 'completed'
     and outcome = 'confirmed'
     and permission_used = 'reviewer';

  select exists (
    select 1
      from (
        select member.ordinal,
               row_number() over (
                 order by review.completed_at,
                          review.human_review_id::text collate "C"
               )::integer as expected_ordinal
          from review_quorum_evaluation_reviews member
          join human_reviews review
            on review.human_review_id = member.human_review_id
         where member.review_quorum_evaluation_id = evaluation_id
      ) ordered
     where ordinal <> expected_ordinal
  ) into ordinal_mismatch;

  end if;

  if ordinal_mismatch
     or actual_count <> eligible_count
     or evaluation.required_confirmed_count <> required_count
     or evaluation.counted_review_count <> actual_count
     or evaluation.quorum_satisfied is distinct from
        (actual_count >= required_count) then
    raise exception 'review quorum result mismatch'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create constraint trigger ai_review_quorum_result_from_member
  after insert on review_quorum_evaluation_ai_reviews deferrable initially deferred
  for each row execute function enforce_review_quorum_result();
