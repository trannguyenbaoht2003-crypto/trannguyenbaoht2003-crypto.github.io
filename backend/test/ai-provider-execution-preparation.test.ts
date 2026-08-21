import assert from 'node:assert/strict';
import test from 'node:test';

import { prepareAiProviderExecution } from '../src/modules/ai-provider-execution/prepare-ai-provider-execution.js';

test('preparation API exists for atomic budget plus PREPARED journal creation', () => {
  assert.equal(typeof prepareAiProviderExecution, 'function');
});
