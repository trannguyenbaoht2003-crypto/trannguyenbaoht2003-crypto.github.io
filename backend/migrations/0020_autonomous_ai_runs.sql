create table autonomous_ai_review_runs (
  run_id uuid primary key check (run_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  utc_tick timestamptz not null unique,
  budget_day date not null,
  started_at timestamptz not null,
  candidate_id uuid not null references candidates,
  candidate_revision_id uuid not null references candidate_revisions,
  eligibility_policy_revision_id uuid not null references eligibility_policy_revisions,
  evidence_policy_revision_id uuid not null references evidence_policy_revisions,
  moderation_policy_revision_id uuid not null references moderation_policy_revisions,
  review_policy_revision_id uuid not null,
  model text not null,
  prompt_version integer not null default 1 check (prompt_version = 1),
  input_hash text not null check (input_hash ~ '^[a-f0-9]{64}$'),
  request_hash text not null check (request_hash ~ '^[a-f0-9]{64}$'),
  request jsonb not null check (jsonb_typeof(request) = 'object' and octet_length(request::text) <= 131072),
  publication_id uuid not null,
  expected_publication_version_id uuid references publication_versions,
  expected_moderation_decision_id uuid references moderation_decisions,
  chosen_moderation_decision_id uuid not null unique,
  state text not null default 'reserved' check (state in ('reserved','in_flight','responded','uncertain','failed','held','declined','published')),
  in_flight_at timestamptz,
  response jsonb check (jsonb_typeof(response) = 'object' and octet_length(response::text) <= 262144),
  provider_response_id text check (octet_length(provider_response_id) between 1 and 256),
  response_hash text check (response_hash ~ '^[a-f0-9]{64}$'),
  failure_code text check (failure_code ~ '^[A-Z][A-Z0-9_]{0,95}$'),
  publication_version_id uuid references publication_versions,
  unique (request_hash, model, prompt_version),
  foreign key (review_policy_revision_id,model,prompt_version) references ai_review_policy_configs(review_policy_revision_id,model,prompt_version),
  check (utc_tick = date_trunc('hour', started_at at time zone 'UTC') at time zone 'UTC'),
  check (budget_day = (utc_tick at time zone 'UTC')::date),
  check ((response is null and provider_response_id is null and response_hash is null) or
         (response is not null and provider_response_id is not null and response_hash is not null)),
  check (state not in ('responded','published','declined') or response is not null),
  check (state not in ('in_flight','responded','uncertain','failed','published','declined') or in_flight_at is not null),
  check ((state = 'published') = (publication_version_id is not null))
);
create index autonomous_ai_review_runs_recovery on autonomous_ai_review_runs(model,state,started_at);
create index autonomous_ai_review_runs_budget on autonomous_ai_review_runs(budget_day);

create function enforce_autonomous_ai_review_run() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then raise exception 'autonomous run immutable'; end if;
  if tg_op = 'INSERT' then
    if new.state <> 'reserved' or new.in_flight_at is not null or new.response is not null or new.failure_code is not null then
      raise exception 'autonomous run must start reserved';
    end if;
    perform pg_advisory_xact_lock(hashtextextended('autonomous-ai-review-budget-v1',0));
    if (select count(*) from autonomous_ai_review_runs where budget_day = new.budget_day) >= 4 then
      raise exception 'autonomous daily budget exhausted';
    end if;
    if not exists (select 1 from candidate_revisions where candidate_revision_id=new.candidate_revision_id and candidate_id=new.candidate_id)
      or not exists (select 1 from eligibility_policy_revisions where eligibility_policy_revision_id=new.eligibility_policy_revision_id
        and evidence_policy_revision_id=new.evidence_policy_revision_id and moderation_policy_revision_id=new.moderation_policy_revision_id
        and review_policy_revision_id=new.review_policy_revision_id) then raise exception 'autonomous identity mismatch'; end if;
    if new.request->>'candidateRevisionId' is distinct from new.candidate_revision_id::text or new.request->>'inputHash' is distinct from new.input_hash then
      raise exception 'autonomous request identity mismatch';
    end if;
    return new;
  end if;
  if (to_jsonb(new) - array['state','in_flight_at','response','provider_response_id','response_hash','failure_code','publication_version_id'])
     is distinct from (to_jsonb(old) - array['state','in_flight_at','response','provider_response_id','response_hash','failure_code','publication_version_id']) then
    raise exception 'autonomous run identity immutable';
  end if;
  if not ((old.state='reserved' and new.state in ('in_flight','held'))
    or (old.state='in_flight' and new.state in ('responded','uncertain','failed'))
    or (old.state='responded' and new.state in ('held','declined','published'))) then
    raise exception 'autonomous run invalid transition';
  end if;
  if old.in_flight_at is distinct from new.in_flight_at and not
     (old.state='reserved' and new.state='in_flight' and old.in_flight_at is null and new.in_flight_at is not null) then
    raise exception 'autonomous ownership timestamp immutable';
  end if;
  if row(old.response,old.provider_response_id,old.response_hash) is distinct from row(new.response,new.provider_response_id,new.response_hash)
     and not (old.state='in_flight' and new.state='responded' and new.response is not null) then
    raise exception 'autonomous response immutable';
  end if;
  return new;
end; $$;
create trigger autonomous_ai_review_run_guard before insert or update or delete on autonomous_ai_review_runs
for each row execute function enforce_autonomous_ai_review_run();

-- Advance even when preparation yields no paid request, so an unpreparable prefix cannot starve input.
create table autonomous_ai_review_scan_state (
  singleton boolean primary key default true check (singleton),
  scan_offset bigint not null default 0 check (scan_offset >= 0)
);
insert into autonomous_ai_review_scan_state(singleton) values (true);

-- The domain service serializes candidate writes. Guard its moderation pointer CAS too,
-- including a manual decision arriving between coordinator preflight and the domain transaction.
create function enforce_autonomous_moderation_pointer() returns trigger language plpgsql as $$
declare
  run autonomous_ai_review_runs%rowtype;
  decision moderation_decisions%rowtype;
begin
  select * into decision from moderation_decisions where moderation_decision_id=new.moderation_decision_id;
  select * into run from autonomous_ai_review_runs where chosen_moderation_decision_id=new.moderation_decision_id;
  if not found then return new; end if;
  if run.state <> 'responded' or decision.evaluator_actor_id <> 'system:ai-reviewer'
    or decision.candidate_revision_id <> run.candidate_revision_id
    or decision.moderation_policy_revision_id <> run.moderation_policy_revision_id
    or (tg_op='UPDATE' and old.moderation_decision_id is distinct from run.expected_moderation_decision_id
      and old.moderation_decision_id <> run.chosen_moderation_decision_id)
    or (tg_op='INSERT' and (select moderation_decision_id from current_candidate_moderation_decisions
      where candidate_revision_id=new.candidate_revision_id and moderation_policy_revision_id=new.moderation_policy_revision_id)
      is distinct from run.expected_moderation_decision_id)
    or not exists (select 1 from active_eligibility_policy_revision where scope='candidate_revision'
      and eligibility_policy_revision_id=run.eligibility_policy_revision_id) then
    raise exception 'AI_AUTONOMOUS_AUTHORITY_CHANGED' using errcode='23514';
  end if;
  return new;
end; $$;
create trigger autonomous_moderation_pointer_guard before insert or update on current_candidate_moderation_decisions
for each row execute function enforce_autonomous_moderation_pointer();
