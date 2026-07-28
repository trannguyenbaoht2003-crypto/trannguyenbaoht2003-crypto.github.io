alter table candidate_revisions
  add constraint candidate_revisions_trust_identity_unique
  unique (
    candidate_revision_id,
    candidate_id,
    patch_id,
    catalog_revision_id
  );

alter table candidate_provenance
  add constraint candidate_provenance_revision_identity_unique
  unique (candidate_provenance_id, candidate_revision_id);

alter table normalized_observations
  add constraint normalized_observations_evidence_identity_unique
  unique (normalized_observation_id, raw_observation_id, patch_id);

alter table raw_observations
  add constraint raw_observations_evidence_identity_unique
  unique (
    raw_observation_id,
    source_id,
    source_policy_revision_id,
    content_hash
  );

alter table source_policy_revisions
  add constraint source_policy_revisions_source_identity_unique
  unique (source_policy_revision_id, source_id);

create or replace function sha256_text_v1(value text)
returns text
language sql
immutable
strict
as $$
  select encode(digest(convert_to(value, 'UTF8'), 'sha256'), 'hex')
$$;

create or replace function sha256_text_tuple_v1(tokens text[])
returns text
language plpgsql
immutable
strict
as $$
declare
  encoded text;
begin
  if exists (
    select 1
      from unnest(tokens) as entry(token)
     where token is null
  ) then
    raise exception 'tuple token cannot be null'
      using errcode = '22004';
  end if;

  select coalesce(
           string_agg(
             octet_length(token)::text || ':' || token,
             '|' order by ordinality
           ),
           ''
         )
    into encoded
    from unnest(tokens) with ordinality as entry(token, ordinality);

  return encode(
    digest(convert_to(encoded, 'UTF8'), 'sha256'),
    'hex'
  );
end;
$$;

create table evidence_policy_revisions (
  evidence_policy_revision_id uuid primary key,
  policy_key text not null collate "C"
    check (
      octet_length(policy_key) between 1 and 128
      and policy_key ~ '^[!-~]+$'
    ),
  revision integer not null check (revision > 0),
  schema_version integer not null check (schema_version = 1),
  reason text not null
    check (octet_length(reason) between 1 and 1024),
  created_by text not null check (octet_length(created_by) between 1 and 256),
  created_at timestamptz not null default clock_timestamp(),
  unique (policy_key, revision),
  unique (evidence_policy_revision_id, policy_key)
);

create table review_policy_revisions (
  review_policy_revision_id uuid primary key,
  policy_key text not null collate "C"
    check (
      octet_length(policy_key) between 1 and 128
      and policy_key ~ '^[!-~]+$'
    ),
  revision integer not null check (revision > 0),
  minimum_confirmed_reviews integer not null
    check (minimum_confirmed_reviews between 1 and 16),
  require_distinct_reviewers boolean not null
    check (require_distinct_reviewers),
  required_permission text not null
    check (required_permission = 'reviewer'),
  applies_to_ai_provenance boolean not null,
  reason text not null
    check (octet_length(reason) between 1 and 1024),
  created_by text not null check (octet_length(created_by) between 1 and 256),
  created_at timestamptz not null default clock_timestamp(),
  unique (policy_key, revision),
  unique (review_policy_revision_id, policy_key)
);

create table candidate_claims (
  claim_id uuid primary key,
  candidate_id uuid not null,
  candidate_revision_id uuid not null,
  patch_id uuid not null,
  catalog_revision_id uuid not null,
  claim_key text not null collate "C"
    check (
      octet_length(claim_key) between 1 and 128
      and claim_key ~ '^[!-~]+$'
    ),
  claim_type text not null
    check (
      claim_type in (
        'meta_trend',
        'build_effectiveness',
        'compatibility',
        'patch_change',
        'playstyle_hypothesis',
        'translation_assertion',
        'ocr_extraction',
        'community_report'
      )
    ),
  importance text not null
    check (importance in ('required', 'supporting', 'informational')),
  statement text not null
    check (octet_length(statement) between 1 and 4096),
  statement_hash text not null
    check (statement_hash ~ '^[a-f0-9]{64}$'),
  created_by text not null check (octet_length(created_by) between 1 and 256),
  created_at timestamptz not null default clock_timestamp(),
  unique (candidate_revision_id, claim_key),
  unique (
    claim_id,
    candidate_id,
    candidate_revision_id,
    patch_id,
    catalog_revision_id
  ),
  unique (claim_id, candidate_revision_id, importance),
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
  )
);

create index candidate_claims_revision_key_idx
  on candidate_claims (candidate_revision_id, claim_key collate "C");

create table candidate_claim_set_seals (
  candidate_claim_set_seal_id uuid primary key default gen_random_uuid(),
  candidate_id uuid not null,
  candidate_revision_id uuid not null unique,
  patch_id uuid not null,
  catalog_revision_id uuid not null,
  claim_count integer not null check (claim_count > 0),
  claim_set_hash text not null
    check (claim_set_hash ~ '^[a-f0-9]{64}$'),
  created_by text not null check (octet_length(created_by) between 1 and 256),
  created_at timestamptz not null default clock_timestamp(),
  unique (
    candidate_claim_set_seal_id,
    candidate_id,
    candidate_revision_id,
    patch_id,
    catalog_revision_id,
    claim_set_hash
  ),
  unique (
    candidate_revision_id,
    candidate_id,
    patch_id,
    catalog_revision_id,
    claim_set_hash
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
  )
);

