export interface PublicationPayloadV1 {
  schemaVersion: 1;
  mode: 'aram_mayhem';
  patchKey: string;
  catalogRevisionId: string;
  championExternalId: string;
  augmentExternalIds: readonly string[];
  itemExternalIds: readonly string[];
}

export interface PublicationPayloadAuthority {
  candidateId: string;
  candidateRevisionId: string;
  patchKey: string;
  catalogRevisionId: string;
  gameModeExternalId: 'aram_mayhem';
  championExternalId: string;
  canonicalPayload: {
    schemaVersion: 1;
    augmentExternalIds: readonly string[];
    itemExternalIds: readonly string[];
  };
}

export interface BuiltPublicationPayload {
  payload: PublicationPayloadV1;
  payloadHash: string;
}


export interface PublicationAuthorizationContext {
  actorId: string;
  permissions: readonly 'publisher'[];
}

export interface PublishCandidateRevisionCommand {
  publicationId: string;
  publicationVersionId: string;
  activationId: string;
  candidateRevisionId: string;
  expectedActiveEligibilityPolicyRevisionId: string;
  expectedEligibilityEvaluationId: string;
  expectedModerationDecisionId: string;
  expectedActivePublicationVersionId: string | null;
  authorization: PublicationAuthorizationContext;
  auditId: string;
  outboxEventId: string;
  correlationId: string;
  idempotencyKey: string;
  occurredAt: string;
}

export interface PublishCandidateRevisionResult {
  publicationId: string;
  publicationVersionId: string;
  candidateId: string;
  candidateRevisionId: string;
  versionNumber: number;
  activePublicationVersionId: string;
  replayed: boolean;
}
