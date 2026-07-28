create table moderation_policy_revisions (
  moderation_policy_revision_id uuid primary key,
  policy_key text not null collate "C"
    check (
      octet_length(policy_key) between 1 and 128
      and policy_key ~ '^[!-~]+$'
    ),
  revision integer not null check (revision > 0),
  schema_version integer not null check (schema_version = 1),
  reason text not null
    check (octet_length(reason) between 1 and 1024),
  created_by text not null
    check (octet_length(created_by) between 1 and 256),
  created_at timestamptz not null default clock_timestamp(),
  unique (policy_key, revision),
  unique (moderation_policy_revision_id, policy_key)
);

create table eligibility_policy_revisions (
  eligibility_policy_revision_id uuid primary key,
  policy_key text not null collate "C"
    check (
      octet_length(policy_key) between 1 and 128
      and policy_key ~ '^[!-~]+$'
    ),
  revision integer not null check (revision > 0),
  schema_version integer not null check (schema_version = 1),
  evidence_policy_revision_id uuid not null
    references evidence_policy_revisions(evidence_policy_revision_id),
  review_policy_revision_id uuid not null
    references review_policy_revisions(review_policy_revision_id),
  moderation_policy_revision_id uuid not null
    references moderation_policy_revisions(
      moderation_policy_revision_id
    ),
  require_all_required_claims_supported boolean not null
    check (require_all_required_claims_supported),
  require_review_quorum_satisfied boolean not null
    check (require_review_quorum_satisfied),
  fail_closed_on_stale_input boolean not null
    check (fail_closed_on_stale_input),
  reason text not null
    check (octet_length(reason) between 1 and 1024),
  created_by text not null
    check (octet_length(created_by) between 1 and 256),
  created_at timestamptz not null default clock_timestamp(),
  unique (policy_key, revision),
  unique (
    eligibility_policy_revision_id,
    evidence_policy_revision_id,
    review_policy_revision_id,
    moderation_policy_revision_id
  )
);

create table active_eligibility_policy_revision (
  scope text primary key
    check (scope = 'candidate_revision'),
  eligibility_policy_revision_id uuid not null unique
    references eligibility_policy_revisions(
      eligibility_policy_revision_id
    ),
  updated_at timestamptz not null default clock_timestamp()
);

alter table candidate_provenance
  add constraint candidate_provenance_moderation_identity_unique
  unique (
    candidate_provenance_id,
    candidate_revision_id,
    origin
  );

create table moderation_input_snapshots (
  moderation_input_snapshot_id uuid primary key,
  candidate_id uuid not null,
  candidate_revision_id uuid not null,
  patch_id uuid not null,
  catalog_revision_id uuid not null,
  candidate_normalized_signature text not null
    check (candidate_normalized_signature ~ '^[a-f0-9]{64}$'),
  candidate_claim_set_seal_id uuid not null,
  claim_set_hash text not null
    check (claim_set_hash ~ '^[a-f0-9]{64}$'),
  claim_count integer not null check (claim_count > 0),
  provenance_count integer not null check (provenance_count > 0),
  provenance_set_hash text not null
    check (provenance_set_hash ~ '^[a-f0-9]{64}$'),
  moderation_policy_revision_id uuid not null
    references moderation_policy_revisions(
      moderation_policy_revision_id
    ),
  input_hash text not null
    check (input_hash ~ '^[a-f0-9]{64}$'),
  created_by text not null
    check (octet_length(created_by) between 1 and 256),
  created_at timestamptz not null default clock_timestamp(),
  unique (
    candidate_revision_id,
    moderation_policy_revision_id,
    input_hash
  ),
  unique (
    moderation_input_snapshot_id,
    candidate_id,
    candidate_revision_id,
    patch_id,
    catalog_revision_id,
    moderation_policy_revision_id,
    input_hash
  ),
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
    candidate_claim_set_seal_id,
    candidate_id,
    candidate_revision_id,
    patch_id,
    catalog_revision_id,
    claim_set_hash
  ) references candidate_claim_set_seals (
    candidate_claim_set_seal_id,
    candidate_id,
    candidate_revision_id,
    patch_id,
    catalog_revision_id,
    claim_set_hash
  )
);

create table moderation_input_snapshot_provenance (
  moderation_input_snapshot_id uuid not null
    references moderation_input_snapshots(
      moderation_input_snapshot_id
    ),
  candidate_provenance_id uuid not null,
  candidate_revision_id uuid not null,
  origin text not null
    check (
      origin in (
        'collector_detected',
        'community_submitted',
        'editorial',
        'ai_generated'
      )
    ),
  ordinal integer not null check (ordinal > 0),
  created_at timestamptz not null default clock_timestamp(),
  primary key (
    moderation_input_snapshot_id,
    candidate_provenance_id
  ),
  unique (moderation_input_snapshot_id, ordinal),
  foreign key (
    candidate_provenance_id,
    candidate_revision_id,
    origin
  ) references candidate_provenance (
    candidate_provenance_id,
    candidate_revision_id,
    origin
  )
);

