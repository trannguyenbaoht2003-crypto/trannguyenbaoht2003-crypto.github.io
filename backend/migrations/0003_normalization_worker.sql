create table normalization_effects (
  outbox_event_id uuid primary key references outbox_events(outbox_event_id),
  raw_observation_id uuid not null unique references raw_observations(raw_observation_id),
  effect_state text not null
    check (effect_state = 'accepted_for_normalization'),
  created_at timestamptz not null default clock_timestamp()
);

create table worker_job_attempts (
  worker_job_attempt_id uuid primary key,
  queue_name text not null,
  job_id text not null,
  attempt_number integer not null check (attempt_number > 0),
  outbox_event_id uuid not null references outbox_events(outbox_event_id),
  status text not null
    check (status in ('succeeded', 'duplicate_noop', 'failed_retryable')),
  error_code text,
  completed_at timestamptz not null default clock_timestamp(),
  unique (queue_name, job_id, attempt_number),
  check (
    (status = 'failed_retryable' and error_code is not null)
    or
    (status <> 'failed_retryable' and error_code is null)
  )
);

create trigger normalization_effects_immutable
before update or delete on normalization_effects
for each row execute function reject_immutable_change();

create trigger worker_job_attempts_immutable
before update or delete on worker_job_attempts
for each row execute function reject_immutable_change();
