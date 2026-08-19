import assert from 'node:assert/strict';
import test from 'node:test';

import { AI_DISCOVERY_SCHEDULER_ID, reconcileAiDiscoveryScheduler } from '../src/queue/ai-discovery-scheduler.js';

test('Sprint 8D fixes the hourly scheduler identity', () => {
  assert.equal(AI_DISCOVERY_SCHEDULER_ID, 'ai-discovery-hourly-v1');
  assert.equal(typeof reconcileAiDiscoveryScheduler, 'function');
});
