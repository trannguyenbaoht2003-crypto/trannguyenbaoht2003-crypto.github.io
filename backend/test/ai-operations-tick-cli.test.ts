import assert from 'node:assert/strict';
import test from 'node:test';

import type { Pool } from 'pg';

import {
  parseAiOperationsTickCliConfig,
  parseAiOperationsTickCliInput,
  runAiOperationsTickCli,
  type AiOperationsTickCliDependencies,
} from '../src/ai-operations-tick-cli.js';

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
    correlationId: 'corr-tick-1',
    idempotencyKey: 'idem-tick-1',
    aiDiscoveryRunId: '22222222-2222-4222-8222-222222222222',
    startedAt: '2026-08-18T14:00:00.000Z',
    input: {
      runKey: 'run-tick-26.17-samira',
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

test('AI operations tick CLI preserves Sprint 8B provider configuration bounds', () => {
  const config = parseAiOperationsTickCliConfig(envFixture());
  assert.equal(config.provider, 'openai');
  assert.equal(config.model, 'test-model');
  assert.equal(config.timeoutMs, 5_000);

  assert.throws(
    () => parseAiOperationsTickCliConfig({ ...envFixture(), OPENAI_API_KEY: '' }),
    /AI_OPERATIONS_TICK_CONFIG_INVALID/,
  );
  assert.throws(
    () => parseAiOperationsTickCliConfig({ ...envFixture(), AI_DISCOVERY_TIMEOUT_MS: '60001' }),
    /AI_OPERATIONS_TICK_CONFIG_INVALID/,
  );
});

test('AI operations tick CLI accepts only the closed 256 KiB stdin command shape', () => {
  const parsed = parseAiOperationsTickCliInput(stdinFixture());
  assert.equal(parsed.input.gameModeExternalId, 'aram_mayhem');

  const withSecret = JSON.parse(stdinFixture()) as Record<string, unknown>;
  withSecret.OPENAI_API_KEY = 'must-not-be-accepted';
  assert.throws(
    () => parseAiOperationsTickCliInput(JSON.stringify(withSecret)),
    /AI_OPERATIONS_TICK_INPUT_INVALID/,
  );
  assert.throws(
    () => parseAiOperationsTickCliInput('x'.repeat(256 * 1024 + 1)),
    /AI_OPERATIONS_TICK_INPUT_INVALID/,
  );
});

test('AI operations tick CLI emits only safe run and budget metadata', async () => {
  let closed = 0;
  const fakePool = { end: async () => { closed += 1; } } as unknown as Pool;
  const deps: AiOperationsTickCliDependencies = {
    createPool: () => fakePool,
    createProvider: () => ({
      providerKey: 'openai',
      execute: async () => ({ providerRequestId: null, outputText: '', proposals: [] }),
    }),
    executeRun: async () => ({
      aiDiscoveryRunId: '22222222-2222-4222-8222-222222222222',
      runKey: 'run-tick-26.17-samira',
      status: 'completed',
      proposalIds: ['33333333-3333-4333-8333-333333333333'],
      proposalCount: 1,
      replayed: false,
      aiOperationsRunBudgetReservationId: '44444444-4444-4444-8444-444444444444',
      aiOperationsPolicyRevisionId: '55555555-5555-4555-8555-555555555555',
      budgetReplayed: false,
    }),
  };

  const result = await runAiOperationsTickCli(stdinFixture(), envFixture(), deps);

  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, JSON.stringify({
    runId: '22222222-2222-4222-8222-222222222222',
    status: 'completed',
    proposalCount: 1,
    replay: false,
    budgetReservationId: '44444444-4444-4444-8444-444444444444',
    budgetReplay: false,
    policyRevisionId: '55555555-5555-4555-8555-555555555555',
  }) + '\n');
  assert.equal(closed, 1);
  assert.doesNotMatch(result.stdout, /secret|observation|rationale|DATABASE_URL|OPENAI_API_KEY|Bearer/i);
});

test('AI operations tick CLI sanitizes provider and database failures', async () => {
  const fakePool = { end: async () => {} } as unknown as Pool;
  const deps: AiOperationsTickCliDependencies = {
    createPool: () => fakePool,
    createProvider: () => ({
      providerKey: 'openai',
      execute: async () => ({ providerRequestId: null, outputText: '', proposals: [] }),
    }),
    executeRun: async () => {
      throw new Error('raw-provider-body test-openai-secret secret-db-password observation rationale');
    },
  };

  const result = await runAiOperationsTickCli(stdinFixture(), envFixture(), deps);
  assert.deepEqual(result, {
    exitCode: 1,
    stdout: '',
    stderr: 'AI_OPERATIONS_TICK_FAILED\n',
  });
});
