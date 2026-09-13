import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildCommunityObservationBatch,
  communityReportPatch,
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
    patchHint: '16.16',
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
  assert.equal(command.adapterVersion, 'community-collector-bridge-v2');
  assert.equal(command.rawBlob, undefined);
  assert.equal(command.collectedAt.toISOString(), '2026-08-13T00:00:00.000Z');
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
    patchHint: '16.16',
    sourceCatalogId: undefined,
    score: 91,
    evidenceVersion: 3,
    evidenceReviewState: 'complete',
    sourceContentId: 'BV1example',
  });
  assert.equal(JSON.stringify(command).includes('raw title'), false);
  assert.equal(JSON.stringify(command).includes('raw reason'), false);
});

test('uses first-seen time for stable collection identity instead of mutable inbox update time', () => {
  const result = buildCommunityObservationBatch(batchInput([
    candidate({
      firstSeenAt: '2026-08-11',
      publishedAt: '2026-08-01',
    }),
  ]));

  assert.equal(result.commands[0]?.collectedAt.toISOString(), '2026-08-11T00:00:00.000Z');
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

test('a stateless collector rediscovery keeps content identity when its collection hint changes', () => {
  const first = buildCommunityObservationBatch(batchInput([candidate()])).commands[0]!;
  const nextDay = buildCommunityObservationBatch(batchInput([
    candidate({ firstSeenAt: '2026-08-14' }),
  ])).commands[0]!;

  assert.notEqual(first.collectedAt.toISOString(), nextDay.collectedAt.toISOString());
  assert.equal(first.idempotencyKey, nextDay.idempotencyKey);
  assert.equal(first.observationId, nextDay.observationId);
  const retry = buildCommunityObservationBatch(batchInput([
    candidate({ firstSeenAt: '2026-08-14' }),
  ])).commands[0]!;
  assert.deepEqual(nextDay, retry);
});

test('skips rows that must not be coerced into backend candidates', () => {
  const result = buildCommunityObservationBatch(batchInput([
    candidate({ id: 'wrong-mode', modeValid: false }),
    candidate({ id: 'stale', currentEnough: false }),
    candidate({ id: 'disqualified', disqualifiers: ['BUG'] }),
    candidate({ id: 'ambiguous', championMatches: [{ id: 'samira' }, { id: 'ashe' }] }),
    candidate({ id: 'bad-disqualifiers', disqualifiers: 'BUG' }),
    candidate({ id: 'bad-augments', augmentMatches: null }),
    candidate({ id: 'bad-items', itemMatches: '6673' }),
    candidate({ id: 'bad-date', firstSeenAt: 'not-a-date', publishedAt: 'also-not-a-date' }),
  ]));

  assert.equal(result.commands.length, 0);
  assert.deepEqual(result.skipped, [
    { candidateId: 'wrong-mode', reason: 'MODE_NOT_CONFIRMED' },
    { candidateId: 'stale', reason: 'CANDIDATE_STALE' },
    { candidateId: 'disqualified', reason: 'CANDIDATE_DISQUALIFIED' },
    { candidateId: 'ambiguous', reason: 'SUBJECT_NOT_EXACT' },
    { candidateId: 'bad-disqualifiers', reason: 'CANDIDATE_SCHEMA_INVALID' },
    { candidateId: 'bad-augments', reason: 'SELECTION_IDS_INVALID' },
    { candidateId: 'bad-items', reason: 'SELECTION_IDS_INVALID' },
    { candidateId: 'bad-date', reason: 'COLLECTED_AT_INVALID' },
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

test('never relabels missing or old source patches with the report patch', () => {
  const result = buildCommunityObservationBatch(batchInput([
    candidate({ id: 'unknown', patchHint: undefined }),
    candidate({ id: 'old', patchHint: '16.14' }),
    candidate({ id: 'future', patchHint: '16.18' }),
  ]));
  assert.equal(result.commands.length, 0);
  assert.deepEqual(result.skipped, [
    { candidateId: 'unknown', reason: 'PATCH_NOT_CONFIRMED' },
    { candidateId: 'old', reason: 'PATCH_MISMATCH' },
    { candidateId: 'future', reason: 'PATCH_MISMATCH' },
  ]);
});

test('accepts the official Riot patch alias and preserves it in provenance', () => {
  const result = buildCommunityObservationBatch(batchInput([candidate({ patchHint: '26.16' })]));
  assert.equal(result.commands.length, 1);
  assert.equal(result.commands[0]?.externalReference?.patchHint, '26.16');
});

test('requires public HTTPS provenance before ingestion', () => {
  const result = buildCommunityObservationBatch(batchInput([
    candidate({ id: 'no-url', url: undefined }),
    candidate({ id: 'http', url: 'http://www.bilibili.com/video/x' }),
    candidate({ id: 'credential', url: 'https://user:password@www.bilibili.com/video/x' }),
    candidate({ id: 'loopback', url: 'https://127.0.0.1/' }),
    candidate({ id: 'localhost', url: 'https://localhost/' }),
    candidate({ id: 'lookalike', url: 'https://bilibili.com.attacker.test/video/x' }),
    candidate({ id: 'reference', url: 'https://raw.communitydragon.org/16.18/' }),
  ]));
  assert.equal(result.commands.length, 0);
  assert.ok(result.skipped.every(({ reason }) => reason === 'SOURCE_URL_INVALID'));
});

test('offline replay files cannot become collector observations', () => {
  const input = batchInput([candidate()]);
  assert.throws(() => buildCommunityObservationBatch({ ...input, inbox: { ...input.inbox, collectionMode: 'offline' } }), /COMMUNITY_OFFLINE_REPLAY_NOT_INGESTIBLE/);
});

test('import requires a live report with an explicit supported patch', () => {
  assert.equal(communityReportPatch({ collectionMode: 'live', currentPatch: '16.18' }), '16.18');
  for (const report of [{ currentPatch: '16.18' }, { collectionMode: 'offline', currentPatch: '16.18' }, { collectionMode: 'live', currentPatch: 'latest' }]) {
    assert.throws(() => communityReportPatch(report), /COMMUNITY_REPORT_NOT_LIVE/);
  }
});
