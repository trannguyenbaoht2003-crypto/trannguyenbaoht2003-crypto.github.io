import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import type { Pool } from 'pg';

import {
  activateAiOperationsPolicyRevision,
} from '../src/modules/ai-operations/activate-ai-operations-policy-revision.js';
import {
  executePolicyGovernedAiDiscoveryRun,
} from '../src/modules/ai-operations/execute-policy-governed-ai-discovery-run.js';
import {
  registerAiOperationsPolicyRevision,
} from '../src/modules/ai-operations/register-ai-operations-policy-revision.js';
import type { AiDiscoveryProvider } from '../src/modules/ai-provider/openai-responses-provider.js';
import { resetDatabase } from './helpers/database.js';

const PROVIDER_INPUT = {
  runKey: 'ops-provider-run',
  patchKey: '26.17',
  gameModeExternalId: 'aram_mayhem' as const,
  subjects: [
    {
      subjectExternalId: 'samira',
      allowedAugmentExternalIds: ['1194'],
      allowedItemExternalIds: ['3006', '3031'],
      observations: ['Community discussion suggests testing this bounded build.'],
    },
  ],
};

async function enablePolicy(
  pool: Pool,
  maxProposalsPerRun = 4,
): Promise<string> {
  const active = await pool.query<{ ai_operations_policy_revision_id: string }>(
    `select ai_operations_policy_revision_id
       from active_ai_operations_policy_revision
      where scope = 'ai_discovery_provider'`,
  );
  const previous = active.rows[0]!.ai_operations_policy_revision_id;
  const policyId = randomUUID();
  await registerAiOperationsPolicyRevision(pool, {
    actorId: 'operator:test',
    correlationId: `corr-orchestrator-register-${policyId}`,
    idempotencyKey: `idem-orchestrator-register-${policyId}`,
    aiOperationsPolicyRevisionId: policyId,
    revision: 2,
    enabled: true,
    maxRunsPerUtcDay: 8,
    minIntervalSeconds: 0,
    maxProposalsPerRun,
    reason: 'enable test provider execution',
  });
  await activateAiOperationsPolicyRevision(pool, {
    actorId: 'operator:test',
    correlationId: `corr-orchestrator-activate-${policyId}`,
    idempotencyKey: `idem-orchestrator-activate-${policyId}`,
    aiOperationsPolicyRevisionId: policyId,
    expectedCurrentAiOperationsPolicyRevisionId: previous,
    reason: 'activate test provider execution',
  });
  return policyId;
}

function command(provider: AiDiscoveryProvider) {
  return {
    actorId: 'operator:test',
    correlationId: `corr-provider-${randomUUID()}`,
    idempotencyKey: `idem-provider-${randomUUID()}`,
    aiDiscoveryRunId: randomUUID(),
    provider,
    modelKey: 'fixture-model',
    modelRevision: 'fixture-model-r1',
    input: PROVIDER_INPUT,
    startedAt: '2026-08-18T14:00:00.000Z',
  };
}

test('disabled operations policy prevents provider execution and durable AI run creation', async () => {
  const pool = await resetDatabase();
  let calls = 0;
  const provider: AiDiscoveryProvider = {
    providerKey: 'fixture-provider',
    async execute() {
      calls += 1;
      return { providerRequestId: null, outputText: '{}', proposals: [] };
    },
  };

  await assert.rejects(
    executePolicyGovernedAiDiscoveryRun(pool, command(provider)),
    /AI_OPERATIONS_DISABLED/,
  );
  assert.equal(calls, 0);
  const runs = await pool.query(`select count(*)::int as count from ai_discovery_runs`);
  const reservations = await pool.query(`select count(*)::int as count from ai_operations_run_budget_reservations`);
  assert.equal(runs.rows[0]?.count, 0);
  assert.equal(reservations.rows[0]?.count, 0);
  await pool.end();
});

