import assert from 'node:assert/strict';
import test from 'node:test';

import { finalizeAiProviderExecution } from '../src/modules/ai-provider-execution/finalize-ai-provider-execution.js';
import { processAiProviderExecution } from '../src/modules/ai-provider-execution/process-ai-provider-execution.js';

test('finalization and durable orchestration APIs exist', () => {
  assert.equal(typeof finalizeAiProviderExecution, 'function');
  assert.equal(typeof processAiProviderExecution, 'function');
});
