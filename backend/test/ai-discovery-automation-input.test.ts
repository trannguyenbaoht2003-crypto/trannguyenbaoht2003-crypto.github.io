import assert from 'node:assert/strict';
import test from 'node:test';

import { buildScheduledAiDiscoveryInput } from '../src/modules/ai-automation/build-scheduled-ai-discovery-input.js';

test('Sprint 8D exposes the deterministic scheduled input builder', () => {
  assert.equal(typeof buildScheduledAiDiscoveryInput, 'function');
});