create table moderation_decisions (
  moderation_decision_id uuid primary key,
  decision_sequence bigint generated always as identity unique,
  candidate_id uuid not null,
  candidate_revision_id uuid not null,
  patch_id uuid not null,
  catalog_revision_id uuid not null,
  moderation_input_snapshot_id uuid not null,
  input_hash text not null
    check (input_hash ~ '^[a-f0-9]{64}$'),
  moderation_policy_revision_id uuid not null,
  outcome text not null
    check (outcome in ('clear', 'needs_review', 'blocked')),
  evaluator_actor_id text not null
    check (octet_length(evaluator_actor_id) between 1 and 256),
  reason text not null
    check (octet_length(reason) between 1 and 1024),
  correlation_id text not null
    check (octet_length(correlation_id) between 1 and 256),
  evaluated_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp(),
  unique (
    moderation_decision_id,
    candidate_id,
    candidate_revision_id,
    moderation_policy_revision_id,
    input_hash
  ),
  foreign key (
    moderation_input_snapshot_id,
    candidate_id,
    candidate_revision_id,
    patch_id,
    catalog_revision_id,
    moderation_policy_revision_id,
    input_hash
  ) references moderation_input_snapshots (
    moderation_input_snapshot_id,
    candidate_id,
    candidate_revision_id,
    patch_id,
    catalog_revision_id,
    moderation_policy_revision_id,
    input_hash
  )
);

create table current_candidate_moderation_decisions (
  candidate_revision_id uuid not null,
  moderation_policy_revision_id uuid not null,
  candidate_id uuid not null,
  input_hash text not null
    check (input_hash ~ '^[a-f0-9]{64}$'),
  moderation_decision_id uuid not null unique,
  updated_at timestamptz not null default clock_timestamp(),
  primary key (
    candidate_revision_id,
    moderation_policy_revision_id
  ),
  foreign key (
    moderation_decision_id,
    candidate_id,
    candidate_revision_id,
    moderation_policy_revision_id,
    input_hash
  ) references moderation_decisions (
    moderation_decision_id,
    candidate_id,
    candidate_revision_id,
    moderation_policy_revision_id,
    input_hash
  )
);

create table eligibility_input_snapshots (
  eligibility_input_snapshot_id uuid primary key,
  candidate_id uuid not null,
  candidate_revision_id uuid not null,
  patch_id uuid not null,
  catalog_revision_id uuid not null,
  candidate_normalized_signature text not null
    check (candidate_normalized_signature ~ '^[a-f0-9]{64}$'),
  candidate_claim_set_seal_id uuid not null,
  claim_set_hash text not null
    check (claim_set_hash ~ '^[a-f0-9]{64}$'),
  eligibility_policy_revision_id uuid not null,
  evidence_policy_revision_id uuid not null,
  review_policy_revision_id uuid not null,
  moderation_policy_revision_id uuid not null,
  moderation_decision_id uuid,
  moderation_outcome text
    check (
      moderation_outcome is null
      or moderation_outcome in ('clear', 'needs_review', 'blocked')
    ),
  moderation_current boolean not null,
  review_quorum_evaluation_id uuid,
  review_quorum_satisfied boolean,
  review_current boolean not null,
  required_claim_count integer not null
    check (required_claim_count > 0),
  required_claim_set_hash text not null
    check (required_claim_set_hash ~ '^[a-f0-9]{64}$'),
  input_hash text not null
    check (input_hash ~ '^[a-f0-9]{64}$'),
  created_by text not null
    check (octet_length(created_by) between 1 and 256),
  created_at timestamptz not null default clock_timestamp(),
  check (
    (moderation_decision_id is null
      and moderation_outcome is null
      and not moderation_current)
    or
    (moderation_decision_id is not null
      and moderation_outcome is not null)
  ),
  check (
    (review_quorum_evaluation_id is null
      and review_quorum_satisfied is null
      and not review_current)
    or
    (review_quorum_evaluation_id is not null
      and review_quorum_satisfied is not null)
  ),
  unique (
    candidate_revision_id,
    eligibility_policy_revision_id,
    input_hash
  ),
  unique (
    eligibility_input_snapshot_id,
    candidate_id,
    candidate_revision_id,
    eligibility_policy_revision_id,
    input_hash
  ),
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
    candidate_claim_set_seal_id,
    candidate_id,
    candidate_revision_id,
    patch_id,
    catalog_revision_id,
    claim_set_hash
  ) references candidate_claim_set_seals (
    candidate_claim_set_seal_id,
    candidate_id,
    candidate_revision_id,
    patch_id,
    catalog_revision_id,
    claim_set_hash
  ),
  foreign key (
    eligibility_policy_revision_id,
    evidence_policy_revision_id,
    review_policy_revision_id,
    moderation_policy_revision_id
  ) references eligibility_policy_revisions (
    eligibility_policy_revision_id,
    evidence_policy_revision_id,
    review_policy_revision_id,
    moderation_policy_revision_id
  ),
  foreign key (moderation_decision_id)
    references moderation_decisions(moderation_decision_id),
  foreign key (review_quorum_evaluation_id)
    references review_quorum_evaluations(review_quorum_evaluation_id)
);

