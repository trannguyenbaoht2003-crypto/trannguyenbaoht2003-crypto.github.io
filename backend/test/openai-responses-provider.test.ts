import assert from 'node:assert/strict';
import test from 'node:test';

import { buildAiProviderRequest } from '../src/modules/ai-provider/build-provider-request.js';
import { normalizeAiProviderExecutionInput } from '../src/modules/ai-provider/normalize-provider-execution-input.js';
import {
  AiProviderError,
  createOpenAiResponsesProvider,
} from '../src/modules/ai-provider/openai-responses-provider.js';

function requestFixture() {
  return buildAiProviderRequest(normalizeAiProviderExecutionInput({
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
  }));
}

function responseBody(output: unknown, id = 'resp_test') {
  return {
    id,
    status: 'completed',
    output: [
      {
        id: 'msg_test',
        type: 'message',
        role: 'assistant',
        content: [
          {
            type: 'output_text',
            text: JSON.stringify(output),
            annotations: [],
          },
        ],
      },
    ],
  };
}

function fetchReturning(body: unknown, status = 200): typeof fetch {
  return (async () => new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })) as typeof fetch;
}

async function rejectCode(
  promise: Promise<unknown>,
  code: string,
  retryable: boolean,
): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof AiProviderError);
    assert.equal(error.code, code);
    assert.equal(error.retryable, retryable);
    return true;
  });
}

