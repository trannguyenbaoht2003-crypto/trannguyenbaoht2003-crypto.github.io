import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AI_DISCOVERY_PROMPT_TEMPLATE_KEY,
  AI_DISCOVERY_PROMPT_TEMPLATE_VERSION,
  buildAiProviderRequest,
} from '../src/modules/ai-provider/build-provider-request.js';
import { normalizeAiProviderExecutionInput } from '../src/modules/ai-provider/normalize-provider-execution-input.js';

function normalizedFixture() {
  return normalizeAiProviderExecutionInput({
    runKey: 'run-26.17-samira',
    patchKey: '26.17',
    gameModeExternalId: 'aram_mayhem',
    subjects: [
      {
        subjectExternalId: 'samira',
        allowedAugmentExternalIds: ['1194', '2001'],
        allowedItemExternalIds: ['3006', '6672'],
        observations: ['Community signal favors an aggressive crit setup.'],
      },
    ],
  });
}

test('provider request uses stable versioned prompt metadata and deterministic messages', () => {
  const normalized = normalizedFixture();
  const first = buildAiProviderRequest(normalized);
  const second = buildAiProviderRequest(normalized);

  assert.equal(AI_DISCOVERY_PROMPT_TEMPLATE_KEY, 'aram-mayhem-discovery');
  assert.equal(AI_DISCOVERY_PROMPT_TEMPLATE_VERSION, 1);
  assert.equal(first.promptTemplateKey, AI_DISCOVERY_PROMPT_TEMPLATE_KEY);
  assert.equal(first.promptTemplateVersion, AI_DISCOVERY_PROMPT_TEMPLATE_VERSION);
  assert.deepEqual(first, second);
  assert.deepEqual(first.input, normalized);

  const serializedMessages = JSON.stringify(first.messages);
  assert.match(serializedMessages, /select only IDs supplied/i);
  assert.match(serializedMessages, /not Evidence/i);
  assert.match(serializedMessages, /advisory/i);
});

test('provider request exposes a strict closed structured-output schema', () => {
  const request = buildAiProviderRequest(normalizedFixture());
  const schema = request.responseSchema;

  assert.equal(schema.type, 'object');
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ['proposals']);
  assert.deepEqual(Object.keys(schema.properties), ['proposals']);

  const proposals = schema.properties.proposals;
  assert.equal(proposals.type, 'array');
  assert.equal(proposals.maxItems, 64);
  assert.equal(proposals.items.type, 'object');
  assert.equal(proposals.items.additionalProperties, false);
  assert.deepEqual(proposals.items.required, [
    'subjectExternalId',
    'augmentExternalIds',
    'itemExternalIds',
    'rationale',
  ]);
  assert.deepEqual(Object.keys(proposals.items.properties), [
    'subjectExternalId',
    'augmentExternalIds',
    'itemExternalIds',
    'rationale',
  ]);
  assert.equal(proposals.items.properties.rationale.maxLength, 2_000);
});

test('provider request contains no credential-bearing or publication-authority fields', () => {
  const request = buildAiProviderRequest(normalizedFixture());
  const serialized = JSON.stringify(request);

  assert.doesNotMatch(serialized, /api[_-]?key|authorization|bearer|cookie/i);
  assert.doesNotMatch(serialized, /publish(?:ed|ing)?\s*automatically|autoPublish/i);
  assert.doesNotMatch(serialized, /evidenceDecision|humanReviewDecision|moderationDecision|eligibilityDecision/i);
});
