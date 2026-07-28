create extension if not exists pgcrypto;

create table sources (
  source_id uuid primary key,
  source_key text not null unique,
  display_name text not null,
  status text not null default 'active'
    check (status in ('active', 'suspended', 'retired')),
  created_at timestamptz not null default clock_timestamp()
);

create table source_policy_revisions (
  source_policy_revision_id uuid primary key,
  source_id uuid not null references sources(source_id),
  revision integer not null check (revision > 0),
  storage_permission text not null
    check (storage_permission in ('blob_allowed', 'reference_only', 'aggregate_only', 'prohibited')),
  collector_enabled boolean not null,
  reason text not null,
  created_by text not null,
  created_at timestamptz not null default clock_timestamp(),
  unique (source_id, revision)
);

create table active_source_policies (
  source_id uuid primary key references sources(source_id),
  source_policy_revision_id uuid not null unique references source_policy_revisions(source_policy_revision_id),
  activated_at timestamptz not null default clock_timestamp()
);

create table patches (
  patch_id uuid primary key,
  patch_key text not null unique,
  display_label text not null,
  effective_from timestamptz,
  effective_until timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  check (effective_until is null or effective_from is null or effective_until > effective_from)
);

create table patch_lifecycle_events (
  patch_lifecycle_event_id uuid primary key,
  patch_id uuid not null references patches(patch_id),
  lifecycle_state text not null
    check (lifecycle_state in ('announced', 'active', 'superseded', 'withdrawn')),
  reason text not null,
  actor_id text not null,
  correlation_id text not null,
  occurred_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp()
);

create table catalog_revisions (
  catalog_revision_id uuid primary key,
  patch_id uuid not null references patches(patch_id),
  revision integer not null check (revision > 0),
  status text not null check (status in ('draft', 'effective', 'superseded', 'withdrawn')),
  source_policy_revision_id uuid not null references source_policy_revisions(source_policy_revision_id),
  created_at timestamptz not null default clock_timestamp(),
  unique (patch_id, revision)
);

create table game_entities (
  game_entity_id uuid primary key,
  entity_type text not null check (entity_type in ('champion', 'item', 'augment', 'mode')),
  canonical_external_id text not null,
  created_at timestamptz not null default clock_timestamp(),
  unique (entity_type, canonical_external_id)
);

create table game_entity_revisions (
  game_entity_revision_id uuid primary key,
  game_entity_id uuid not null references game_entities(game_entity_id),
  catalog_revision_id uuid not null references catalog_revisions(catalog_revision_id),
  display_name text not null,
  attributes jsonb not null default '{}'::jsonb,
  active boolean not null,
  created_at timestamptz not null default clock_timestamp(),
  unique (game_entity_id, catalog_revision_id)
);

create table compatibility_rules (
  compatibility_rule_id uuid primary key,
  catalog_revision_id uuid not null references catalog_revisions(catalog_revision_id),
  rule_key text not null,
  constraint_type text not null check (constraint_type in ('allow', 'deny', 'limit')),
  definition jsonb not null,
  created_at timestamptz not null default clock_timestamp(),
  unique (catalog_revision_id, rule_key)
);

create table raw_observations (
  raw_observation_id uuid primary key,
  source_id uuid not null references sources(source_id),
  source_policy_revision_id uuid not null references source_policy_revisions(source_policy_revision_id),
  adapter_version text not null,
  external_reference jsonb,
  aggregate_metadata jsonb,
  content_hash text not null,
  raw_blob text,
  patch_hint text,
  observed_at timestamptz,
  collected_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp()
);

create table audit_events (
  audit_event_id uuid primary key,
  actor_id text not null,
  action text not null,
  reason text not null,
  correlation_id text not null,
  policy_version text,
  payload jsonb not null,
  created_at timestamptz not null default clock_timestamp()
);

create table idempotency_records (
  idempotency_record_id uuid primary key default gen_random_uuid(),
  scope text not null,
  idempotency_key text not null,
  payload_hash text not null,
  state text not null
    check (state in ('in_progress', 'completed', 'failed_retryable', 'failed_terminal')),
  result jsonb,
  created_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz,
  unique (scope, idempotency_key),
  check ((state = 'completed' and result is not null and completed_at is not null) or state <> 'completed')
);

create table outbox_events (
  outbox_event_id uuid primary key,
  aggregate_type text not null,
  aggregate_id uuid not null,
  event_type text not null,
  payload jsonb not null,
  correlation_id text not null,
  delivery_state text not null default 'pending'
    check (delivery_state in ('pending', 'delivered', 'retryable_failed', 'terminal_failed')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  available_at timestamptz not null default clock_timestamp(),
  delivered_at timestamptz,
  last_error_code text,
  created_at timestamptz not null default clock_timestamp()
);

create index outbox_events_pending_idx
  on outbox_events (available_at, created_at)
  where delivery_state in ('pending', 'retryable_failed');

create or replace function reject_immutable_change()
returns trigger
language plpgsql
as $$
begin
  raise exception '% is immutable', tg_table_name
    using errcode = '55000';
end;
$$;

create trigger source_policy_revisions_immutable
before update or delete on source_policy_revisions
for each row execute function reject_immutable_change();

create trigger patch_lifecycle_events_immutable
before update or delete on patch_lifecycle_events
for each row execute function reject_immutable_change();

create trigger catalog_revisions_immutable
before update or delete on catalog_revisions
for each row execute function reject_immutable_change();

create trigger game_entity_revisions_immutable
before update or delete on game_entity_revisions
for each row execute function reject_immutable_change();

create trigger compatibility_rules_immutable
before update or delete on compatibility_rules
for each row execute function reject_immutable_change();

create trigger raw_observations_immutable
before update or delete on raw_observations
for each row execute function reject_immutable_change();

create trigger audit_events_immutable
before update or delete on audit_events
for each row execute function reject_immutable_change();
