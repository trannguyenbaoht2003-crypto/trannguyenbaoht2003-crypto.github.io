import { hashCanonicalJson } from '../../shared/hash.js';
import type {
  NormalizedAiProviderExecutionInput,
  NormalizedAiProviderExecutionSubject,
} from './types.js';

const PRINTABLE_IDENTIFIER_PATTERN = /^[!-~]+$/u;
const FORBIDDEN_OBSERVATION_CONTROL_PATTERN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u;
const FORBIDDEN_OBSERVATION_SECRET_PATTERNS = [
  /https?:\/\//iu,
  /authorization\s*:/iu,
  /bearer\s+/iu,
  /api[_-]?key/iu,
  /cookie\s*:/iu,
  /begin[^\r\n]{0,64}private key/iu,
] as const;

const MAX_IDENTIFIER_LENGTH = 128;
const MAX_SUBJECTS = 64;
const MAX_SELECTION_IDS = 128;
const MAX_OBSERVATIONS = 32;
const MAX_OBSERVATION_LENGTH = 1_000;
const MAX_CANONICAL_INPUT_BYTES = 128 * 1024;

const ROOT_KEYS = ['gameModeExternalId', 'patchKey', 'runKey', 'subjects'] as const;
const SUBJECT_KEYS = [
  'allowedAugmentExternalIds',
  'allowedItemExternalIds',
  'observations',
  'subjectExternalId',
] as const;

function fail(): never {
  throw new Error('AI_PROVIDER_INPUT_INVALID');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(record).sort();
  const required = [...expected].sort();
  return keys.length === required.length && keys.every((key, index) => key === required[index]);
}

function requireIdentifier(value: unknown): string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > MAX_IDENTIFIER_LENGTH
    || value !== value.trim()
    || !PRINTABLE_IDENTIFIER_PATTERN.test(value)
  ) {
    return fail();
  }
  return value;
}

function compareAscii(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function requireCanonicalIdentifiers(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_SELECTION_IDS) return fail();

  const result = value.map(requireIdentifier);
  for (let index = 1; index < result.length; index += 1) {
    if (compareAscii(result[index - 1]!, result[index]!) >= 0) return fail();
  }
  return result;
}

function requireObservation(value: unknown): string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > MAX_OBSERVATION_LENGTH
    || value !== value.trim()
    || FORBIDDEN_OBSERVATION_CONTROL_PATTERN.test(value)
    || FORBIDDEN_OBSERVATION_SECRET_PATTERNS.some((pattern) => pattern.test(value))
  ) {
    return fail();
  }
  return value;
}

function requireObservations(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_OBSERVATIONS) return fail();
  return value.map(requireObservation);
}

function normalizeSubject(value: unknown): NormalizedAiProviderExecutionSubject {
  if (!isRecord(value) || !hasExactKeys(value, SUBJECT_KEYS)) return fail();
  return {
    subjectExternalId: requireIdentifier(value.subjectExternalId),
    allowedAugmentExternalIds: requireCanonicalIdentifiers(value.allowedAugmentExternalIds),
    allowedItemExternalIds: requireCanonicalIdentifiers(value.allowedItemExternalIds),
    observations: requireObservations(value.observations),
  };
}

export function normalizeAiProviderExecutionInput(
  input: unknown,
): NormalizedAiProviderExecutionInput {
  if (!isRecord(input) || !hasExactKeys(input, ROOT_KEYS)) return fail();
  if (input.gameModeExternalId !== 'aram_mayhem') return fail();
  if (!Array.isArray(input.subjects) || input.subjects.length < 1 || input.subjects.length > MAX_SUBJECTS) {
    return fail();
  }

  const subjects = input.subjects.map(normalizeSubject);
  if (new Set(subjects.map((subject) => subject.subjectExternalId)).size !== subjects.length) {
    return fail();
  }
  subjects.sort((left, right) => compareAscii(left.subjectExternalId, right.subjectExternalId));

  const normalized: NormalizedAiProviderExecutionInput = {
    runKey: requireIdentifier(input.runKey),
    patchKey: requireIdentifier(input.patchKey),
    gameModeExternalId: 'aram_mayhem',
    subjects,
  };

  if (Buffer.byteLength(JSON.stringify(normalized), 'utf8') > MAX_CANONICAL_INPUT_BYTES) {
    return fail();
  }

  return normalized;
}

export function hashNormalizedAiProviderExecutionInput(
  input: NormalizedAiProviderExecutionInput,
): string {
  return hashCanonicalJson(input);
}