create table evidence_records (
  evidence_id uuid primary key,
  normalized_observation_id uuid not null unique,
  raw_observation_id uuid not null,
  source_id uuid not null,
  source_policy_revision_id uuid not null,
  evidence_patch_id uuid not null references patches(patch_id),
  content_hash text not null check (octet_length(content_hash) > 0),
  evidence_kind text not null
    check (evidence_kind = 'normalized_observation'),
  created_by text not null check (octet_length(created_by) between 1 and 256),
  created_at timestamptz not null default clock_timestamp(),
  unique (evidence_id, evidence_patch_id),
  foreign key (
    normalized_observation_id,
    raw_observation_id,
    evidence_patch_id
  ) references normalized_observations (
    normalized_observation_id,
    raw_observation_id,
    patch_id
  ),
  foreign key (
    raw_observation_id,
    source_id,
    source_policy_revision_id,
    content_hash
  ) references raw_observations (
    raw_observation_id,
    source_id,
    source_policy_revision_id,
    content_hash
  ),
  foreign key (source_policy_revision_id, source_id)
    references source_policy_revisions(
      source_policy_revision_id,
      source_id
    )
);

create table evidence_associations (
  evidence_association_id uuid primary key,
  claim_id uuid not null,
  evidence_id uuid not null,
  candidate_id uuid not null,
  candidate_revision_id uuid not null,
  decision_patch_id uuid not null,
  catalog_revision_id uuid not null,
  evidence_patch_id uuid not null,
  stance text not null
    check (stance in ('supports', 'contradicts', 'context_only')),
  cross_patch_revalidated boolean not null,
  revalidation_reason text,
  created_by text not null check (octet_length(created_by) between 1 and 256),
  created_at timestamptz not null default clock_timestamp(),
  unique (claim_id, evidence_id),
  unique (
    evidence_association_id,
    claim_id,
    candidate_id,
    candidate_revision_id,
    decision_patch_id,
    catalog_revision_id,
    evidence_id,
    stance
  ),
  check (
    revalidation_reason is null
    or octet_length(revalidation_reason) between 1 and 1024
  ),
  foreign key (
    claim_id,
    candidate_id,
    candidate_revision_id,
    decision_patch_id,
    catalog_revision_id
  ) references candidate_claims (
    claim_id,
    candidate_id,
    candidate_revision_id,
    patch_id,
    catalog_revision_id
  ),
  foreign key (evidence_id, evidence_patch_id)
    references evidence_records(evidence_id, evidence_patch_id)
);

create index evidence_associations_claim_idx
  on evidence_associations (
    claim_id,
    evidence_association_id
  );

