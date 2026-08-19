import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import type { Pool } from 'pg';

import {
  activateAiOperationsPolicyRevision,
} from '../src/modules/ai-operations/activate-ai-operations-policy-revision.js';
import {
  registerAiOperationsPolicyRevision,
} from '../src/modules/ai-operations/register-ai-operations-policy-revision.js';
import {
  reserveAiOperationsRunBudget,
  reserveAiOperationsRunBudgetWithFloor,
} from '../src/modules/ai-operations/reserve-ai-operations-run-budget.js';
import { resetDatabase } from './helpers/database.js';

async function activateEnabledPolicy(
  pool: Pool,
  options: { minIntervalSeconds?: number; maxRunsPerUtcDay?: number } = {},
): Promise<void> {
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
    maxRunsPerUtcDay: options.maxRunsPerUtcDay ?? 8,
    minIntervalSeconds: options.minIntervalSeconds ?? 0,
    maxProposalsPerRun: 8,
    reason: 'Sprint 8D budget test policy',
  });
  await activateAiOperationsPolicyRevision(pool, {
    actorId: 'operator:test',
    correlationId: `corr-activate-${policyId}`,
    idempotencyKey: `idem-activate-${policyId}`,
    aiOperationsPolicyRevisionId: policyId,
    expectedCurrentAiOperationsPolicyRevisionId: previous,
    reason: 'activate Sprint 8D budget test policy',
  });
}

function command(overrides: Partial<{
  aiDiscoveryRunId: string;
  idempotencyKey: string;
  runKey: string;
}> = {}) {
  const token = randomUUID();
  return {
    actorId: 'operator:test',
    correlationId: `corr-${token}`,
    idempotencyKey: overrides.idempotencyKey ?? `idem-${token}`,
    aiDiscoveryRunId: overrides.aiDiscoveryRunId ?? randomUUID(),
    runKey: overrides.runKey ?? `run-${token}`,
    gameModeExternalId: 'aram_mayhem' as const,
  };
}

const SCHEDULED_FLOOR = { minimumIntervalFloorSeconds: 3_600 } as const;

test('scheduled floor blocks a second provider budget reservation inside one hour', async () => {
  const pool = await resetDatabase();
  try {
    await activateEnabledPolicy(pool, { minIntervalSeconds: 0 });
    await reserveAiOperationsRunBudgetWithFloor(pool, command(), SCHEDULED_FLOOR);
    await assert.rejects(
      reserveAiOperationsRunBudgetWithFloor(pool, command(), SCHEDULED_FLOOR),
      /AI_OPERATIONS_SCHEDULED_CADENCE_NOT_ELAPSED/,
    );
  } finally {
    await pool.end();
  }
});

test('active policy interval remains the stronger rejection reason', async () => {
  const pool = await resetDatabase();
  try {
    await activateEnabledPolicy(pool, { minIntervalSeconds: 7_200 });
    await reserveAiOperationsRunBudgetWithFloor(pool, command(), SCHEDULED_FLOOR);
    await assert.rejects(
      reserveAiOperationsRunBudgetWithFloor(pool, command(), SCHEDULED_FLOOR),
      /AI_OPERATIONS_MIN_INTERVAL_NOT_ELAPSED/,
    );
  } finally {
    await pool.end();
  }
});

test('manual Sprint 8C callers keep zero-floor behavior', async () => {
  const pool = await resetDatabase();
  try {
    await activateEnabledPolicy(pool, { minIntervalSeconds: 0, maxRunsPerUtcDay: 4 });
    const first = await reserveAiOperationsRunBudget(pool, command());
    const second = await reserveAiOperationsRunBudget(pool, command());
    assert.equal(first.replayed, false);
    assert.equal(second.replayed, false);
  } finally {
    await pool.end();
  }
});

test('concurrent scheduled reservations share the existing atomic budget lock', async () => {
  const pool = await resetDatabase();
  try {
    await activateEnabledPolicy(pool, { minIntervalSeconds: 0, maxRunsPerUtcDay: 8 });
    const outcomes = await Promise.allSettled([
      reserveAiOperationsRunBudgetWithFloor(pool, command(), SCHEDULED_FLOOR),
      reserveAiOperationsRunBudgetWithFloor(pool, command(), SCHEDULED_FLOOR),
    ]);
    assert.equal(outcomes.filter((entry) => entry.status === 'fulfilled').length, 1);
    const rejected = outcomes.find((entry) => entry.status === 'rejected') as PromiseRejectedResult;
    assert.match(String(rejected.reason), /AI_OPERATIONS_SCHEDULED_CADENCE_NOT_ELAPSED/);
  } finally {
    await pool.end();
  }
});

test('scheduled budget authority accepts deterministic UUID v5 AI run identities', async () => {
  const pool = await resetDatabase();
  try {
    await activateEnabledPolicy(pool, { minIntervalSeconds: 0 });
    const result = await reserveAiOperationsRunBudgetWithFloor(
      pool,
      command({ aiDiscoveryRunId: '00000000-0000-5000-8000-000000000301' }),
      SCHEDULED_FLOOR,
    );
    assert.equal(result.aiDiscoveryRunId, '00000000-0000-5000-8000-000000000301');
  } finally {
    await pool.end();
  }
});