test('OpenAI Responses adapter sends strict structured output with store disabled and no secret in body', async () => {
  let capturedUrl = '';
  let capturedInit: RequestInit | undefined;
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    capturedUrl = String(input);
    capturedInit = init;
    return new Response(JSON.stringify(responseBody({
      proposals: [
        {
          subjectExternalId: 'samira',
          augmentExternalIds: ['1194'],
          itemExternalIds: ['3006', '6672'],
          rationale: 'Bounded advisory proposal.',
        },
      ],
    })), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;

  const provider = createOpenAiResponsesProvider({
    apiKey: 'test-secret-value',
    model: 'test-model',
    fetchImpl: fakeFetch,
    timeoutMs: 5_000,
  });

  const result = await provider.execute(requestFixture());

  assert.equal(provider.providerKey, 'openai');
  assert.equal(capturedUrl, 'https://api.openai.com/v1/responses');
  assert.equal(capturedInit?.method, 'POST');
  const headers = new Headers(capturedInit?.headers);
  assert.equal(headers.get('authorization'), 'Bearer test-secret-value');
  assert.equal(headers.get('content-type'), 'application/json');

  const bodyText = String(capturedInit?.body);
  assert.doesNotMatch(bodyText, /test-secret-value/);
  const body = JSON.parse(bodyText) as Record<string, unknown>;
  assert.equal(body.model, 'test-model');
  assert.equal(body.store, false);
  assert.deepEqual(body.input, requestFixture().messages);
  assert.deepEqual(body.text, {
    format: {
      type: 'json_schema',
      name: 'aram_mayhem_discovery',
      strict: true,
      schema: requestFixture().responseSchema,
    },
  });

  assert.equal(result.providerRequestId, null);
  assert.equal(result.providerResponseId, 'resp_test');
  assert.deepEqual(result.proposals, [
    {
      subjectExternalId: 'samira',
      augmentExternalIds: ['1194'],
      itemExternalIds: ['3006', '6672'],
      rationale: 'Bounded advisory proposal.',
    },
  ]);
});

test('OpenAI Responses adapter maps bounded HTTP and transport failures without provider body leakage', async () => {
  const cases = [
    { status: 401, code: 'PROVIDER_AUTH_REJECTED', retryable: false },
    { status: 400, code: 'PROVIDER_REQUEST_REJECTED', retryable: false },
    { status: 408, code: 'PROVIDER_TIMEOUT', retryable: true },
    { status: 429, code: 'PROVIDER_RATE_LIMITED', retryable: true },
    { status: 500, code: 'PROVIDER_UNAVAILABLE', retryable: true },
    { status: 502, code: 'PROVIDER_UNAVAILABLE', retryable: true },
    { status: 503, code: 'PROVIDER_UNAVAILABLE', retryable: true },
    { status: 504, code: 'PROVIDER_UNAVAILABLE', retryable: true },
  ] as const;

  for (const entry of cases) {
    const provider = createOpenAiResponsesProvider({
      apiKey: 'test-secret-value',
      model: 'test-model',
      fetchImpl: fetchReturning({ error: { message: 'raw-provider-secret-body' } }, entry.status),
    });
    await assert.rejects(provider.execute(requestFixture()), (error: unknown) => {
      assert.ok(error instanceof AiProviderError);
      assert.equal(error.code, entry.code);
      assert.equal(error.retryable, entry.retryable);
      assert.doesNotMatch(error.message, /raw-provider-secret-body|test-secret-value/);
      return true;
    });
  }

  const timeoutFetch = (async () => {
    const error = new Error('secret transport details');
    error.name = 'AbortError';
    throw error;
  }) as typeof fetch;
  await rejectCode(createOpenAiResponsesProvider({
    apiKey: 'test-secret-value',
    model: 'test-model',
    fetchImpl: timeoutFetch,
  }).execute(requestFixture()), 'PROVIDER_TIMEOUT', true);

  const transportFetch = (async () => {
    throw new Error('socket and secret transport details');
  }) as typeof fetch;
  await rejectCode(createOpenAiResponsesProvider({
    apiKey: 'test-secret-value',
    model: 'test-model',
    fetchImpl: transportFetch,
  }).execute(requestFixture()), 'PROVIDER_TRANSPORT_ERROR', true);
});

test('OpenAI Responses adapter rejects malformed, extra-field and allow-list violating output locally', async () => {
  const invalidBodies = [
    { body: { id: 'resp_test', status: 'completed', output: [] }, code: 'AI_PROVIDER_OUTPUT_INVALID' },
    { body: responseBody({ proposals: [], extra: true }), code: 'AI_PROVIDER_OUTPUT_INVALID' },
    {
      body: responseBody({
        proposals: [{
          subjectExternalId: 'samira',
          augmentExternalIds: ['1194'],
          itemExternalIds: ['3006'],
          rationale: null,
          extra: true,
        }],
      }),
      code: 'AI_PROVIDER_OUTPUT_INVALID',
    },
    {
      body: responseBody({
        proposals: [{
          subjectExternalId: 'invented-subject',
          augmentExternalIds: ['1194'],
          itemExternalIds: ['3006'],
          rationale: null,
        }],
      }),
      code: 'AI_PROVIDER_ALLOWLIST_VIOLATION',
    },
    {
      body: responseBody({
        proposals: [{
          subjectExternalId: 'samira',
          augmentExternalIds: ['invented-augment'],
          itemExternalIds: ['3006'],
          rationale: null,
        }],
      }),
      code: 'AI_PROVIDER_ALLOWLIST_VIOLATION',
    },
    {
      body: responseBody({
        proposals: [{
          subjectExternalId: 'samira',
          augmentExternalIds: ['1194'],
          itemExternalIds: ['invented-item'],
          rationale: 'x'.repeat(2_001),
        }],
      }),
      code: 'AI_PROVIDER_OUTPUT_INVALID',
    },
  ] as const;

  for (const entry of invalidBodies) {
    await rejectCode(createOpenAiResponsesProvider({
      apiKey: 'test-secret-value',
      model: 'test-model',
      fetchImpl: fetchReturning(entry.body),
    }).execute(requestFixture()), entry.code, false);
  }
});

test('OpenAI Responses adapter honors an injected non-production endpoint without changing request authority', async () => {
  let capturedUrl = '';
  const fakeFetch = (async (input: string | URL | Request) => {
    capturedUrl = String(input);
    return new Response(JSON.stringify(responseBody({ proposals: [] })), { status: 200 });
  }) as typeof fetch;

  const provider = createOpenAiResponsesProvider({
    apiKey: 'test-secret-value',
    model: 'test-model',
    endpoint: 'http://127.0.0.1:9999/v1/responses',
    fetchImpl: fakeFetch,
  });
  const result = await provider.execute(requestFixture());

  assert.equal(capturedUrl, 'http://127.0.0.1:9999/v1/responses');
  assert.equal(result.proposals.length, 0);
});

test('OpenAI Responses adapter sends client tracing ID and separates HTTP request ID from response object ID', async () => {
  let capturedInit: RequestInit | undefined;
  const fakeFetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    capturedInit = init;
    return new Response(JSON.stringify(responseBody({ proposals: [] }, 'resp_object_123')), {
      status: 200,
      headers: { 'content-type': 'application/json', 'x-request-id': 'req_server_456' },
    });
  }) as typeof fetch;
  const provider = createOpenAiResponsesProvider({
    apiKey: 'test-secret-value',
    model: 'test-model',
    fetchImpl: fakeFetch,
  });
  const result = await provider.execute(requestFixture(), {
    clientRequestId: '11111111-1111-5111-8111-111111111111',
  });
  const headers = new Headers(capturedInit?.headers);
  assert.equal(headers.get('x-client-request-id'), '11111111-1111-5111-8111-111111111111');
  assert.equal(result.providerRequestId, 'req_server_456');
  assert.equal(result.providerResponseId, 'resp_object_123');
});
