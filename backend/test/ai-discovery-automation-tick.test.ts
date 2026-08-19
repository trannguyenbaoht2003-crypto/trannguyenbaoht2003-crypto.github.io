import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import type { AiDiscoveryProvider } from '../src/modules/ai-provider/openai-responses-provider.js';
import { processScheduledAiDiscoveryTick } from '../src/modules/ai-automation/process-scheduled-ai-discovery-tick.js';
import type { BuiltScheduledAiDiscoveryInput } from '../src/modules/ai-automation/types.js';
import { resetDatabase } from './helpers/database.js';

const provider: AiDiscoveryProvider = {
  providerKey: 'test-provider',
  async execute() {
    throw new Error('provider must not execute in this test');
  },
};

const command = {
  actorId: 'system:ai-automation',
  correlationId: 'scheduled-test',
  provider,
  modelKey: 'test-model',
  modelRevision: 'test-model',
  startedAt: '2026-08-19T03:00:00.000Z',
};

function builtInput(): BuiltScheduledAiDiscoveryInput {
  const hash = 'a'.repeat(64);
  return {
    content: {
      patchKey: '26.16',
      gameModeExternalId: 'aram_mayhem',
      subjects: [{
        subjectExternalId: 'champion:1',
        allowedAugmentExternalIds: [],
        allowedItemExternalIds: [],
        observations: ['structured-observation'],
      }],
    },
    input: {
      runKey: `scheduled:v1:${hash}`,
      patchKey: '26.16',
      gameModeExternalId: 'aram_mayhem',
      subjects: [{
        subjectExternalId: 'champion:1',
        allowedAugmentExternalIds: [],
        allowedItemExternalIds: [],
        observations: ['structured-observation'],
      }],
    },
    scheduledContentHash: hash,
    runKey: `scheduled:v1:${hash}`,
    idempotencyKey: `ai-discovery-scheduled:v1:${hash}`,
    aiDiscoveryRunId: '00000000-0000-5000-8000-000000000401',
  };
}

test('same PostgreSQL UTC hour is claimed by exactly one scheduled processor', async () => {
  const pool = await resetDatabase();
  try {
    let buildCalls = 0;
    const buildInput = async () => {
      buildCalls += 1;
      return null;
    };
    const [first, second] = await Promise.all([
      processScheduledAiDiscoveryTick(pool, command, { buildInput }),
      processScheduledAiDiscoveryTick(pool, command, { buildInput }),
    ]);
    assert.deepEqual(
      [first.outcome, second.outcome].sort(),
      ['DUPLICATE_NOOP', 'NO_NEW_INPUT'],
    );
    assert.equal(buildCalls, 1);
    const count = await pool.query(`select count(*)::int as count from scheduled_ai_discovery_ticks`);
    assert.equal(count.rows[0]?.count, 1);
  } finally {
    await pool.end();
  }
});

test('policy denial finalizes safely without executing provider authority', async () => {
  const pool = await resetDatabase();
  try {
    let executeCalls = 0;
    const result = await processScheduledAiDiscoveryTick(pool, command, {
      buildInput: async () => builtInput(),
      executeRun: async () => {
        executeCalls += 1;
        throw new Error('AI_OPERATIONS_DISABLED');
      },
    });
    assert.equal(result.outcome, 'POLICY_DISABLED');
    assert.equal(executeCalls, 1);
    const tick = await pool.query(`select status, ai_discovery_run_id from scheduled_ai_discovery_ticks`);
    assert.equal(tick.rows[0]?.status, 'POLICY_DISABLED');
    assert.equal(tick.rows[0]?.ai_discovery_run_id, builtInput().aiDiscoveryRunId);
  } finally {
    await pool.end();
  }
});

test('returned provider failure stores only durable safe authority linkage', async () => {
  const pool = await resetDatabase();
  try {
    const built = builtInput();
    const policy = await pool.query<{ ai_operations_policy_revision_id: string }>(
      `select ai_operations_policy_revision_id
         from active_ai_operations_policy_revision
        where scope = 'ai_discovery_provider'`,
    );
    const policyId = policy.rows[0]!.ai_operations_policy_revision_id;
    const reservationId = randomUUID();
    const result = await processScheduledAiDiscoveryTick(pool, command, {
      buildInput: async () => built,
      executeRun: async () => {
        await pool.query(
          `insert into ai_operations_run_budget_reservations
            (ai_operations_run_budget_reservation_id, ai_discovery_run_id,
             run_key, ai_operations_policy_revision_id, budget_date,
             max_proposals_per_run, actor_id, correlation_id)
           values ($1,$2,$3,$4,
                   (timezone('UTC', clock_timestamp()))::date,
                   8,'system:ai-automation','scheduled-test')`,
          [reservationId, built.aiDiscoveryRunId, built.runKey, policyId],
        );
        return {
          aiDiscoveryRunId: built.aiDiscoveryRunId,
          runKey: built.runKey,
          status: 'failed' as const,
          proposalIds: [],
          proposalCount: 0,
          replayed: false,
          aiOperationsRunBudgetReservationId: reservationId,
          aiOperationsPolicyRevisionId: policyId,
          budgetReplayed: false,
        };
      },
    });
    assert.equal(result.outcome, 'PROVIDER_FAILED');
    const tick = await pool.query(
      `select status, ai_operations_policy_revision_id,
              ai_operations_run_budget_reservation_id
         from scheduled_ai_discovery_ticks`,
    );
    assert.equal(tick.rows[0]?.status, 'PROVIDER_FAILED');
    assert.equal(tick.rows[0]?.ai_operations_policy_revision_id, policyId);
    assert.equal(tick.rows[0]?.ai_operations_run_budget_reservation_id, reservationId);
  } finally {
    await pool.end();
  }
});
