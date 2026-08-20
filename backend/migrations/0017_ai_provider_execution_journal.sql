create table ai_provider_executions (
  ai_provider_execution_id uuid primary key,
  ai_discovery_run_id uuid not null unique,
  ai_operations_run_budget_reservation_id uuid not null unique
    references ai_operations_run_budget_reservations(ai_operations_run_budget_reservation_id),
  run_key text not null unique,
  idempotency_key text not null,
  provider_key text not null,
  model_key text not null,
  model_revision text not null,
  prompt_template_key text not null,
  prompt_template_version integer not null check (prompt_template_version > 0),
  input_hash text not null check (input_hash ~ '^[a-f0-9]{64}$'),
  status text not null check (status in ('PREPARED','IN_FLIGHT','COMPLETED','FAILED','UNCERTAIN')),
  current_attempt_ordinal smallint not null check (current_attempt_ordinal between 1 and 3),
  lease_token uuid,
  leased_at timestamptz,
  lease_expires_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  terminal_at timestamptz,
  check (
    (lease_token is null and leased_at is null and lease_expires_at is null)
    or (lease_token is not null and leased_at is not null and lease_expires_at is not null
        and lease_expires_at > leased_at)
  ),
  check (status <> 'IN_FLIGHT' or lease_token is not null),
  check (status not in ('COMPLETED','FAILED') or (terminal_at is not null and lease_token is null))
);

create table ai_provider_execution_attempts (
  ai_provider_execution_attempt_id uuid primary key,
  ai_provider_execution_id uuid not null references ai_provider_executions(ai_provider_execution_id),
  ordinal smallint not null check (ordinal between 1 and 3),
  client_request_id uuid not null unique,
  status text not null check (status in ('PREPARED','IN_FLIGHT','COMPLETED','FAILED','UNCERTAIN')),
  failure_code text,
  provider_request_id text,
  provider_response_id text,
  output_hash text check (output_hash is null or output_hash ~ '^[a-f0-9]{64}$'),
  prepared_at timestamptz not null default clock_timestamp(),
  dispatch_started_at timestamptz,
  completed_at timestamptz,
  unique (ai_provider_execution_id, ordinal),
  unique (ai_provider_execution_id, ai_provider_execution_attempt_id),
  check (status <> 'PREPARED' or dispatch_started_at is null),
  check (status = 'PREPARED' or dispatch_started_at is not null),
  check (status in ('PREPARED','IN_FLIGHT') or completed_at is not null)
);

create unique index ai_provider_execution_attempts_one_active_idx
  on ai_provider_execution_attempts (ai_provider_execution_id)
  where status in ('PREPARED','IN_FLIGHT');

create table ai_provider_execution_reconciliations (
  ai_provider_execution_reconciliation_id uuid primary key,
  ai_provider_execution_id uuid not null references ai_provider_executions(ai_provider_execution_id),
  ai_provider_execution_attempt_id uuid not null unique,
  decision text not null check (decision in ('CONFIRMED_NOT_RECEIVED','CONFIRMED_RECEIVED','ABANDONED')),
  actor_id text not null check (octet_length(actor_id) between 1 and 256),
  reason_code text not null check (octet_length(reason_code) between 1 and 128),
  evidence_reference text not null check (octet_length(evidence_reference) between 1 and 512),
  created_at timestamptz not null default clock_timestamp(),
  foreign key (ai_provider_execution_id, ai_provider_execution_attempt_id)
    references ai_provider_execution_attempts(ai_provider_execution_id, ai_provider_execution_attempt_id)
);

create index ai_provider_executions_status_idx
  on ai_provider_executions (status, lease_expires_at, created_at);
create index ai_provider_execution_attempts_execution_idx
  on ai_provider_execution_attempts (ai_provider_execution_id, ordinal);

create function enforce_ai_provider_execution_transition()
returns trigger
language plpgsql
as $$
declare
  recon_decision text;
  next_attempt_exists boolean;
