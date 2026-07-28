create table moderation_policy_revisions (
  moderation_policy_revision_id uuid primary key,
  policy_key text not null collate "C"
    check (
      octet_length(policy_key) between 1 and 128
      and policy_key ~ '^[!-~]+$'
    ),
  revision integer not null check (revision > 0),
  schema_version integer not null check (schema_version = 1),
  reason text not null
    check (octet_length(reason) between 1 and 1024),
  created_by text not null
    check (octet_length(created_by) between 1 and 256),
  created_at timestamptz not null default clock_timestamp(),
  unique (policy_key, revision),
  unique (moderation_policy_revision_id, policy_key)
);

create table eligibility_policy_revisions (
  eligibility_policy_revision_id uuid primary key,
  policy_key text not null collate "C"
    check (
      octet_length(policy_key) between 1 and 128
      and policy_key ~ '^[!-~]+$'
    ),
  revision integer not null check (revision > 0),
  schema_version integer not null check (schema_version = 1),
  evidence_policy_revision_id uuid not null
    references evidence_policy_revisions(evidence_policy_revision_id),
  review_policy_revision_id uuid not null
    references review_policy_revisions(review_policy_revision_id),
  moderation_policy_revision_id uuid not null
    references moderation_policy_revisions(
      moderation_policy_revision_id
    ),
  require_all_required_claims_supported boolean not null
    check (require_all_required_claims_supported),
  require_review_quorum_satisfied boolean not null
    check (require_review_quorum_satisfied),
  fail_closed_on_stale_input boolean not null
    check (fail_closed_on_stale_input),
  reason text not null
    check (octet_length(reason) between 1 and 1024),
  created_by text not null
    check (octet_length(created_by) between 1 and 256),
  created_at timestamptz not null default clock_timestamp(),
  unique (policy_key, revision),
  unique (
    eligibility_policy_revision_id,
    evidence_policy_revision_id,
    review_policy_revision_id,
    moderation_policy_revision_id
  )
);

create table active_eligibility_policy_revision (
  scope text primary key
    check (scope = 'candidate_revision'),
  eligibility_policy_revision_id uuid not null unique
    references eligibility_policy_revisions(
      eligibility_policy_revision_id
    ),
  updated_at timestamptz not null default clock_timestamp()
);

create trigger moderation_policy_revisions_immutable
before update or delete on moderation_policy_revisions
for each row execute function reject_immutable_change();

create trigger eligibility_policy_revisions_immutable
before update or delete on eligibility_policy_revisions
for each row execute function reject_immutable_change();
