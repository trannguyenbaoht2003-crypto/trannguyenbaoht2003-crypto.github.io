import assert from 'node:assert/strict';
import test from 'node:test';

import type { Pool } from 'pg';

import {
  parseAiOperationsPolicyCliConfig,
  parseAiOperationsPolicyCliInput,
  runAiOperationsPolicyCli,
  type AiOperationsPolicyCliDependencies,
} from '../src/ai-operations-policy-cli.js';

const POLICY_ID = '22222222-2222-4222-8222-222222222222';
const PREVIOUS_POLICY_ID = '11111111-1111-4111-8111-111111111111';

function envFixture(): NodeJS.ProcessEnv {
  return { DATABASE_URL: 'postgresql://user:secret-db-password@127.0.0.1:5432/hai_dau' };
}

function registerStdin(): string {
  return JSON.stringify({
    action: 'register',
    actorId: 'operator-1',
    correlationId: 'corr-policy-cli-register',
    idempotencyKey: 'idem-policy-cli-register',
    aiOperationsPolicyRevisionId: POLICY_ID,
    revision: 2,
    enabled: true,
    maxRunsPerUtcDay: 4,
    minIntervalSeconds: 600,
    maxProposalsPerRun: 12,
    reason: 'register reviewed policy',
  });
}

function activateStdin(): string {
  return JSON.stringify({
    action: 'activate',
    actorId: 'operator-1',
    correlationId: 'corr-policy-cli-activate',
    idempotencyKey: 'idem-policy-cli-activate',
    aiOperationsPolicyRevisionId: POLICY_ID,
    expectedCurrentAiOperationsPolicyRevisionId: PREVIOUS_POLICY_ID,
    reason: 'activate reviewed policy',
  });
}

test('AI operations policy CLI requires only a non-empty DATABASE_URL', () => {
  assert.equal(parseAiOperationsPolicyCliConfig(envFixture()).databaseUrl, envFixture().DATABASE_URL);
  assert.throws(
    () => parseAiOperationsPolicyCliConfig({ DATABASE_URL: '' }),
    /AI_OPERATIONS_POLICY_CONFIG_INVALID/,
  );
});

test('AI operations policy CLI accepts only closed register and activate stdin shapes', () => {
  const register = parseAiOperationsPolicyCliInput(registerStdin());
  const activate = parseAiOperationsPolicyCliInput(activateStdin());
  assert.equal(register.action, 'register');
  assert.equal(activate.action, 'activate');

  const withSecret = JSON.parse(registerStdin()) as Record<string, unknown>;
  withSecret.OPENAI_API_KEY = 'must-not-be-accepted';
  assert.throws(
    () => parseAiOperationsPolicyCliInput(JSON.stringify(withSecret)),
    /AI_OPERATIONS_POLICY_INPUT_INVALID/,
  );
});

test('AI operations policy CLI returns minimal safe register/activate summaries and closes resources', async () => {
  let closed = 0;
  const fakePool = { end: async () => { closed += 1; } } as unknown as Pool;
  const deps: AiOperationsPolicyCliDependencies = {
    createPool: () => fakePool,
    registerPolicy: async (_pool, command) => ({
      aiOperationsPolicyRevisionId: command.aiOperationsPolicyRevisionId,
      revision: command.revision,
      replayed: false,
    }),
    activatePolicy: async (_pool, command) => ({
      currentAiOperationsPolicyRevisionId: command.aiOperationsPolicyRevisionId,
      previousAiOperationsPolicyRevisionId: command.expectedCurrentAiOperationsPolicyRevisionId,
      replayed: false,
    }),
  };

  const register = await runAiOperationsPolicyCli(registerStdin(), envFixture(), deps);
  const activate = await runAiOperationsPolicyCli(activateStdin(), envFixture(), deps);

  assert.equal(register.exitCode, 0);
  assert.equal(register.stderr, '');
  assert.equal(register.stdout, JSON.stringify({
    action: 'register',
    policyRevisionId: POLICY_ID,
    revision: 2,
    replay: false,
  }) + '\n');
  assert.equal(activate.exitCode, 0);
  assert.equal(activate.stderr, '');
  assert.equal(activate.stdout, JSON.stringify({
    action: 'activate',
    policyRevisionId: POLICY_ID,
    previousPolicyRevisionId: PREVIOUS_POLICY_ID,
    replay: false,
  }) + '\n');
  assert.equal(closed, 2);
  assert.doesNotMatch(register.stdout + activate.stdout, /secret|DATABASE_URL|OPENAI_API_KEY/i);
});

test('AI operations policy CLI sanitizes failures', async () => {
  const fakePool = { end: async () => {} } as unknown as Pool;
  const deps: AiOperationsPolicyCliDependencies = {
    createPool: () => fakePool,
    registerPolicy: async () => { throw new Error('secret-db-password raw failure'); },
    activatePolicy: async () => { throw new Error('secret-db-password raw failure'); },
  };

  const result = await runAiOperationsPolicyCli(registerStdin(), envFixture(), deps);
  assert.deepEqual(result, {
    exitCode: 1,
    stdout: '',
    stderr: 'AI_OPERATIONS_POLICY_FAILED\n',
  });
});
