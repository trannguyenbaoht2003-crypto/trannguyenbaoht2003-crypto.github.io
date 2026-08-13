import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildCommunityObservationBatch,
} from '../src/modules/community/community-inbox-bridge.js';

const SOURCE_ID = '11111111-1111-4111-8111-111111111111';

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    id: 'candidate-samira-1',
    platform: 'Bilibili',
    url: 'https://www.bilibili.com/video/BV1example/',
    title: 'raw title must not enter backend provenance',
    author: 'creator',
    publishedAt: '2026-08-13',
    firstSeenAt: '2026-08-13',
    status: 'ready-for-review',
    score: 91,
    modeValid: true,
    currentEnough: true,
    disqualifiers: [],
    evidenceVersion: 3,
    evidenceReviewState: 'complete',
    sourceContentId: 'BV1example',
    championMatches: [{ id: 'samira' }],
    augmentMatches: [{ id: 1194 }, { id: 'augment-2' }],
    itemMatches: [{ id: 6673 }],
    reasons: ['raw reason text must not enter backend provenance'],
    ...overrides,
  };
}

function batchInput(candidates: unknown[]) {
  return {
    inbox: {
      schemaVersion: 1,
      updatedAt: '2026-08-13',
      candidates,
    },
    patchKey: '16.16',
    sourceId: SOURCE_ID,
  };
}

test('maps one structurally valid collector row into a governed observation command', () => {
  const result = buildCommunityObservationBatch(batchInput([candidate()]));

  assert.equal(result.skipped.length, 0);
  assert.equal(result.commands.length, 1);
  const command = result.commands[0]!;
  assert.equal(command.sourceId, SOURCE_ID);
  assert.equal(command.actorId, 'community-collector');
  assert.equal(command.adapterVersion, 'community-collector-bridge-v1');
  assert.equal(command.rawBlob, undefined);
  assert.deepEqual(command.aggregateMetadata, {
    normalizationSnapshot: {
      schemaVersion: 1,
      patchKey: '16.16',
      gameModeExternalId: 'aram_mayhem',
      origin: 'collector_detected',
      subjectExternalId: 'samira',
      augmentExternalIds: ['1194', 'augment-2'],
      itemExternalIds: ['6673'],
    },
  });
  assert.deepEqual(command.externalReference, {
    schemaVersion: 1,
    candidateId: 'candidate-samira-1',
    platform: 'Bilibili',
    url: 'https://www.bilibili.com/video/BV1example/',
    author: 'creator',
    publishedAt: '2026-08-13',
    status: 'ready-for-review',
    score: 91,
    evidenceVersion: 3,
    evidenceReviewState: 'complete',
    sourceContentId: 'BV1example',
  });
  assert.equal(JSON.stringify(command).includes('raw title'), false);
  assert.equal(JSON.stringify(command).includes('raw reason'), false);
});

test('unchanged collector input has stable observation and idempotency identity', () => {
  const first = buildCommunityObservationBatch(batchInput([candidate()])).commands[0]!;
  const second = buildCommunityObservationBatch(batchInput([candidate()])).commands[0]!;

  assert.equal(first.observationId, second.observationId);
  assert.equal(first.idempotencyKey, second.idempotencyKey);
  assert.equal(first.correlationId, second.correlationId);
  assert.match(first.observationId, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('a canonical selection change creates a new observation identity', () => {
  const first = buildCommunityObservationBatch(batchInput([candidate()])).commands[0]!;
  const second = buildCommunityObservationBatch(batchInput([
    candidate({ itemMatches: [{ id: 6673 }, { id: 3031 }] }),
  ])).commands[0]!;

  assert.notEqual(first.observationId, second.observationId);
  assert.notEqual(first.idempotencyKey, second.idempotencyKey);
});

test('skips rows that must not be coerced into backend candidates', () => {
  const result = buildCommunityObservationBatch(batchInput([
    candidate({ id: 'wrong-mode', modeValid: false }),
    candidate({ id: 'stale', currentEnough: false }),
    candidate({ id: 'disqualified', disqualifiers: ['BUG'] }),
    candidate({ id: 'ambiguous', championMatches: [{ id: 'samira' }, { id: 'ashe' }] }),
  ]));

  assert.equal(result.commands.length, 0);
  assert.deepEqual(result.skipped, [
    { candidateId: 'wrong-mode', reason: 'MODE_NOT_CONFIRMED' },
    { candidateId: 'stale', reason: 'CANDIDATE_STALE' },
    { candidateId: 'disqualified', reason: 'CANDIDATE_DISQUALIFIED' },
    { candidateId: 'ambiguous', reason: 'SUBJECT_NOT_EXACT' },
  ]);
});

test('rejects an unsupported inbox or patch contract before producing commands', () => {
  assert.throws(
    () => buildCommunityObservationBatch({ ...batchInput([]), patchKey: '' }),
    /COMMUNITY_PATCH_REQUIRED/,
  );
  assert.throws(
    () => buildCommunityObservationBatch({ ...batchInput([]), inbox: { schemaVersion: 2, candidates: [] } }),
    /COMMUNITY_INBOX_SCHEMA_UNSUPPORTED/,
  );
});