import type { Pool } from 'pg';

import type { PgQueryable } from '../../database/queryable.js';
import {
  readPublicationFeedbackSignals,
  type ReadPublicationFeedbackSignalOptions,
} from '../feedback/read-publication-feedback-signals.js';
import type { PublicationFeedbackSignal } from '../feedback/types.js';
import {
  readOpenPublicationMonitoringAlerts,
} from '../monitoring/read-open-publication-monitoring-alerts.js';
import type { OpenPublicationMonitoringAlert } from '../monitoring/types.js';
import type {
  OperatorFeedbackSignal,
  OperatorMonitoringAlert,
  OperatorPriority,
  OperatorPublicationSignal,
  OperatorSnapshot,
} from './types.js';

export type ReadOperatorPublicationSignalsOptions =
  ReadPublicationFeedbackSignalOptions;

export type OperatorSignalReaderDependencies = {
  readMonitoring(
    database: PgQueryable,
  ): Promise<OpenPublicationMonitoringAlert[]>;
  readFeedback(
    database: PgQueryable,
    options: ReadPublicationFeedbackSignalOptions,
  ): Promise<PublicationFeedbackSignal[]>;
};

const DEFAULT_DEPENDENCIES: OperatorSignalReaderDependencies = {
  readMonitoring: readOpenPublicationMonitoringAlerts,
  readFeedback: readPublicationFeedbackSignals,
};

const PRIORITY_RANK: Record<OperatorPriority, number> = {
  critical: 0,
  warning: 1,
  feedback: 2,
};

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.trunc(value)));
}

function signalKey(publicationId: string, publicationVersionId: string): string {
  return `${publicationId}\u0000${publicationVersionId}`;
}

function toMonitoringAlert(
  alert: OpenPublicationMonitoringAlert,
): OperatorMonitoringAlert {
  return {
    alertCode: alert.alertCode,
    severity: alert.severity,
    evaluatedAt: alert.evaluatedAt,
    candidateRevisionId: alert.candidateRevisionId,
    eligibilityOutcome: alert.eligibilityOutcome,
    eligibilityReason: alert.eligibilityReason,
  };
}

function toFeedbackSignal(
  feedback: PublicationFeedbackSignal,
): OperatorFeedbackSignal {
  return {
    totalCount: feedback.totalCount,
    countsByReason: { ...feedback.countsByReason },
    newestReceivedAt: feedback.newestReceivedAt,
    recentDetails: feedback.recentDetails.map((detail) => ({ ...detail })),
  };
}

function latestTimestamp(signal: OperatorPublicationSignal): number {
  const candidates = [
    signal.monitoringAlert?.evaluatedAt,
    signal.feedback?.newestReceivedAt,
  ].filter((value): value is string => value !== undefined);

  return candidates.reduce((latest, value) => {
    const timestamp = Date.parse(value);
    return Number.isNaN(timestamp) ? latest : Math.max(latest, timestamp);
  }, 0);
}

function sortSignals(
  left: OperatorPublicationSignal,
  right: OperatorPublicationSignal,
): number {
  const priorityDifference =
    PRIORITY_RANK[left.priority] - PRIORITY_RANK[right.priority];
  if (priorityDifference !== 0) return priorityDifference;

  if (left.isActiveVersion !== right.isActiveVersion) {
    return left.isActiveVersion ? -1 : 1;
  }

  const feedbackDifference =
    (right.feedback?.totalCount ?? 0) - (left.feedback?.totalCount ?? 0);
  if (feedbackDifference !== 0) return feedbackDifference;

  const recencyDifference = latestTimestamp(right) - latestTimestamp(left);
  if (recencyDifference !== 0) return recencyDifference;

  const publicationDifference = left.publicationId.localeCompare(
    right.publicationId,
  );
  if (publicationDifference !== 0) return publicationDifference;

  return left.publicationVersionId.localeCompare(right.publicationVersionId);
}

export async function readOperatorPublicationSignals(
  pool: Pool,
  options: ReadOperatorPublicationSignalsOptions = {},
  dependencies: OperatorSignalReaderDependencies = DEFAULT_DEPENDENCIES,
): Promise<OperatorSnapshot> {
  const sinceHours = boundedInteger(options.sinceHours, 168, 1, 720);
  const limit = boundedInteger(options.limit, 50, 1, 100);
  const detailSampleLimit = boundedInteger(
    options.detailSampleLimit,
    3,
    0,
    5,
  );
  const now = options.now ?? new Date();
  const feedbackOptions: ReadPublicationFeedbackSignalOptions = {
    sinceHours,
    limit,
    detailSampleLimit,
    now,
  };

  const client = await pool.connect();
  try {
    await client.query(
      'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
    );

    const monitoringAlerts = await dependencies.readMonitoring(client);
    const feedbackSignals = await dependencies.readFeedback(
      client,
      feedbackOptions,
    );

    const feedbackByVersion = new Map(
      feedbackSignals.map((feedback) => [
        signalKey(feedback.publicationId, feedback.publicationVersionId),
        feedback,
      ]),
    );
    const matchedFeedbackKeys = new Set<string>();

    const signals: OperatorPublicationSignal[] = monitoringAlerts.map((alert) => {
      const key = signalKey(alert.publicationId, alert.publicationVersionId);
      const matchingFeedback = feedbackByVersion.get(key) ?? null;
      if (matchingFeedback) matchedFeedbackKeys.add(key);

      return {
        publicationId: alert.publicationId,
        publicationVersionId: alert.publicationVersionId,
        isActiveVersion: true,
        priority: alert.severity === 'critical' ? 'critical' : 'warning',
        monitoringAlert: toMonitoringAlert(alert),
        feedback: matchingFeedback ? toFeedbackSignal(matchingFeedback) : null,
      };
    });

    for (const feedback of feedbackSignals) {
      const key = signalKey(feedback.publicationId, feedback.publicationVersionId);
      if (matchedFeedbackKeys.has(key)) continue;
      signals.push({
        publicationId: feedback.publicationId,
        publicationVersionId: feedback.publicationVersionId,
        isActiveVersion: feedback.isActive,
        priority: 'feedback',
        monitoringAlert: null,
        feedback: toFeedbackSignal(feedback),
      });
    }

    signals.sort(sortSignals);

    const snapshot: OperatorSnapshot = {
      schemaVersion: 1,
      generatedAt: now.toISOString(),
      sinceHours,
      summary: {
        critical: signals.filter((signal) => signal.priority === 'critical').length,
        warning: signals.filter((signal) => signal.priority === 'warning').length,
        feedbackOnly: signals.filter((signal) => signal.priority === 'feedback').length,
        total: signals.length,
      },
      signals,
    };

    await client.query('COMMIT');
    return snapshot;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Preserve the source error; the connection is released below.
    }
    throw error;
  } finally {
    client.release();
  }
}