create table eligibility_input_snapshot_required_claims (
  eligibility_input_snapshot_id uuid not null
    references eligibility_input_snapshots(
      eligibility_input_snapshot_id
    ),
  claim_id uuid not null,
  candidate_revision_id uuid not null,
  claim_key text not null collate "C",
  importance text not null default 'required'
    check (importance = 'required'),
  claim_evidence_decision_id uuid,
  evidence_decision text
    check (
      evidence_decision is null
      or evidence_decision in (
        'supported',
        'insufficient',
        'contradicted'
      )
    ),
  evidence_policy_revision_id uuid,
  decision_current boolean not null,
  ordinal integer not null check (ordinal > 0),
  created_at timestamptz not null default clock_timestamp(),
  primary key (eligibility_input_snapshot_id, claim_id),
  unique (eligibility_input_snapshot_id, ordinal),
  check (
    (
      claim_evidence_decision_id is null
      and evidence_decision is null
      and evidence_policy_revision_id is null
      and not decision_current
    )
    or
    (
      claim_evidence_decision_id is not null
      and evidence_decision is not null
      and evidence_policy_revision_id is not null
    )
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
    references claim_evidence_decisions(claim_evidence_decision_id)
);

create table candidate_eligibility_evaluations (
  candidate_eligibility_evaluation_id uuid primary key,
  evaluation_sequence bigint generated always as identity unique,
  candidate_id uuid not null,
  candidate_revision_id uuid not null,
  eligibility_input_snapshot_id uuid not null,
  input_hash text not null
    check (input_hash ~ '^[a-f0-9]{64}$'),
  eligibility_policy_revision_id uuid not null,
  outcome text not null
    check (outcome in ('eligible', 'needs_review', 'ineligible')),
  reason_count integer not null check (reason_count > 0),
  evaluator_actor_id text not null
    check (octet_length(evaluator_actor_id) between 1 and 256),
  correlation_id text not null
    check (octet_length(correlation_id) between 1 and 256),
  evaluated_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp(),
  unique (
    candidate_eligibility_evaluation_id,
    candidate_id,
    candidate_revision_id,
    eligibility_policy_revision_id,
    input_hash
  ),
  foreign key (
    eligibility_input_snapshot_id,
    candidate_id,
    candidate_revision_id,
    eligibility_policy_revision_id,
    input_hash
  ) references eligibility_input_snapshots (
    eligibility_input_snapshot_id,
    candidate_id,
    candidate_revision_id,
    eligibility_policy_revision_id,
    input_hash
  )
);

create table candidate_eligibility_evaluation_reasons (
  candidate_eligibility_evaluation_id uuid not null
    references candidate_eligibility_evaluations(
      candidate_eligibility_evaluation_id
    ),
  reason_code text not null
    check (
      reason_code in (
        'moderation_blocked',
        'required_claim_contradicted',
        'moderation_missing',
        'moderation_stale',
        'moderation_needs_review',
        'required_claim_decision_missing',
        'required_claim_decision_stale',
        'required_claim_policy_mismatch',
        'required_claim_insufficient',
        'review_quorum_missing',
        'review_quorum_stale',
        'review_policy_mismatch',
        'review_quorum_unsatisfied',
        'all_requirements_satisfied'
      )
    ),
  ordinal integer not null check (ordinal > 0),
  created_at timestamptz not null default clock_timestamp(),
  primary key (candidate_eligibility_evaluation_id, reason_code),
  unique (candidate_eligibility_evaluation_id, ordinal)
);

create table current_candidate_eligibility_evaluations (
  candidate_revision_id uuid not null,
  eligibility_policy_revision_id uuid not null,
  candidate_id uuid not null,
  input_hash text not null
    check (input_hash ~ '^[a-f0-9]{64}$'),
  candidate_eligibility_evaluation_id uuid not null unique,
  updated_at timestamptz not null default clock_timestamp(),
  primary key (
    candidate_revision_id,
    eligibility_policy_revision_id
  ),
  foreign key (
    candidate_eligibility_evaluation_id,
    candidate_id,
    candidate_revision_id,
    eligibility_policy_revision_id,
    input_hash
  ) references candidate_eligibility_evaluations (
    candidate_eligibility_evaluation_id,
    candidate_id,
    candidate_revision_id,
    eligibility_policy_revision_id,
    input_hash
  )
);

create table eligibility_recalculation_effects (
  outbox_event_id uuid primary key
    references outbox_events(outbox_event_id),
  candidate_revision_id uuid not null
    references candidate_revisions(candidate_revision_id),
  effect_state text not null
    check (effect_state in ('reserved', 'evaluated', 'not_evaluable_yet')),
  eligibility_input_snapshot_id uuid not null,
  candidate_eligibility_evaluation_id uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);

create or replace function enforce_moderation_input_snapshot_seal()
returns trigger
language plpgsql
as $$
declare
  snapshot_id uuid;
  snapshot moderation_input_snapshots%rowtype;
  revision candidate_revisions%rowtype;
  seal candidate_claim_set_seals%rowtype;
  actual_provenance_count integer;
  member_count integer;
  provenance_tokens text[];
  expected_provenance_hash text;
  expected_input_hash text;
begin
  snapshot_id := case
    when tg_table_name = 'moderation_input_snapshots'
      then new.moderation_input_snapshot_id
    else new.moderation_input_snapshot_id
  end;

  select *
    into snapshot
    from moderation_input_snapshots
   where moderation_input_snapshot_id = snapshot_id;
  if not found then
    raise exception 'moderation input snapshot missing'
      using errcode = '23514';
  end if;

  select *
    into revision
    from candidate_revisions
   where candidate_revision_id = snapshot.candidate_revision_id;
  select *
    into seal
    from candidate_claim_set_seals
   where candidate_claim_set_seal_id =
         snapshot.candidate_claim_set_seal_id;
  if not found
     or revision.candidate_id <> snapshot.candidate_id
     or revision.patch_id <> snapshot.patch_id
     or revision.catalog_revision_id <> snapshot.catalog_revision_id
     or revision.normalized_signature <>
        snapshot.candidate_normalized_signature
     or seal.candidate_id <> snapshot.candidate_id
     or seal.candidate_revision_id <> snapshot.candidate_revision_id
     or seal.patch_id <> snapshot.patch_id
     or seal.catalog_revision_id <> snapshot.catalog_revision_id
     or seal.claim_set_hash <> snapshot.claim_set_hash
     or seal.claim_count <> snapshot.claim_count then
    raise exception 'moderation input snapshot authority mismatch'
      using errcode = '23514';
  end if;

  select count(*)::integer
    into actual_provenance_count
    from candidate_provenance
   where candidate_revision_id = snapshot.candidate_revision_id;
  select count(*)::integer
    into member_count
    from moderation_input_snapshot_provenance
   where moderation_input_snapshot_id = snapshot_id;

  if actual_provenance_count = 0
     or member_count <> actual_provenance_count
     or snapshot.provenance_count <> actual_provenance_count then
    raise exception 'moderation input snapshot provenance is not current'
      using errcode = '23514';
  end if;

  select array_agg(
           entry.token
           order by entry.candidate_provenance_id, entry.part
         )
    into provenance_tokens
    from (
      select member.candidate_provenance_id,
             part.part,
             part.token
        from moderation_input_snapshot_provenance member
        cross join lateral (
          values
            (1, member.candidate_provenance_id::text),
            (2, member.origin)
        ) as part(part, token)
       where member.moderation_input_snapshot_id = snapshot_id
    ) as entry;

  expected_provenance_hash := sha256_text_tuple_v1(
    array[
      'TrustTupleV1',
      'ModerationProvenanceSetV1',
      snapshot.candidate_revision_id::text,
      actual_provenance_count::text
    ] || coalesce(provenance_tokens, array[]::text[])
  );
  expected_input_hash := sha256_text_tuple_v1(
    array[
      'TrustTupleV1',
      'ModerationInputSnapshotV1',
      snapshot.candidate_id::text,
      snapshot.candidate_revision_id::text,
      snapshot.patch_id::text,
      snapshot.catalog_revision_id::text,
      snapshot.candidate_normalized_signature,
      snapshot.candidate_claim_set_seal_id::text,
      snapshot.claim_set_hash,
      snapshot.claim_count::text,
      snapshot.moderation_policy_revision_id::text,
      actual_provenance_count::text
    ] || coalesce(provenance_tokens, array[]::text[])
  );

  if snapshot.provenance_set_hash <> expected_provenance_hash
     or snapshot.input_hash <> expected_input_hash then
    raise exception 'moderation input snapshot seal mismatch'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create or replace function enforce_moderation_decision_graph()
returns trigger
language plpgsql
as $$
declare
  snapshot moderation_input_snapshots%rowtype;
begin
  select *
    into snapshot
    from moderation_input_snapshots
   where moderation_input_snapshot_id =
         new.moderation_input_snapshot_id;
  if not found
     or snapshot.candidate_id <> new.candidate_id
     or snapshot.candidate_revision_id <> new.candidate_revision_id
     or snapshot.patch_id <> new.patch_id
     or snapshot.catalog_revision_id <> new.catalog_revision_id
     or snapshot.moderation_policy_revision_id <>
        new.moderation_policy_revision_id
     or snapshot.input_hash <> new.input_hash then
    raise exception 'moderation decision graph mismatch'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create or replace function enforce_eligibility_input_snapshot_seal()
returns trigger
language plpgsql
as $
declare
  snapshot_id uuid;
  snapshot eligibility_input_snapshots%rowtype;
  actual_required_claim_count integer;
  member_count integer;
  required_claim_tokens text[];
  expected_required_claim_set_hash text;
  expected_input_hash text;
  moderation_input_hash text;
  review_input_hash text;
  actual_moderation_current boolean;
  actual_review_current boolean;
begin
  snapshot_id := new.eligibility_input_snapshot_id;
  select *
    into snapshot
    from eligibility_input_snapshots
   where eligibility_input_snapshot_id = snapshot_id;
  if not found then
    raise exception 'eligibility input snapshot missing'
      using errcode = '23514';
  end if;

  select count(*)::integer
    into actual_required_claim_count
    from candidate_claims
   where candidate_revision_id = snapshot.candidate_revision_id
     and importance = 'required';
  select count(*)::integer
    into member_count
    from eligibility_input_snapshot_required_claims
   where eligibility_input_snapshot_id = snapshot_id;

  if actual_required_claim_count = 0
     or member_count <> actual_required_claim_count
     or snapshot.required_claim_count <> actual_required_claim_count
     or exists (
       select 1
         from candidate_claims claim
         left join current_claim_evidence_decisions current_decision
           on current_decision.claim_id = claim.claim_id
        where claim.candidate_revision_id =
              snapshot.candidate_revision_id
          and claim.importance = 'required'
          and not exists (
            select 1
              from eligibility_input_snapshot_required_claims member
              left join claim_evidence_decisions decision
                on decision.claim_evidence_decision_id =
                   member.claim_evidence_decision_id
             where member.eligibility_input_snapshot_id = snapshot_id
               and member.claim_id = claim.claim_id
               and member.candidate_revision_id =
                   snapshot.candidate_revision_id
               and member.claim_key = claim.claim_key
               and member.importance = claim.importance
               and member.claim_evidence_decision_id is not distinct from
                   current_decision.claim_evidence_decision_id
               and member.evidence_decision is not distinct from
                   decision.decision
               and member.evidence_policy_revision_id is not distinct from
                   decision.evidence_policy_revision_id
               and member.decision_current =
                   (current_decision.claim_evidence_decision_id is not null)
          )
     )
     or exists (
       select 1
         from eligibility_input_snapshot_required_claims member
        where member.eligibility_input_snapshot_id = snapshot_id
          and not exists (
            select 1
              from candidate_claims claim
              left join current_claim_evidence_decisions current_decision
                on current_decision.claim_id = claim.claim_id
              left join claim_evidence_decisions decision
                on decision.claim_evidence_decision_id =
                   current_decision.claim_evidence_decision_id
             where claim.candidate_revision_id =
                   snapshot.candidate_revision_id
               and claim.importance = 'required'
               and claim.claim_id = member.claim_id
               and claim.claim_key = member.claim_key
               and member.claim_evidence_decision_id is not distinct from
                   current_decision.claim_evidence_decision_id
               and member.evidence_decision is not distinct from
                   decision.decision
               and member.evidence_policy_revision_id is not distinct from
                   decision.evidence_policy_revision_id
          )
     ) then
    raise exception
      'eligibility input snapshot required Claim membership mismatch'
      using errcode = '23514';
  end if;

  select array_agg(
           entry.token
           order by entry.claim_key collate "C", entry.part
         )
    into required_claim_tokens
    from (
      select member.claim_key,
             part.part,
             part.token
        from eligibility_input_snapshot_required_claims member
        cross join lateral (
          values
            (1, member.claim_id::text),
            (2, member.claim_key),
            (3, coalesce(
                  member.claim_evidence_decision_id::text,
                  '@null'
                )),
            (4, coalesce(member.evidence_decision, '@null')),
            (5, coalesce(
                  member.evidence_policy_revision_id::text,
                  '@null'
                )),
            (6, member.decision_current::text)
        ) as part(part, token)
       where member.eligibility_input_snapshot_id = snapshot_id
    ) as entry;

  expected_required_claim_set_hash := sha256_text_tuple_v1(
    array[
      'TrustTupleV1',
      'EligibilityRequiredClaimSetV1',
      snapshot.candidate_revision_id::text,
      actual_required_claim_count::text
    ] || coalesce(required_claim_tokens, array[]::text[])
  );

  if snapshot.moderation_decision_id is null then
    moderation_input_hash := null;
    actual_moderation_current := false;
  else
    select decision.input_hash
      into moderation_input_hash
      from moderation_decisions decision
     where decision.moderation_decision_id =
           snapshot.moderation_decision_id
       and decision.candidate_id = snapshot.candidate_id
       and decision.candidate_revision_id =
           snapshot.candidate_revision_id
       and decision.moderation_policy_revision_id =
           snapshot.moderation_policy_revision_id
       and decision.outcome = snapshot.moderation_outcome;
    if not found then
      raise exception 'eligibility input snapshot Moderation mismatch'
        using errcode = '23514';
    end if;
    select exists (
      select 1
        from current_candidate_moderation_decisions current_decision
        join moderation_decisions decision
          on decision.moderation_decision_id =
             current_decision.moderation_decision_id
       where current_decision.candidate_revision_id =
             snapshot.candidate_revision_id
         and current_decision.moderation_policy_revision_id =
             snapshot.moderation_policy_revision_id
         and current_decision.moderation_decision_id =
             snapshot.moderation_decision_id
         and not exists (
           select 1
             from candidate_provenance live
            where live.candidate_revision_id =
                  snapshot.candidate_revision_id
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
                 where live.candidate_revision_id =
                       snapshot.candidate_revision_id
                   and live.candidate_provenance_id =
                       member.candidate_provenance_id
                   and live.origin = member.origin
              )
         )
    ) into actual_moderation_current;
  end if;

  if snapshot.review_quorum_evaluation_id is null then
    review_input_hash := null;
    actual_review_current := false;
  else
    select evaluation.input_hash
      into review_input_hash
      from review_quorum_evaluations evaluation
     where evaluation.review_quorum_evaluation_id =
           snapshot.review_quorum_evaluation_id
       and evaluation.candidate_id = snapshot.candidate_id
       and evaluation.candidate_revision_id =
           snapshot.candidate_revision_id
       and evaluation.review_policy_revision_id =
           snapshot.review_policy_revision_id
       and evaluation.quorum_satisfied =
           snapshot.review_quorum_satisfied;
    if not found then
      raise exception 'eligibility input snapshot Review mismatch'
        using errcode = '23514';
    end if;
    select exists (
      select 1
        from current_review_quorum_evaluations current_review
       where current_review.candidate_revision_id =
             snapshot.candidate_revision_id
         and current_review.review_policy_revision_id =
             snapshot.review_policy_revision_id
         and current_review.review_quorum_evaluation_id =
             snapshot.review_quorum_evaluation_id
    ) into actual_review_current;
  end if;

  expected_input_hash := sha256_text_tuple_v1(
    array[
      'TrustTupleV1',
      'EligibilityInputSnapshotV1',
      snapshot.candidate_id::text,
      snapshot.candidate_revision_id::text,
      snapshot.patch_id::text,
      snapshot.catalog_revision_id::text,
      snapshot.candidate_normalized_signature,
      snapshot.candidate_claim_set_seal_id::text,
      snapshot.claim_set_hash,
      snapshot.eligibility_policy_revision_id::text,
      snapshot.evidence_policy_revision_id::text,
      snapshot.review_policy_revision_id::text,
      snapshot.moderation_policy_revision_id::text,
      coalesce(snapshot.moderation_decision_id::text, '@null'),
      coalesce(moderation_input_hash, '@null'),
      coalesce(snapshot.moderation_outcome, '@null'),
      actual_moderation_current::text,
      coalesce(snapshot.review_quorum_evaluation_id::text, '@null'),
      coalesce(review_input_hash, '@null'),
      coalesce(snapshot.review_quorum_satisfied::text, 'false'),
      actual_review_current::text,
      actual_required_claim_count::text
    ] || coalesce(required_claim_tokens, array[]::text[])
  );

  if snapshot.required_claim_set_hash <>
       expected_required_claim_set_hash
     or snapshot.input_hash <> expected_input_hash
     or snapshot.moderation_current <> actual_moderation_current
     or snapshot.review_current <> actual_review_current then
    raise exception 'eligibility input snapshot seal mismatch'
      using errcode = '23514';
  end if;
  return new;
