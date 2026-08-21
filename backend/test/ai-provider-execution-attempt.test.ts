import assert from 'node:assert/strict';
import test from 'node:test';

import { deterministicAiProviderClientRequestId } from '../src/modules/ai-provider-execution/client-request-id.js';
import { executeAiProviderAttempt } from '../src/modules/ai-provider-execution/execute-ai-provider-attempt.js';

test('client request id is deterministic per execution and attempt ordinal', () => {
  const executionId = '11111111-1111-4111-8111-111111111111';
  const first = deterministicAiProviderClientRequestId(executionId, 1);
  assert.equal(first, deterministicAiProviderClientRequestId(executionId, 1));
  assert.notEqual(first, deterministicAiProviderClientRequestId(executionId, 2));
  assert.match(first, /^[0-9a-f-]{36}$/i);
});

test('single-attempt executor exists so retry ownership is outside provider adapter', () => {
  assert.equal(typeof executeAiProviderAttempt, 'function');
});