test('enabled policy reserves budget then delegates durable run recording to Sprint 8B', async () => {
  const pool = await resetDatabase();
  const policyId = await enablePolicy(pool, 4);
  let calls = 0;
  const provider: AiDiscoveryProvider = {
    providerKey: 'fixture-provider',
    async execute() {
      calls += 1;
      return {
        providerRequestId: 'fixture-request',
        outputText: '{}',
        proposals: [{
          subjectExternalId: 'samira',
          augmentExternalIds: ['1194'],
          itemExternalIds: ['3006'],
          rationale: 'bounded fixture proposal',
        }],
      };
    },
  };
  const runCommand = command(provider);

  const result = await executePolicyGovernedAiDiscoveryRun(pool, runCommand, {
    now: () => '2026-08-18T14:00:01.000Z',
    sleep: async () => {},
  });

  assert.equal(calls, 1);
  assert.equal(result.aiDiscoveryRunId, runCommand.aiDiscoveryRunId);
  assert.equal(result.status, 'completed');
  assert.equal(result.proposalCount, 1);
  assert.equal(result.replayed, false);
  assert.equal(result.aiOperationsPolicyRevisionId, policyId);
  assert.equal(result.budgetReplayed, false);
  assert.match(result.aiOperationsRunBudgetReservationId, /^[0-9a-f-]{36}$/u);

  const runs = await pool.query(`select count(*)::int as count from ai_discovery_runs`);
  const proposals = await pool.query(`select count(*)::int as count from ai_candidate_proposals`);
  const reservations = await pool.query(`select count(*)::int as count from ai_operations_run_budget_reservations`);
  assert.equal(runs.rows[0]?.count, 1);
  assert.equal(proposals.rows[0]?.count, 1);
  assert.equal(reservations.rows[0]?.count, 1);
  await pool.end();
});

test('same governed command replays budget and durable run without another provider call', async () => {
  const pool = await resetDatabase();
  await enablePolicy(pool, 4);
  let calls = 0;
  const provider: AiDiscoveryProvider = {
    providerKey: 'fixture-provider',
    async execute() {
      calls += 1;
      return {
        providerRequestId: null,
        outputText: '{}',
        proposals: [{
          subjectExternalId: 'samira',
          augmentExternalIds: ['1194'],
          itemExternalIds: ['3006'],
          rationale: null,
        }],
      };
    },
  };
  const runCommand = command(provider);

  const first = await executePolicyGovernedAiDiscoveryRun(pool, runCommand, {
    now: () => '2026-08-18T14:00:01.000Z',
    sleep: async () => {},
  });
  const second = await executePolicyGovernedAiDiscoveryRun(pool, runCommand, {
    now: () => '2026-08-18T14:00:02.000Z',
    sleep: async () => {},
  });

  assert.equal(calls, 1);
  assert.equal(first.budgetReplayed, false);
  assert.equal(second.budgetReplayed, true);
  assert.equal(second.replayed, true);
  assert.equal(second.aiOperationsRunBudgetReservationId, first.aiOperationsRunBudgetReservationId);
  const reservations = await pool.query(`select count(*)::int as count from ai_operations_run_budget_reservations`);
  assert.equal(reservations.rows[0]?.count, 1);
  await pool.end();
});

test('proposal cap violation becomes a safe failed Sprint 8B run with no proposals stored', async () => {
  const pool = await resetDatabase();
  await enablePolicy(pool, 1);
  let calls = 0;
  const provider: AiDiscoveryProvider = {
    providerKey: 'fixture-provider',
    async execute() {
      calls += 1;
      return {
        providerRequestId: null,
        outputText: '{}',
        proposals: [
          {
            subjectExternalId: 'samira',
            augmentExternalIds: ['1194'],
            itemExternalIds: ['3006'],
            rationale: 'first',
          },
          {
            subjectExternalId: 'samira',
            augmentExternalIds: ['1194'],
            itemExternalIds: ['3031'],
            rationale: 'second',
          },
        ],
      };
    },
  };
  const runCommand = command(provider);

  const result = await executePolicyGovernedAiDiscoveryRun(pool, runCommand, {
    now: () => '2026-08-18T14:00:01.000Z',
    sleep: async () => {},
  });

  assert.equal(calls, 1);
  assert.equal(result.status, 'failed');
  assert.equal(result.proposalCount, 0);
  const run = await pool.query<{ failure_code: string | null }>(
    `select failure_code from ai_discovery_runs where ai_discovery_run_id = $1`,
    [runCommand.aiDiscoveryRunId],
  );
  assert.equal(run.rows[0]?.failure_code, 'PROVIDER_RESPONSE_INVALID');
  const proposals = await pool.query(`select count(*)::int as count from ai_candidate_proposals`);
  assert.equal(proposals.rows[0]?.count, 0);
  await pool.end();
});