end;
$;

create or replace function enforce_eligibility_evaluation_result()
returns trigger
language plpgsql
as $
declare
  evaluation_id uuid;
  evaluation candidate_eligibility_evaluations%rowtype;
  snapshot eligibility_input_snapshots%rowtype;
  expected_outcome text;
  expected_reasons text[];
  actual_reasons text[];
begin
  evaluation_id := new.candidate_eligibility_evaluation_id;
  select *
    into evaluation
    from candidate_eligibility_evaluations
   where candidate_eligibility_evaluation_id = evaluation_id;
  if not found then
    raise exception 'eligibility evaluation missing'
      using errcode = '23514';
  end if;
  select *
    into snapshot
    from eligibility_input_snapshots
   where eligibility_input_snapshot_id =
         evaluation.eligibility_input_snapshot_id;

  if snapshot.moderation_current
     and snapshot.moderation_outcome = 'blocked' then
    expected_outcome := 'ineligible';
    expected_reasons := array['moderation_blocked'];
  elsif exists (
    select 1
      from eligibility_input_snapshot_required_claims member
     where member.eligibility_input_snapshot_id =
           snapshot.eligibility_input_snapshot_id
       and member.decision_current
       and member.evidence_policy_revision_id =
           snapshot.evidence_policy_revision_id
       and member.evidence_decision = 'contradicted'
  ) then
    expected_outcome := 'ineligible';
    expected_reasons := array['required_claim_contradicted'];
  else
    select array_agg(reason order by reason)
      into expected_reasons
      from (
        select 'moderation_missing'::text as reason
         where snapshot.moderation_outcome is null
        union
        select 'moderation_stale'
         where snapshot.moderation_outcome is not null
           and not snapshot.moderation_current
        union
        select 'moderation_needs_review'
         where snapshot.moderation_outcome = 'needs_review'
           and snapshot.moderation_current
        union
        select 'required_claim_decision_missing'
          from eligibility_input_snapshot_required_claims member
         where member.eligibility_input_snapshot_id =
               snapshot.eligibility_input_snapshot_id
           and member.evidence_decision is null
        union
        select 'required_claim_decision_stale'
          from eligibility_input_snapshot_required_claims member
         where member.eligibility_input_snapshot_id =
               snapshot.eligibility_input_snapshot_id
           and member.evidence_decision is not null
           and not member.decision_current
        union
        select 'required_claim_policy_mismatch'
          from eligibility_input_snapshot_required_claims member
         where member.eligibility_input_snapshot_id =
               snapshot.eligibility_input_snapshot_id
           and member.evidence_decision is not null
           and member.decision_current
           and member.evidence_policy_revision_id <>
               snapshot.evidence_policy_revision_id
        union
        select 'required_claim_insufficient'
          from eligibility_input_snapshot_required_claims member
         where member.eligibility_input_snapshot_id =
               snapshot.eligibility_input_snapshot_id
           and member.evidence_decision = 'insufficient'
           and member.decision_current
           and member.evidence_policy_revision_id =
               snapshot.evidence_policy_revision_id
        union
        select 'review_quorum_missing'
         where snapshot.review_quorum_evaluation_id is null
        union
        select 'review_quorum_stale'
         where snapshot.review_quorum_evaluation_id is not null
           and not snapshot.review_current
        union
        select 'review_quorum_unsatisfied'
         where snapshot.review_quorum_evaluation_id is not null
           and snapshot.review_current
           and not snapshot.review_quorum_satisfied
      ) reasons;
    if coalesce(cardinality(expected_reasons), 0) = 0 then
      expected_outcome := 'eligible';
      expected_reasons := array['all_requirements_satisfied'];
    else
      expected_outcome := 'needs_review';
    end if;
  end if;

  select array_agg(reason_code order by ordinal)
    into actual_reasons
    from candidate_eligibility_evaluation_reasons
   where candidate_eligibility_evaluation_id = evaluation_id;
  if evaluation.outcome <> expected_outcome
     or evaluation.reason_count <> cardinality(expected_reasons)
     or actual_reasons is distinct from expected_reasons then
    raise exception 'eligibility evaluation result mismatch'
      using errcode = '23514';
  end if;
  return new;
