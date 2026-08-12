import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildPublicationPayload,
} from '../src/modules/publication/build-publication-payload.js';
import type {
  PublicationPayloadAuthority,
} from '../src/modules/publication/types.js';

function validAuthority(): PublicationPayloadAuthority {
  return {
    candidateId: '62000000-0000-4000-8000-000000000001',
    candidateRevisionId: '62000000-0000-4000-8000-000000000002',
    patchKey: '26.14',
    catalogRevisionId: '61000000-0000-4000-8000-000000000004',
    gameModeExternalId: 'aram_mayhem',
    championExternalId: '266',
    canonicalPayload: {
      schemaVersion: 1,
      augmentExternalIds: ['augment-a', 'augment-b'],
      itemExternalIds: ['1001', '1002'],
    },
  };
}

test('Publication payload is closed, canonical, and deterministically hashed', () => {
  const first = buildPublicationPayload(validAuthority());
  const second = buildPublicationPayload(validAuthority());

  assert.deepEqual(first, {
    payload: {
      schemaVersion: 1,
      mode: 'aram_mayhem',
      patchKey: '26.14',
      catalogRevisionId: '61000000-0000-4000-8000-000000000004',
      championExternalId: '266',
      augmentExternalIds: ['augment-a', 'augment-b'],
      itemExternalIds: ['1001', '1002'],
    },
    payloadHash:
      '11b1a96e55c3c390ed11ed1756810f06d5f48b7eb2c295c7baa92d87babc25ee',
  });
  assert.deepEqual(second, first);
});

test('Publication payload rejects the mutation that accepts caller-authored content', () => {
  assert.throws(
    () => buildPublicationPayload({
      ...validAuthority(),
      title: 'untrusted',
    } as never),
    /PUBLICATION_PAYLOAD_INVALID/,
  );
});

test('Publication payload rejects an unsupported game mode', () => {
  assert.throws(
    () => buildPublicationPayload({
      ...validAuthority(),
      gameModeExternalId: 'ranked',
    } as never),
    /PUBLICATION_PAYLOAD_INVALID/,
  );
});

test('Publication payload rejects duplicate external IDs', () => {
  assert.throws(
    () => buildPublicationPayload({
      ...validAuthority(),
      canonicalPayload: {
        schemaVersion: 1,
        augmentExternalIds: ['augment-a', 'augment-a'],
        itemExternalIds: ['1001', '1002'],
      },
    }),
    /PUBLICATION_PAYLOAD_INVALID/,
  );
});

test('Publication payload rejects non-canonical external ID ordering', () => {
  assert.throws(
    () => buildPublicationPayload({
      ...validAuthority(),
      canonicalPayload: {
        schemaVersion: 1,
        augmentExternalIds: ['augment-b', 'augment-a'],
        itemExternalIds: ['1001', '1002'],
      },
    }),
    /PUBLICATION_PAYLOAD_INVALID/,
  );
});

test('Publication payload rejects invalid external identifiers', () => {
  assert.throws(
    () => buildPublicationPayload({
      ...validAuthority(),
      championExternalId: 'invalid id',
    }),
    /PUBLICATION_PAYLOAD_INVALID/,
  );
  assert.throws(
    () => buildPublicationPayload({
      ...validAuthority(),
      canonicalPayload: {
        schemaVersion: 1,
        augmentExternalIds: ['augment-a'],
        itemExternalIds: [],
      },
    }),
    /PUBLICATION_PAYLOAD_INVALID/,
  );
});
