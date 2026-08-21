import assert from 'node:assert/strict';
import test from 'node:test';

import { reconcileAiProviderExecution } from '../src/modules/ai-provider-execution/reconcile-ai-provider-execution.js';

test('reconciliation API exists as explicit operator authority', () => {
  assert.equal(typeof reconcileAiProviderExecution, 'function');
});