end;
$;

create or replace function enforce_current_candidate_moderation_graph()
returns trigger
language plpgsql
as $$
declare
  next_decision moderation_decisions%rowtype;
  previous_decision moderation_decisions%rowtype;
begin
  if tg_op = 'DELETE' then
    raise exception 'current moderation decision cannot be deleted'
      using errcode = '23514';
  end if;

  select *
    into next_decision
    from moderation_decisions
   where moderation_decision_id = new.moderation_decision_id;
  if not found
     or next_decision.candidate_id <> new.candidate_id
     or next_decision.candidate_revision_id <>
        new.candidate_revision_id
     or next_decision.moderation_policy_revision_id <>
        new.moderation_policy_revision_id
     or next_decision.input_hash <> new.input_hash then
    raise exception 'current moderation decision graph mismatch'
      using errcode = '23514';
  end if;

  if tg_op = 'UPDATE'
     and old.moderation_decision_id <>
         new.moderation_decision_id then
    select *
      into previous_decision
      from moderation_decisions
     where moderation_decision_id = old.moderation_decision_id;
    if next_decision.evaluated_at <
       previous_decision.evaluated_at
       or next_decision.decision_sequence <=
          previous_decision.decision_sequence then
      raise exception 'current moderation decision cannot move backward'
        using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

