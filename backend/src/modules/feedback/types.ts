export const FEEDBACK_REASON_CODES = [
  'OUTDATED',
  'WRONG_BUILD',
  'WRONG_ITEMS',
  'WRONG_AUGMENTS',
  'MISMATCHED_CHAMPION',
  'OTHER',
] as const;

export type FeedbackReasonCode = (typeof FEEDBACK_REASON_CODES)[number];

export type NormalizedFeedbackInput = {
  schemaVersion: 1;
  submissionId: string;
  publicationVersionId: string;
  reasonCode: FeedbackReasonCode;
  details: string | null;
};

export type SubmitPublicationFeedbackCommand = NormalizedFeedbackInput & {
  publicationId: string;
  requestHash: string;
  receivedAt: Date;
};

export type SubmitPublicationFeedbackResult =
  | { outcome: 'accepted'; replayed: boolean }
  | { outcome: 'not_found' }
  | { outcome: 'conflict' };

export type FeedbackRateLimitInput = {
  fingerprint: string;
  submissionId: string;
  publicationVersionId: string;
  reasonCode: FeedbackReasonCode;
};

export type FeedbackRateLimitResult =
  | { outcome: 'allowed' }
  | { outcome: 'replay_pass' }
  | { outcome: 'denied'; retryAfterSeconds: number };

export interface FeedbackRateLimiter {
  check(input: FeedbackRateLimitInput): Promise<FeedbackRateLimitResult>;
}

export type PublicationFeedbackSignal = {
  publicationId: string;
  publicationVersionId: string;
  isActive: boolean;
  totalCount: number;
  countsByReason: Partial<Record<FeedbackReasonCode, number>>;
  newestReceivedAt: string;
  recentDetails: Array<{
    reasonCode: FeedbackReasonCode;
    details: string;
    receivedAt: string;
  }>;
};
