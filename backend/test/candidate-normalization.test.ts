import assert from 'node:assert/strict';
import test from 'node:test';

import {
  fingerprintCandidate,
  normalizeObservationSnapshot,
} from '../src/modules/candidate/normalize-observation.js';

function snapshot() {
  return {
    schemaVersion: 1,
    patchKey: '26.15',
    gameModeExternalId: 'aram_mayhem',
    origin: 'collector_detected',
    subjectExternalId: 'samira',
    augmentExternalIds: ['1194', '2001'],
    itemExternalIds: ['6672', '3006'],
  };
}

test('equivalent set order produces one normalized signature', () => {
  const left = normalizeObservationSnapshot(snapshot());
  const right = normalizeObservationSnapshot({
    ...snapshot(),
    augmentExternalIds: ['2001', '1194'],
    itemExternalIds: ['3006', '6672'],
  });

  assert.equal(left.normalizedSignature, right.normalizedSignature);
  assert.deepEqual(left.payload.augmentExternalIds, ['1194', '2001']);
  assert.deepEqual(left.payload.itemExternalIds, ['3006', '6672']);
});

test('duplicate and empty identifiers fail with stable codes', () => {
  assert.throws(
    () => normalizeObservationSnapshot({
      ...snapshot(),
      itemExternalIds: ['3006', ' 3006 '],
    }),
    /NORMALIZATION_DUPLICATE_ID/,
  );
  assert.throws(
    () => normalizeObservationSnapshot({
      ...snapshot(),
      augmentExternalIds: [' '],
    }),
    /NORMALIZATION_ENTITY_ID_REQUIRED/,
  );
});

test('snapshot boundary rejects additional or oversized input', () => {
  assert.throws(
    () => normalizeObservationSnapshot({
      ...snapshot(),
      sourceHtml: '<p>not structured game identity</p>',
    }),
    /NORMALIZATION_SCHEMA_UNSUPPORTED/,
  );
  assert.throws(
    () => normalizeObservationSnapshot({
      ...snapshot(),
      subjectExternalId: 's'.repeat(129),
    }),
    /NORMALIZATION_SCHEMA_UNSUPPORTED/,
  );
  assert.throws(
    () => normalizeObservationSnapshot({
      ...snapshot(),
      itemExternalIds: Array.from(
        { length: 65 },
        (_value, index) => `item-${index}`,
      ),
    }),
    /NORMALIZATION_SCHEMA_UNSUPPORTED/,
  );
});

test('sparse selection arrays are rejected before hashing', () => {
  assert.throws(
    () => normalizeObservationSnapshot({
      ...snapshot(),
      itemExternalIds: Array<string>(1),
    }),
    /NORMALIZATION_ENTITY_ID_REQUIRED/,
  );
});

test('origin and source-adjacent fields do not affect fingerprint', () => {
  const collector = normalizeObservationSnapshot(snapshot());
  const ai = normalizeObservationSnapshot({
    ...snapshot(),
    origin: 'ai_generated',
  });
  const base = {
    gameModeExternalId: collector.snapshot.gameModeExternalId,
    normalizedSignature: collector.normalizedSignature,
    patchId: '40000000-0000-4000-8000-000000000003',
    subjectExternalId: collector.snapshot.subjectExternalId,
  };
  const withSourceMetadata = {
    ...base,
    sourceId: 'source-a',
  };

  assert.equal(collector.normalizedSignature, ai.normalizedSignature);
  assert.equal(
    fingerprintCandidate(base),
    fingerprintCandidate(withSourceMetadata),
  );
});

test('patch, subject, or semantic selection changes fingerprint', () => {
  const first = normalizeObservationSnapshot(snapshot());
  const second = normalizeObservationSnapshot({
    ...snapshot(),
    itemExternalIds: ['3006'],
  });
  const common = {
    gameModeExternalId: 'aram_mayhem' as const,
    patchId: '40000000-0000-4000-8000-000000000003',
    subjectExternalId: 'samira',
  };
  const fingerprint = fingerprintCandidate({
    ...common,
    normalizedSignature: first.normalizedSignature,
  });

  assert.notEqual(fingerprint, fingerprintCandidate({
    ...common,
    patchId: '50000000-0000-4000-8000-000000000003',
    normalizedSignature: first.normalizedSignature,
  }));
  assert.notEqual(fingerprint, fingerprintCandidate({
    ...common,
    subjectExternalId: 'jinx',
    normalizedSignature: first.normalizedSignature,
  }));
  assert.notEqual(fingerprint, fingerprintCandidate({
    ...common,
    normalizedSignature: second.normalizedSignature,
  }));
});
