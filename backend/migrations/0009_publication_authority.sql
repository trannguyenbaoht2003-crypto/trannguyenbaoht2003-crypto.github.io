create table publications (
  publication_id uuid primary key,
  candidate_id uuid not null unique
    references candidates(candidate_id),
  created_by text not null
    check (octet_length(created_by) between 1 and 256),
  created_at timestamptz not null default clock_timestamp(),
  unique (publication_id, candidate_id)
);

create table publication_versions (
  publication_version_id uuid primary key,
  version_sequence bigint generated always as identity unique,
  publication_id uuid not null,
  candidate_id uuid not null,
  candidate_revision_id uuid not null,
  patch_id uuid not null,
  catalog_revision_id uuid not null,
  candidate_normalized_signature text not null
    check (candidate_normalized_signature ~ '^[a-f0-9]{64}$'),
  eligibility_policy_revision_id uuid not null
    references eligibility_policy_revisions(
      eligibility_policy_revision_id
    ),
  candidate_eligibility_evaluation_id uuid not null,
  eligibility_input_hash text not null
    check (eligibility_input_hash ~ '^[a-f0-9]{64}$'),
  moderation_policy_revision_id uuid not null
    references moderation_policy_revisions(
      moderation_policy_revision_id
    ),
  moderation_decision_id uuid not null,
  moderation_input_hash text not null
    check (moderation_input_hash ~ '^[a-f0-9]{64}$'),
  version_number integer not null check (version_number > 0),
  publication_payload jsonb not null
    check (jsonb_typeof(publication_payload) = 'object'),
  payload_hash text not null
    check (payload_hash ~ '^[a-f0-9]{64}$'),
  published_by text not null
    check (octet_length(published_by) between 1 and 256),
  correlation_id text not null
    check (octet_length(correlation_id) between 1 and 256),
  published_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp(),
  unique (publication_id, version_number),
  unique (publication_version_id, publication_id),
  unique (
    publication_version_id,
    publication_id,
    candidate_id,
    candidate_revision_id
  ),
  foreign key (publication_id, candidate_id)
    references publications(publication_id, candidate_id),
  foreign key (
    candidate_revision_id,
    candidate_id,
    patch_id,
    catalog_revision_id
  ) references candidate_revisions (
    candidate_revision_id,
    candidate_id,
    patch_id,
    catalog_revision_id
  ),
  foreign key (
    candidate_eligibility_evaluation_id,
    candidate_id,
    candidate_revision_id,
    eligibility_policy_revision_id,
    eligibility_input_hash
  ) references candidate_eligibility_evaluations (
    candidate_eligibility_evaluation_id,
    candidate_id,
    candidate_revision_id,
    eligibility_policy_revision_id,
    input_hash
  ),
  foreign key (
    moderation_decision_id,
    candidate_id,
    candidate_revision_id,
    moderation_policy_revision_id,
    moderation_input_hash
  ) references moderation_decisions (
    moderation_decision_id,
    candidate_id,
    candidate_revision_id,
    moderation_policy_revision_id,
    input_hash
  )
);

create index publication_versions_candidate_revision_idx
  on publication_versions (candidate_revision_id, version_sequence);

create table publication_version_input_required_claims (
  publication_version_id uuid not null,
  publication_id uuid not null,
  candidate_id uuid not null,
  candidate_revision_id uuid not null,
  claim_id uuid not null,
  importance text not null default 'required'
    check (importance = 'required'),
  claim_evidence_decision_id uuid not null,
  evidence_decision text not null
    check (
      evidence_decision in (
        'supported',
        'insufficient',
        'contradicted'
      )
    ),
  evidence_policy_revision_id uuid not null
    references evidence_policy_revisions(
      evidence_policy_revision_id
    ),
  ordinal integer not null check (ordinal > 0),
  created_at timestamptz not null default clock_timestamp(),
  primary key (publication_version_id, claim_id),
  unique (publication_version_id, ordinal),
  foreign key (
    publication_version_id,
    publication_id,
    candidate_id,
    candidate_revision_id
  ) references publication_versions (
    publication_version_id,
    publication_id,
    candidate_id,
    candidate_revision_id
  ),
  foreign key (
    claim_id,
    candidate_revision_id,
    importance
  ) references candidate_claims (
    claim_id,
    candidate_revision_id,
    importance
  ),
  foreign key (claim_evidence_decision_id)
    references claim_evidence_decisions(
      claim_evidence_decision_id
    )
);

