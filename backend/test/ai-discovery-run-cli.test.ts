import assert from 'node:assert/strict';
import test from 'node:test';

import type { Pool } from 'pg';

import type { RecordAiDiscoveryRunResult } from '../src/modules/ai-discovery/types.js';
import {
  parseAiDiscoveryRunCliConfig,
  parseAiDiscoveryRunCliInput,
  runAiDiscoveryRunCli,
  type AiDiscoveryRunCliDependencies,
} from '../src/ai-discovery-run-cli.js';

function envFixture(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://user:secret-db-password@127.0.0.1:5432/hai_dau',
    AI_DISCOVERY_PROVIDER: 'openai',
    OPENAI_API_KEY: 'test-openai-secret',
    AI_DISCOVERY_OPENAI_MODEL: 'test-model',
    AI_DISCOVERY_TIMEOUT_MS: '5000',
  };
}

function stdinFixture(): string {
  return JSON.stringify({
    actorId: 'operator-1',
    correlationId: 'corr-cli-1',
    idempotencyKey: 'idem-cli-1',
    aiDiscoveryRunId: '22222222-2222-4222-8222-222222222222',
    startedAt: '2026-08-17T10:30:00.000Z',
    input: {
      runKey: 'run-cli-26.17-samira',
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
    },
  });
}

test('AI discovery CLI validates server-only environment configuration and timeout bounds', () => {
  const config = parseAiDiscoveryRunCliConfig(envFixture());
  assert.equal(config.provider, 'openai');
  assert.equal(config.model, 'test-model');
  assert.equal(config.timeoutMs, 5_000);
  assert.equal(config.endpoint, undefined);

  assert.throws(
    () => parseAiDiscoveryRunCliConfig({ ...envFixture(), OPENAI_API_KEY: '' }),
    /AI_PROVIDER_CONFIG_INVALID/,
  );
  assert.throws(
    () => parseAiDiscoveryRunCliConfig({ ...envFixture(), AI_DISCOVERY_PROVIDER: 'other' }),
    /AI_PROVIDER_CONFIG_INVALID/,
  );
  assert.throws(
    () => parseAiDiscoveryRunCliConfig({ ...envFixture(), AI_DISCOVERY_TIMEOUT_MS: '999' }),
    /AI_PROVIDER_CONFIG_INVALID/,
  );
  assert.throws(
    () => parseAiDiscoveryRunCliConfig({ ...envFixture(), AI_DISCOVERY_TIMEOUT_MS: '60001' }),
    /AI_PROVIDER_CONFIG_INVALID/,
  );
});

test('AI discovery CLI allows custom endpoint only outside production', () => {
  const nonProduction = parseAiDiscoveryRunCliConfig({
    ...envFixture(),
    AI_DISCOVERY_OPENAI_ENDPOINT: 'http://127.0.0.1:9999/v1/responses',
  });
  assert.equal(nonProduction.endpoint, 'http://127.0.0.1:9999/v1/responses');

  assert.throws(
    () => parseAiDiscoveryRunCliConfig({
      ...envFixture(),
      NODE_ENV: 'production',
      AI_DISCOVERY_OPENAI_ENDPOINT: 'http://127.0.0.1:9999/v1/responses',
    }),
    /AI_PROVIDER_CONFIG_INVALID/,
  );
});

test('AI discovery CLI accepts only the closed stdin command shape and enforces 256 KiB hard limit', () => {
  const parsed = parseAiDiscoveryRunCliInput(stdinFixture());
  assert.equal(parsed.actorId, 'operator-1');
  assert.equal(parsed.input.gameModeExternalId, 'aram_mayhem');

  const withSecretField = JSON.parse(stdinFixture()) as Record<string, unknown>;
  withSecretField.OPENAI_API_KEY = 'must-not-be-accepted';
  assert.throws(
    () => parseAiDiscoveryRunCliInput(JSON.stringify(withSecretField)),
    /AI_PROVIDER_INPUT_INVALID/,
  );

  assert.throws(
    () => parseAiDiscoveryRunCliInput('x'.repeat(256 * 1024 + 1)),
    /AI_PROVIDER_INPUT_INVALID/,
  );
});

test('AI discovery CLI success output is a minimal sanitized summary and resources close', async () => {
  let closed = 0;
  let providerConfig: Record<string, unknown> | null = null;
  const fakePool = { end: async () => { closed += 1; } } as unknown as Pool;
  const deps: AiDiscoveryRunCliDependencies = {
    createPool: () => fakePool,
    createProvider: (config) => {
      providerConfig = { ...config, apiKey: '<redacted>' };
      return { providerKey: 'openai', execute: async () => ({ providerRequestId: null, outputText: '', proposals: [] }) };
    },
    executeRun: async (): Promise<RecordAiDiscoveryRunResult> => ({
      aiDiscoveryRunId: '22222222-2222-4222-8222-222222222222',
      runKey: 'run-cli-26.17-samira',
      status: 'completed',
      proposalIds: ['33333333-3333-4333-8333-333333333333'],
      proposalCount: 1,
      replayed: false,
    }),
  };

  const result = await runAiDiscoveryRunCli(stdinFixture(), envFixture(), deps);

  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, JSON.stringify({
    runId: '22222222-2222-4222-8222-222222222222',
    status: 'completed',
    proposalCount: 1,
    replay: false,
  }) + '\n');
  assert.equal(closed, 1);
  assert.deepEqual(providerConfig, {
    apiKey: '<redacted>',
    model: 'test-model',
    timeoutMs: 5_000,
  });
  assert.doesNotMatch(result.stdout, /secret|observation|rationale|DATABASE_URL|OPENAI_API_KEY|Bearer/i);
});

test('AI discovery CLI failure output never leaks env, prompt, observation, rationale or provider body', async () => {
  let closed = 0;
  const fakePool = { end: async () => { closed += 1; } } as unknown as Pool;
  const deps: AiDiscoveryRunCliDependencies = {
    createPool: () => fakePool,
    createProvider: () => ({ providerKey: 'openai', execute: async () => ({ providerRequestId: null, outputText: '', proposals: [] }) }),
    executeRun: async () => {
      throw new Error('raw-provider-body test-openai-secret secret-db-password Community signal favors rationale');
    },
  };

  const result = await runAiDiscoveryRunCli(stdinFixture(), envFixture(), deps);

  assert.equal(result.exitCode, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'AI_DISCOVERY_RUN_FAILED\n');
  assert.equal(closed, 1);
  assert.doesNotMatch(result.stderr, /raw-provider|test-openai-secret|secret-db-password|Community signal|rationale/i);
});
