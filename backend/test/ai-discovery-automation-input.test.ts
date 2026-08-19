import assert from 'node:assert/strict';
import test from 'node:test';

import {
  deterministicScheduledRunUuid,
  deriveScheduledAiDiscoveryIdentity,
} from '../src/modules/ai-automation/scheduled-run-identity.js';
import { buildScheduledAiDiscoveryInput } from '../src/modules/ai-automation/build-scheduled-ai-discovery-input.js';
import { resetDatabase } from './helpers/database.js';

test('scheduled run UUID uses the approved deterministic UUID v5 namespace semantics', () => {
  assert.equal(
    deterministicScheduledRunUuid('a'.repeat(64)),
    '2417aa84-89c6-5635-8c6f-95902318ada6',
  );
});

test('scheduled content identity excludes time and is stable for identical authoritative content', () => {
  const content = {
    patchKey: '26.16',
    gameModeExternalId: 'aram_mayhem' as const,
    subjects: [{
      subjectExternalId: 'champion:1',
      allowedAugmentExternalIds: ['augment:1'],
      allowedItemExternalIds: ['item:1'],
      observations: [JSON.stringify({
        schemaVersion: 1,
        origin: 'editorial',
        augmentExternalIds: ['augment:1'],
        itemExternalIds: ['item:1'],
      })],
    }],
  };
  const first = deriveScheduledAiDiscoveryIdentity(content);
  const second = deriveScheduledAiDiscoveryIdentity(structuredClone(content));
  assert.deepEqual(second, first);
  assert.equal(first.runKey, `scheduled:v1:${first.scheduledContentHash}`);
  assert.equal(first.idempotencyKey, `ai-discovery-scheduled:v1:${first.scheduledContentHash}`);
  assert.match(first.aiDiscoveryRunId, /^[0-9a-f-]{36}$/u);
});

test('scheduled input builder fails closed when there is no exact active catalog authority', async () => {
  const pool = await resetDatabase();
  try {
    await assert.rejects(
      buildScheduledAiDiscoveryInput(pool),
      /AI_AUTOMATION_ACTIVE_CATALOG_UNAVAILABLE/,
    );
  } finally {
    await pool.end();
  }
});