create table publication_activation_history (
  activation_id uuid primary key,
  activation_sequence bigint generated always as identity unique,
  publication_id uuid not null
    references publications(publication_id),
  activation_kind text not null
    check (activation_kind in ('published', 'rolled_back')),
  from_publication_version_id uuid,
  to_publication_version_id uuid not null,
  actor_id text not null
    check (octet_length(actor_id) between 1 and 256),
  audit_event_id uuid not null unique
    references audit_events(audit_event_id),
  outbox_event_id uuid not null unique
    references outbox_events(outbox_event_id),
  correlation_id text not null
    check (octet_length(correlation_id) between 1 and 256),
  activated_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp(),
  unique (activation_id, publication_id, to_publication_version_id),
  foreign key (from_publication_version_id, publication_id)
    references publication_versions(
      publication_version_id,
      publication_id
    ),
  foreign key (to_publication_version_id, publication_id)
    references publication_versions(
      publication_version_id,
      publication_id
    ),
  check (
    from_publication_version_id is null
    or from_publication_version_id <> to_publication_version_id
  )
);

create index publication_activation_history_publication_idx
  on publication_activation_history (
    publication_id,
    activation_sequence
  );

create table active_publication_versions (
  publication_id uuid primary key
    references publications(publication_id),
  publication_version_id uuid not null unique,
  activation_id uuid not null unique,
  activation_sequence bigint not null unique,
  updated_at timestamptz not null default clock_timestamp(),
  foreign key (publication_version_id, publication_id)
    references publication_versions(
      publication_version_id,
      publication_id
    ),
  foreign key (
    activation_id,
    publication_id,
    publication_version_id
  ) references publication_activation_history (
    activation_id,
    publication_id,
    to_publication_version_id
  )
);

create table publication_projection_effects (
  outbox_event_id uuid primary key
    references outbox_events(outbox_event_id),
  publication_id uuid not null
    references publications(publication_id),
  publication_version_id uuid not null,
  event_type text not null
    check (
      event_type in (
        'PublicationPublished',
        'PublicationRolledBack'
      )
    ),
  projected_state text not null
    check (projected_state in ('active', 'rolled_back')),
  projected_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp(),
  foreign key (publication_version_id, publication_id)
    references publication_versions(
      publication_version_id,
      publication_id
    )
);

create trigger publications_immutable
before update or delete on publications
for each row execute function reject_immutable_change();

create trigger publication_versions_immutable
before update or delete on publication_versions
for each row execute function reject_immutable_change();

create trigger publication_version_input_required_claims_immutable
before update or delete on publication_version_input_required_claims
for each row execute function reject_immutable_change();

create trigger publication_activation_history_immutable
before update or delete on publication_activation_history
for each row execute function reject_immutable_change();


create or replace function enforce_publication_version_seal()
returns trigger
language plpgsql
as $$
declare
  version_id uuid;
  version_row publication_versions%rowtype;
  patch_key_value text;
  mode_value text;
  champion_external_id_value text;
  revision_signature text;
  revision_payload jsonb;
  expected_payload jsonb;
  augment_tokens text[];
  item_tokens text[];
  expected_payload_hash text;
  version_ordinal integer;
  trust_matches boolean;
