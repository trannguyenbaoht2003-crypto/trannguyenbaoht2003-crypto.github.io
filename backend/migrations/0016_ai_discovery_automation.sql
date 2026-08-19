create table scheduled_ai_discovery_ticks (
  scheduled_ai_discovery_tick_id uuid primary key,
  scheduler_key text not null check (scheduler_key = 'ai-discovery-hourly-v1'),
  utc_hour timestamptz not null,
  status text not null check (status in (
    'PROCESSING', 'NO_NEW_INPUT', 'CADENCE_NOT_ELAPSED', 'POLICY_DISABLED',
    'DAILY_BUDGET_EXHAUSTED', 'POLICY_MIN_INTERVAL', 'COMPLETED',
    'PROVIDER_FAILED', 'AMBIGUOUS_FAILURE'
  )),
  scheduled_content_hash text
    check (scheduled_content_hash is null or scheduled_content_hash ~ '^[a-f0-9]{64}$'),
  ai_discovery_run_id uuid,
  ai_operations_policy_revision_id uuid
    references ai_operations_policy_revisions(ai_operations_policy_revision_id),
  ai_operations_run_budget_reservation_id uuid
    references ai_operations_run_budget_reservations(ai_operations_run_budget_reservation_id),
  created_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz,
  unique (scheduler_key, utc_hour),
  check (date_trunc('hour', utc_hour) = utc_hour),
  check (
    (status = 'PROCESSING' and completed_at is null)
    or (status <> 'PROCESSING' and completed_at is not null)
  )
);

create index scheduled_ai_discovery_ticks_recent_idx
  on scheduled_ai_discovery_ticks (utc_hour desc, scheduled_ai_discovery_tick_id);

create function enforce_scheduled_ai_discovery_tick_transition()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'scheduled AI discovery ticks cannot be deleted';
  end if;

  if old.status <> 'PROCESSING' then
    raise exception 'terminal scheduled AI discovery ticks are immutable';
  end if;

  if new.scheduled_ai_discovery_tick_id <> old.scheduled_ai_discovery_tick_id
     or new.scheduler_key <> old.scheduler_key
     or new.utc_hour <> old.utc_hour
     or new.created_at <> old.created_at then
    raise exception 'scheduled AI discovery tick identity is immutable';
  end if;

  if old.scheduled_content_hash is not null
     and new.scheduled_content_hash is distinct from old.scheduled_content_hash then
    raise exception 'scheduled content hash cannot change once set';
  end if;

  if old.ai_discovery_run_id is not null
     and new.ai_discovery_run_id is distinct from old.ai_discovery_run_id then
    raise exception 'AI discovery run id cannot change once set';
  end if;

  if old.ai_operations_policy_revision_id is not null
     and new.ai_operations_policy_revision_id is distinct from old.ai_operations_policy_revision_id then
    raise exception 'policy revision id cannot change once set';
  end if;

  if old.ai_operations_run_budget_reservation_id is not null
     and new.ai_operations_run_budget_reservation_id is distinct from old.ai_operations_run_budget_reservation_id then
    raise exception 'budget reservation id cannot change once set';
  end if;

  if new.status = 'PROCESSING' then
    if new.completed_at is not null then
      raise exception 'processing tick cannot have completed_at';
    end if;
    return new;
  end if;

  if new.completed_at is null then
    raise exception 'terminal tick requires completed_at';
  end if;

  return new;
end;
$$;

create trigger scheduled_ai_discovery_ticks_transition_guard
before update or delete on scheduled_ai_discovery_ticks
for each row execute function enforce_scheduled_ai_discovery_tick_transition();