create or replace function enforce_current_candidate_eligibility_graph()
returns trigger
language plpgsql
as $$
declare
  next_evaluation candidate_eligibility_evaluations%rowtype;
  previous_evaluation candidate_eligibility_evaluations%rowtype;
begin
  if tg_op = 'DELETE' then
    raise exception 'current eligibility evaluation cannot be deleted'
      using errcode = '23514';
  end if;

  select *
    into next_evaluation
    from candidate_eligibility_evaluations
   where candidate_eligibility_evaluation_id =
         new.candidate_eligibility_evaluation_id;
  if not found
     or next_evaluation.candidate_id <> new.candidate_id
     or next_evaluation.candidate_revision_id <>
        new.candidate_revision_id
     or next_evaluation.eligibility_policy_revision_id <>
        new.eligibility_policy_revision_id
     or next_evaluation.input_hash <> new.input_hash then
    raise exception 'current eligibility evaluation graph mismatch'
      using errcode = '23514';
  end if;

  if tg_op = 'UPDATE'
     and old.candidate_eligibility_evaluation_id <>
         new.candidate_eligibility_evaluation_id then
    select *
      into previous_evaluation
      from candidate_eligibility_evaluations
     where candidate_eligibility_evaluation_id =
           old.candidate_eligibility_evaluation_id;
    if next_evaluation.evaluated_at <
       previous_evaluation.evaluated_at
       or next_evaluation.evaluation_sequence <=
          previous_evaluation.evaluation_sequence then
      raise exception 'current eligibility evaluation cannot move backward'
        using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

