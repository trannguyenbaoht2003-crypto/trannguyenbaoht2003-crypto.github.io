create table publication_monitoring_evaluations (
  publication_monitoring_evaluation_id uuid primary key,
  trigger_outbox_event_id uuid not null unique
    references outbox_events(outbox_event_id),
  publication_id uuid not null
    references publications(publication_id),
  publication_version_id uuid not null,
  candidate_id uuid not null,
  candidate_revision_id uuid not null,
  candidate_eligibility_evaluation_id uuid,
  eligibility_policy_revision_id uuid,
  eligibility_input_hash text
    check (
      eligibility_input_hash is null
      or eligibility_input_hash ~ '^[a-f0-9]{64}$'
    ),
  monitoring_version text not null
    check (monitoring_version = 'post-publication-monitor-v1'),
  outcome text not null
    check (outcome in ('healthy', 'warning', 'critical')),
  reason_code text
    check (
      reason_code is null
      or reason_code in (
        'ACTIVE_PUBLICATION_REVALIDATION_REQUIRED',
        'ACTIVE_PUBLICATION_NEEDS_REVIEW',
        'ACTIVE_PUBLICATION_INELIGIBLE'
      )
    ),
  evaluated_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp(),
  check (
    (
      candidate_eligibility_evaluation_id is null
      and eligibility_policy_revision_id is null
      and eligibility_input_hash is null
    )
    or
    (
      candidate_eligibility_evaluation_id is not null
      and eligibility_policy_revision_id is not null
      and eligibility_input_hash is not null
    )
  ),
  check (
    (outcome = 'healthy' and reason_code is null)
    or
    (
      outcome = 'warning'
      and reason_code in (
        'ACTIVE_PUBLICATION_REVALIDATION_REQUIRED',
        'ACTIVE_PUBLICATION_NEEDS_REVIEW'
      )
    )
    or
    (
      outcome = 'critical'
      and reason_code = 'ACTIVE_PUBLICATION_INELIGIBLE'
    )
  ),
  unique (
    publication_monitoring_evaluation_id,
    publication_id,
    publication_version_id
  ),
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
  )
);

create index publication_monitoring_evaluations_publication_idx
  on publication_monitoring_evaluations (
    publication_id,
    evaluated_at,
    publication_monitoring_evaluation_id
  );

create trigger publication_monitoring_evaluations_immutable
before update or delete on publication_monitoring_evaluations
for each row execute function reject_immutable_change();

create table publication_monitoring_alert_events (
  publication_monitoring_alert_event_id uuid primary key,
  publication_id uuid not null
    references publications(publication_id),
  publication_version_id uuid not null,
  publication_monitoring_evaluation_id uuid not null,
  alert_code text not null
    check (
      alert_code in (
        'ACTIVE_PUBLICATION_REVALIDATION_REQUIRED',
        'ACTIVE_PUBLICATION_NEEDS_REVIEW',
        'ACTIVE_PUBLICATION_INELIGIBLE'
      )
    ),
  severity text not null
    check (severity in ('warning', 'critical')),
  state text not null
    check (state in ('open', 'resolved')),
  audit_event_id uuid not null unique
    references audit_events(audit_event_id),
  outbox_event_id uuid not null unique
    references outbox_events(outbox_event_id),
  correlation_id text not null
    check (octet_length(correlation_id) between 1 and 256),
  actor_id text not null
    check (octet_length(actor_id) between 1 and 256),
  created_at timestamptz not null default clock_timestamp(),
  check (
    (alert_code = 'ACTIVE_PUBLICATION_INELIGIBLE' and severity = 'critical')
    or
    (
      alert_code in (
        'ACTIVE_PUBLICATION_REVALIDATION_REQUIRED',
        'ACTIVE_PUBLICATION_NEEDS_REVIEW'
      )
      and severity = 'warning'
    )
  ),
  unique (
    publication_monitoring_alert_event_id,
    publication_id,
    publication_version_id,
    alert_code,
    state,
    severity
  ),
  unique (
    publication_monitoring_alert_event_id,
    publication_id
  ),
  foreign key (
    publication_monitoring_evaluation_id,
    publication_id,
    publication_version_id
  ) references publication_monitoring_evaluations (
    publication_monitoring_evaluation_id,
    publication_id,
    publication_version_id
  )
);