begin
  version_id := new.publication_version_id;
  select *
    into version_row
    from publication_versions
   where publication_version_id = version_id;
  if not found then
    raise exception 'publication version missing'
      using errcode = '23514';
  end if;

  select patch.patch_key,
         candidate.game_mode_external_id,
         entity.canonical_external_id,
         revision.normalized_signature,
         revision.canonical_payload
    into patch_key_value,
         mode_value,
         champion_external_id_value,
         revision_signature,
         revision_payload
    from candidate_revisions revision
    join candidates candidate
      on candidate.candidate_id = revision.candidate_id
    join patches patch
      on patch.patch_id = candidate.patch_id
    join game_entities entity
      on entity.game_entity_id = candidate.subject_game_entity_id
   where revision.candidate_revision_id =
         version_row.candidate_revision_id
     and revision.candidate_id = version_row.candidate_id
     and candidate.patch_id = version_row.patch_id
     and revision.catalog_revision_id =
         version_row.catalog_revision_id;

  expected_payload := jsonb_build_object(
    'schemaVersion', 1,
    'mode', mode_value,
    'patchKey', patch_key_value,
    'catalogRevisionId', version_row.catalog_revision_id::text,
    'championExternalId', champion_external_id_value,
    'augmentExternalIds', revision_payload -> 'augmentExternalIds',
    'itemExternalIds', revision_payload -> 'itemExternalIds'
  );

  select coalesce(
           array_agg(value order by ordinality),
           array[]::text[]
         )
    into augment_tokens
    from jsonb_array_elements_text(
           revision_payload -> 'augmentExternalIds'
         ) with ordinality as entry(value, ordinality);
  select coalesce(
           array_agg(value order by ordinality),
           array[]::text[]
         )
    into item_tokens
    from jsonb_array_elements_text(
           revision_payload -> 'itemExternalIds'
         ) with ordinality as entry(value, ordinality);

  expected_payload_hash := sha256_text_tuple_v1(
    array[
      'PublicationTupleV1',
      'PublicationPayloadV1',
      version_row.candidate_id::text,
      version_row.candidate_revision_id::text,
      patch_key_value,
      version_row.catalog_revision_id::text,
      mode_value,
      champion_external_id_value,
      cardinality(augment_tokens)::text
    ]
    || augment_tokens
    || array[cardinality(item_tokens)::text]
    || item_tokens
  );

  if revision_signature is null
     or version_row.candidate_normalized_signature <>
        revision_signature
     or version_row.publication_payload <> expected_payload
     or version_row.payload_hash <> expected_payload_hash then
    raise exception 'publication version seal mismatch'
      using errcode = '23514';
  end if;

  select count(*)::integer
    into version_ordinal
    from publication_versions other_version
   where other_version.publication_id =
         version_row.publication_id
     and other_version.version_sequence <=
         version_row.version_sequence;
  if version_row.version_number <> version_ordinal then
    raise exception 'publication version sequence mismatch'
      using errcode = '23514';
  end if;

  select exists (
    select 1
      from active_eligibility_policy_revision active_policy
      join current_candidate_eligibility_evaluations current_evaluation
        on current_evaluation.candidate_revision_id =
           version_row.candidate_revision_id
       and current_evaluation.eligibility_policy_revision_id =
           active_policy.eligibility_policy_revision_id
      join candidate_eligibility_evaluations evaluation
        on evaluation.candidate_eligibility_evaluation_id =
           current_evaluation.candidate_eligibility_evaluation_id
      join current_candidate_moderation_decisions current_moderation
        on current_moderation.candidate_revision_id =
           version_row.candidate_revision_id
       and current_moderation.moderation_policy_revision_id =
           version_row.moderation_policy_revision_id
      join moderation_decisions moderation
        on moderation.moderation_decision_id =
           current_moderation.moderation_decision_id
     where active_policy.scope = 'candidate_revision'
       and active_policy.eligibility_policy_revision_id =
           version_row.eligibility_policy_revision_id
       and current_evaluation.candidate_id =
           version_row.candidate_id
       and current_evaluation.candidate_eligibility_evaluation_id =
           version_row.candidate_eligibility_evaluation_id
       and current_evaluation.input_hash =
           version_row.eligibility_input_hash
       and evaluation.outcome = 'eligible'
       and current_moderation.candidate_id =
           version_row.candidate_id
       and current_moderation.moderation_decision_id =
           version_row.moderation_decision_id
       and current_moderation.input_hash =
           version_row.moderation_input_hash
       and moderation.outcome = 'clear'
  ) into trust_matches;

  if trust_matches is distinct from true then
    raise exception 'publication input stale'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create or replace function enforce_publication_required_claim_graph()
returns trigger
language plpgsql
as $$
declare
  version_id uuid;
  version_row publication_versions%rowtype;
  expected_count integer;
  actual_count integer;
  graph_mismatch boolean;
