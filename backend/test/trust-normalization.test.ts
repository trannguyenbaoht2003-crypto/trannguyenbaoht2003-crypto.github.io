import assert from 'node:assert/strict';
import test from 'node:test';

import {
  hashCanonicalTupleV1,
  hashUtf8TextV1,
  normalizeClaimSet,
  normalizePolicyKey,
  requireBoundedText,
  requireUuid,
} from '../src/modules/trust/normalize-trust-input.js';
import type {
  CandidateClaimInput,
  ClaimImportance,
  ClaimType,
} from '../src/modules/trust/types.js';

const IDS = {
  candidateId: '71000000-0000-4000-8000-000000000001',
  candidateRevisionId: '71000000-0000-4000-8000-000000000002',
  catalogRevisionId: '71000000-0000-4000-8000-000000000003',
  patchId: '71000000-0000-4000-8000-000000000004',
  requiredClaimId: '71000000-0000-4000-8000-000000000005',
  supportingClaimId: '71000000-0000-4000-8000-000000000006',
} as const;

function requiredClaim(
  overrides: Partial<CandidateClaimInput> = {},
): CandidateClaimInput {
  return {
    claimId: IDS.requiredClaimId,
    claimKey: 'build-core',
    claimType: 'build_effectiveness',
    importance: 'required',
    statement: 'The selected build is effective for this ARAM Mayhem patch.',
    ...overrides,
  };
}

function supportingClaim(
  overrides: Partial<CandidateClaimInput> = {},
): CandidateClaimInput {
  return {
    claimId: IDS.supportingClaimId,
    claimKey: 'context-note',
    claimType: 'playstyle_hypothesis',
    importance: 'supporting',
    statement: 'This selection favors aggressive resets.',
    ...overrides,
  };
}

function normalize(
  claims: CandidateClaimInput[] = [requiredClaim(), supportingClaim()],
) {
  return normalizeClaimSet(
    IDS.candidateId,
    IDS.candidateRevisionId,
    IDS.patchId,
    IDS.catalogRevisionId,
    claims,
  );
}

test('TrustTupleV1 uses UTF-8 byte lengths and a hand-checked hash', () => {
  assert.equal(
    hashCanonicalTupleV1(['TrustTupleV1', 'known', 'é', '@null']),
    'e4a0deda3a0813df3ba895e80dda9b76a0cbfef0971ddce825a6644eec2b7ea1',
  );
  assert.equal(
    hashUtf8TextV1('é'),
    '4a99557e4033c3539de2eb65472017cad5f9557f7a0625a09f1c3f6e2ba69c4c',
  );
});

test('claim set hash and output order are independent of input order', () => {
  const first = normalize([requiredClaim(), supportingClaim()]);
  const second = normalize([supportingClaim(), requiredClaim()]);

  assert.equal(first.claimSetHash, second.claimSetHash);
  assert.deepEqual(
    first.claims.map((claim: CandidateClaimInput) => claim.claimKey),
    ['build-core', 'context-note'],
  );
});

test('claim identity, content, and authority all affect the seal', () => {
  const base = normalize().claimSetHash;

  assert.notEqual(
    base,
    normalize([requiredClaim({ statement: 'Changed claim.' })]).claimSetHash,
  );
  assert.notEqual(
    base,
    normalize([
      requiredClaim({
        claimId: '71000000-0000-4000-8000-000000000007',
      }),
    ]).claimSetHash,
  );
  assert.notEqual(
    base,
    normalizeClaimSet(
      IDS.candidateId,
      IDS.candidateRevisionId,
      IDS.patchId,
      '71000000-0000-4000-8000-000000000008',
      [requiredClaim(), supportingClaim()],
    ).claimSetHash,
  );
});

test('claim set requires one required claim and unique identities', () => {
  assert.throws(
    () => normalize([]),
    /CLAIM_SET_EMPTY/,
  );
  assert.throws(
    () => normalize([supportingClaim()]),
    /CLAIM_SET_REQUIRED_CLAIM_MISSING/,
  );
  assert.throws(
    () => normalize([
      requiredClaim(),
      supportingClaim({ claimId: IDS.requiredClaimId }),
    ]),
    /CLAIM_ID_DUPLICATE/,
  );
  assert.throws(
    () => normalize([
      requiredClaim(),
      supportingClaim({ claimKey: 'build-core' }),
    ]),
    /CLAIM_KEY_DUPLICATE/,
  );
});

test('claim set rejects identifiers outside the closed V1 grammar', () => {
  for (const claimKey of [
    'not canonical',
    '\tbuild-core',
    'x'.repeat(129),
    'lối-chơi',
  ]) {
    assert.throws(
      () => normalize([requiredClaim({ claimKey })]),
      /TRUST_IDENTIFIER_INVALID/,
    );
  }
  assert.throws(
    () => normalizePolicyKey('review policy'),
    /TRUST_IDENTIFIER_INVALID/,
  );
  assert.equal(normalizePolicyKey('review-policy-v1'), 'review-policy-v1');
});

test('claim set rejects non-V4 UUIDs and unknown enum values', () => {
  assert.throws(
    () => requireUuid('not-a-uuid', 'claimId'),
    /TRUST_UUID_INVALID:claimId/,
  );
  assert.throws(
    () => normalize([
      requiredClaim({
        claimType: 'unknown' as ClaimType,
      }),
    ]),
    /CLAIM_TYPE_INVALID/,
  );
  assert.throws(
    () => normalize([
      requiredClaim({
        importance: 'unknown' as ClaimImportance,
      }),
    ]),
    /CLAIM_IMPORTANCE_INVALID/,
  );
});

test('claim set rejects empty, oversized, and open-shaped claim input', () => {
  assert.throws(
    () => normalize([requiredClaim({ statement: '' })]),
    /TRUST_TEXT_EMPTY:statement/,
  );
  assert.equal(
    requireBoundedText('é'.repeat(2048), 'statement', 4096),
    'é'.repeat(2048),
  );
  assert.throws(
    () => normalize([
      requiredClaim({ statement: `${'é'.repeat(2048)}x` }),
    ]),
    /TRUST_TEXT_TOO_LARGE:statement/,
  );

  const openClaim = {
    ...requiredClaim(),
    retainedSourceText: 'must not enter the sealed claim graph',
  };
  assert.throws(
    () => normalize([openClaim as CandidateClaimInput]),
    /TRUST_OBJECT_KEYS_INVALID:claim/,
  );
});
