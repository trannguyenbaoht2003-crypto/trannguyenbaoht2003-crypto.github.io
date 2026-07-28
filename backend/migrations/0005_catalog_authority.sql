alter table catalog_revisions
  add constraint catalog_revisions_revision_patch_unique
  unique (catalog_revision_id, patch_id);

create table catalog_revision_seals (
  catalog_revision_id uuid primary key
    references catalog_revisions(catalog_revision_id),
  schema_version integer not null
    check (schema_version = 1),
  adapter_version text not null
    check (length(btrim(adapter_version)) > 0),
  source_digest text not null
    check (source_digest ~ '^[a-f0-9]{64}$'),
  game_mode_external_id text not null
    check (game_mode_external_id = 'aram_mayhem'),
  content_hash text not null unique
    check (content_hash ~ '^[a-f0-9]{64}$'),
  entity_count integer not null
    check (entity_count >= 0),
  rule_count integer not null
    check (rule_count >= 0),
  sealed_by text not null,
  sealed_at timestamptz not null default clock_timestamp()
);

create table catalog_validation_results (
  catalog_validation_result_id uuid primary key,
  catalog_revision_id uuid not null
    references catalog_revision_seals(catalog_revision_id),
  sealed_content_hash text not null
    check (sealed_content_hash ~ '^[a-f0-9]{64}$'),
  validator_ruleset_version text not null,
  result text not null
    check (result in ('passed', 'failed')),
  reason_codes text[] not null,
  validated_by text not null,
  validated_at timestamptz not null default clock_timestamp()
);

create index catalog_validation_results_latest_idx
  on catalog_validation_results
  (catalog_revision_id, validated_at desc, catalog_validation_result_id desc);

create table catalog_lifecycle_events (
  catalog_lifecycle_event_id uuid primary key,
  catalog_revision_id uuid not null
    references catalog_revision_seals(catalog_revision_id),
  lifecycle_state text not null
    check (
      lifecycle_state in (
        'imported',
        'validated',
        'activated',
        'superseded',
        'withdrawn'
      )
    ),
  reason text not null,
  actor_id text not null,
  correlation_id text not null,
  occurred_at timestamptz not null default clock_timestamp(),
  created_at timestamptz not null default clock_timestamp()
);

create table active_catalog_revisions (
  patch_id uuid not null
    references patches(patch_id),
  game_mode_external_id text not null
    check (game_mode_external_id = 'aram_mayhem'),
  catalog_revision_id uuid not null,
  activated_at timestamptz not null default clock_timestamp(),
  primary key (patch_id, game_mode_external_id),
  foreign key (catalog_revision_id, patch_id)
    references catalog_revisions(catalog_revision_id, patch_id)
);

create trigger game_entities_immutable
before update or delete on game_entities
for each row execute function reject_immutable_change();

create trigger catalog_revision_seals_immutable
before update or delete on catalog_revision_seals
for each row execute function reject_immutable_change();

create trigger catalog_validation_results_immutable
before update or delete on catalog_validation_results
for each row execute function reject_immutable_change();

create trigger catalog_lifecycle_events_immutable
before update or delete on catalog_lifecycle_events
for each row execute function reject_immutable_change();

create or replace function reject_sealed_catalog_child_insert()
returns trigger
language plpgsql
as $$
begin
  if exists (
    select 1
      from catalog_revision_seals
     where catalog_revision_id = new.catalog_revision_id
  ) then
    raise exception 'catalog revision % is sealed', new.catalog_revision_id
      using errcode = '55000';
  end if;
  return new;
end;
$$;

create trigger game_entity_revisions_sealed_insert
before insert on game_entity_revisions
for each row execute function reject_sealed_catalog_child_insert();

create trigger compatibility_rules_sealed_insert
before insert on compatibility_rules
for each row execute function reject_sealed_catalog_child_insert();