begin
  version_id := new.publication_version_id;
  select *
    into version_row
    from publication_versions
   where publication_version_id = version_id;
  if not found then
    raise exception 'publication version missing'
      using errcode = '23514';
  end if;

  select count(*)::integer
    into expected_count
    from candidate_claims claim
   where claim.candidate_revision_id =
         version_row.candidate_revision_id
     and claim.importance = 'required';
  select count(*)::integer
    into actual_count
    from publication_version_input_required_claims member
   where member.publication_version_id = version_id;

  select exists (
    select 1
      from candidate_claims claim
     where claim.candidate_revision_id =
           version_row.candidate_revision_id
       and claim.importance = 'required'
       and not exists (
         select 1
           from publication_version_input_required_claims member
          where member.publication_version_id = version_id
            and member.claim_id = claim.claim_id
       )
  ) or exists (
    select 1
      from publication_version_input_required_claims member
      left join current_claim_evidence_decisions current_decision
        on current_decision.claim_id = member.claim_id
       and current_decision.candidate_id = member.candidate_id
       and current_decision.candidate_revision_id =
           member.candidate_revision_id
       and current_decision.evidence_policy_revision_id =
           member.evidence_policy_revision_id
       and current_decision.claim_evidence_decision_id =
           member.claim_evidence_decision_id
      left join claim_evidence_decisions decision
        on decision.claim_evidence_decision_id =
           member.claim_evidence_decision_id
       and decision.decision = member.evidence_decision
      left join candidate_eligibility_evaluations evaluation
        on evaluation.candidate_eligibility_evaluation_id =
           version_row.candidate_eligibility_evaluation_id
      left join eligibility_input_snapshot_required_claims input_member
        on input_member.eligibility_input_snapshot_id =
           evaluation.eligibility_input_snapshot_id
       and input_member.claim_id = member.claim_id
       and input_member.claim_evidence_decision_id =
           member.claim_evidence_decision_id
       and input_member.evidence_decision =
           member.evidence_decision
       and input_member.evidence_policy_revision_id =
           member.evidence_policy_revision_id
       and input_member.decision_current
     where member.publication_version_id = version_id
       and (
         member.importance <> 'required'
         or member.evidence_decision <> 'supported'
         or current_decision.claim_id is null
         or decision.claim_evidence_decision_id is null
         or input_member.claim_id is null
       )
  ) into graph_mismatch;

  if expected_count = 0
     or actual_count <> expected_count
     or graph_mismatch then
    raise exception 'publication required Claim membership mismatch'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create or replace function enforce_publication_activation_transition()
returns trigger
language plpgsql
as $$
declare
  previous_activation publication_activation_history%rowtype;
  target_version_number integer;
begin
  select *
    into previous_activation
    from publication_activation_history history
   where history.publication_id = new.publication_id
     and history.activation_sequence < new.activation_sequence
   order by history.activation_sequence desc
   limit 1;

  select version_number
    into target_version_number
    from publication_versions
   where publication_version_id =
         new.to_publication_version_id
     and publication_id = new.publication_id;

  if previous_activation.activation_id is null then
    if new.activation_kind <> 'published'
       or new.from_publication_version_id is not null
       or target_version_number <> 1 then
      raise exception 'publication activation transition mismatch'
        using errcode = '23514';
    end if;
  elsif new.from_publication_version_id is distinct from
        previous_activation.to_publication_version_id
        or (
          new.activation_kind = 'rolled_back'
          and new.from_publication_version_id is null
        ) then
    raise exception 'publication activation transition mismatch'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create or replace function enforce_active_publication_pointer()
returns trigger
language plpgsql
as $$
declare
  activation publication_activation_history%rowtype;
  latest_sequence bigint;
begin
  select *
    into activation
    from publication_activation_history
   where activation_id = new.activation_id
     and publication_id = new.publication_id;
  select max(activation_sequence)
    into latest_sequence
    from publication_activation_history
   where publication_id = new.publication_id;

  if activation.activation_id is null
     or activation.to_publication_version_id <>
        new.publication_version_id
     or activation.activation_sequence <>
        new.activation_sequence
     or new.activation_sequence <> latest_sequence then
    raise exception 'active publication pointer mismatch'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create constraint trigger publication_version_seal_from_header
after insert on publication_versions
deferrable initially deferred
for each row execute function enforce_publication_version_seal();

create constraint trigger publication_version_seal_from_member
after insert on publication_version_input_required_claims
deferrable initially deferred
for each row execute function enforce_publication_version_seal();

create constraint trigger publication_required_claim_graph_from_header
after insert on publication_versions
deferrable initially deferred
for each row execute function enforce_publication_required_claim_graph();

create constraint trigger publication_required_claim_graph_from_member
after insert on publication_version_input_required_claims
deferrable initially deferred
for each row execute function enforce_publication_required_claim_graph();

create constraint trigger publication_activation_transition_guard
after insert on publication_activation_history
deferrable initially deferred
for each row execute function enforce_publication_activation_transition();

create constraint trigger active_publication_pointer_guard
after insert or update on active_publication_versions
deferrable initially deferred
for each row execute function enforce_active_publication_pointer();
