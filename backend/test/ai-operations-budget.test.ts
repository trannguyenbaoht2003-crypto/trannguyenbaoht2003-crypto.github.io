import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import {
  activateAiOperationsPolicyRevision,
} from '../src/modules/ai-operations/activate-ai-operations-policy-revision.js';
import {
  registerAiOperationsPolicyRevision,
} from '../src/modules/ai-operations/register-ai-operations-policy-revision.js';
import {
  reserveAiOperationsRunBudget,
} from '../src/modules/ai-operations/reserve-ai-operations-run-budget.js';
import type { Pool } from 'pg';
import { resetDatabase } from './helpers/database.js';

async function activateEnabledPolicy(
  pool: Pool,
  options: {
    maxRunsPerUtcDay?: number;
    minIntervalSeconds?: number;
    maxProposalsPerRun?: number;
  } = {},
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
    correlationId: `corr-register-${policyId}`,
    idempotencyKey: `idem-register-${policyId}`,
    aiOperationsPolicyRevisionId: policyId,
    revision: 2,
    enabled: true,
    maxRunsPerUtcDay: options.maxRunsPerUtcDay ?? 4,
    minIntervalSeconds: options.minIntervalSeconds ?? 0,
    maxProposalsPerRun: options.maxProposalsPerRun ?? 8,
    reason: 'test bounded operations policy',
  });
  await activateAiOperationsPolicyRevision(pool, {
    actorId: 'operator:test',
    correlationId: `corr-activate-${policyId}`,
    idempotencyKey: `idem-activate-${policyId}`,
    aiOperationsPolicyRevisionId: policyId,
    expectedCurrentAiOperationsPolicyRevisionId: previous,
    reason: 'activate test policy',
  });
  return policyId;
}

function reserveCommand(overrides: Record<string, unknown> = {}) {
  return {
    actorId: 'operator:test',
    correlationId: `corr-reserve-${randomUUID()}`,
    idempotencyKey: `idem-reserve-${randomUUID()}`,
    aiDiscoveryRunId: randomUUID(),
    runKey: `run-${randomUUID()}`,
    gameModeExternalId: 'aram_mayhem' as const,
    ...overrides,
  };
}

test('budget reservation fails closed while active policy is disabled', async () => {
  const pool = await resetDatabase();
  await assert.rejects(
    reserveAiOperationsRunBudget(pool, reserveCommand()),
    /AI_OPERATIONS_DISABLED/,
  );
  const count = await pool.query(`select count(*)::int as count from ai_operations_run_budget_reservations`);
  assert.equal(count.rows[0]?.count, 0);
  await pool.end();
});

test('reserves one UTC daily budget unit and replays without a second row', async () => {
  const pool = await resetDatabase();
  const policyId = await activateEnabledPolicy(pool, { maxProposalsPerRun: 7 });
  const command = reserveCommand();

  const first = await reserveAiOperationsRunBudget(pool, command);
  const second = await reserveAiOperationsRunBudget(pool, command);

  assert.equal(first.aiDiscoveryRunId, command.aiDiscoveryRunId);
  assert.equal(first.aiOperationsPolicyRevisionId, policyId);
  assert.equal(first.maxProposalsPerRun, 7);
  assert.equal(first.replayed, false);
  assert.deepEqual(second, { ...first, replayed: true });
  assert.match(first.budgetDate, /^\d{4}-\d{2}-\d{2}$/u);

  const count = await pool.query(`select count(*)::int as count from ai_operations_run_budget_reservations`);
  assert.equal(count.rows[0]?.count, 1);
  await pool.end();
});

test('rejects a different reservation command for an already reserved AI run id', async () => {
  const pool = await resetDatabase();
  await activateEnabledPolicy(pool);
  const aiDiscoveryRunId = randomUUID();
  await reserveAiOperationsRunBudget(pool, reserveCommand({ aiDiscoveryRunId }));

  await assert.rejects(
    reserveAiOperationsRunBudget(pool, reserveCommand({ aiDiscoveryRunId })),
    /AI_OPERATIONS_RUN_ALREADY_RESERVED/,
  );
  await pool.end();
});

test('enforces UTC daily budget across all reservations', async () => {
  const pool = await resetDatabase();
  await activateEnabledPolicy(pool, { maxRunsPerUtcDay: 1 });
  await reserveAiOperationsRunBudget(pool, reserveCommand());

  await assert.rejects(
    reserveAiOperationsRunBudget(pool, reserveCommand()),
    /AI_OPERATIONS_DAILY_BUDGET_EXHAUSTED/,
  );
  await pool.end();
});

test('minimum interval counts the newest reservation across policy revisions', async () => {
  const pool = await resetDatabase();
  const firstPolicyId = await activateEnabledPolicy(pool, {
    maxRunsPerUtcDay: 8,
    minIntervalSeconds: 3600,
  });
  await reserveAiOperationsRunBudget(pool, reserveCommand());

  const secondPolicyId = randomUUID();
  await registerAiOperationsPolicyRevision(pool, {
    actorId: 'operator:test',
    correlationId: 'corr-register-revision-3',
    idempotencyKey: 'idem-register-revision-3',
    aiOperationsPolicyRevisionId: secondPolicyId,
    revision: 3,
    enabled: true,
    maxRunsPerUtcDay: 8,
    minIntervalSeconds: 3600,
    maxProposalsPerRun: 8,
    reason: 'new revision must not reset interval',
  });
  await activateAiOperationsPolicyRevision(pool, {
    actorId: 'operator:test',
    correlationId: 'corr-activate-revision-3',
    idempotencyKey: 'idem-activate-revision-3',
    aiOperationsPolicyRevisionId: secondPolicyId,
    expectedCurrentAiOperationsPolicyRevisionId: firstPolicyId,
    reason: 'rotate policy without resetting budget clock',
  });

  await assert.rejects(
    reserveAiOperationsRunBudget(pool, reserveCommand()),
    /AI_OPERATIONS_MIN_INTERVAL_NOT_ELAPSED/,
  );
  await pool.end();
});

test('concurrent reservations cannot oversubscribe a one-run daily budget', async () => {
  const pool = await resetDatabase();
  await activateEnabledPolicy(pool, { maxRunsPerUtcDay: 1, minIntervalSeconds: 0 });

  const outcomes = await Promise.allSettled([
    reserveAiOperationsRunBudget(pool, reserveCommand()),
    reserveAiOperationsRunBudget(pool, reserveCommand()),
  ]);
  const fulfilled = outcomes.filter((entry) => entry.status === 'fulfilled');
  const rejected = outcomes.filter((entry) => entry.status === 'rejected');

  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.match(String((rejected[0] as PromiseRejectedResult).reason), /AI_OPERATIONS_DAILY_BUDGET_EXHAUSTED/);
  const count = await pool.query(`select count(*)::int as count from ai_operations_run_budget_reservations`);
  assert.equal(count.rows[0]?.count, 1);
  await pool.end();
});
