import type { Pool } from 'pg';

import {
  requireUuid,
} from '../trust/normalize-trust-input.js';
import type {
  OpenPublicationMonitoringAlert,
  PublicationMonitoringAlertCode,
  PublicationMonitoringEligibilityOutcome,
  PublicationMonitoringSeverity,
} from './types.js';

export type { OpenPublicationMonitoringAlert } from './types.js';

interface OpenAlertRow {
  publication_id: string;
  publication_version_id: string;
  active_publication_version_id: string | null;
  candidate_revision_id: string;
  alert_code: PublicationMonitoringAlertCode;
  severity: PublicationMonitoringSeverity;
  monitoring_reason_code: PublicationMonitoringAlertCode | null;
  evaluated_at: Date | string;
  eligibility_outcome: PublicationMonitoringEligibilityOutcome | null;
  eligibility_reason: string | null;
}

function parseTimestamp(value: Date | string): string {
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error('PUBLICATION_MONITORING_READ_INVALID');
  }
  return parsed.toISOString();
}

export async function readOpenPublicationMonitoringAlerts(
  pool: Pool,
): Promise<OpenPublicationMonitoringAlert[]> {
  const result = await pool.query<OpenAlertRow>(
    `select current.publication_id,
            current.publication_version_id,
            active.publication_version_id as active_publication_version_id,
            evaluation.candidate_revision_id,
            current.alert_code,
            current.severity,
            evaluation.reason_code as monitoring_reason_code,
            evaluation.evaluated_at,
            eligibility.outcome as eligibility_outcome,
            eligibility_reason.reason_code as eligibility_reason
       from current_publication_monitoring_alerts current
       join publication_monitoring_alert_events alert_event
         on alert_event.publication_monitoring_alert_event_id =
            current.publication_monitoring_alert_event_id
        and alert_event.publication_id = current.publication_id
        and alert_event.publication_version_id = current.publication_version_id
        and alert_event.alert_code = current.alert_code
        and alert_event.state = current.state
        and alert_event.severity = current.severity
       join publication_monitoring_evaluations evaluation
         on evaluation.publication_monitoring_evaluation_id =
            alert_event.publication_monitoring_evaluation_id
        and evaluation.publication_id = current.publication_id
        and evaluation.publication_version_id = current.publication_version_id
       left join candidate_eligibility_evaluations eligibility
         on eligibility.candidate_eligibility_evaluation_id =
            evaluation.candidate_eligibility_evaluation_id
       left join lateral (
         select reason.reason_code
           from candidate_eligibility_evaluation_reasons reason
          where reason.candidate_eligibility_evaluation_id =
                evaluation.candidate_eligibility_evaluation_id
          order by reason.ordinal
          limit 1
       ) eligibility_reason on true
       left join active_publication_versions active
         on active.publication_id = current.publication_id
      where current.state = 'open'
      order by case current.severity when 'critical' then 0 else 1 end,
               alert_event.created_at,
               current.publication_id`,
  );

  return result.rows.map((row) => {
    if (
      row.active_publication_version_id === null
      || row.active_publication_version_id !== row.publication_version_id
      || row.monitoring_reason_code === null
      || row.monitoring_reason_code !== row.alert_code
    ) {
      throw new Error('PUBLICATION_MONITORING_POINTER_STALE');
    }
    try {
      return {
        publicationId: requireUuid(row.publication_id, 'publicationId'),
        publicationVersionId: requireUuid(
          row.publication_version_id,
          'publicationVersionId',
        ),
        candidateRevisionId: requireUuid(
          row.candidate_revision_id,
          'candidateRevisionId',
        ),
        alertCode: row.alert_code,
        severity: row.severity,
        evaluatedAt: parseTimestamp(row.evaluated_at),
        eligibilityOutcome: row.eligibility_outcome,
        eligibilityReason: row.eligibility_reason,
      };
    } catch (error) {
      if (
        error instanceof Error
        && error.message === 'PUBLICATION_MONITORING_POINTER_STALE'
      ) {
        throw error;
      }
      throw new Error('PUBLICATION_MONITORING_READ_INVALID', {
        cause: error,
      });
    }
  });
}
