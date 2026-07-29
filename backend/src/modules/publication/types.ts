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
