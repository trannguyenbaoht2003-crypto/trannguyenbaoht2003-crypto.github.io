create or replace function reject_outbox_identity_change()
returns trigger
language plpgsql
as $$
begin
  if new.aggregate_type is distinct from old.aggregate_type
    or new.aggregate_id is distinct from old.aggregate_id
    or new.event_type is distinct from old.event_type
    or new.payload is distinct from old.payload
    or new.correlation_id is distinct from old.correlation_id
  then
    raise exception 'outbox event identity and payload are immutable'
      using errcode = '55000';
  end if;
  return new;
end;
$$;

create trigger outbox_event_identity_immutable
before update on outbox_events
for each row execute function reject_outbox_identity_change();
