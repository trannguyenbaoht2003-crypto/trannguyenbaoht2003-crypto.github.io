alter table outbox_events
  add column lease_token uuid,
  add column leased_at timestamptz,
  add column lease_expires_at timestamptz,
  add constraint outbox_events_lease_consistency check (
    (lease_token is null and leased_at is null and lease_expires_at is null)
    or
    (lease_token is not null and leased_at is not null and lease_expires_at is not null)
  );

create index outbox_events_dispatchable_idx
  on outbox_events (event_type, available_at, created_at)
  where delivery_state in ('pending', 'retryable_failed');
