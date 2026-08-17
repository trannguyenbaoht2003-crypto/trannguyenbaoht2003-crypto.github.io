import assert from 'node:assert/strict';
import test from 'node:test';

import type { Pool } from 'pg';

import type { RecordAiDiscoveryRunCommand, RecordAiDiscoveryRunResult } from '../src/modules/ai-discovery/types.js';
import {
  executeAiDiscoveryProviderRun,
  type ExecuteAiDiscoveryProviderRunCommand,
} from '../src/modules/ai-provider/execute-ai-discovery-provider-run.js';
import {
  AiProviderError,
  type AiDiscoveryProvider,
  type AiProviderResult,
} from '../src/modules/ai-provider/openai-responses-provider.js';

const pool = {} as Pool;

function inputFixture() {
  return {
    runKey: 'run-26.17-samira',
    patchKey: '26.17',
    gameModeExternalId: 'aram_mayhem' as const,
    subjects: [
      {
        subjectExternalId: 'samira',
        allowedAugmentExternalIds: ['1194', '2001'],
        allowedItemExternalIds: ['3006', '6672'],
        observations: ['Community signal favors an aggressive crit setup.'],
      },
    ],
  };
}

function commandFixture(provider: AiDiscoveryProvider): ExecuteAiDiscoveryProviderRunCommand {
  return {
    actorId: 'operator-1',
    correlationId: 'corr-8b-1',
    idempotencyKey: 'idem-8b-1',
    aiDiscoveryRunId: '11111111-1111-4111-8111-111111111111',
    provider,
    modelKey: 'runtime-model',
    modelRevision: 'runtime-model-revision',
    input: inputFixture(),
    startedAt: '2026-08-17T10:00:00.000Z',
  };
}

function successResult(outputText = '{"proposals":[]}'): AiProviderResult {
  return {
    providerRequestId: 'resp_test',
    outputText,
    proposals: [
      {
        subjectExternalId: 'samira',
        augmentExternalIds: ['1194'],
        itemExternalIds: ['3006', '6672'],
        rationale: 'Bounded advisory proposal.',
      },
    ],
  };
}

function providerFromSteps(steps: Array<AiProviderResult | Error>): AiDiscoveryProvider & { calls: number } {
  let calls = 0;
  return {
    providerKey: 'openai',
    get calls() {
      return calls;
    },
    async execute() {
      const step = steps[Math.min(calls, steps.length - 1)];
      calls += 1;
      if (step instanceof Error) throw step;
      if (!step) throw new Error('missing provider step');
      return step;
    },
  };
}

function recorder() {
  const commands: RecordAiDiscoveryRunCommand[] = [];
  const fn = async (_pool: Pool, command: RecordAiDiscoveryRunCommand): Promise<RecordAiDiscoveryRunResult> => {
    commands.push(structuredClone(command));
    return {
      aiDiscoveryRunId: command.aiDiscoveryRunId,
      runKey: command.runKey,
      status: command.status,
      proposalIds: command.proposals.map((proposal) => proposal.aiCandidateProposalId),
      proposalCount: command.proposals.length,
      replayed: commands.length > 1,
    };
  };
  return { commands, fn };
}

