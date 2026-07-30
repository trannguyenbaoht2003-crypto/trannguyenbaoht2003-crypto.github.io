create or replace function enforce_publication_activation_transition()
returns trigger
language plpgsql
as $$
declare
  previous_activation publication_activation_history%rowtype;
  target_version_number integer;
  latest_version_number integer;
begin
  select *
    into previous_activation
    from publication_activation_history history
   where history.publication_id = new.publication_id
     and history.activation_sequence < new.activation_sequence
   order by history.activation_sequence desc
   limit 1;

  select version_number
    into target_version_number
    from publication_versions
   where publication_version_id = new.to_publication_version_id
     and publication_id = new.publication_id;

  select max(version_number)
    into latest_version_number
    from publication_versions
   where publication_id = new.publication_id;

  if previous_activation.activation_id is null then
    if new.activation_kind <> 'published'
       or new.from_publication_version_id is not null
       or target_version_number <> 1
       or latest_version_number <> 1 then
      raise exception 'publication activation transition mismatch'
        using errcode = '23514';
    end if;
  elsif new.from_publication_version_id is distinct from
        previous_activation.to_publication_version_id
        or (
          new.activation_kind = 'published'
          and target_version_number <> latest_version_number
        )
        or (
          new.activation_kind = 'rolled_back'
          and new.from_publication_version_id is null
        ) then
    raise exception 'publication activation transition mismatch'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create or replace function enforce_publication_activation_pointer_sync()
returns trigger
language plpgsql
as $$
declare
  latest_sequence bigint;
  pointer active_publication_versions%rowtype;
begin
  select max(activation_sequence)
    into latest_sequence
    from publication_activation_history
   where publication_id = new.publication_id;

  if new.activation_sequence <> latest_sequence then
    return new;
  end if;

  select *
    into pointer
    from active_publication_versions
   where publication_id = new.publication_id;

  if pointer.publication_id is null
     or pointer.publication_version_id <>
        new.to_publication_version_id
     or pointer.activation_id <> new.activation_id
     or pointer.activation_sequence <> new.activation_sequence then
    raise exception 'active publication pointer mismatch'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create constraint trigger publication_activation_pointer_guard
  after insert on publication_activation_history
  deferrable initially deferred
  for each row execute function enforce_publication_activation_pointer_sync();
