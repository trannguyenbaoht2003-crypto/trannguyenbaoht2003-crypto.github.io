create table ai_operations_policy_revisions (
  ai_operations_policy_revision_id uuid primary key,
  revision integer not null unique
    check (revision > 0),
  enabled boolean not null,
  max_runs_per_utc_day integer not null
    check (max_runs_per_utc_day between 0 and 64),
  min_interval_seconds integer not null
    check (min_interval_seconds between 0 and 86400),
  max_proposals_per_run integer not null
    check (max_proposals_per_run between 1 and 64),
  game_mode_external_id text not null
    check (game_mode_external_id = 'aram_mayhem'),
  reason text not null
    check (char_length(btrim(reason)) between 1 and 1024),
  created_by text not null
    check (char_length(btrim(created_by)) between 1 and 256),
  created_at timestamptz not null default clock_timestamp(),
  check (enabled is false or max_runs_per_utc_day >= 1)
);

insert into ai_operations_policy_revisions
  (ai_operations_policy_revision_id, revision, enabled,
   max_runs_per_utc_day, min_interval_seconds, max_proposals_per_run,
   game_mode_external_id, reason, created_by)
values
  (gen_random_uuid(), 1, false, 0, 3600, 16,
   'aram_mayhem',
   'disabled by default; explicit activation required',
   'system:migration:0015');

create table active_ai_operations_policy_revision (
  scope text primary key
    check (scope = 'ai_discovery_provider'),
  ai_operations_policy_revision_id uuid not null
    references ai_operations_policy_revisions(ai_operations_policy_revision_id),
  updated_at timestamptz not null default clock_timestamp()
);

insert into active_ai_operations_policy_revision
  (scope, ai_operations_policy_revision_id)
select 'ai_discovery_provider', ai_operations_policy_revision_id
  from ai_operations_policy_revisions
 where revision = 1;

create table ai_operations_run_budget_reservations (
  ai_operations_run_budget_reservation_id uuid primary key,
  ai_discovery_run_id uuid not null unique,
  run_key text not null
    check (char_length(run_key) between 1 and 128 and run_key collate "C" ~ '^[!-~]+$'),
  ai_operations_policy_revision_id uuid not null
    references ai_operations_policy_revisions(ai_operations_policy_revision_id),
  budget_date date not null,
  max_proposals_per_run integer not null
    check (max_proposals_per_run between 1 and 64),
  actor_id text not null
    check (char_length(btrim(actor_id)) between 1 and 256),
  correlation_id text not null
    check (char_length(btrim(correlation_id)) between 1 and 256),
  reserved_at timestamptz not null default clock_timestamp(),
  created_at timestamptz not null default clock_timestamp()
);

create index ai_operations_budget_date_idx
  on ai_operations_run_budget_reservations
     (budget_date, reserved_at desc, ai_operations_run_budget_reservation_id);

create index ai_operations_budget_policy_idx
  on ai_operations_run_budget_reservations
     (ai_operations_policy_revision_id, reserved_at desc);

create trigger ai_operations_policy_revisions_immutable
before update or delete on ai_operations_policy_revisions
for each row execute function reject_immutable_change();

create trigger ai_operations_run_budget_reservations_immutable
before update or delete on ai_operations_run_budget_reservations
for each row execute function reject_immutable_change();
