import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizeCatalogSnapshot,
} from '../src/modules/catalog/normalize-catalog-snapshot.js';
import type { CatalogSnapshotV1 } from '../src/modules/catalog/types.js';

function snapshot(): CatalogSnapshotV1 {
  return {
    schemaVersion: 1,
    patchKey: '26.15',
    gameModeExternalId: 'aram_mayhem',
    source: {
      adapterVersion: 'communitydragon-v1',
      sourceDigest: 'a'.repeat(64),
    },
    entities: [
      {
        entityType: 'mode',
        externalId: 'aram_mayhem',
        displayName: 'ARAM: Mayhem',
        active: true,
        attributes: {},
      },
      {
        entityType: 'champion',
        externalId: 'samira',
        displayName: 'Samira',
        active: true,
        attributes: { icon: 'https://example.invalid/samira.png' },
      },
      {
        entityType: 'augment',
        externalId: '1194',
        displayName: 'Ma Pháp Mê Hoặc',
        active: true,
        attributes: {},
      },
      {
        entityType: 'item',
        externalId: '6672',
        displayName: 'Nỏ Tử Thủ',
        active: true,
        attributes: {},
      },
      {
        entityType: 'item',
        externalId: '3006',
        displayName: 'Giày Cuồng Nộ',
        active: true,
        attributes: {},
      },
    ],
    rules: [
      {
        ruleKey: 'aram-augment-limit',
        constraintType: 'limit',
        definition: {
          modeExternalId: 'aram_mayhem',
          entityType: 'augment',
          maxSelections: 3,
        },
      },
    ],
  };
}

test('equivalent entity and rule ordering produces the same content hash', () => {
  const left = snapshot();
  const right = {
    ...snapshot(),
    entities: [...snapshot().entities].reverse(),
    rules: [...snapshot().rules].reverse(),
  };
  assert.equal(
    normalizeCatalogSnapshot(left).contentHash,
    normalizeCatalogSnapshot(right).contentHash,
  );
});

test('duplicate entity identity is rejected before persistence', () => {
  const value = snapshot();
  value.entities.push({ ...value.entities[1]! });
  assert.throws(
    () => normalizeCatalogSnapshot(value),
    /CATALOG_DUPLICATE_ENTITY/,
  );
});

test('exactly one active aram_mayhem mode entity is required', () => {
  const value = snapshot();
  value.entities = value.entities.filter((entry) => entry.entityType !== 'mode');
  assert.throws(
    () => normalizeCatalogSnapshot(value),
    /CATALOG_MODE_REQUIRED/,
  );
});

test('source digest must be lowercase hexadecimal sha256', () => {
  const value = snapshot();
  value.source.sourceDigest = 'not-a-digest';
  assert.throws(
    () => normalizeCatalogSnapshot(value),
    /CATALOG_SOURCE_DIGEST_INVALID/,
  );
});
