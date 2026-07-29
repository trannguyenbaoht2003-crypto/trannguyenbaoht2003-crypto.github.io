create table publications (
  publication_id uuid primary key,
  candidate_id uuid not null unique
    references candidates(candidate_id),
  created_by text not null
    check (octet_length(created_by) between 1 and 256),
  created_at timestamptz not null default clock_timestamp(),
  unique (publication_id, candidate_id)
);

create table publication_versions (
  publication_version_id uuid primary key,
  version_sequence bigint generated always as identity unique,
  publication_id uuid not null,
  candidate_id uuid not null,
  candidate_revision_id uuid not null,
  patch_id uuid not null,
  catalog_revision_id uuid not null,
  candidate_normalized_signature text not null
    check (candidate_normalized_signature ~ '^[a-f0-9]{64}$'),
  eligibility_policy_revision_id uuid not null
    references eligibility_policy_revisions(
      eligibility_policy_revision_id
    ),
  candidate_eligibility_evaluation_id uuid not null,
  eligibility_input_hash text not null
    check (eligibility_input_hash ~ '^[a-f0-9]{64}$'),
  moderation_policy_revision_id uuid not null
    references moderation_policy_revisions(
      moderation_policy_revision_id
    ),
  moderation_decision_id uuid not null,
  moderation_input_hash text not null
    check (moderation_input_hash ~ '^[a-f0-9]{64}$'),
  version_number integer not null check (version_number > 0),
  publication_payload jsonb not null
    check (jsonb_typeof(publication_payload) = 'object'),
  payload_hash text not null
    check (payload_hash ~ '^[a-f0-9]{64}$'),
  published_by text not null
    check (octet_length(published_by) between 1 and 256),
  correlation_id text not null
    check (octet_length(correlation_id) between 1 and 256),
  published_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp(),
  unique (publication_id, version_number),
  unique (publication_version_id, publication_id),
  unique (
    publication_version_id,
    publication_id,
    candidate_id,
    candidate_revision_id
  ),
  foreign key (publication_id, candidate_id)
    references publications(publication_id, candidate_id),
  foreign key (
    candidate_revision_id,
    candidate_id,
    patch_id,
    catalog_revision_id
  ) references candidate_revisions (
    candidate_revision_id,
    candidate_id,
    patch_id,
    catalog_revision_id
  ),
  foreign key (
    candidate_eligibility_evaluation_id,
    candidate_id,
    candidate_revision_id,
    eligibility_policy_revision_id,
    eligibility_input_hash
  ) references candidate_eligibility_evaluations (
    candidate_eligibility_evaluation_id,
    candidate_id,
    candidate_revision_id,
    eligibility_policy_revision_id,
    input_hash
  ),
  foreign key (
    moderation_decision_id,
    candidate_id,
    candidate_revision_id,
    moderation_policy_revision_id,
    moderation_input_hash
  ) references moderation_decisions (
    moderation_decision_id,
    candidate_id,
    candidate_revision_id,
    moderation_policy_revision_id,
    input_hash
  )
);

create index publication_versions_candidate_revision_idx
  on publication_versions (candidate_revision_id, version_sequence);

create table publication_version_input_required_claims (
  publication_version_id uuid not null,
  publication_id uuid not null,
  candidate_id uuid not null,
  candidate_revision_id uuid not null,
  claim_id uuid not null,
  claim_evidence_decision_id uuid not null,
  evidence_decision text not null
    check (
      evidence_decision in (
        'supported',
        'insufficient',
        'contradicted'
      )
    ),
  evidence_policy_revision_id uuid not null
    references evidence_policy_revisions(
      evidence_policy_revision_id
    ),
  ordinal integer not null check (ordinal > 0),
  created_at timestamptz not null default clock_timestamp(),
  primary key (publication_version_id, claim_id),
  unique (publication_version_id, ordinal),
  foreign key (
    publication_version_id,
    publication_id,
    candidate_id,
    candidate_revision_id
  ) references publication_versions (
    publication_version_id,
    publication_id,
    candidate_id,
    candidate_revision_id
  ),
  foreign key (
    claim_id,
    candidate_revision_id,
    importance
  ) references candidate_claims (
    claim_id,
    candidate_revision_id,
    importance
  ),
  foreign key (claim_evidence_decision_id)
    references claim_evidence_decisions(
      claim_evidence_decision_id
    )
);

create table publication_activation_history (
  activation_id uuid primary key,
  activation_sequence bigint generated always as identity unique,
  publication_id uuid not null
    references publications(publication_id),
  activation_kind text not null
    check (activation_kind in ('published', 'rolled_back')),
  from_publication_version_id uuid,
  to_publication_version_id uuid not null,
  actor_id text not null
    check (octet_length(actor_id) between 1 and 256),
  audit_event_id uuid not null unique
    references audit_events(audit_event_id),
  outbox_event_id uuid not null unique
    references outbox_events(outbox_event_id),
  correlation_id text not null
    check (octet_length(correlation_id) between 1 and 256),
  activated_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp(),
  unique (activation_id, publication_id, to_publication_version_id),
  foreign key (from_publication_version_id, publication_id)
    references publication_versions(
      publication_version_id,
      publication_id
    ),
  foreign key (to_publication_version_id, publication_id)
    references publication_versions(
      publication_version_id,
      publication_id
    ),
  check (
    from_publication_version_id is null
    or from_publication_version_id <> to_publication_version_id
  )
);

create index publication_activation_history_publication_idx
  on publication_activation_history (
    publication_id,
    activation_sequence
  );

create table active_publication_versions (
  publication_id uuid primary key
    references publications(publication_id),
  publication_version_id uuid not null unique,
  activation_id uuid not null unique,
  activation_sequence bigint not null unique,
  updated_at timestamptz not null default clock_timestamp(),
  foreign key (publication_version_id, publication_id)
    references publication_versions(
      publication_version_id,
      publication_id
    ),
  foreign key (
    activation_id,
    publication_id,
    publication_version_id
  ) references publication_activation_history (
    activation_id,
    publication_id,
    to_publication_version_id
  )
);

create table publication_projection_effects (
  outbox_event_id uuid primary key
    references outbox_events(outbox_event_id),
  publication_id uuid not null
    references publications(publication_id),
  publication_version_id uuid not null,
  event_type text not null
    check (
      event_type in (
        'PublicationPublished',
        'PublicationRolledBack'
      )
    ),
  projected_state text not null
    check (projected_state in ('active', 'rolled_back')),
  projected_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp(),
  foreign key (publication_version_id, publication_id)
    references publication_versions(
      publication_version_id,
      publication_id
    )
);

create trigger publications_immutable
before update or delete on publications
for each row execute function reject_immutable_change();

create trigger publication_versions_immutable
before update or delete on publication_versions
for each row execute function reject_immutable_change();

create trigger publication_version_input_required_claims_immutable
before update or delete on publication_version_input_required_claims
for each row execute function reject_immutable_change();

create trigger publication_activation_history_immutable
before update or delete on publication_activation_history
for each row execute function reject_immutable_change();
