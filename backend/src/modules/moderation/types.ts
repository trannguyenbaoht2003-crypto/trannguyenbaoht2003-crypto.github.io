export interface RegisterModerationPolicyRevisionCommand {
  actorId: string;
  correlationId: string;
  idempotencyKey: string;
  moderationPolicyRevisionId: string;
  policyKey: string;
  reason: string;
  revision: number;
  schemaVersion: 1;
}

export interface RegisterModerationPolicyRevisionResult {
  moderationPolicyRevisionId: string;
  replayed: boolean;
}

export type ModerationOutcome = 'clear' | 'needs_review' | 'blocked';

export interface RecordCandidateModerationDecisionCommand {
  actorId: string;
  candidateId: string;
  candidateRevisionId: string;
  correlationId: string;
  decisionId: string;
  evaluatedAt: string;
  idempotencyKey: string;
  inputSnapshotId: string;
  moderationPolicyRevisionId: string;
  outcome: ModerationOutcome;
  reason: string;
}

export interface RecordCandidateModerationDecisionResult {
  candidateRevisionId: string;
  decisionId: string;
  inputHash: string;
  outcome: ModerationOutcome;
  replayed: boolean;
}
