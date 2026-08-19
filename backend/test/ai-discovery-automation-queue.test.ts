import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { parseAiAutomationConfig } from '../src/ai-automation-config.js';
import {
  AI_DISCOVERY_SCHEDULER_EVERY_MS,
  AI_DISCOVERY_SCHEDULER_ID,
  reconcileAiDiscoveryScheduler,
} from '../src/queue/ai-discovery-scheduler.js';
import { AI_DISCOVERY_AUTOMATION_QUEUE_NAME } from '../src/queue/names.js';

test('Sprint 8D fixes the private queue and hourly scheduler identity', () => {
  assert.equal(AI_DISCOVERY_AUTOMATION_QUEUE_NAME, 'hai-dau-ai-discovery-automation-v1');
  assert.equal(AI_DISCOVERY_SCHEDULER_ID, 'ai-discovery-hourly-v1');
  assert.equal(AI_DISCOVERY_SCHEDULER_EVERY_MS, 3_600_000);
});

test('enabled reconciliation upserts exact minimal payload with no BullMQ retry', async () => {
  const calls: unknown[][] = [];
  const queue = {
    async upsertJobScheduler(...args: unknown[]) {
      calls.push(args);
    },
    async removeJobScheduler() {},
  };
  const outcome = await reconcileAiDiscoveryScheduler(queue, true);
  assert.equal(outcome, 'enabled');
  assert.deepEqual(calls, [[
    'ai-discovery-hourly-v1',
    { every: 3_600_000 },
    {
      name: 'scheduled-ai-discovery',
      data: { schemaVersion: 1 },
      opts: { attempts: 1 },
    },
  ]]);
});

test('disabled reconciliation removes stale scheduler idempotently', async () => {
  const removed: string[] = [];
  const queue = {
    async upsertJobScheduler() {},
    async removeJobScheduler(id: string) {
      removed.push(id);
    },
  };
  await reconcileAiDiscoveryScheduler(queue, false);
  await reconcileAiDiscoveryScheduler(queue, false);
  assert.deepEqual(removed, ['ai-discovery-hourly-v1', 'ai-discovery-hourly-v1']);
});

test('disabled config is default and does not require provider credentials', () => {
  const config = parseAiAutomationConfig({
    DATABASE_URL: 'postgres://example',
    REDIS_URL: 'redis://example',
  });
  assert.equal(config.schedulerEnabled, false);
  assert.equal(config.providerConfig, undefined);
});

test('enabled config fails closed without provider settings', () => {
  assert.throws(
    () => parseAiAutomationConfig({
      DATABASE_URL: 'postgres://example',
      REDIS_URL: 'redis://example',
      AI_DISCOVERY_SCHEDULER_ENABLED: 'true',
    }),
    /AI_AUTOMATION_CONFIG_INVALID/,
  );
});

test('scheduler flag only accepts exact true or false', () => {
  assert.throws(
    () => parseAiAutomationConfig({
      DATABASE_URL: 'postgres://example',
      REDIS_URL: 'redis://example',
      AI_DISCOVERY_SCHEDULER_ENABLED: 'TRUE',
    }),
    /AI_AUTOMATION_CONFIG_INVALID/,
  );
});

test('dedicated automation entrypoint owns provider wiring while core worker stays provider-free', async () => {
  const automation = await readFile(new URL('../src/ai-automation-worker.ts', import.meta.url), 'utf8');
  const coreWorker = await readFile(new URL('../src/worker.ts', import.meta.url), 'utf8');
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.match(automation, /createOpenAiResponsesProvider/u);
  assert.equal(coreWorker.includes('createOpenAiResponsesProvider'), false);
  assert.equal(coreWorker.includes('OPENAI_API_KEY'), false);
  assert.equal(packageJson.scripts['start:ai-automation'], 'node dist/src/ai-automation-worker.js');
});