create index publication_monitoring_alert_events_publication_idx
  on publication_monitoring_alert_events (
    publication_id,
    created_at,
    publication_monitoring_alert_event_id
  );

create trigger publication_monitoring_alert_events_immutable
before update or delete on publication_monitoring_alert_events
for each row execute function reject_immutable_change();

create table current_publication_monitoring_alerts (
  publication_id uuid not null
    references publications(publication_id),
  alert_code text not null
    check (
      alert_code in (
        'ACTIVE_PUBLICATION_REVALIDATION_REQUIRED',
        'ACTIVE_PUBLICATION_NEEDS_REVIEW',
        'ACTIVE_PUBLICATION_INELIGIBLE'
      )
    ),
  publication_monitoring_alert_event_id uuid not null unique,
  state text not null
    check (state in ('open', 'resolved')),
  severity text not null
    check (severity in ('warning', 'critical')),
  publication_version_id uuid not null,
  updated_at timestamptz not null default clock_timestamp(),
  primary key (publication_id, alert_code),
  foreign key (
    publication_monitoring_alert_event_id,
    publication_id,
    publication_version_id,
    alert_code,
    state,
    severity
  ) references publication_monitoring_alert_events (
    publication_monitoring_alert_event_id,
    publication_id,
    publication_version_id,
    alert_code,
    state,
    severity
  )
);

create index current_publication_monitoring_alerts_open_idx
  on current_publication_monitoring_alerts (
    state,
    severity,
    updated_at,
    publication_id
  );

create table publication_monitoring_effects (
  trigger_outbox_event_id uuid primary key
    references outbox_events(outbox_event_id),
  publication_id uuid
    references publications(publication_id),
  publication_version_id uuid,
  publication_monitoring_evaluation_id uuid,
  effect_outcome text not null
    check (effect_outcome in ('evaluated', 'not_applicable')),
  created_at timestamptz not null default clock_timestamp(),
  check (
    (
      effect_outcome = 'evaluated'
      and publication_id is not null
      and publication_version_id is not null
      and publication_monitoring_evaluation_id is not null
    )
    or
    (
      effect_outcome = 'not_applicable'
      and publication_monitoring_evaluation_id is null
    )
  ),
  foreign key (
    publication_monitoring_evaluation_id,
    publication_id,
    publication_version_id
  ) references publication_monitoring_evaluations (
    publication_monitoring_evaluation_id,
    publication_id,
    publication_version_id
  ),
  foreign key (publication_version_id, publication_id)
    references publication_versions(
      publication_version_id,
      publication_id
    )
);

create trigger publication_monitoring_effects_immutable
before update or delete on publication_monitoring_effects
for each row execute function reject_immutable_change();

create table publication_monitoring_delivery_effects (
  outbox_event_id uuid primary key
    references outbox_events(outbox_event_id),
  publication_monitoring_alert_event_id uuid not null unique,
  publication_id uuid not null
    references publications(publication_id),
  event_type text not null
    check (
      event_type in (
        'PublicationMonitoringAlertOpened',
        'PublicationMonitoringAlertResolved'
      )
    ),
  created_at timestamptz not null default clock_timestamp(),
  foreign key (
    publication_monitoring_alert_event_id,
    publication_id
  ) references publication_monitoring_alert_events (
    publication_monitoring_alert_event_id,
    publication_id
  )
);

create trigger publication_monitoring_delivery_effects_immutable
before update or delete on publication_monitoring_delivery_effects
for each row execute function reject_immutable_change();
