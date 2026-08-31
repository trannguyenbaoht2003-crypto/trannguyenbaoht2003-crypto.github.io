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

export type OperatorCandidateReviewState = 'unreviewed' | 'in_progress';

export type OperatorCandidateConfidenceBand =
  | 'unscored'
  | 'low'
  | 'medium'
  | 'high'
  | 'very_high';

export type OperatorCandidateConfidence = {
  scoreId: string;
  scoringVersion: 'candidate-confidence-v1';
  score: number;
  band: Exclude<OperatorCandidateConfidenceBand, 'unscored'>;
  components: {
    provenanceQualityScore: 0 | 20 | 30;
    evidenceDiversityScore: 0 | 10 | 25;
    patchAlignmentScore: 0 | 10 | 20;
    freshnessScore: 0 | 5 | 15;
  };
  evaluatedAt: string;
  createdAt: string;
};

export type OperatorCandidateReviewQueueItem = {
  candidateId: string;
  candidateRevisionId: string;
  revision: number;
  patchId: string;
  catalogRevisionId: string;
  subjectExternalId: string;
  selection: {
    augmentExternalIds: string[];
    itemExternalIds: string[];
  };
  createdAt: string;
  review: {
    state: OperatorCandidateReviewState;
    confirmedCount: number;
    requiredCount: number;
  };
  confidence: OperatorCandidateConfidence | null;
};

export type OperatorCandidateReviewQueue = {
  schemaVersion: 1;
  generatedAt: string;
  activeReviewPolicyRevisionId: string;
  limit: number;
  summary: {
    returned: number;
    unreviewed: number;
    inProgress: number;
    unscored: number;
    low: number;
    medium: number;
    high: number;
    veryHigh: number;
  };
  items: OperatorCandidateReviewQueueItem[];
};

export type OperatorCandidateReviewQueueOptions = {
  limit?: number;
  now?: Date;
};
