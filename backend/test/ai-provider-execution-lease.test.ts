import assert from 'node:assert/strict';
import test from 'node:test';

import { claimAiProviderExecution } from '../src/modules/ai-provider-execution/claim-ai-provider-execution.js';
import { markAiProviderAttemptInFlight } from '../src/modules/ai-provider-execution/mark-ai-provider-attempt-in-flight.js';

test('lease APIs exist and separate claim from durable IN_FLIGHT transition', () => {
  assert.equal(typeof claimAiProviderExecution, 'function');
  assert.equal(typeof markAiProviderAttemptInFlight, 'function');
});
