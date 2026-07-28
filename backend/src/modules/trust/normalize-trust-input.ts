import { createHash } from 'node:crypto';

import type {
  CandidateClaimInput,
  ClaimImportance,
  ClaimType,
  NormalizedCandidateClaim,
  NormalizedClaimSet,
} from './types.js';

const TRUST_IDENTIFIER_V1 = /^[!-~]+$/;
const UUID_V4 = (
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
);

const CLAIM_TYPES = new Set<ClaimType>([
  'meta_trend',
  'build_effectiveness',
  'compatibility',
  'patch_change',
  'playstyle_hypothesis',
  'translation_assertion',
  'ocr_extraction',
  'community_report',
]);

const CLAIM_IMPORTANCE = new Set<ClaimImportance>([
  'required',
  'supporting',
  'informational',
]);

function compareCanonical(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function requireExactKeys(
  value: unknown,
  expectedKeys: readonly string[],
  field: string,
): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`TRUST_OBJECT_INVALID:${field}`);
  }
  const actual = Object.keys(value).sort(compareCanonical);
  const expected = [...expectedKeys].sort(compareCanonical);
  if (
    actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])
  ) {
    throw new Error(`TRUST_OBJECT_KEYS_INVALID:${field}`);
  }
}

function requireTrustIdentifier(value: unknown, field: string): string {
  if (
    typeof value !== 'string'
    || Buffer.byteLength(value, 'utf8') < 1
    || Buffer.byteLength(value, 'utf8') > 128
    || !TRUST_IDENTIFIER_V1.test(value)
  ) {
    throw new Error(`TRUST_IDENTIFIER_INVALID:${field}`);
  }
  return value;
}

export function normalizePolicyKey(value: string): string {
  return requireTrustIdentifier(value, 'policyKey');
}

export function requireUuid(value: string, field: string): string {
  if (typeof value !== 'string' || !UUID_V4.test(value)) {
    throw new Error(`TRUST_UUID_INVALID:${field}`);
  }
  return value;
}

export function requireBoundedText(
  value: string,
  field: string,
  maxBytes: number,
): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`TRUST_TEXT_EMPTY:${field}`);
  }
  if (Buffer.byteLength(value, 'utf8') > maxBytes) {
    throw new Error(`TRUST_TEXT_TOO_LARGE:${field}`);
  }
  return value;
}

export function hashUtf8TextV1(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function hashCanonicalTupleV1(tokens: readonly string[]): string {
  const encoded = tokens.map((token) => {
    if (typeof token !== 'string') {
      throw new Error('TRUST_TUPLE_TOKEN_INVALID');
    }
    return `${Buffer.byteLength(token, 'utf8')}:${token}`;
  }).join('|');
  return hashUtf8TextV1(encoded);
}

function normalizeClaim(value: unknown): NormalizedCandidateClaim {
  requireExactKeys(
    value,
    ['claimId', 'claimKey', 'claimType', 'importance', 'statement'],
    'claim',
  );
  const claimId = requireUuid(value.claimId as string, 'claimId');
  const claimKey = requireTrustIdentifier(value.claimKey, 'claimKey');
  if (
    typeof value.claimType !== 'string'
    || !CLAIM_TYPES.has(value.claimType as ClaimType)
  ) {
    throw new Error('CLAIM_TYPE_INVALID');
  }
  if (
    typeof value.importance !== 'string'
    || !CLAIM_IMPORTANCE.has(value.importance as ClaimImportance)
  ) {
    throw new Error('CLAIM_IMPORTANCE_INVALID');
  }
  const statement = requireBoundedText(
    value.statement as string,
    'statement',
    4096,
  );
  return {
    claimId,
    claimKey,
    claimType: value.claimType as ClaimType,
    importance: value.importance as ClaimImportance,
    statement,
    statementHash: hashUtf8TextV1(statement),
  };
}

export function normalizeClaimSet(
  candidateId: string,
  candidateRevisionId: string,
  patchId: string,
  catalogRevisionId: string,
  claims: readonly CandidateClaimInput[],
): NormalizedClaimSet {
  const normalizedCandidateId = requireUuid(candidateId, 'candidateId');
  const normalizedCandidateRevisionId = requireUuid(
    candidateRevisionId,
    'candidateRevisionId',
  );
  const normalizedPatchId = requireUuid(patchId, 'patchId');
  const normalizedCatalogRevisionId = requireUuid(
    catalogRevisionId,
    'catalogRevisionId',
  );
  if (!Array.isArray(claims) || claims.length === 0) {
    throw new Error('CLAIM_SET_EMPTY');
  }

  const normalizedClaims: NormalizedCandidateClaim[] = [];
  for (let index = 0; index < claims.length; index += 1) {
    if (!(index in claims)) {
      throw new Error('TRUST_ARRAY_SPARSE:claims');
    }
    normalizedClaims.push(normalizeClaim(claims[index]));
  }

  const claimIds = new Set<string>();
  const claimKeys = new Set<string>();
  for (const claim of normalizedClaims) {
    if (claimIds.has(claim.claimId)) {
      throw new Error('CLAIM_ID_DUPLICATE');
    }
    if (claimKeys.has(claim.claimKey)) {
      throw new Error('CLAIM_KEY_DUPLICATE');
    }
    claimIds.add(claim.claimId);
    claimKeys.add(claim.claimKey);
  }
  if (!normalizedClaims.some((claim) => claim.importance === 'required')) {
    throw new Error('CLAIM_SET_REQUIRED_CLAIM_MISSING');
  }

  normalizedClaims.sort((left, right) => (
    compareCanonical(left.claimKey, right.claimKey)
  ));
  const claimSetHash = hashCanonicalTupleV1([
    'TrustTupleV1',
    'CandidateClaimSetV1',
    normalizedCandidateId,
    normalizedCandidateRevisionId,
    normalizedPatchId,
    normalizedCatalogRevisionId,
    String(normalizedClaims.length),
    ...normalizedClaims.flatMap((claim) => [
      claim.claimId,
      claim.claimKey,
      claim.claimType,
      claim.importance,
      claim.statementHash,
    ]),
  ]);

  return {
    claims: normalizedClaims,
    claimSetHash,
  };
}
