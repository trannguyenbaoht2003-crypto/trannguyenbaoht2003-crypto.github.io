import {
  hashCanonicalTupleV1,
} from '../trust/normalize-trust-input.js';
import type {
  BuiltPublicationPayload,
  PublicationPayloadAuthority,
  PublicationPayloadV1,
} from './types.js';

const IDENTIFIER_V1 = /^[!-~]+$/;
const UUID_V4 = (
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
);
const AUTHORITY_KEYS = [
  'candidateId',
  'candidateRevisionId',
  'patchKey',
  'catalogRevisionId',
  'gameModeExternalId',
  'championExternalId',
  'canonicalPayload',
] as const;
const CANDIDATE_PAYLOAD_KEYS = [
  'schemaVersion',
  'augmentExternalIds',
  'itemExternalIds',
] as const;

function compareCanonical(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function requireExactKeys(
  value: unknown,
  expectedKeys: readonly string[],
): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('PUBLICATION_PAYLOAD_INVALID');
  }
  const actual = Object.keys(value).sort(compareCanonical);
  const expected = [...expectedKeys].sort(compareCanonical);
  if (
    actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])
  ) {
    throw new Error('PUBLICATION_PAYLOAD_INVALID');
  }
}

function requireIdentifier(value: unknown): string {
  if (
    typeof value !== 'string'
    || Buffer.byteLength(value, 'utf8') < 1
    || Buffer.byteLength(value, 'utf8') > 128
    || !IDENTIFIER_V1.test(value)
  ) {
    throw new Error('PUBLICATION_PAYLOAD_INVALID');
  }
  return value;
}

function requireUuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID_V4.test(value)) {
    throw new Error('PUBLICATION_PAYLOAD_INVALID');
  }
  return value;
}

function requireCanonicalIdentifiers(
  value: unknown,
  minimum: number,
): string[] {
  if (
    !Array.isArray(value)
    || value.length < minimum
    || value.length > 64
  ) {
    throw new Error('PUBLICATION_PAYLOAD_INVALID');
  }
  const normalized: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, index)) {
      throw new Error('PUBLICATION_PAYLOAD_INVALID');
    }
    const identifier = requireIdentifier(value[index]);
    if (
      index > 0
      && compareCanonical(normalized[index - 1]!, identifier) >= 0
    ) {
      throw new Error('PUBLICATION_PAYLOAD_INVALID');
    }
    normalized.push(identifier);
  }
  return normalized;
}

export function buildPublicationPayload(
  input: PublicationPayloadAuthority,
): BuiltPublicationPayload {
  try {
    requireExactKeys(input, AUTHORITY_KEYS);
    requireExactKeys(input.canonicalPayload, CANDIDATE_PAYLOAD_KEYS);
    const candidateId = requireUuid(input.candidateId);
    const candidateRevisionId = requireUuid(input.candidateRevisionId);
    const patchKey = requireIdentifier(input.patchKey);
    const catalogRevisionId = requireUuid(input.catalogRevisionId);
    const championExternalId = requireIdentifier(input.championExternalId);
    if (
      input.gameModeExternalId !== 'aram_mayhem'
      || input.canonicalPayload.schemaVersion !== 1
    ) {
      throw new Error('PUBLICATION_PAYLOAD_INVALID');
    }
    const augmentExternalIds = requireCanonicalIdentifiers(
      input.canonicalPayload.augmentExternalIds,
      1,
    );
    const itemExternalIds = requireCanonicalIdentifiers(
      input.canonicalPayload.itemExternalIds,
      2,
    );
    const payload: PublicationPayloadV1 = {
      schemaVersion: 1,
      mode: 'aram_mayhem',
      patchKey,
      catalogRevisionId,
      championExternalId,
      augmentExternalIds,
      itemExternalIds,
    };
    const payloadHash = hashCanonicalTupleV1([
      'PublicationTupleV1',
      'PublicationPayloadV1',
      candidateId,
      candidateRevisionId,
      patchKey,
      catalogRevisionId,
      payload.mode,
      championExternalId,
      String(augmentExternalIds.length),
      ...augmentExternalIds,
      String(itemExternalIds.length),
      ...itemExternalIds,
    ]);
    return { payload, payloadHash };
  } catch (error) {
    if (
      error instanceof Error
      && error.message === 'PUBLICATION_PAYLOAD_INVALID'
    ) {
      throw error;
    }
    throw new Error('PUBLICATION_PAYLOAD_INVALID', { cause: error });
  }
}
