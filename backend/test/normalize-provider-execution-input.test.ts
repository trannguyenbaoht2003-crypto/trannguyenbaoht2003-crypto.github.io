import assert from 'node:assert/strict';
import test from 'node:test';

import {
  hashNormalizedAiProviderExecutionInput,
  normalizeAiProviderExecutionInput,
} from '../src/modules/ai-provider/normalize-provider-execution-input.js';

function fixture() {
  return {
    runKey: 'run-26.17-samira',
    patchKey: '26.17',
    gameModeExternalId: 'aram_mayhem',
    subjects: [
      {
        subjectExternalId: 'samira',
        allowedAugmentExternalIds: ['1194', '2001'],
        allowedItemExternalIds: ['3006', '6672'],
        observations: [
          'Community signal favors an aggressive crit setup.',
          'Augment choices repeatedly mention 1194 and 2001.',
        ],
      },
    ],
  } as const;
}

test('provider execution input normalizes deterministically and hashes canonical content', () => {
  const first = normalizeAiProviderExecutionInput(fixture());
  const second = normalizeAiProviderExecutionInput({
    ...fixture(),
    subjects: [...fixture().subjects].reverse(),
  });

  assert.deepEqual(first, second);
  assert.match(hashNormalizedAiProviderExecutionInput(first), /^[a-f0-9]{64}$/);
  assert.equal(
    hashNormalizedAiProviderExecutionInput(first),
    hashNormalizedAiProviderExecutionInput(second),
  );
});

test('provider execution input rejects duplicate subjects', () => {
  const subject = fixture().subjects[0];
  assert.throws(
    () => normalizeAiProviderExecutionInput({
      ...fixture(),
      subjects: [subject, subject],
    }),
    /AI_PROVIDER_INPUT_INVALID/,
  );
});

test('provider execution input rejects non-canonical or duplicate allow lists', () => {
  const subject = fixture().subjects[0];

  assert.throws(
    () => normalizeAiProviderExecutionInput({
      ...fixture(),
      subjects: [{
        ...subject,
        allowedAugmentExternalIds: ['2001', '1194'],
      }],
    }),
    /AI_PROVIDER_INPUT_INVALID/,
  );

  assert.throws(
    () => normalizeAiProviderExecutionInput({
      ...fixture(),
      subjects: [{
        ...subject,
        allowedItemExternalIds: ['3006', '3006'],
      }],
    }),
    /AI_PROVIDER_INPUT_INVALID/,
  );
});

test('provider execution input rejects secret-bearing observations', () => {
  const subject = fixture().subjects[0];
  const forbidden = [
    'Authorization: Bearer secret-value',
    'api_key=secret-value',
    'Cookie: session=secret-value',
    'https://example.com/private-source',
    '-----BEGIN PRIVATE KEY-----',
  ];

  for (const observation of forbidden) {
    assert.throws(
      () => normalizeAiProviderExecutionInput({
        ...fixture(),
        subjects: [{ ...subject, observations: [observation] }],
      }),
      /AI_PROVIDER_INPUT_INVALID/,
    );
  }
});

test('provider execution input enforces bounded observations and total canonical size', () => {
  const subject = fixture().subjects[0];

  assert.throws(
    () => normalizeAiProviderExecutionInput({
      ...fixture(),
      subjects: [{ ...subject, observations: ['x'.repeat(1001)] }],
    }),
    /AI_PROVIDER_INPUT_INVALID/,
  );

  assert.throws(
    () => normalizeAiProviderExecutionInput({
      ...fixture(),
      subjects: Array.from({ length: 64 }, (_, index) => ({
        subjectExternalId: `subject-${String(index).padStart(2, '0')}`,
        allowedAugmentExternalIds: ['1194'],
        allowedItemExternalIds: ['3006'],
        observations: Array.from({ length: 32 }, () => 'x'.repeat(1000)),
      })),
    }),
    /AI_PROVIDER_INPUT_INVALID/,
  );
});
