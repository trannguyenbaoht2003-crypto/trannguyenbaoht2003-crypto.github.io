create table publication_feedback_submissions (
  id uuid primary key,
  client_submission_id uuid not null unique,
  request_hash text not null check (request_hash ~ '^[a-f0-9]{64}$'),
  publication_id uuid not null references publications(publication_id),
  publication_version_id uuid not null,
  reason_code text not null check (
    reason_code in (
      'OUTDATED',
      'WRONG_BUILD',
      'WRONG_ITEMS',
      'WRONG_AUGMENTS',
      'MISMATCHED_CHAMPION',
      'OTHER'
    )
  ),
  details text,
  was_active_at_submission boolean not null,
  received_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp(),
  check (details is null or char_length(details) between 1 and 280),
  check (reason_code <> 'OTHER' or details is not null),
  foreign key (publication_version_id, publication_id)
    references publication_versions(publication_version_id, publication_id)
);

create index publication_feedback_submissions_target_idx
  on publication_feedback_submissions(
    publication_id,
    publication_version_id,
    received_at desc
  );

create trigger publication_feedback_submissions_immutable
before update or delete on publication_feedback_submissions
for each row execute function reject_immutable_change();
