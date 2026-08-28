create table candidate_confidence_input_snapshots (
  candidate_confidence_input_snapshot_id uuid primary key,
  candidate_id uuid not null,
  candidate_revision_id uuid not null,
  patch_id uuid not null,
  catalog_revision_id uuid not null,
  scoring_version text not null
    check (scoring_version = 'candidate-confidence-v1'),
  provenance_quality integer not null
    check (provenance_quality in (0, 20, 30)),
  supporting_source_count integer not null
    check (supporting_source_count >= 0),
  has_exact_patch_support boolean not null,
  has_revalidated_cross_patch_support boolean not null,
  newest_supporting_evidence_at timestamptz,
  evaluated_at timestamptz not null,
  input_hash text not null
    check (input_hash ~ '^[a-f0-9]{64}$'),
  created_by text not null
    check (octet_length(created_by) between 1 and 256),
  created_at timestamptz not null default clock_timestamp(),
  constraint candidate_confidence_input_evidence_time_check
    check (
      newest_supporting_evidence_at is null
      or newest_supporting_evidence_at <= evaluated_at
    ),
  constraint candidate_confidence_input_evidence_consistency_check
    check (
      (
        supporting_source_count = 0
        and newest_supporting_evidence_at is null
        and not has_exact_patch_support
        and not has_revalidated_cross_patch_support
      )
      or (
        supporting_source_count > 0
        and newest_supporting_evidence_at is not null
      )
    ),
  unique (candidate_revision_id, scoring_version, input_hash),
  unique (
    candidate_confidence_input_snapshot_id,
    candidate_id,
    candidate_revision_id,
    patch_id,
    catalog_revision_id,
    scoring_version,
    input_hash,
    evaluated_at
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

create index candidate_confidence_input_revision_time_idx
  on candidate_confidence_input_snapshots (
    candidate_revision_id,
    evaluated_at desc,
    created_at desc
  );

create table candidate_confidence_scores (
  candidate_confidence_score_id uuid primary key,
  score_sequence bigint generated always as identity unique,
  candidate_confidence_input_snapshot_id uuid not null unique,
  candidate_id uuid not null,
  candidate_revision_id uuid not null,
  patch_id uuid not null,
  catalog_revision_id uuid not null,
  scoring_version text not null
    check (scoring_version = 'candidate-confidence-v1'),
  input_hash text not null
    check (input_hash ~ '^[a-f0-9]{64}$'),
  evaluated_at timestamptz not null,
  provenance_quality_score integer not null
    check (provenance_quality_score in (0, 20, 30)),
  evidence_diversity_score integer not null
    check (evidence_diversity_score in (0, 10, 25)),
  patch_alignment_score integer not null
    check (patch_alignment_score in (0, 10, 20)),
  freshness_score integer not null
    check (freshness_score in (0, 5, 15)),
  score integer not null check (score between 0 and 90),
  band text not null
    constraint candidate_confidence_scores_band_domain_check
    check (band in ('low', 'medium', 'high', 'very_high')),
  reason text not null check (octet_length(reason) between 1 and 1024),
  actor_id text not null check (octet_length(actor_id) between 1 and 256),
  correlation_id text not null
    check (octet_length(correlation_id) between 1 and 256),
  created_at timestamptz not null default clock_timestamp(),
  constraint candidate_confidence_scores_component_sum_check
    check (
      score = provenance_quality_score
        + evidence_diversity_score
        + patch_alignment_score
        + freshness_score
    ),
  constraint candidate_confidence_scores_band_check
    check (
      (score between 0 and 39 and band = 'low')
      or (score between 40 and 69 and band = 'medium')
      or (score between 70 and 89 and band = 'high')
      or (score = 90 and band = 'very_high')
    ),
  unique (candidate_revision_id, scoring_version, input_hash),
  unique (
    candidate_confidence_score_id,
    candidate_id,
    candidate_revision_id,
    patch_id,
    catalog_revision_id,
    scoring_version,
    input_hash,
    evaluated_at,
    score_sequence
  ),
  foreign key (
    candidate_confidence_input_snapshot_id,
    candidate_id,
    candidate_revision_id,
    patch_id,
    catalog_revision_id,
    scoring_version,
    input_hash,
    evaluated_at
  ) references candidate_confidence_input_snapshots (
    candidate_confidence_input_snapshot_id,
    candidate_id,
    candidate_revision_id,
    patch_id,
    catalog_revision_id,
    scoring_version,
    input_hash,
    evaluated_at
  )
);

create index candidate_confidence_scores_revision_time_idx
  on candidate_confidence_scores (
    candidate_revision_id,
    evaluated_at desc,
    score_sequence desc
  );

create table current_candidate_confidence_scores (
  candidate_revision_id uuid primary key,
  candidate_id uuid not null,
  patch_id uuid not null,
  catalog_revision_id uuid not null,
  candidate_confidence_score_id uuid not null unique,
  scoring_version text not null
    check (scoring_version = 'candidate-confidence-v1'),
  input_hash text not null
    check (input_hash ~ '^[a-f0-9]{64}$'),
  evaluated_at timestamptz not null,
  score_sequence bigint not null,
  updated_at timestamptz not null default clock_timestamp(),
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
    candidate_confidence_score_id,
    candidate_id,
    candidate_revision_id,
    patch_id,
    catalog_revision_id,
    scoring_version,
    input_hash,
    evaluated_at,
    score_sequence
  ) references candidate_confidence_scores (
    candidate_confidence_score_id,
    candidate_id,
    candidate_revision_id,
    patch_id,
    catalog_revision_id,
    scoring_version,
    input_hash,
    evaluated_at,
    score_sequence
  )
);

create or replace function enforce_candidate_confidence_score_result()
returns trigger
language plpgsql
as $$
declare
  snapshot candidate_confidence_input_snapshots%rowtype;
  expected_evidence_diversity_score integer;
  expected_freshness_score integer;
  expected_patch_alignment_score integer;
begin
  select *
    into snapshot
    from candidate_confidence_input_snapshots
   where candidate_confidence_input_snapshot_id =
         new.candidate_confidence_input_snapshot_id;
  if not found then
    raise exception 'candidate confidence input snapshot missing'
      using errcode = '23514';
  end if;

  expected_evidence_diversity_score := case
    when snapshot.supporting_source_count >= 2 then 25
    when snapshot.supporting_source_count = 1 then 10
    else 0
  end;
  expected_patch_alignment_score := case
    when snapshot.has_exact_patch_support then 20
    when snapshot.has_revalidated_cross_patch_support then 10
    else 0
  end;
  expected_freshness_score := case
    when snapshot.newest_supporting_evidence_at is null then 0
    when snapshot.evaluated_at
           - snapshot.newest_supporting_evidence_at
         < interval '7 days' then 15
    when snapshot.evaluated_at
           - snapshot.newest_supporting_evidence_at
         <= interval '30 days' then 5
    else 0
  end;

  if new.provenance_quality_score <> snapshot.provenance_quality
     or new.evidence_diversity_score <>
        expected_evidence_diversity_score
     or new.patch_alignment_score <> expected_patch_alignment_score
     or new.freshness_score <> expected_freshness_score then
    raise exception 'candidate confidence score result mismatch'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create or replace function enforce_current_candidate_confidence_score()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'current candidate confidence score cannot be deleted'
      using errcode = '23514';
  end if;

  if tg_op = 'UPDATE'
     and (
       new.candidate_revision_id <> old.candidate_revision_id
       or new.candidate_id <> old.candidate_id
       or new.patch_id <> old.patch_id
       or new.catalog_revision_id <> old.catalog_revision_id
       or new.scoring_version <> old.scoring_version
     ) then
    raise exception 'current candidate confidence score identity is immutable'
      using errcode = '23514';
  end if;

  if tg_op = 'UPDATE'
     and new.candidate_confidence_score_id <>
         old.candidate_confidence_score_id
     and (
       new.evaluated_at < old.evaluated_at
       or (
         new.evaluated_at = old.evaluated_at
         and new.score_sequence <= old.score_sequence
       )
     ) then
    raise exception 'current candidate confidence score cannot move backward'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger candidate_confidence_score_result_guard
before insert or update on candidate_confidence_scores
for each row execute function enforce_candidate_confidence_score_result();

create trigger current_candidate_confidence_score_guard
before insert or update or delete on current_candidate_confidence_scores
for each row execute function enforce_current_candidate_confidence_score();

create trigger candidate_confidence_input_snapshots_immutable
before update or delete on candidate_confidence_input_snapshots
for each row execute function reject_immutable_change();

create trigger candidate_confidence_scores_immutable
before update or delete on candidate_confidence_scores
for each row execute function reject_immutable_change();