test('provider execution records one completed Sprint 8A run with deterministic canonical proposals', async () => {
  const provider = providerFromSteps([successResult('transport formatting is not authority')]);
  const recorded = recorder();

  const result = await executeAiDiscoveryProviderRun(pool, commandFixture(provider), {
    recordRun: recorded.fn,
    now: () => '2026-08-17T10:00:05.000Z',
    sleep: async () => undefined,
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.proposalCount, 1);
  assert.equal(provider.calls, 1);
  assert.equal(recorded.commands.length, 1);

  const command = recorded.commands[0]!;
  assert.equal(command.providerKey, 'openai');
  assert.equal(command.promptTemplateKey, 'aram-mayhem-discovery');
  assert.equal(command.promptTemplateVersion, 1);
  assert.equal(command.status, 'completed');
  assert.equal(command.failureCode, null);
  assert.match(command.inputHash, /^[a-f0-9]{64}$/);
  assert.match(command.outputHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(command.proposals.map((proposal) => ({
    ordinal: proposal.ordinal,
    patchKey: proposal.patchKey,
    subjectExternalId: proposal.subjectExternalId,
    augmentExternalIds: proposal.augmentExternalIds,
    itemExternalIds: proposal.itemExternalIds,
    rationale: proposal.rationale,
  })), [{
    ordinal: 0,
    patchKey: '26.17',
    subjectExternalId: 'samira',
    augmentExternalIds: ['1194'],
    itemExternalIds: ['3006', '6672'],
    rationale: 'Bounded advisory proposal.',
  }]);
  assert.match(command.proposals[0]!.aiCandidateProposalId, /^[0-9a-f-]{36}$/);
  assert.doesNotMatch(JSON.stringify(command), /transport formatting is not authority|resp_test/);
});

test('provider execution retries only typed transient failures with bounded deterministic delays', async () => {
  const provider = providerFromSteps([
    new AiProviderError('PROVIDER_RATE_LIMITED', true, 'PROVIDER_RATE_LIMITED'),
    new AiProviderError('PROVIDER_UNAVAILABLE', true, 'PROVIDER_UNAVAILABLE'),
    successResult(),
  ]);
  const recorded = recorder();
  const sleeps: number[] = [];

  const result = await executeAiDiscoveryProviderRun(pool, commandFixture(provider), {
    recordRun: recorded.fn,
    now: () => '2026-08-17T10:00:05.000Z',
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
    },
  });

  assert.equal(result.status, 'completed');
  assert.equal(provider.calls, 3);
  assert.deepEqual(sleeps, [500, 1_500]);
  assert.equal(recorded.commands.length, 1);
});

test('provider execution records a failed zero-proposal run after a non-retryable provider failure', async () => {
  const provider = providerFromSteps([
    new AiProviderError('AI_PROVIDER_OUTPUT_INVALID', false, 'PROVIDER_RESPONSE_INVALID'),
  ]);
  const recorded = recorder();
  const sleeps: number[] = [];

  const result = await executeAiDiscoveryProviderRun(pool, commandFixture(provider), {
    recordRun: recorded.fn,
    now: () => '2026-08-17T10:00:05.000Z',
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
    },
  });

  assert.equal(provider.calls, 1);
  assert.deepEqual(sleeps, []);
  assert.equal(result.status, 'failed');
  const failed = recorded.commands[0]!;
  assert.equal(failed.status, 'failed');
  assert.equal(failed.failureCode, 'PROVIDER_RESPONSE_INVALID');
  assert.deepEqual(failed.proposals, []);
  assert.match(failed.outputHash, /^[a-f0-9]{64}$/);
});

test('provider execution caps retryable failure at three total attempts and records the final safe failure code', async () => {
  const provider = providerFromSteps([
    new AiProviderError('PROVIDER_UNAVAILABLE', true, 'PROVIDER_UNAVAILABLE'),
    new AiProviderError('PROVIDER_UNAVAILABLE', true, 'PROVIDER_UNAVAILABLE'),
    new AiProviderError('PROVIDER_TIMEOUT', true, 'PROVIDER_TIMEOUT'),
  ]);
  const recorded = recorder();
  const sleeps: number[] = [];

  const result = await executeAiDiscoveryProviderRun(pool, commandFixture(provider), {
    recordRun: recorded.fn,
    now: () => '2026-08-17T10:00:05.000Z',
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
    },
  });

  assert.equal(provider.calls, 3);
  assert.deepEqual(sleeps, [500, 1_500]);
  assert.equal(result.status, 'failed');
  assert.equal(recorded.commands[0]!.failureCode, 'PROVIDER_TIMEOUT');
});

test('provider execution produces the same authority command for exact stable replay despite raw provider text differences', async () => {
  const provider = providerFromSteps([
    successResult('first raw transport text'),
    successResult('different raw transport text'),
  ]);
  const recorded = recorder();
  const command = commandFixture(provider);
  const deps = {
    recordRun: recorded.fn,
    now: () => '2026-08-17T10:00:05.000Z',
    sleep: async () => undefined,
  };

  const first = await executeAiDiscoveryProviderRun(pool, command, deps);
  const second = await executeAiDiscoveryProviderRun(pool, command, deps);

  assert.equal(first.replayed, false);
  assert.equal(second.replayed, true);
  assert.equal(recorded.commands.length, 2);
  assert.equal(recorded.commands[0]!.outputHash, recorded.commands[1]!.outputHash);
  assert.deepEqual(recorded.commands[0]!.proposals, recorded.commands[1]!.proposals);
});

test('provider execution does not retry unknown errors and records only a bounded transport failure code', async () => {
  const provider = providerFromSteps([new Error('raw unknown provider secret detail')]);
  const recorded = recorder();

  await executeAiDiscoveryProviderRun(pool, commandFixture(provider), {
    recordRun: recorded.fn,
    now: () => '2026-08-17T10:00:05.000Z',
    sleep: async () => undefined,
  });

  assert.equal(provider.calls, 1);
  assert.equal(recorded.commands[0]!.failureCode, 'PROVIDER_TRANSPORT_ERROR');
  assert.doesNotMatch(JSON.stringify(recorded.commands[0]), /raw unknown provider secret detail/);
});
