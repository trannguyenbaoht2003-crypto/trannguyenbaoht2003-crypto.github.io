import type {
  FeedbackReasonCode,
  PublicationFeedbackSignal,
} from '../feedback/types.js';
import type {
  PublicationMonitoringAlertCode,
  PublicationMonitoringEligibilityOutcome,
  PublicationMonitoringSeverity,
} from '../monitoring/types.js';

export type OperatorPriority = 'critical' | 'warning' | 'feedback';

export type OperatorMonitoringAlert = {
  alertCode: PublicationMonitoringAlertCode;
  severity: PublicationMonitoringSeverity;
  evaluatedAt: string;
  candidateRevisionId: string;
  eligibilityOutcome: PublicationMonitoringEligibilityOutcome | null;
  eligibilityReason: string | null;
};

export type OperatorFeedbackSignal = Pick<
  PublicationFeedbackSignal,
  'totalCount' | 'countsByReason' | 'newestReceivedAt' | 'recentDetails'
> & {
  countsByReason: Partial<Record<FeedbackReasonCode, number>>;
};

export type OperatorPublicationSignal = {
  publicationId: string;
  publicationVersionId: string;
  isActiveVersion: boolean;
  priority: OperatorPriority;
  monitoringAlert: OperatorMonitoringAlert | null;
  feedback: OperatorFeedbackSignal | null;
};

export type OperatorSnapshot = {
  schemaVersion: 1;
  generatedAt: string;
  sinceHours: number;
  summary: {
    critical: number;
    warning: number;
    feedbackOnly: number;
    total: number;
  };
  signals: OperatorPublicationSignal[];
};
