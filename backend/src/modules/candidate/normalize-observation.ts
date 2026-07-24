import { hashCanonicalJson } from '../../shared/hash.js';
import type {
  CandidateFingerprintInput,
  CandidateOrigin,
  CandidateSelectionPayloadV1,
  NormalizationReasonCode,
  NormalizedObservationSnapshot,
  ObservationAggregateMetadataV1,
  ObservationNormalizationSnapshotV1,
} from './types.js';

const MAX_IDENTIFIER_LENGTH = 128;
const MAX_SELECTIONS_PER_TYPE = 64;
const SNAPSHOT_KEYS = [
  'augmentExternalIds',
  'gameModeExternalId',
  'itemExternalIds',
  'origin',
  'patchKey',
  'schemaVersion',
  'subjectExternalId',
] as const;

const CANDIDATE_ORIGINS = new Set<CandidateOrigin>([
  'collector_detected',
  'community_submitted',
  'editorial',
  'ai_generated',
]);

function fail(code: NormalizationReasonCode): never {
  throw new Error(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requiredText(
  value: unknown,
  code: NormalizationReasonCode,
): string {
  if (typeof value !== 'string') {
    return fail(code);
  }
  const normalized = value.trim();
  if (!normalized) {
    return fail(code);
  }
  if (normalized.length > MAX_IDENTIFIER_LENGTH) {
    return fail('NORMALIZATION_SCHEMA_UNSUPPORTED');
  }
  return normalized;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort(compareText);
  return (
    actual.length === expected.length
    && actual.every((key, index) => key === expected[index])
  );
}

function normalizeEntityIds(value: unknown): string[] {
  if (
    !Array.isArray(value)
    || value.length > MAX_SELECTIONS_PER_TYPE
  ) {
    return fail('NORMALIZATION_SCHEMA_UNSUPPORTED');
  }
  const normalized = value.map((entry) => (
    requiredText(entry, 'NORMALIZATION_ENTITY_ID_REQUIRED')
  ));
  if (new Set(normalized).size !== normalized.length) {
    return fail('NORMALIZATION_DUPLICATE_ID');
  }
  return normalized.sort(compareText);
}

function normalizeOrigin(value: unknown): CandidateOrigin {
  if (
    typeof value !== 'string'
    || !CANDIDATE_ORIGINS.has(value as CandidateOrigin)
  ) {
    return fail('NORMALIZATION_SCHEMA_UNSUPPORTED');
  }
  return value as CandidateOrigin;
}

export function normalizeObservationSnapshot(
  value: unknown,
): NormalizedObservationSnapshot {
  if (
    !isRecord(value)
    || !hasExactKeys(value, SNAPSHOT_KEYS)
    || value.schemaVersion !== 1
    || value.gameModeExternalId !== 'aram_mayhem'
  ) {
    return fail('NORMALIZATION_SCHEMA_UNSUPPORTED');
  }

  const snapshot: ObservationNormalizationSnapshotV1 = {
    schemaVersion: 1,
    patchKey: requiredText(
      value.patchKey,
      'NORMALIZATION_PATCH_KEY_REQUIRED',
    ),
    gameModeExternalId: 'aram_mayhem',
    origin: normalizeOrigin(value.origin),
    subjectExternalId: requiredText(
      value.subjectExternalId,
      'NORMALIZATION_SUBJECT_REQUIRED',
    ),
    augmentExternalIds: normalizeEntityIds(value.augmentExternalIds),
    itemExternalIds: normalizeEntityIds(value.itemExternalIds),
  };
  const payload: CandidateSelectionPayloadV1 = {
    schemaVersion: 1,
    augmentExternalIds: [...snapshot.augmentExternalIds],
    itemExternalIds: [...snapshot.itemExternalIds],
  };

  return {
    normalizedSignature: hashCanonicalJson(payload),
    payload,
    snapshot,
  };
}

export function normalizeObservationAggregateMetadata(
  value: unknown,
): ObservationAggregateMetadataV1 {
  if (
    !isRecord(value)
    || !hasExactKeys(value, ['normalizationSnapshot'])
  ) {
    return fail('NORMALIZATION_SCHEMA_UNSUPPORTED');
  }
  const normalized = normalizeObservationSnapshot(
    value.normalizationSnapshot,
  );
  return {
    normalizationSnapshot: normalized.snapshot,
  };
}

export function fingerprintCandidate(
  input: CandidateFingerprintInput,
): string {
  return hashCanonicalJson({
    patchScope: requiredText(
      input.patchId,
      'NORMALIZATION_SCHEMA_UNSUPPORTED',
    ),
    gameMode: input.gameModeExternalId,
    subjectGameEntity: requiredText(
      input.subjectExternalId,
      'NORMALIZATION_SUBJECT_REQUIRED',
    ),
    normalizedSignature: requiredText(
      input.normalizedSignature,
      'NORMALIZATION_SCHEMA_UNSUPPORTED',
    ),
  });
}
