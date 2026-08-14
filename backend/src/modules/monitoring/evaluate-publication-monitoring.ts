import { randomUUID } from 'node:crypto';

import type { Pool, PoolClient } from 'pg';

import { withTransaction } from '../../database/transaction.js';
import {
  loadEligibilityAuthority,
} from '../eligibility/load-eligibility-authority.js';
import {
  requireUuid,
} from '../trust/normalize-trust-input.js';
import {
  computePublicationMonitoring,
} from './compute-publication-monitoring.js';
import type {
  PublicationMonitoringAlertCode,
  PublicationMonitoringComputation,
  PublicationMonitoringEligibilityOutcome,
  PublicationMonitoringSeverity,
  PublicationMonitoringSourceKind,
} from './types.js';

const MONITORING_ACTOR = 'post-publication-monitor-v1';
const MONITORING_VERSION = 'post-publication-monitor-v1';

export interface EvaluatePublicationMonitoringInput {
  sourceOutboxEventId: string;
  expectedEventType:
    | 'CandidateEligibilityEvaluated'
    | 'PublicationMonitoringRequested';
}

export interface EvaluatePublicationMonitoringResult {
  outcome: 'evaluated' | 'not_applicable' | 'duplicate_noop';
  publicationId: string | null;
  publicationVersionId: string | null;
  alertCode: PublicationMonitoringAlertCode | null;
}

interface SourceOutboxRow {
  aggregate_id: string;
  aggregate_type: string;
  correlation_id: string;
  created_at: Date;
  event_type: string;
  payload: unknown;
}

interface MonitoringSource {
  candidateId: string | null;
  candidateRevisionId: string | null;
  correlationId: string;
  createdAt: Date;
  eventType:
    | 'CandidateEligibilityEvaluated'
    | 'PublicationMonitoringRequested';
  publicationId: string | null;
  sourceKind: PublicationMonitoringSourceKind;
}

interface ActivePublicationAuthority {
  candidateId: string;
  candidateRevisionId: string;
  publicationId: string;
  publicationVersionId: string;
}

interface CurrentEligibilityAuthority {
  current: boolean;
  eligibilityEvaluationId: string | null;
  eligibilityInputHash: string | null;
  eligibilityOutcome: PublicationMonitoringEligibilityOutcome | null;
  eligibilityPolicyRevisionId: string | null;
}

interface CurrentAlertPointer {
  alert_code: PublicationMonitoringAlertCode;
  publication_monitoring_alert_event_id: string;
  publication_monitoring_evaluation_id: string;
  publication_version_id: string;
  severity: PublicationMonitoringSeverity;
  state: 'open' | 'resolved';
}

interface MonitoringEffectRow {
  publication_id: string | null;
  publication_version_id: string | null;
}

