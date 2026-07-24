export type CandidateOrigin =
  | 'collector_detected'
  | 'community_submitted'
  | 'editorial'
  | 'ai_generated';

export type NormalizationReasonCode =
  | 'NORMALIZATION_SCHEMA_UNSUPPORTED'
  | 'NORMALIZATION_PATCH_KEY_REQUIRED'
  | 'NORMALIZATION_SUBJECT_REQUIRED'
  | 'NORMALIZATION_ENTITY_ID_REQUIRED'
  | 'NORMALIZATION_DUPLICATE_ID';

export interface ObservationNormalizationSnapshotV1 {
  schemaVersion: 1;
  patchKey: string;
  gameModeExternalId: 'aram_mayhem';
  origin: CandidateOrigin;
  subjectExternalId: string;
  augmentExternalIds: string[];
  itemExternalIds: string[];
}

export interface CandidateSelectionPayloadV1 {
  schemaVersion: 1;
  augmentExternalIds: string[];
  itemExternalIds: string[];
}

export interface NormalizedObservationSnapshot {
  normalizedSignature: string;
  payload: CandidateSelectionPayloadV1;
  snapshot: ObservationNormalizationSnapshotV1;
}

export interface CandidateFingerprintInput {
  gameModeExternalId: 'aram_mayhem';
  normalizedSignature: string;
  patchId: string;
  subjectExternalId: string;
}