create table evidence_input_snapshots (
  evidence_input_snapshot_id uuid primary key,
  claim_id uuid not null,
  candidate_id uuid not null,
  candidate_revision_id uuid not null,
  patch_id uuid not null,
  catalog_revision_id uuid not null,
  candidate_claim_set_seal_id uuid not null,
  claim_set_hash text not null
    check (claim_set_hash ~ '^[a-f0-9]{64}$'),
  claim_statement_hash text not null
    check (claim_statement_hash ~ '^[a-f0-9]{64}$'),
  evidence_policy_revision_id uuid not null
    references evidence_policy_revisions(evidence_policy_revision_id),
  association_count integer not null check (association_count >= 0),
  input_hash text not null check (input_hash ~ '^[a-f0-9]{64}$'),
  created_by text not null check (octet_length(created_by) between 1 and 256),
  evaluated_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp(),
  unique (
    claim_id,
    evidence_policy_revision_id,
    input_hash
  ),
  unique (
    evidence_input_snapshot_id,
    claim_id,
    candidate_id,
    candidate_revision_id,
    patch_id,
    catalog_revision_id,
    evidence_policy_revision_id
  ),
  foreign key (
    claim_id,
    candidate_id,
    candidate_revision_id,
    patch_id,
    catalog_revision_id
  ) references candidate_claims (
    claim_id,
    candidate_id,
    candidate_revision_id,
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

create table evidence_input_snapshot_associations (
  evidence_input_snapshot_id uuid not null
    references evidence_input_snapshots(evidence_input_snapshot_id),
  evidence_association_id uuid not null
    references evidence_associations(evidence_association_id),
  ordinal integer not null check (ordinal > 0),
  created_at timestamptz not null default clock_timestamp(),
  primary key (
    evidence_input_snapshot_id,
    evidence_association_id
  ),
  unique (evidence_input_snapshot_id, ordinal)
);

create table claim_evidence_decisions (
  claim_evidence_decision_id uuid primary key,
  claim_id uuid not null,
  evidence_input_snapshot_id uuid not null,
  candidate_id uuid not null,
  candidate_revision_id uuid not null,
  patch_id uuid not null,
  catalog_revision_id uuid not null,
  evidence_policy_revision_id uuid not null,
  decision text not null
    check (decision in ('supported', 'insufficient', 'contradicted')),
  evaluator_actor_id text not null
    check (octet_length(evaluator_actor_id) between 1 and 256),
  reason text not null check (octet_length(reason) between 1 and 1024),
  correlation_id text not null
    check (octet_length(correlation_id) between 1 and 256),
  evaluated_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp(),
  unique (
    claim_evidence_decision_id,
    claim_id,
    candidate_id,
    candidate_revision_id,
    patch_id,
    catalog_revision_id,
    evidence_policy_revision_id
  ),
  foreign key (
    evidence_input_snapshot_id,
    claim_id,
    candidate_id,
    candidate_revision_id,
    patch_id,
    catalog_revision_id,
    evidence_policy_revision_id
  ) references evidence_input_snapshots (
    evidence_input_snapshot_id,
    claim_id,
    candidate_id,
    candidate_revision_id,
    patch_id,
    catalog_revision_id,
    evidence_policy_revision_id
  )
);

create index claim_evidence_decisions_claim_time_idx
  on claim_evidence_decisions (claim_id, evaluated_at, created_at);

create table current_claim_evidence_decisions (
  claim_id uuid primary key,
  candidate_id uuid not null,
  candidate_revision_id uuid not null,
  patch_id uuid not null,
  catalog_revision_id uuid not null,
  evidence_policy_revision_id uuid not null,
  claim_evidence_decision_id uuid not null unique,
  updated_at timestamptz not null default clock_timestamp(),
  foreign key (
    claim_id,
    candidate_id,
    candidate_revision_id,
    patch_id,
    catalog_revision_id
  ) references candidate_claims (
    claim_id,
    candidate_id,
    candidate_revision_id,
    patch_id,
    catalog_revision_id
  ),
  foreign key (
    claim_evidence_decision_id,
    claim_id,
    candidate_id,
    candidate_revision_id,
    patch_id,
    catalog_revision_id,
    evidence_policy_revision_id
  ) references claim_evidence_decisions (
    claim_evidence_decision_id,
    claim_id,
    candidate_id,
    candidate_revision_id,
    patch_id,
    catalog_revision_id,
    evidence_policy_revision_id
  )
);

create table review_input_snapshots (
  review_input_snapshot_id uuid primary key,
  candidate_id uuid not null,
  candidate_revision_id uuid not null,
  patch_id uuid not null,
  catalog_revision_id uuid not null,
  candidate_normalized_signature text not null
    check (candidate_normalized_signature ~ '^[a-f0-9]{64}$'),
  candidate_claim_set_seal_id uuid not null,
  claim_set_hash text not null check (claim_set_hash ~ '^[a-f0-9]{64}$'),
  claim_count integer not null check (claim_count > 0),
  provenance_count integer not null check (provenance_count > 0),
  provenance_set_hash text not null
    check (provenance_set_hash ~ '^[a-f0-9]{64}$'),
  claim_decision_set_hash text not null
    check (claim_decision_set_hash ~ '^[a-f0-9]{64}$'),
  review_policy_revision_id uuid not null
    references review_policy_revisions(review_policy_revision_id),
  input_hash text not null check (input_hash ~ '^[a-f0-9]{64}$'),
  created_by text not null check (octet_length(created_by) between 1 and 256),
  created_at timestamptz not null default clock_timestamp(),
  unique (
    candidate_revision_id,
    review_policy_revision_id,
    input_hash
  ),
  unique (
    review_input_snapshot_id,
    candidate_id,
    candidate_revision_id,
    review_policy_revision_id,
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

create table review_input_snapshot_provenance (
  review_input_snapshot_id uuid not null
    references review_input_snapshots(review_input_snapshot_id),
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
    review_input_snapshot_id,
    candidate_provenance_id
  ),
  unique (review_input_snapshot_id, ordinal),
  foreign key (candidate_provenance_id, candidate_revision_id)
    references candidate_provenance(
      candidate_provenance_id,
      candidate_revision_id
    )
);

create table review_input_snapshot_claims (
  review_input_snapshot_id uuid not null
    references review_input_snapshots(review_input_snapshot_id),
  claim_id uuid not null,
  candidate_revision_id uuid not null,
  importance text not null
    check (importance in ('required', 'supporting', 'informational')),
  claim_evidence_decision_id uuid,
  ordinal integer not null check (ordinal > 0),
  created_at timestamptz not null default clock_timestamp(),
  primary key (review_input_snapshot_id, claim_id),
  unique (review_input_snapshot_id, ordinal),
  foreign key (claim_id, candidate_revision_id, importance)
    references candidate_claims(
      claim_id,
      candidate_revision_id,
      importance
    ),
  foreign key (claim_evidence_decision_id)
    references claim_evidence_decisions(claim_evidence_decision_id)
);

create table human_reviews (
  human_review_id uuid primary key,
  candidate_id uuid not null,
  candidate_revision_id uuid not null,
  review_input_snapshot_id uuid not null,
  input_hash text not null check (input_hash ~ '^[a-f0-9]{64}$'),
  review_policy_revision_id uuid not null,
  reviewer_actor_id text not null
    check (octet_length(reviewer_actor_id) between 1 and 256),
  status text not null check (status = 'completed'),
  outcome text not null
    check (outcome in ('confirmed', 'changes_requested', 'declined')),
  permission_used text not null check (permission_used = 'reviewer'),
  reason text not null check (octet_length(reason) between 1 and 1024),
  correlation_id text not null
    check (octet_length(correlation_id) between 1 and 256),
  completed_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp(),
  unique (
    reviewer_actor_id,
    candidate_revision_id,
    review_policy_revision_id,
    input_hash
  ),
  unique (
    human_review_id,
    candidate_id,
    candidate_revision_id,
    review_policy_revision_id,
    input_hash,
    reviewer_actor_id
  ),
  foreign key (
    review_input_snapshot_id,
    candidate_id,
    candidate_revision_id,
    review_policy_revision_id,
    input_hash
  ) references review_input_snapshots (
    review_input_snapshot_id,
    candidate_id,
    candidate_revision_id,
    review_policy_revision_id,
    input_hash
  )
);

create table review_quorum_evaluations (
  review_quorum_evaluation_id uuid primary key,
  candidate_id uuid not null,
  candidate_revision_id uuid not null,
  review_input_snapshot_id uuid not null,
  input_hash text not null check (input_hash ~ '^[a-f0-9]{64}$'),
  review_policy_revision_id uuid not null,
  required_confirmed_count integer not null
    check (required_confirmed_count between 1 and 16),
  counted_review_count integer not null check (counted_review_count >= 0),
  quorum_satisfied boolean not null,
  evaluated_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp(),
  unique (
    review_quorum_evaluation_id,
    candidate_id,
    candidate_revision_id,
    review_policy_revision_id,
    input_hash
  ),
  foreign key (
    review_input_snapshot_id,
    candidate_id,
    candidate_revision_id,
    review_policy_revision_id,
    input_hash
  ) references review_input_snapshots (
    review_input_snapshot_id,
    candidate_id,
    candidate_revision_id,
    review_policy_revision_id,
    input_hash
  )
);

create table review_quorum_evaluation_reviews (
  review_quorum_evaluation_id uuid not null
    references review_quorum_evaluations(review_quorum_evaluation_id),
  human_review_id uuid not null,
  candidate_id uuid not null,
  candidate_revision_id uuid not null,
  review_policy_revision_id uuid not null,
  input_hash text not null check (input_hash ~ '^[a-f0-9]{64}$'),
  reviewer_actor_id text not null,
  ordinal integer not null check (ordinal > 0),
  created_at timestamptz not null default clock_timestamp(),
  primary key (
    review_quorum_evaluation_id,
    human_review_id
  ),
  unique (review_quorum_evaluation_id, reviewer_actor_id),
  unique (review_quorum_evaluation_id, ordinal),
  foreign key (
    human_review_id,
    candidate_id,
    candidate_revision_id,
    review_policy_revision_id,
    input_hash,
    reviewer_actor_id
  ) references human_reviews (
    human_review_id,
    candidate_id,
    candidate_revision_id,
    review_policy_revision_id,
    input_hash,
    reviewer_actor_id
  )
);

create table current_review_quorum_evaluations (
  candidate_revision_id uuid not null,
  review_policy_revision_id uuid not null,
  candidate_id uuid not null,
  input_hash text not null check (input_hash ~ '^[a-f0-9]{64}$'),
  review_quorum_evaluation_id uuid not null unique,
  updated_at timestamptz not null default clock_timestamp(),
  primary key (
    candidate_revision_id,
    review_policy_revision_id
  ),
  foreign key (
    review_quorum_evaluation_id,
    candidate_id,
    candidate_revision_id,
    review_policy_revision_id,
    input_hash
  ) references review_quorum_evaluations (
    review_quorum_evaluation_id,
    candidate_id,
    candidate_revision_id,
    review_policy_revision_id,
    input_hash
  )
);

create or replace function enforce_candidate_claim_graph()
returns trigger
language plpgsql
as $$
begin
  if new.statement_hash <> sha256_text_v1(new.statement) then
    raise exception 'candidate claim statement hash mismatch'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create or replace function enforce_candidate_claim_set_seal()
returns trigger
language plpgsql
as $$
declare
  revision_id uuid;
  seal candidate_claim_set_seals%rowtype;
  actual_count integer;
  required_count integer;
  claim_tokens text[];
  expected_hash text;
begin
  revision_id := case
    when tg_table_name = 'candidate_claims'
      then new.candidate_revision_id
    else new.candidate_revision_id
  end;

  select *
    into seal
    from candidate_claim_set_seals
   where candidate_revision_id = revision_id;
  if not found then
    raise exception 'candidate claim set seal missing'
      using errcode = '23514';
  end if;

  select count(*)::integer,
         count(*) filter (where importance = 'required')::integer
    into actual_count, required_count
    from candidate_claims
   where candidate_revision_id = revision_id;

  if actual_count = 0 or required_count = 0 then
    raise exception 'candidate claim set requires a required claim'
      using errcode = '23514';
  end if;

  select array_agg(entry.token order by entry.claim_key collate "C", entry.part)
    into claim_tokens
    from (
      select cc.claim_key,
             part.part,
             part.token
        from candidate_claims cc
        cross join lateral (
          values
            (1, cc.claim_id::text),
            (2, cc.claim_key),
            (3, cc.claim_type),
            (4, cc.importance),
            (5, cc.statement_hash)
        ) as part(part, token)
       where cc.candidate_revision_id = revision_id
    ) as entry;

  expected_hash := sha256_text_tuple_v1(
    array[
      'TrustTupleV1',
      'CandidateClaimSetV1',
      seal.candidate_id::text,
      seal.candidate_revision_id::text,
      seal.patch_id::text,
      seal.catalog_revision_id::text,
      actual_count::text
    ] || claim_tokens
  );

  if seal.claim_count <> actual_count
     or seal.claim_set_hash <> expected_hash then
    raise exception 'candidate claim set seal mismatch'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create or replace function enforce_evidence_source_graph()
returns trigger
language plpgsql
as $$
declare
  graph_matches boolean;
begin
  select (
           no.raw_observation_id = new.raw_observation_id
           and no.patch_id = new.evidence_patch_id
           and ro.source_id = new.source_id
           and ro.source_policy_revision_id =
               new.source_policy_revision_id
           and ro.content_hash = new.content_hash
           and spr.source_id = new.source_id
         )
    into graph_matches
    from normalized_observations no
    join raw_observations ro
      on ro.raw_observation_id = no.raw_observation_id
    join source_policy_revisions spr
      on spr.source_policy_revision_id =
         ro.source_policy_revision_id
   where no.normalized_observation_id =
         new.normalized_observation_id;

  if graph_matches is distinct from true then
    raise exception 'evidence source graph mismatch'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create or replace function enforce_evidence_association_graph()
returns trigger
language plpgsql
as $$
declare
  claim_patch uuid;
  evidence_patch uuid;
begin
  select patch_id
    into claim_patch
    from candidate_claims
   where claim_id = new.claim_id;
  select evidence_patch_id
    into evidence_patch
    from evidence_records
   where evidence_id = new.evidence_id;

  if claim_patch is null or evidence_patch is null
     or claim_patch <> new.decision_patch_id
     or evidence_patch <> new.evidence_patch_id then
    raise exception 'evidence association graph mismatch'
      using errcode = '23514';
  end if;

  if claim_patch <> evidence_patch then
    if new.cross_patch_revalidated is distinct from true
       or new.revalidation_reason is null
       or octet_length(new.revalidation_reason) = 0 then
      raise exception 'cross-patch evidence requires explicit revalidation'
        using errcode = '23514';
    end if;
  elsif new.cross_patch_revalidated
        or new.revalidation_reason is not null then
    raise exception 'same-patch evidence cannot claim cross-patch revalidation'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create or replace function enforce_evidence_snapshot_association_graph()
returns trigger
language plpgsql
as $$
declare
  snapshot_claim uuid;
  association_claim uuid;
begin
  select claim_id
    into snapshot_claim
    from evidence_input_snapshots
   where evidence_input_snapshot_id =
         new.evidence_input_snapshot_id;
  select claim_id
    into association_claim
    from evidence_associations
   where evidence_association_id =
         new.evidence_association_id;

  if snapshot_claim is null
     or association_claim is null
     or snapshot_claim <> association_claim then
    raise exception 'evidence snapshot association graph mismatch'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create or replace function enforce_evidence_input_snapshot_seal()
returns trigger
language plpgsql
as $$
declare
  snapshot_id uuid;
  snapshot evidence_input_snapshots%rowtype;
  actual_count integer;
  association_tokens text[];
  expected_hash text;
  ordinal_mismatch boolean;
begin
  snapshot_id := case
    when tg_table_name = 'evidence_input_snapshots'
      then new.evidence_input_snapshot_id
    else new.evidence_input_snapshot_id
  end;

  select *
    into snapshot
    from evidence_input_snapshots
   where evidence_input_snapshot_id = snapshot_id;
  if not found then
    raise exception 'evidence input snapshot missing'
      using errcode = '23514';
  end if;

  select count(*)::integer
    into actual_count
    from evidence_input_snapshot_associations
   where evidence_input_snapshot_id = snapshot_id;

  select exists (
    select 1
      from (
        select ordinal,
               row_number() over (
                 order by evidence_association_id::text collate "C"
               )::integer as expected_ordinal
          from evidence_input_snapshot_associations
         where evidence_input_snapshot_id = snapshot_id
      ) ordered
     where ordinal <> expected_ordinal
  ) into ordinal_mismatch;

  if ordinal_mismatch then
    raise exception 'evidence snapshot association ordinal mismatch'
      using errcode = '23514';
  end if;

  select array_agg(
           entry.token
           order by entry.association_id::text collate "C", entry.part
         )
    into association_tokens
    from (
      select ea.evidence_association_id as association_id,
             part.part,
             part.token
        from evidence_input_snapshot_associations member
        join evidence_associations ea
          on ea.evidence_association_id =
             member.evidence_association_id
        cross join lateral (
          values
            (1, ea.evidence_association_id::text),
            (2, ea.evidence_id::text),
            (3, ea.stance)
        ) as part(part, token)
       where member.evidence_input_snapshot_id = snapshot_id
    ) as entry;

  expected_hash := sha256_text_tuple_v1(
    array[
      'TrustTupleV1',
      'EvidenceInputSnapshotV1',
      snapshot.candidate_revision_id::text,
      snapshot.patch_id::text,
      snapshot.catalog_revision_id::text,
      snapshot.claim_id::text,
      snapshot.claim_set_hash,
      snapshot.claim_statement_hash,
      snapshot.evidence_policy_revision_id::text,
      actual_count::text
    ] || coalesce(association_tokens, array[]::text[])
  );

  if snapshot.association_count <> actual_count
     or snapshot.input_hash <> expected_hash then
    raise exception 'evidence input snapshot seal mismatch'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create or replace function enforce_claim_evidence_decision_graph()
returns trigger
language plpgsql
as $$
declare
  graph_matches boolean;
  support_count integer;
  contradiction_count integer;
begin
  select (
           snapshot.claim_id = new.claim_id
           and snapshot.candidate_id = new.candidate_id
           and snapshot.candidate_revision_id =
               new.candidate_revision_id
           and snapshot.patch_id = new.patch_id
           and snapshot.catalog_revision_id =
               new.catalog_revision_id
           and snapshot.evidence_policy_revision_id =
               new.evidence_policy_revision_id
         )
    into graph_matches
    from evidence_input_snapshots snapshot
   where snapshot.evidence_input_snapshot_id =
         new.evidence_input_snapshot_id;
  if graph_matches is distinct from true then
    raise exception 'claim evidence decision graph mismatch'
      using errcode = '23514';
  end if;

  select count(*) filter (where ea.stance = 'supports')::integer,
         count(*) filter (where ea.stance = 'contradicts')::integer
    into support_count, contradiction_count
    from evidence_input_snapshot_associations member
    join evidence_associations ea
      on ea.evidence_association_id =
         member.evidence_association_id
   where member.evidence_input_snapshot_id =
         new.evidence_input_snapshot_id;

  if new.decision = 'supported' and support_count = 0 then
    raise exception 'supported decision requires supporting evidence'
      using errcode = '23514';
  end if;
  if new.decision = 'contradicted'
     and contradiction_count = 0 then
    raise exception 'contradicted decision requires contradicting evidence'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create or replace function enforce_current_claim_evidence_decision_graph()
returns trigger
language plpgsql
as $$
declare
  old_evaluated_at timestamptz;
  new_evaluated_at timestamptz;
begin
  if tg_op = 'DELETE' then
    raise exception 'current claim evidence decision pointer is immutable'
      using errcode = '55000';
  end if;

  if tg_op = 'UPDATE'
     and (
       new.claim_id <> old.claim_id
       or new.candidate_id <> old.candidate_id
       or new.candidate_revision_id <> old.candidate_revision_id
       or new.patch_id <> old.patch_id
       or new.catalog_revision_id <> old.catalog_revision_id
     ) then
    raise exception 'current claim evidence decision identity is immutable'
      using errcode = '55000';
  end if;

  if tg_op = 'UPDATE' then
    select evaluated_at
      into old_evaluated_at
      from claim_evidence_decisions
     where claim_evidence_decision_id =
           old.claim_evidence_decision_id;
    select evaluated_at
      into new_evaluated_at
      from claim_evidence_decisions
     where claim_evidence_decision_id =
           new.claim_evidence_decision_id;
    if new_evaluated_at < old_evaluated_at then
      raise exception 'current claim evidence decision cannot move backward'
        using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

create or replace function enforce_review_snapshot_provenance_graph()
returns trigger
language plpgsql
as $$
declare
  graph_matches boolean;
begin
  select (
           snapshot.candidate_revision_id =
             provenance.candidate_revision_id
           and new.candidate_revision_id =
             provenance.candidate_revision_id
           and new.origin = provenance.origin
         )
    into graph_matches
    from review_input_snapshots snapshot
    join candidate_provenance provenance
      on provenance.candidate_provenance_id =
         new.candidate_provenance_id
   where snapshot.review_input_snapshot_id =
         new.review_input_snapshot_id;
  if graph_matches is distinct from true then
    raise exception 'review snapshot provenance graph mismatch'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create or replace function enforce_review_snapshot_claim_graph()
returns trigger
language plpgsql
as $$
declare
  snapshot_revision uuid;
  current_decision uuid;
  decision_matches boolean;
begin
  select candidate_revision_id
    into snapshot_revision
    from review_input_snapshots
   where review_input_snapshot_id =
         new.review_input_snapshot_id;
  if snapshot_revision is null
     or snapshot_revision <> new.candidate_revision_id then
    raise exception 'review snapshot claim graph mismatch'
      using errcode = '23514';
  end if;

  select claim_evidence_decision_id
    into current_decision
    from current_claim_evidence_decisions
   where claim_id = new.claim_id;
  if current_decision is distinct from
     new.claim_evidence_decision_id then
    raise exception 'review snapshot claim decision is not current'
      using errcode = '23514';
  end if;

  if new.claim_evidence_decision_id is not null then
    select (
             decision.claim_id = new.claim_id
             and decision.candidate_revision_id =
                 new.candidate_revision_id
           )
      into decision_matches
      from claim_evidence_decisions decision
     where decision.claim_evidence_decision_id =
           new.claim_evidence_decision_id;
    if decision_matches is distinct from true then
      raise exception 'review snapshot claim decision graph mismatch'
        using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

create or replace function enforce_review_input_snapshot_seal()
returns trigger
language plpgsql
as $$
declare
  snapshot_id uuid;
  snapshot review_input_snapshots%rowtype;
  actual_claim_count integer;
  actual_provenance_count integer;
  claim_tokens text[];
  provenance_tokens text[];
  expected_claim_hash text;
  expected_provenance_hash text;
  expected_input_hash text;
  missing_claim boolean;
  missing_provenance boolean;
  ordinal_mismatch boolean;
  revision_signature text;
begin
  snapshot_id := case
    when tg_table_name = 'review_input_snapshots'
      then new.review_input_snapshot_id
    else new.review_input_snapshot_id
  end;

  select *
    into snapshot
    from review_input_snapshots
   where review_input_snapshot_id = snapshot_id;
  if not found then
    raise exception 'review input snapshot missing'
      using errcode = '23514';
  end if;

  select normalized_signature
    into revision_signature
    from candidate_revisions
   where candidate_revision_id =
         snapshot.candidate_revision_id;
  if revision_signature is distinct from
     snapshot.candidate_normalized_signature then
    raise exception 'review snapshot candidate signature mismatch'
      using errcode = '23514';
  end if;

  select count(*)::integer
    into actual_claim_count
    from review_input_snapshot_claims
   where review_input_snapshot_id = snapshot_id;
  select count(*)::integer
    into actual_provenance_count
    from review_input_snapshot_provenance
   where review_input_snapshot_id = snapshot_id;

  select exists (
    select 1
      from candidate_claims claim
     where claim.candidate_revision_id =
           snapshot.candidate_revision_id
       and not exists (
         select 1
           from review_input_snapshot_claims member
          where member.review_input_snapshot_id = snapshot_id
            and member.claim_id = claim.claim_id
       )
  ) into missing_claim;

  select exists (
    select 1
      from candidate_provenance provenance
     where provenance.candidate_revision_id =
           snapshot.candidate_revision_id
       and not exists (
         select 1
           from review_input_snapshot_provenance member
          where member.review_input_snapshot_id = snapshot_id
            and member.candidate_provenance_id =
                provenance.candidate_provenance_id
       )
  ) into missing_provenance;

  if missing_claim or missing_provenance then
    raise exception 'review input snapshot membership incomplete'
      using errcode = '23514';
  end if;

  select exists (
    select 1
      from (
        select member.ordinal,
               row_number() over (
                 order by claim.claim_key collate "C"
               )::integer as expected_ordinal
          from review_input_snapshot_claims member
          join candidate_claims claim
            on claim.claim_id = member.claim_id
         where member.review_input_snapshot_id = snapshot_id
      ) ordered
     where ordinal <> expected_ordinal
  ) or exists (
    select 1
      from (
        select ordinal,
               row_number() over (
                 order by candidate_provenance_id::text collate "C"
               )::integer as expected_ordinal
          from review_input_snapshot_provenance
         where review_input_snapshot_id = snapshot_id
      ) ordered
     where ordinal <> expected_ordinal
  ) into ordinal_mismatch;

  if ordinal_mismatch then
    raise exception 'review input snapshot ordinal mismatch'
      using errcode = '23514';
  end if;

  select array_agg(
           entry.token
           order by entry.claim_key collate "C", entry.part
         )
    into claim_tokens
    from (
      select claim.claim_key,
             part.part,
             part.token
        from review_input_snapshot_claims member
        join candidate_claims claim
          on claim.claim_id = member.claim_id
        cross join lateral (
          values
            (1, member.claim_id::text),
            (2, member.importance),
            (
              3,
              coalesce(
                member.claim_evidence_decision_id::text,
                '@null'
              )
            )
        ) as part(part, token)
       where member.review_input_snapshot_id = snapshot_id
    ) as entry;

  select array_agg(
           entry.token
           order by entry.provenance_id::text collate "C", entry.part
         )
    into provenance_tokens
    from (
      select member.candidate_provenance_id as provenance_id,
             part.part,
             part.token
        from review_input_snapshot_provenance member
        cross join lateral (
          values
            (1, member.candidate_provenance_id::text),
            (2, member.origin)
        ) as part(part, token)
       where member.review_input_snapshot_id = snapshot_id
    ) as entry;

  expected_claim_hash := sha256_text_tuple_v1(
    array[
      'TrustTupleV1',
      'ReviewClaimDecisionSetV1',
      snapshot.candidate_revision_id::text,
      actual_claim_count::text
    ] || coalesce(claim_tokens, array[]::text[])
  );
  expected_provenance_hash := sha256_text_tuple_v1(
    array[
      'TrustTupleV1',
      'ReviewProvenanceSetV1',
      snapshot.candidate_revision_id::text,
      actual_provenance_count::text
    ] || coalesce(provenance_tokens, array[]::text[])
  );
  expected_input_hash := sha256_text_tuple_v1(
    array[
      'TrustTupleV1',
      'ReviewInputSnapshotV1',
      snapshot.candidate_id::text,
      snapshot.candidate_revision_id::text,
      snapshot.patch_id::text,
      snapshot.catalog_revision_id::text,
      snapshot.candidate_normalized_signature,
      snapshot.claim_set_hash,
      snapshot.review_policy_revision_id::text,
      actual_claim_count::text
    ]
    || coalesce(claim_tokens, array[]::text[])
    || array[actual_provenance_count::text]
    || coalesce(provenance_tokens, array[]::text[])
  );

  if snapshot.claim_count <> actual_claim_count
     or snapshot.provenance_count <> actual_provenance_count
     or snapshot.claim_decision_set_hash <> expected_claim_hash
     or snapshot.provenance_set_hash <> expected_provenance_hash
     or snapshot.input_hash <> expected_input_hash then
    raise exception 'review input snapshot seal mismatch'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create or replace function enforce_human_review_graph()
returns trigger
language plpgsql
as $$
declare
  graph_matches boolean;
begin
  select (
           snapshot.candidate_id = new.candidate_id
           and snapshot.candidate_revision_id =
               new.candidate_revision_id
           and snapshot.review_policy_revision_id =
               new.review_policy_revision_id
           and snapshot.input_hash = new.input_hash
         )
    into graph_matches
    from review_input_snapshots snapshot
   where snapshot.review_input_snapshot_id =
         new.review_input_snapshot_id;
  if graph_matches is distinct from true then
    raise exception 'human review graph mismatch'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create or replace function enforce_review_quorum_membership_graph()
returns trigger
language plpgsql
as $$
declare
  graph_matches boolean;
begin
  select (
           evaluation.candidate_id = review.candidate_id
           and evaluation.candidate_revision_id =
               review.candidate_revision_id
           and evaluation.review_policy_revision_id =
               review.review_policy_revision_id
           and evaluation.input_hash = review.input_hash
           and new.candidate_id = review.candidate_id
           and new.candidate_revision_id =
               review.candidate_revision_id
           and new.review_policy_revision_id =
               review.review_policy_revision_id
           and new.input_hash = review.input_hash
           and new.reviewer_actor_id =
               review.reviewer_actor_id
           and review.status = 'completed'
           and review.outcome = 'confirmed'
           and review.permission_used = 'reviewer'
         )
    into graph_matches
    from review_quorum_evaluations evaluation
    join human_reviews review
      on review.human_review_id = new.human_review_id
   where evaluation.review_quorum_evaluation_id =
         new.review_quorum_evaluation_id;
  if graph_matches is distinct from true then
    raise exception 'review quorum membership graph mismatch'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

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

create or replace function enforce_current_review_quorum_graph()
returns trigger
language plpgsql
as $$
declare
  old_evaluated_at timestamptz;
  new_evaluated_at timestamptz;
begin
  if tg_op = 'DELETE' then
    raise exception 'current review quorum pointer is immutable'
      using errcode = '55000';
  end if;
  if tg_op = 'UPDATE'
     and (
       new.candidate_revision_id <> old.candidate_revision_id
       or new.review_policy_revision_id <>
          old.review_policy_revision_id
       or new.candidate_id <> old.candidate_id
     ) then
    raise exception 'current review quorum identity is immutable'
      using errcode = '55000';
  end if;
  if tg_op = 'UPDATE' then
    select evaluated_at
      into old_evaluated_at
      from review_quorum_evaluations
     where review_quorum_evaluation_id =
           old.review_quorum_evaluation_id;
    select evaluated_at
      into new_evaluated_at
      from review_quorum_evaluations
     where review_quorum_evaluation_id =
           new.review_quorum_evaluation_id;
    if new_evaluated_at < old_evaluated_at then
      raise exception 'current review quorum cannot move backward'
        using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

create trigger candidate_claim_graph_guard
before insert on candidate_claims
for each row execute function enforce_candidate_claim_graph();

create constraint trigger candidate_claim_set_seal_from_claim
after insert on candidate_claims
deferrable initially deferred
for each row execute function enforce_candidate_claim_set_seal();

create constraint trigger candidate_claim_set_seal_from_header
after insert on candidate_claim_set_seals
deferrable initially deferred
for each row execute function enforce_candidate_claim_set_seal();

create trigger evidence_source_graph_guard
before insert on evidence_records
for each row execute function enforce_evidence_source_graph();

create trigger evidence_association_graph_guard
before insert on evidence_associations
for each row execute function enforce_evidence_association_graph();

create trigger evidence_snapshot_association_graph_guard
before insert on evidence_input_snapshot_associations
for each row execute function enforce_evidence_snapshot_association_graph();

create constraint trigger evidence_input_snapshot_seal_from_header
after insert on evidence_input_snapshots
deferrable initially deferred
for each row execute function enforce_evidence_input_snapshot_seal();

create constraint trigger evidence_input_snapshot_seal_from_member
after insert on evidence_input_snapshot_associations
deferrable initially deferred
for each row execute function enforce_evidence_input_snapshot_seal();

create trigger claim_evidence_decision_graph_guard
before insert on claim_evidence_decisions
for each row execute function enforce_claim_evidence_decision_graph();

create trigger current_claim_evidence_decision_graph_guard
before insert or update or delete on current_claim_evidence_decisions
for each row execute function enforce_current_claim_evidence_decision_graph();

create trigger review_snapshot_provenance_graph_guard
before insert on review_input_snapshot_provenance
for each row execute function enforce_review_snapshot_provenance_graph();

create trigger review_snapshot_claim_graph_guard
before insert on review_input_snapshot_claims
for each row execute function enforce_review_snapshot_claim_graph();

create constraint trigger review_input_snapshot_seal_from_header
after insert on review_input_snapshots
deferrable initially deferred
for each row execute function enforce_review_input_snapshot_seal();

create constraint trigger review_input_snapshot_seal_from_claim
after insert on review_input_snapshot_claims
deferrable initially deferred
for each row execute function enforce_review_input_snapshot_seal();

create constraint trigger review_input_snapshot_seal_from_provenance
after insert on review_input_snapshot_provenance
deferrable initially deferred
for each row execute function enforce_review_input_snapshot_seal();

create trigger human_review_graph_guard
before insert on human_reviews
for each row execute function enforce_human_review_graph();

create trigger review_quorum_membership_graph_guard
before insert on review_quorum_evaluation_reviews
for each row execute function enforce_review_quorum_membership_graph();

create constraint trigger review_quorum_result_from_header
after insert on review_quorum_evaluations
deferrable initially deferred
for each row execute function enforce_review_quorum_result();

create constraint trigger review_quorum_result_from_member
after insert on review_quorum_evaluation_reviews
deferrable initially deferred
for each row execute function enforce_review_quorum_result();

create trigger current_review_quorum_graph_guard
before insert or update or delete on current_review_quorum_evaluations
for each row execute function enforce_current_review_quorum_graph();

create trigger evidence_policy_revisions_immutable
before update or delete on evidence_policy_revisions
for each row execute function reject_immutable_change();

create trigger review_policy_revisions_immutable
before update or delete on review_policy_revisions
for each row execute function reject_immutable_change();

create trigger candidate_claims_immutable
before update or delete on candidate_claims
for each row execute function reject_immutable_change();

create trigger candidate_claim_set_seals_immutable
before update or delete on candidate_claim_set_seals
for each row execute function reject_immutable_change();

create trigger evidence_records_immutable
before update or delete on evidence_records
for each row execute function reject_immutable_change();

create trigger evidence_associations_immutable
before update or delete on evidence_associations
for each row execute function reject_immutable_change();

create trigger evidence_input_snapshots_immutable
before update or delete on evidence_input_snapshots
for each row execute function reject_immutable_change();

create trigger evidence_input_snapshot_associations_immutable
before update or delete on evidence_input_snapshot_associations
for each row execute function reject_immutable_change();

create trigger claim_evidence_decisions_immutable
before update or delete on claim_evidence_decisions
for each row execute function reject_immutable_change();

create trigger review_input_snapshots_immutable
before update or delete on review_input_snapshots
for each row execute function reject_immutable_change();

create trigger review_input_snapshot_provenance_immutable
before update or delete on review_input_snapshot_provenance
for each row execute function reject_immutable_change();

create trigger review_input_snapshot_claims_immutable
before update or delete on review_input_snapshot_claims
for each row execute function reject_immutable_change();

create trigger human_reviews_immutable
before update or delete on human_reviews
for each row execute function reject_immutable_change();

create trigger review_quorum_evaluations_immutable
before update or delete on review_quorum_evaluations
for each row execute function reject_immutable_change();

create trigger review_quorum_evaluation_reviews_immutable
before update or delete on review_quorum_evaluation_reviews
for each row execute function reject_immutable_change();