function invalidSource(error?: unknown): never {
  throw new Error('INVALID_PUBLICATION_MONITORING_SOURCE_EVENT', {
    cause: error,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  return actual.length === canonical.length
    && actual.every((key, index) => key === canonical[index]);
}

function requirePayloadUuid(
  payload: Record<string, unknown>,
  key: string,
): string {
  const value = payload[key];
  if (typeof value !== 'string') {
    invalidSource();
  }
  try {
    return requireUuid(value, key);
  } catch (error) {
    invalidSource(error);
  }
}

async function loadSource(
  client: PoolClient,
  sourceOutboxEventId: string,
  expectedEventType: EvaluatePublicationMonitoringInput['expectedEventType'],
): Promise<MonitoringSource> {
  let sourceId: string;
  try {
    sourceId = requireUuid(sourceOutboxEventId, 'sourceOutboxEventId');
  } catch (error) {
    invalidSource(error);
  }

  const result = await client.query<SourceOutboxRow>(
    `select aggregate_id, aggregate_type, correlation_id, created_at,
            event_type, payload
       from outbox_events
      where outbox_event_id = $1
      for key share`,
    [sourceId],
  );
  const row = result.rows[0];
  if (!row || row.event_type !== expectedEventType || !isRecord(row.payload)) {
    invalidSource();
  }

  if (expectedEventType === 'CandidateEligibilityEvaluated') {
    const candidateId = requirePayloadUuid(row.payload, 'candidateId');
    const candidateRevisionId = requirePayloadUuid(
      row.payload,
      'candidateRevisionId',
    );
    const evaluationId = requirePayloadUuid(row.payload, 'evaluationId');
    if (
      row.aggregate_type !== 'candidate_revision'
      || row.aggregate_id !== candidateRevisionId
    ) {
      invalidSource();
    }
    const relation = await client.query(
      `select 1
         from candidate_revisions revision
         join candidate_eligibility_evaluations evaluation
           on evaluation.candidate_revision_id = revision.candidate_revision_id
          and evaluation.candidate_id = revision.candidate_id
        where revision.candidate_revision_id = $1
          and revision.candidate_id = $2
          and evaluation.candidate_eligibility_evaluation_id = $3`,
      [candidateRevisionId, candidateId, evaluationId],
    );
    if (relation.rowCount !== 1) {
      invalidSource();
    }
    return {
      candidateId,
      candidateRevisionId,
      correlationId: row.correlation_id,
      createdAt: row.created_at,
      eventType: expectedEventType,
      publicationId: null,
      sourceKind: 'eligibility',
    };
  }

  if (!exactKeys(row.payload, [
    'activationId',
    'publicationId',
    'requestedReason',
    'schemaVersion',
  ])) {
    invalidSource();
  }
  const publicationId = requirePayloadUuid(row.payload, 'publicationId');
  const activationId = requirePayloadUuid(row.payload, 'activationId');
  if (
    row.aggregate_type !== 'publication'
    || row.aggregate_id !== publicationId
    || row.payload.schemaVersion !== 1
    || (
      row.payload.requestedReason !== 'published'
      && row.payload.requestedReason !== 'rolled_back'
    )
  ) {
    invalidSource();
  }
  const activation = await client.query(
    `select 1
       from publication_activation_history
      where activation_id = $1
        and publication_id = $2`,
    [activationId, publicationId],
  );
  if (activation.rowCount !== 1) {
    invalidSource();
  }
  return {
    candidateId: null,
    candidateRevisionId: null,
    correlationId: row.correlation_id,
    createdAt: row.created_at,
    eventType: expectedEventType,
    publicationId,
    sourceKind: 'lifecycle',
  };
}

async function loadReplay(
  client: PoolClient,
  sourceOutboxEventId: string,
): Promise<MonitoringEffectRow | null> {
  const result = await client.query<MonitoringEffectRow>(
    `select publication_id, publication_version_id
       from publication_monitoring_effects
      where trigger_outbox_event_id = $1`,
    [sourceOutboxEventId],
  );
  return result.rows[0] ?? null;
}

async function recordNotApplicable(
  client: PoolClient,
  sourceOutboxEventId: string,
  publicationId: string | null,
  publicationVersionId: string | null,
): Promise<EvaluatePublicationMonitoringResult> {
  await client.query(
    `insert into publication_monitoring_effects
       (trigger_outbox_event_id, publication_id, publication_version_id,
        publication_monitoring_evaluation_id, effect_outcome)
     values ($1, $2, $3, null, 'not_applicable')`,
    [sourceOutboxEventId, publicationId, publicationVersionId],
  );
  return {
    outcome: 'not_applicable',
    publicationId,
    publicationVersionId,
    alertCode: null,
  };
}

async function findPublicationForCandidate(
  client: PoolClient,
  candidateId: string,
): Promise<string | null> {
  const result = await client.query<{ publication_id: string }>(
    `select publication_id
       from publications
      where candidate_id = $1`,
    [candidateId],
  );
  return result.rows[0]?.publication_id ?? null;
}

async function lockActivePublication(
  client: PoolClient,
  publicationId: string,
): Promise<ActivePublicationAuthority | null> {
  const publication = await client.query(
    `select publication_id
       from publications
      where publication_id = $1
      for update`,
    [publicationId],
  );
  if (publication.rowCount !== 1) {
    return null;
  }

  const active = await client.query<{ publication_version_id: string }>(
    `select publication_version_id
       from active_publication_versions
      where publication_id = $1
      for update`,
    [publicationId],
  );
  const publicationVersionId = active.rows[0]?.publication_version_id;
  if (!publicationVersionId) {
    return null;
  }
  const version = await client.query<{
    candidate_id: string;
    candidate_revision_id: string;
  }>(
    `select candidate_id, candidate_revision_id
       from publication_versions
      where publication_version_id = $1
        and publication_id = $2
      for key share`,
    [publicationVersionId, publicationId],
  );
  const row = version.rows[0];
  if (!row) {
    throw new Error('PUBLICATION_MONITORING_AUTHORITY_INVALID');
  }
  return {
    candidateId: row.candidate_id,
    candidateRevisionId: row.candidate_revision_id,
    publicationId,
    publicationVersionId,
  };
}

async function loadCurrentEligibility(
  client: PoolClient,
  candidateId: string,
  candidateRevisionId: string,
): Promise<CurrentEligibilityAuthority> {
  const authority = await loadEligibilityAuthority(
    client,
    candidateId,
    candidateRevisionId,
    { lock: false },
  );
  if (
    !authority.activePolicy
    || !authority.computationInput
    || !authority.inputHash
  ) {
    return {
      current: false,
      eligibilityEvaluationId: null,
      eligibilityInputHash: null,
      eligibilityOutcome: null,
      eligibilityPolicyRevisionId: null,
    };
  }
  const result = await client.query<{
    candidate_eligibility_evaluation_id: string;
    input_hash: string;
    outcome: PublicationMonitoringEligibilityOutcome;
  }>(
    `select evaluation.candidate_eligibility_evaluation_id,
            evaluation.input_hash,
            evaluation.outcome
       from current_candidate_eligibility_evaluations current
       join candidate_eligibility_evaluations evaluation
         on evaluation.candidate_eligibility_evaluation_id =
            current.candidate_eligibility_evaluation_id
      where current.candidate_revision_id = $1
        and current.eligibility_policy_revision_id = $2`,
    [
      candidateRevisionId,
      authority.activePolicy.eligibilityPolicyRevisionId,
    ],
  );
  const row = result.rows[0];
  if (!row || row.input_hash !== authority.inputHash) {
    return {
      current: false,
      eligibilityEvaluationId: null,
      eligibilityInputHash: null,
      eligibilityOutcome: null,
      eligibilityPolicyRevisionId: null,
    };
  }
  return {
    current: true,
    eligibilityEvaluationId: row.candidate_eligibility_evaluation_id,
    eligibilityInputHash: row.input_hash,
    eligibilityOutcome: row.outcome,
    eligibilityPolicyRevisionId:
      authority.activePolicy.eligibilityPolicyRevisionId,
  };
}

async function loadCurrentAlerts(
  client: PoolClient,
  publicationId: string,
): Promise<Map<PublicationMonitoringAlertCode, CurrentAlertPointer>> {
  const result = await client.query<CurrentAlertPointer>(
    `select current.alert_code,
            current.publication_monitoring_alert_event_id,
            event.publication_monitoring_evaluation_id,
            current.publication_version_id,
            current.severity,
            current.state
       from current_publication_monitoring_alerts current
       join publication_monitoring_alert_events event
         on event.publication_monitoring_alert_event_id =
            current.publication_monitoring_alert_event_id
      where current.publication_id = $1
      order by current.alert_code
      for update of current`,
    [publicationId],
  );
  return new Map(result.rows.map((row) => [row.alert_code, row]));
}

function alertSeverity(
  alertCode: PublicationMonitoringAlertCode,
): PublicationMonitoringSeverity {
  return alertCode === 'ACTIVE_PUBLICATION_INELIGIBLE'
    ? 'critical'
    : 'warning';
}

async function persistAlertTransition(
  client: PoolClient,
  input: {
    alertCode: PublicationMonitoringAlertCode;
    correlationId: string;
    monitoringEvaluationId: string;
    publicationId: string;
    publicationVersionId: string;
    severity: PublicationMonitoringSeverity;
    state: 'open' | 'resolved';
  },
): Promise<CurrentAlertPointer> {
  const alertEventId = randomUUID();
  const auditEventId = randomUUID();
  const outboxEventId = randomUUID();
  const action = input.state === 'open'
    ? 'monitoring.publication_alert_opened'
    : 'monitoring.publication_alert_resolved';
  const outputEventType = input.state === 'open'
    ? 'PublicationMonitoringAlertOpened'
    : 'PublicationMonitoringAlertResolved';
  const auditPayload = {
    publicationId: input.publicationId,
    publicationVersionId: input.publicationVersionId,
    publicationMonitoringEvaluationId: input.monitoringEvaluationId,
    alertCode: input.alertCode,
    severity: input.severity,
    state: input.state,
  };
  await client.query(
    `insert into audit_events
       (audit_event_id, actor_id, action, reason, correlation_id, payload)
     values ($1, $2, $3, $4, $5, $6::jsonb)`,
    [
      auditEventId,
      MONITORING_ACTOR,
      action,
      input.alertCode,
      input.correlationId,
      JSON.stringify(auditPayload),
    ],
  );
  await client.query(
    `insert into outbox_events
       (outbox_event_id, aggregate_type, aggregate_id, event_type,
        payload, correlation_id)
     values ($1, 'publication_monitoring_alert', $2, $3,
             $4::jsonb, $5)`,
    [
      outboxEventId,
      alertEventId,
      outputEventType,
      JSON.stringify({
        schemaVersion: 1,
        publicationMonitoringAlertEventId: alertEventId,
        publicationId: input.publicationId,
        alertCode: input.alertCode,
        state: input.state,
      }),
      input.correlationId,
    ],
  );
  await client.query(
    `insert into publication_monitoring_alert_events
       (publication_monitoring_alert_event_id, publication_id,
        publication_version_id, publication_monitoring_evaluation_id,
        alert_code, severity, state, audit_event_id, outbox_event_id,
        correlation_id, actor_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      alertEventId,
      input.publicationId,
      input.publicationVersionId,
      input.monitoringEvaluationId,
      input.alertCode,
      input.severity,
      input.state,
      auditEventId,
      outboxEventId,
      input.correlationId,
      MONITORING_ACTOR,
    ],
  );
  await client.query(
    `insert into current_publication_monitoring_alerts
       (publication_id, alert_code,
        publication_monitoring_alert_event_id, state, severity,
        publication_version_id)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (publication_id, alert_code) do update
       set publication_monitoring_alert_event_id =
             excluded.publication_monitoring_alert_event_id,
           state = excluded.state,
           severity = excluded.severity,
           publication_version_id = excluded.publication_version_id,
           updated_at = clock_timestamp()`,
    [
      input.publicationId,
      input.alertCode,
      alertEventId,
      input.state,
      input.severity,
      input.publicationVersionId,
    ],
  );
  return {
    alert_code: input.alertCode,
    publication_monitoring_alert_event_id: alertEventId,
    publication_monitoring_evaluation_id: input.monitoringEvaluationId,
    publication_version_id: input.publicationVersionId,
    severity: input.severity,
    state: input.state,
  };
}

async function persistEvaluation(
  client: PoolClient,
  sourceOutboxEventId: string,
  source: MonitoringSource,
  active: ActivePublicationAuthority,
  eligibility: CurrentEligibilityAuthority,
  computation: Exclude<PublicationMonitoringComputation, { outcome: 'not_applicable' }>,
): Promise<string> {
  const monitoringEvaluationId = randomUUID();
  await client.query(
    `insert into publication_monitoring_evaluations
       (publication_monitoring_evaluation_id, trigger_outbox_event_id,
        publication_id, publication_version_id, candidate_id,
        candidate_revision_id, candidate_eligibility_evaluation_id,
        eligibility_policy_revision_id, eligibility_input_hash,
        monitoring_version, outcome, reason_code, evaluated_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [
      monitoringEvaluationId,
      sourceOutboxEventId,
      active.publicationId,
      active.publicationVersionId,
      active.candidateId,
      active.candidateRevisionId,
      eligibility.eligibilityEvaluationId,
      eligibility.eligibilityPolicyRevisionId,
      eligibility.eligibilityInputHash,
      MONITORING_VERSION,
      computation.outcome,
      computation.alertCode,
      source.createdAt,
    ],
  );
  return monitoringEvaluationId;
}

export async function evaluatePublicationMonitoring(
  pool: Pool,
  input: EvaluatePublicationMonitoringInput,
): Promise<EvaluatePublicationMonitoringResult> {
  return withTransaction(pool, async (client) => {
    const source = await loadSource(
      client,
      input.sourceOutboxEventId,
      input.expectedEventType,
    );
    const replay = await loadReplay(client, input.sourceOutboxEventId);
    if (replay) {
      return {
        outcome: 'duplicate_noop',
        publicationId: replay.publication_id,
        publicationVersionId: replay.publication_version_id,
        alertCode: null,
      };
    }

    let publicationId = source.publicationId;
    if (source.sourceKind === 'eligibility') {
      if (!source.candidateId || !source.candidateRevisionId) {
        invalidSource();
      }
      publicationId = await findPublicationForCandidate(
        client,
        source.candidateId,
      );
      if (!publicationId) {
        return recordNotApplicable(
          client,
          input.sourceOutboxEventId,
          null,
          null,
        );
      }
    }
    if (!publicationId) {
      invalidSource();
    }

    const active = await lockActivePublication(client, publicationId);
    if (!active) {
      return recordNotApplicable(
        client,
        input.sourceOutboxEventId,
        publicationId,
        null,
      );
    }
    const sourceRevisionMatches = source.sourceKind === 'lifecycle'
      || active.candidateRevisionId === source.candidateRevisionId;
    if (!sourceRevisionMatches) {
      return recordNotApplicable(
        client,
        input.sourceOutboxEventId,
        active.publicationId,
        active.publicationVersionId,
      );
    }

    const eligibility = await loadCurrentEligibility(
      client,
      active.candidateId,
      active.candidateRevisionId,
    );
    const computation = computePublicationMonitoring({
      sourceKind: source.sourceKind,
      activeVersionMatchesEligibilitySource: sourceRevisionMatches,
      hasActivePublication: true,
      eligibilityCurrent: eligibility.current,
      eligibilityOutcome: eligibility.eligibilityOutcome,
    });
    if (computation.outcome === 'not_applicable') {
      return recordNotApplicable(
        client,
        input.sourceOutboxEventId,
        active.publicationId,
        active.publicationVersionId,
      );
    }

    const monitoringEvaluationId = await persistEvaluation(
      client,
      input.sourceOutboxEventId,
      source,
      active,
      eligibility,
      computation,
    );
    const pointers = await loadCurrentAlerts(client, active.publicationId);

    for (const [alertCode, pointer] of pointers) {
      if (pointer.state !== 'open') {
        continue;
      }
      const keepOpen = pointer.publication_version_id === active.publicationVersionId
        && alertCode === computation.alertCode;
      if (keepOpen) {
        continue;
      }
      const resolvingEvaluationId =
        pointer.publication_version_id === active.publicationVersionId
          ? monitoringEvaluationId
          : pointer.publication_monitoring_evaluation_id;
      const resolved = await persistAlertTransition(client, {
        alertCode,
        correlationId: source.correlationId,
        monitoringEvaluationId: resolvingEvaluationId,
        publicationId: active.publicationId,
        publicationVersionId: pointer.publication_version_id,
        severity: pointer.severity,
        state: 'resolved',
      });
      pointers.set(alertCode, resolved);
    }

    if (computation.alertCode) {
      const desired = pointers.get(computation.alertCode);
      const alreadyOpen = desired?.state === 'open'
        && desired.publication_version_id === active.publicationVersionId;
      if (!alreadyOpen) {
        const opened = await persistAlertTransition(client, {
          alertCode: computation.alertCode,
          correlationId: source.correlationId,
          monitoringEvaluationId,
          publicationId: active.publicationId,
          publicationVersionId: active.publicationVersionId,
          severity: alertSeverity(computation.alertCode),
          state: 'open',
        });
        pointers.set(computation.alertCode, opened);
      }
    }

    await client.query(
      `insert into publication_monitoring_effects
         (trigger_outbox_event_id, publication_id,
          publication_version_id, publication_monitoring_evaluation_id,
          effect_outcome)
       values ($1, $2, $3, $4, 'evaluated')`,
      [
        input.sourceOutboxEventId,
        active.publicationId,
        active.publicationVersionId,
        monitoringEvaluationId,
      ],
    );

    return {
      outcome: 'evaluated',
      publicationId: active.publicationId,
      publicationVersionId: active.publicationVersionId,
      alertCode: computation.alertCode,
    };
  });
}
