import assert from 'node:assert/strict';
import test from 'node:test';

import type { Pool } from 'pg';

import {
  parseAiDiscoveryMaterializeCliConfig,
  parseAiDiscoveryMaterializeCliInput,
  runAiDiscoveryMaterializeCli,
  type AiDiscoveryMaterializeCliDependencies,
} from '../src/ai-discovery-materialize-cli.js';

function envFixture(): NodeJS.ProcessEnv {
  return { DATABASE_URL: 'postgresql://user:secret-db-password@127.0.0.1:5432/hai_dau' };
}

function stdinFixture(): string {
  return JSON.stringify({
    actorId: 'operator-1',
    correlationId: 'corr-materialize-1',
    idempotencyKey: 'idem-materialize-1',
    aiCandidateMaterializationId: '22222222-2222-4222-8222-222222222222',
    aiCandidateProposalId: '33333333-3333-4333-8333-333333333333',
    reason: 'operator explicitly selected this proposal for Candidate review',
    materializedAt: '2026-08-18T14:15:00.000Z',
  });
}

test('AI proposal materialization CLI requires only DATABASE_URL and a closed one-proposal command', () => {
  assert.equal(parseAiDiscoveryMaterializeCliConfig(envFixture()).databaseUrl, envFixture().DATABASE_URL);
  const input = parseAiDiscoveryMaterializeCliInput(stdinFixture());
  assert.equal(input.aiCandidateProposalId, '33333333-3333-4333-8333-333333333333');

  const withBulk = JSON.parse(stdinFixture()) as Record<string, unknown>;
  withBulk.proposalIds = ['33333333-3333-4333-8333-333333333333'];
  assert.throws(
    () => parseAiDiscoveryMaterializeCliInput(JSON.stringify(withBulk)),
    /AI_DISCOVERY_MATERIALIZE_INPUT_INVALID/,
  );
  assert.throws(
    () => parseAiDiscoveryMaterializeCliInput(JSON.stringify({
      ...JSON.parse(stdinFixture()),
      aiCandidateProposalId: 'not-a-uuid',
    })),
    /AI_DISCOVERY_MATERIALIZE_INPUT_INVALID/,
  );
});

test('AI proposal materialization CLI calls existing authority once and emits only safe IDs', async () => {
  let closed = 0;
  let calls = 0;
  const fakePool = { end: async () => { closed += 1; } } as unknown as Pool;
  const deps: AiDiscoveryMaterializeCliDependencies = {
    createPool: () => fakePool,
    materializeProposal: async (_pool, command) => {
      calls += 1;
      return {
        aiCandidateMaterializationId: command.aiCandidateMaterializationId,
        aiCandidateProposalId: command.aiCandidateProposalId,
        candidateId: '44444444-4444-4444-8444-444444444444',
        candidateRevisionId: '55555555-5555-4555-8555-555555555555',
        candidateProvenanceId: '66666666-6666-4666-8666-666666666666',
        normalizedObservationId: '77777777-7777-4777-8777-777777777777',
        rawObservationId: '88888888-8888-4888-8888-888888888888',
        reusedCanonicalGraph: false,
        replayed: false,
      };
    },
  };

  const result = await runAiDiscoveryMaterializeCli(stdinFixture(), envFixture(), deps);

  assert.equal(calls, 1);
  assert.equal(closed, 1);
  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, JSON.stringify({
    materializationId: '22222222-2222-4222-8222-222222222222',
    proposalId: '33333333-3333-4333-8333-333333333333',
    candidateId: '44444444-4444-4444-8444-444444444444',
    candidateRevisionId: '55555555-5555-4555-8555-555555555555',
    replay: false,
  }) + '\n');
  assert.doesNotMatch(result.stdout, /reason|secret|DATABASE_URL|OPENAI_API_KEY|observation|rationale/i);
});

test('AI proposal materialization CLI sanitizes all failures', async () => {
  const fakePool = { end: async () => {} } as unknown as Pool;
  const deps: AiDiscoveryMaterializeCliDependencies = {
    createPool: () => fakePool,
    materializeProposal: async () => {
      throw new Error('secret-db-password raw observation rationale');
    },
  };

  const result = await runAiDiscoveryMaterializeCli(stdinFixture(), envFixture(), deps);
  assert.deepEqual(result, {
    exitCode: 1,
    stdout: '',
    stderr: 'AI_DISCOVERY_MATERIALIZE_FAILED\n',
  });
});
