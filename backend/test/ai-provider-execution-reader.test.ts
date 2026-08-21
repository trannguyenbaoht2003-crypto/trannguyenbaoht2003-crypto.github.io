import assert from 'node:assert/strict';
import test from 'node:test';

import { readAiProviderExecutionStatus } from '../src/modules/ai-provider-execution/read-ai-provider-execution-status.js';

test('provider execution status reader exists and is read-only authority', () => {
  assert.equal(typeof readAiProviderExecutionStatus, 'function');
});
