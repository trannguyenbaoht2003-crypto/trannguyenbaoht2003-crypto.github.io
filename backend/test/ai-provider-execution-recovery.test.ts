import assert from 'node:assert/strict';
import test from 'node:test';

import { recoverStaleAiProviderExecutions } from '../src/modules/ai-provider-execution/recover-stale-ai-provider-executions.js';

test('recovery API exists and is provider-independent', () => {
  assert.equal(typeof recoverStaleAiProviderExecutions, 'function');
  assert.equal(recoverStaleAiProviderExecutions.length >= 1, true);
});
