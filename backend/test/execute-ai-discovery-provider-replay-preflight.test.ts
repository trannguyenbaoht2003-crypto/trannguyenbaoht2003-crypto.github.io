import assert from 'node:assert/strict';
import test from 'node:test';

import type { Pool } from 'pg';

import type { RecordAiDiscoveryRunResult } from '../src/modules/ai-discovery/types.js';
import { executeAiDiscoveryProviderRun } from '../src/modules/ai-provider/execute-ai-discovery-provider-run.js';
import type { AiDiscoveryProvider } from '../src/modules/ai-provider/openai-responses-provider.js';

const pool = {} as Pool;

function providerFixture(): AiDiscoveryProvider & { calls: number } {
  let calls = 0;
  return {
    providerKey: 'openai',
    get calls() {
      return calls;
    },
    async execute() {
      calls += 1;
      throw new Error('provider must not execute for a completed replay');
    },
  };
}

test('provider execution returns completed Sprint 8A replay before any provider or record call', async () => {
  const provider = providerFixture();
  const replay: RecordAiDiscoveryRunResult = {
    aiDiscoveryRunId: '11111111-1111-4111-8111-111111111111',
    runKey: 'run-26.17-samira',
    status: 'completed',
    proposalIds: ['22222222-2222-4222-8222-222222222222'],
    proposalCount: 1,
    replayed: true,
  };
  let recordCalls = 0;
  let replayCalls = 0;

  const result = await executeAiDiscoveryProviderRun(pool, {
    actorId: 'operator-1',
    correlationId: 'corr-8b-replay',
    idempotencyKey: 'idem-8b-replay',
    aiDiscoveryRunId: replay.aiDiscoveryRunId,
    provider,
    modelKey: 'runtime-model',
    modelRevision: 'runtime-model-revision',
    input: {
      runKey: replay.runKey,
      patchKey: '26.17',
      gameModeExternalId: 'aram_mayhem',
      subjects: [{
        subjectExternalId: 'samira',
        allowedAugmentExternalIds: ['1194'],
        allowedItemExternalIds: ['3006'],
        observations: ['Governed community signal.'],
      }],
    },
    startedAt: '2026-08-17T10:00:00.000Z',
  }, {
    readReplay: async (_pool, identity) => {
      replayCalls += 1;
      assert.equal(identity.runKey, replay.runKey);
      assert.equal(identity.providerKey, 'openai');
      assert.equal(identity.promptTemplateKey, 'aram-mayhem-discovery');
      assert.equal(identity.promptTemplateVersion, 1);
      assert.match(identity.inputHash, /^[a-f0-9]{64}$/);
      return replay;
    },
    recordRun: async () => {
      recordCalls += 1;
      throw new Error('recordRun must not execute for a completed replay');
    },
    now: () => '2026-08-17T10:00:05.000Z',
    sleep: async () => undefined,
  });

  assert.deepEqual(result, replay);
  assert.equal(replayCalls, 1);
  assert.equal(provider.calls, 0);
  assert.equal(recordCalls, 0);
});
