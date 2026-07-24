alter table game_entity_revisions
  add constraint game_entity_revisions_revision_catalog_unique
  unique (game_entity_revision_id, catalog_revision_id);

create table normalized_observations (
  normalized_observation_id uuid primary key,
  raw_observation_id uuid not null unique
    references raw_observations(raw_observation_id),
  patch_id uuid not null references patches(patch_id),
  catalog_revision_id uuid not null
    references catalog_revision_seals(catalog_revision_id),
  game_mode_external_id text not null
    check (game_mode_external_id = 'aram_mayhem'),
  subject_game_entity_revision_id uuid not null,
  normalizer_version text not null
    check (length(btrim(normalizer_version)) > 0),
  normalized_signature text not null
    check (normalized_signature ~ '^[a-f0-9]{64}$'),
  canonical_payload jsonb not null
    check (jsonb_typeof(canonical_payload) = 'object'),
  created_at timestamptz not null default clock_timestamp(),
  foreign key (subject_game_entity_revision_id, catalog_revision_id)
    references game_entity_revisions(
      game_entity_revision_id,
      catalog_revision_id
    )
);

create index normalized_observations_catalog_idx
  on normalized_observations (
    patch_id,
    game_mode_external_id,
    catalog_revision_id
  );

create table candidates (
  candidate_id uuid primary key,
  fingerprint text not null unique
    check (fingerprint ~ '^[a-f0-9]{64}$'),
  patch_id uuid not null references patches(patch_id),
  game_mode_external_id text not null
    check (game_mode_external_id = 'aram_mayhem'),
  subject_game_entity_id uuid not null references game_entities(game_entity_id),
  created_at timestamptz not null default clock_timestamp()
);

create index candidates_subject_idx
  on candidates (patch_id, game_mode_external_id, subject_game_entity_id);

create table candidate_revisions (
  candidate_revision_id uuid primary key,
  candidate_id uuid not null references candidates(candidate_id),
  revision integer not null check (revision > 0),
  catalog_revision_id uuid not null
    references catalog_revision_seals(catalog_revision_id),
  normalized_signature text not null
    check (normalized_signature ~ '^[a-f0-9]{64}$'),
  canonical_payload jsonb not null
    check (jsonb_typeof(canonical_payload) = 'object'),
  created_at timestamptz not null default clock_timestamp(),
  unique (candidate_id, revision),
  unique (candidate_id, catalog_revision_id, normalized_signature)
);

create index candidate_revisions_catalog_idx
  on candidate_revisions (catalog_revision_id, candidate_id);

create table candidate_provenance (
  candidate_provenance_id uuid primary key,
  candidate_revision_id uuid not null
    references candidate_revisions(candidate_revision_id),
  normalized_observation_id uuid not null unique
    references normalized_observations(normalized_observation_id),
  origin text not null
    check (
      origin in (
        'collector_detected',
        'community_submitted',
        'editorial',
        'ai_generated'
      )
    ),
  created_at timestamptz not null default clock_timestamp()
);

create index candidate_provenance_revision_idx
  on candidate_provenance (candidate_revision_id, created_at);

create trigger normalized_observations_immutable
before update or delete on normalized_observations
for each row execute function reject_immutable_change();

create trigger candidates_immutable
before update or delete on candidates
for each row execute function reject_immutable_change();

create trigger candidate_revisions_immutable
before update or delete on candidate_revisions
for each row execute function reject_immutable_change();

create trigger candidate_provenance_immutable
before update or delete on candidate_provenance
for each row execute function reject_immutable_change();
