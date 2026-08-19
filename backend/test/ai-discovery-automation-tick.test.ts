import assert from 'node:assert/strict';
import test from 'node:test';

import { processScheduledAiDiscoveryTick } from '../src/modules/ai-automation/process-scheduled-ai-discovery-tick.js';

test('Sprint 8D exposes the durable scheduled tick processor', () => {
  assert.equal(typeof processScheduledAiDiscoveryTick, 'function');
});