create constraint trigger moderation_input_snapshot_seal_from_header
after insert on moderation_input_snapshots
deferrable initially deferred
for each row execute function enforce_moderation_input_snapshot_seal();

create constraint trigger moderation_input_snapshot_seal_from_member
after insert on moderation_input_snapshot_provenance
deferrable initially deferred
for each row execute function enforce_moderation_input_snapshot_seal();

create trigger moderation_decision_graph_guard
before insert on moderation_decisions
for each row execute function enforce_moderation_decision_graph();

create constraint trigger eligibility_input_snapshot_seal_from_header
after insert on eligibility_input_snapshots
deferrable initially deferred
for each row execute function enforce_eligibility_input_snapshot_seal();

create constraint trigger eligibility_input_snapshot_seal_from_member
after insert on eligibility_input_snapshot_required_claims
deferrable initially deferred
for each row execute function enforce_eligibility_input_snapshot_seal();

create constraint trigger eligibility_evaluation_result_from_header
after insert on candidate_eligibility_evaluations
deferrable initially deferred
for each row execute function enforce_eligibility_evaluation_result();

create constraint trigger eligibility_evaluation_result_from_reason
after insert on candidate_eligibility_evaluation_reasons
deferrable initially deferred
for each row execute function enforce_eligibility_evaluation_result();
create trigger current_candidate_moderation_graph_guard
before insert or update or delete
on current_candidate_moderation_decisions
for each row execute function enforce_current_candidate_moderation_graph();