begin
  if tg_op = 'DELETE' then
    raise exception 'AI provider executions cannot be deleted';
  end if;

  if new.ai_provider_execution_id <> old.ai_provider_execution_id
     or new.ai_discovery_run_id <> old.ai_discovery_run_id
     or new.ai_operations_run_budget_reservation_id <> old.ai_operations_run_budget_reservation_id
     or new.run_key <> old.run_key
     or new.idempotency_key <> old.idempotency_key
     or new.provider_key <> old.provider_key
     or new.model_key <> old.model_key
     or new.model_revision <> old.model_revision
     or new.prompt_template_key <> old.prompt_template_key
     or new.prompt_template_version <> old.prompt_template_version
     or new.input_hash <> old.input_hash
     or new.created_at <> old.created_at then
    raise exception 'AI provider execution identity is immutable';
  end if;

  if old.status in ('COMPLETED','FAILED') then
    raise exception 'terminal AI provider execution is immutable';
  end if;

  if old.status = 'UNCERTAIN' and new.status = 'PREPARED' then
    select r.decision into recon_decision
      from ai_provider_execution_reconciliations r
      join ai_provider_execution_attempts a
        on a.ai_provider_execution_attempt_id = r.ai_provider_execution_attempt_id
     where r.ai_provider_execution_id = old.ai_provider_execution_id
       and a.ordinal = old.current_attempt_ordinal;
    select exists(
      select 1 from ai_provider_execution_attempts a
       where a.ai_provider_execution_id = old.ai_provider_execution_id
         and a.ordinal = old.current_attempt_ordinal + 1
         and a.status = 'PREPARED'
    ) into next_attempt_exists;
    if recon_decision is distinct from 'CONFIRMED_NOT_RECEIVED'
       or old.current_attempt_ordinal >= 3
       or new.current_attempt_ordinal <> old.current_attempt_ordinal + 1
       or not next_attempt_exists then
      raise exception 'uncertain AI provider execution cannot reopen without confirmed-not-received reconciliation';
    end if;
  elsif old.status = 'UNCERTAIN' and new.status <> 'UNCERTAIN' then
    raise exception 'uncertain AI provider execution is fail closed';
  end if;

  if new.status = 'IN_FLIGHT' and (
    new.lease_token is null or new.lease_expires_at <= clock_timestamp()
  ) then
    raise exception 'in-flight AI provider execution requires valid lease';
  end if;

  if new.status in ('COMPLETED','FAILED') and (
    new.terminal_at is null or new.lease_token is not null
  ) then
    raise exception 'terminal AI provider execution requires terminal timestamp and cleared lease';
  end if;

  return new;
end;
$$;

create trigger ai_provider_executions_transition_guard
before update or delete on ai_provider_executions
for each row execute function enforce_ai_provider_execution_transition();

create function enforce_ai_provider_execution_attempt_transition()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'AI provider execution attempts cannot be deleted';
  end if;
  if new.ai_provider_execution_attempt_id <> old.ai_provider_execution_attempt_id
     or new.ai_provider_execution_id <> old.ai_provider_execution_id
     or new.ordinal <> old.ordinal
     or new.client_request_id <> old.client_request_id
     or new.prepared_at <> old.prepared_at then
    raise exception 'AI provider execution attempt identity is immutable';
  end if;
  if old.status in ('COMPLETED','FAILED','UNCERTAIN') then
    raise exception 'terminal AI provider execution attempt is immutable';
  end if;
  if old.status = 'PREPARED' and new.status not in ('PREPARED','IN_FLIGHT') then
    raise exception 'prepared AI provider attempt must enter in-flight before terminal state';
  end if;
  if old.status = 'IN_FLIGHT' and new.status not in ('IN_FLIGHT','COMPLETED','FAILED','UNCERTAIN') then
    raise exception 'invalid AI provider attempt transition';
  end if;
  return new;
end;
$$;

create trigger ai_provider_execution_attempts_transition_guard
before update or delete on ai_provider_execution_attempts
for each row execute function enforce_ai_provider_execution_attempt_transition();

create function enforce_ai_provider_execution_reconciliation()
returns trigger
language plpgsql
as $$
declare
  attempt_status text;
begin
  if tg_op = 'DELETE' then
    raise exception 'AI provider execution reconciliations cannot be deleted';
  end if;
  if tg_op = 'UPDATE' then
    raise exception 'AI provider execution reconciliations are append-only';
  end if;
  select status into attempt_status
    from ai_provider_execution_attempts
   where ai_provider_execution_attempt_id = new.ai_provider_execution_attempt_id
     and ai_provider_execution_id = new.ai_provider_execution_id;
  if attempt_status is distinct from 'UNCERTAIN' then
    raise exception 'only uncertain AI provider attempts may be reconciled';
  end if;
  return new;
end;
$$;

create trigger ai_provider_execution_reconciliations_guard
before insert or update or delete on ai_provider_execution_reconciliations
for each row execute function enforce_ai_provider_execution_reconciliation();
