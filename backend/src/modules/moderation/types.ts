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
