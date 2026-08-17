do $$
declare
  existing_source record;
begin
  select source_id, display_name, status
    into existing_source
    from sources
   where source_key = 'ai-discovery';

  if found then
    if existing_source.display_name <> 'AI Discovery'
       or existing_source.status <> 'active' then
      raise exception 'AI_DISCOVERY_RESERVED_SOURCE_CONFLICT'
        using errcode = '23514';
    end if;
  else
    insert into sources (source_id, source_key, display_name, status)
    values (gen_random_uuid(), 'ai-discovery', 'AI Discovery', 'active');
  end if;
end;
$$;

do $$
declare
  reserved_source_id uuid;
  existing_policy record;
  policy_reason constant text := 'synthetic AI proposal materialization only';
begin
  select source_id
    into reserved_source_id
    from sources
   where source_key = 'ai-discovery';

  if reserved_source_id is null then
    raise exception 'AI_DISCOVERY_RESERVED_SOURCE_MISSING'
      using errcode = '23514';
  end if;

  select source_policy_revision_id,
         storage_permission,
         collector_enabled,
         reason,
         created_by
    into existing_policy
    from source_policy_revisions
   where source_id = reserved_source_id
     and revision = 1;

  if found then
    if existing_policy.storage_permission <> 'aggregate_only'
       or existing_policy.collector_enabled is distinct from false
       or existing_policy.reason <> policy_reason
       or existing_policy.created_by <> 'system:migration:0014' then
      raise exception 'AI_DISCOVERY_RESERVED_POLICY_CONFLICT'
        using errcode = '23514';
    end if;
  else
    insert into source_policy_revisions
      (source_policy_revision_id, source_id, revision,
       storage_permission, collector_enabled, reason, created_by)
    values
      (gen_random_uuid(), reserved_source_id, 1,
       'aggregate_only', false, policy_reason, 'system:migration:0014');
  end if;
end;
$$;

do $$
declare
  reserved_source_id uuid;
  reserved_policy_id uuid;
  active_policy_id uuid;
begin
  select source_id
    into reserved_source_id
    from sources
   where source_key = 'ai-discovery';

  select source_policy_revision_id
    into reserved_policy_id
    from source_policy_revisions
   where source_id = reserved_source_id
     and revision = 1;

  select source_policy_revision_id
    into active_policy_id
    from active_source_policies
   where source_id = reserved_source_id;

  if active_policy_id is not null and active_policy_id <> reserved_policy_id then
    raise exception 'AI_DISCOVERY_RESERVED_ACTIVE_POLICY_CONFLICT'
      using errcode = '23514';
  end if;

  if active_policy_id is null then
    insert into active_source_policies
      (source_id, source_policy_revision_id)
    values (reserved_source_id, reserved_policy_id);
  end if;
end;
$$;

create or replace function is_ai_discovery_selection_array(value jsonb)
returns boolean
language plpgsql
immutable
strict
as $$
declare
  item_count integer;
  distinct_count integer;
begin
  if jsonb_typeof(value) is distinct from 'array'
     or jsonb_array_length(value) > 64 then
    return false;
  end if;

  if exists (
    select 1
      from jsonb_array_elements(value) as entry(item)
     where jsonb_typeof(item) is distinct from 'string'
  ) then
    return false;
  end if;

  if exists (
    select 1
      from jsonb_array_elements_text(value) as entry(item)
     where char_length(item) = 0
        or char_length(item) > 128
        or item collate "C" !~ '^[!-~]+$'
  ) then
    return false;
  end if;

  select count(*)::integer,
         count(distinct (item collate "C"))::integer
    into item_count, distinct_count
    from jsonb_array_elements_text(value) as entry(item);

  if item_count <> distinct_count then
    return false;
  end if;

  if exists (
    select 1
      from (
        select item,
               lag(item) over (order by ordinality) as previous_item
          from jsonb_array_elements_text(value)
               with ordinality as entry(item, ordinality)
      ) ordered
     where previous_item is not null
       and previous_item collate "C" >= item collate "C"
  ) then
    return false;
  end if;

  return true;
end;
$$;

create table ai_discovery_runs (
  ai_discovery_run_id uuid primary key,
  run_key text not null unique
    check (char_length(run_key) between 1 and 128 and run_key collate "C" ~ '^[!-~]+$'),
  provider_key text not null
    check (char_length(provider_key) between 1 and 128 and provider_key collate "C" ~ '^[!-~]+$'),
  model_key text not null
    check (char_length(model_key) between 1 and 128 and model_key collate "C" ~ '^[!-~]+$'),
  model_revision text not null
    check (char_length(model_revision) between 1 and 128 and model_revision collate "C" ~ '^[!-~]+$'),
  prompt_template_key text not null
    check (char_length(prompt_template_key) between 1 and 128 and prompt_template_key collate "C" ~ '^[!-~]+$'),
  prompt_template_version integer not null
    check (prompt_template_version > 0),
  input_hash text not null
    check (input_hash ~ '^[a-f0-9]{64}$'),
  output_hash text not null
    check (output_hash ~ '^[a-f0-9]{64}$'),
  status text not null
    check (status in ('completed', 'failed')),
  started_at timestamptz not null,
  completed_at timestamptz not null,
  failure_code text,
  created_at timestamptz not null default clock_timestamp(),
  check (completed_at >= started_at),
  check (
    (status = 'completed' and failure_code is null)
    or (
      status = 'failed'
      and failure_code is not null
      and char_length(failure_code) between 1 and 128
      and failure_code collate "C" ~ '^[!-~]+$'
    )
  )
);