create trigger current_candidate_eligibility_graph_guard
before insert or update or delete
on current_candidate_eligibility_evaluations
for each row execute function enforce_current_candidate_eligibility_graph();

create trigger moderation_policy_revisions_immutable
before update or delete on moderation_policy_revisions
for each row execute function reject_immutable_change();

create trigger eligibility_policy_revisions_immutable
before update or delete on eligibility_policy_revisions
for each row execute function reject_immutable_change();

create trigger moderation_input_snapshots_immutable
before update or delete on moderation_input_snapshots
for each row execute function reject_immutable_change();

create trigger moderation_input_snapshot_provenance_immutable
before update or delete on moderation_input_snapshot_provenance
for each row execute function reject_immutable_change();

create trigger moderation_decisions_immutable
before update or delete on moderation_decisions
for each row execute function reject_immutable_change();

create trigger eligibility_input_snapshots_immutable
before update or delete on eligibility_input_snapshots
for each row execute function reject_immutable_change();

create trigger eligibility_input_snapshot_required_claims_immutable
before update or delete on eligibility_input_snapshot_required_claims
for each row execute function reject_immutable_change();

create trigger candidate_eligibility_evaluations_immutable
before update or delete on candidate_eligibility_evaluations
for each row execute function reject_immutable_change();

create trigger candidate_eligibility_evaluation_reasons_immutable
before update or delete on candidate_eligibility_evaluation_reasons
for each row execute function reject_immutable_change();