create index ai_discovery_runs_created_idx
  on ai_discovery_runs (created_at desc, ai_discovery_run_id);

create table ai_candidate_proposals (
  ai_candidate_proposal_id uuid primary key,
  ai_discovery_run_id uuid not null
    references ai_discovery_runs(ai_discovery_run_id),
  ordinal integer not null check (ordinal >= 0),
  proposal_hash text not null
    check (proposal_hash ~ '^[a-f0-9]{64}$'),
  patch_key text not null
    check (char_length(patch_key) between 1 and 128 and patch_key collate "C" ~ '^[!-~]+$'),
  game_mode_external_id text not null
    check (game_mode_external_id = 'aram_mayhem'),
  subject_external_id text not null
    check (char_length(subject_external_id) between 1 and 128 and subject_external_id collate "C" ~ '^[!-~]+$'),
  augment_external_ids jsonb not null
    check (is_ai_discovery_selection_array(augment_external_ids)),
  item_external_ids jsonb not null
    check (is_ai_discovery_selection_array(item_external_ids)),
  rationale text
    check (rationale is null or char_length(rationale) <= 2000),
  created_at timestamptz not null default clock_timestamp(),
  unique (ai_discovery_run_id, ordinal),
  unique (ai_discovery_run_id, proposal_hash)
);

create index ai_candidate_proposals_run_idx
  on ai_candidate_proposals (ai_discovery_run_id, ordinal);

create or replace function enforce_ai_candidate_proposal_completed_run()
returns trigger
language plpgsql
as $$
declare
  run_status text;
begin
  select status
    into run_status
    from ai_discovery_runs
   where ai_discovery_run_id = new.ai_discovery_run_id;

  if run_status is distinct from 'completed' then
    raise exception 'AI_DISCOVERY_PROPOSAL_REQUIRES_COMPLETED_RUN'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger ai_candidate_proposal_completed_run_guard
before insert on ai_candidate_proposals
for each row execute function enforce_ai_candidate_proposal_completed_run();

create table ai_candidate_materializations (
  ai_candidate_materialization_id uuid primary key,
  ai_candidate_proposal_id uuid not null unique
    references ai_candidate_proposals(ai_candidate_proposal_id),
  raw_observation_id uuid not null unique
    references raw_observations(raw_observation_id),
  normalized_observation_id uuid not null unique
    references normalized_observations(normalized_observation_id),
  candidate_id uuid not null
    references candidates(candidate_id),
  candidate_revision_id uuid not null
    references candidate_revisions(candidate_revision_id),
  candidate_provenance_id uuid not null unique
    references candidate_provenance(candidate_provenance_id),
  actor_id text not null
    check (char_length(btrim(actor_id)) between 1 and 256),
  reason text not null
    check (char_length(btrim(reason)) between 1 and 2000),
  correlation_id text not null
    check (char_length(btrim(correlation_id)) between 1 and 256),
  materialized_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp()
);

create or replace function enforce_ai_candidate_materialization_graph()
returns trigger
language plpgsql
as $$
declare
  graph_matches boolean;
begin
  select (
           no.raw_observation_id = new.raw_observation_id
           and cp.normalized_observation_id = new.normalized_observation_id
           and cp.candidate_revision_id = new.candidate_revision_id
           and cp.origin = 'ai_generated'
           and cr.candidate_id = new.candidate_id
         )
    into graph_matches
    from normalized_observations no
    join candidate_provenance cp
      on cp.candidate_provenance_id = new.candidate_provenance_id
    join candidate_revisions cr
      on cr.candidate_revision_id = new.candidate_revision_id
   where no.normalized_observation_id = new.normalized_observation_id;

  if graph_matches is distinct from true then
    raise exception 'AI_DISCOVERY_MATERIALIZATION_GRAPH_MISMATCH'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger ai_candidate_materialization_graph_guard
before insert on ai_candidate_materializations
for each row execute function enforce_ai_candidate_materialization_graph();

create trigger ai_discovery_runs_immutable
before update or delete on ai_discovery_runs
for each row execute function reject_immutable_change();

create trigger ai_candidate_proposals_immutable
before update or delete on ai_candidate_proposals
for each row execute function reject_immutable_change();

create trigger ai_candidate_materializations_immutable
before update or delete on ai_candidate_materializations
for each row execute function reject_immutable_change();
