import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { recordAiDiscoveryRun } from '../src/modules/ai-discovery/record-ai-discovery-run.js';
import { executePolicyGovernedAiDiscoveryRun } from '../src/modules/ai-operations/execute-policy-governed-ai-discovery-run.js';
import {
  AI_DISCOVERY_PROMPT_TEMPLATE_KEY,
  AI_DISCOVERY_PROMPT_TEMPLATE_VERSION,
} from '../src/modules/ai-provider/build-provider-request.js';
import {
  hashNormalizedAiProviderExecutionInput,
  normalizeAiProviderExecutionInput,
} from '../src/modules/ai-provider/normalize-provider-execution-input.js';
import type { AiDiscoveryProvider } from '../src/modules/ai-provider/openai-responses-provider.js';
import { resetDatabase } from './helpers/database.js';

function historicalInput(runKey: string) {
  return {
    runKey,
    patchKey: '26.17',
    gameModeExternalId: 'aram_mayhem' as const,
    subjects: [{
      subjectExternalId: 'samira',
      allowedAugmentExternalIds: ['1194'],
      allowedItemExternalIds: ['3006'],
      observations: ['Historical pre-budget replay fixture.'],
    }],
  };
}

test('historical durable AI run replays with zero budget, journal, and provider work', async () => {
  const pool = await resetDatabase();
  try {
    const aiDiscoveryRunId = randomUUID();
    const runKey = `historical-replay-${aiDiscoveryRunId}`;
    const actorId = 'operator:test';
    const correlationId = `corr-historical-${aiDiscoveryRunId}`;
    const idempotencyKey = `idem-historical-${aiDiscoveryRunId}`;
    const startedAt = '2026-08-20T08:00:00.000Z';
    const input = historicalInput(runKey);
    const normalized = normalizeAiProviderExecutionInput(input);
    const inputHash = hashNormalizedAiProviderExecutionInput(normalized);

    await recordAiDiscoveryRun(pool, {
      actorId,
      aiDiscoveryRunId,
      correlationId,
      idempotencyKey,
      runKey,
      providerKey: 'fixture-provider',
      modelKey: 'fixture-model',
      modelRevision: 'fixture-r1',
      promptTemplateKey: AI_DISCOVERY_PROMPT_TEMPLATE_KEY,
      promptTemplateVersion: AI_DISCOVERY_PROMPT_TEMPLATE_VERSION,
      inputHash,
      outputHash: 'c'.repeat(64),
      status: 'completed',
      startedAt,
      completedAt: '2026-08-20T08:00:01.000Z',
      failureCode: null,
      proposals: [],
    });

    let providerCalls = 0;
    const provider: AiDiscoveryProvider = {
      providerKey: 'fixture-provider',
      async execute() {
        providerCalls += 1;
        throw new Error('provider must not be called for historical replay');
      },
    };

    const result = await executePolicyGovernedAiDiscoveryRun(pool, {
      actorId,
      correlationId,
      idempotencyKey,
      aiDiscoveryRunId,
      provider,
      modelKey: 'fixture-model',
      modelRevision: 'fixture-r1',
      input,
      startedAt,
    });

    assert.equal(result.replayed, true);
    assert.equal(result.status, 'completed');
    assert.equal(providerCalls, 0);
    assert.equal(result.aiOperationsRunBudgetReservationId, null);
    assert.equal(result.aiOperationsPolicyRevisionId, null);
    assert.equal(result.budgetReplayed, null);

    const budget = await pool.query<{ count: number }>(
      `select count(*)::int as count from ai_operations_run_budget_reservations`,
    );
    const journal = await pool.query<{ count: number }>(
      `select count(*)::int as count from ai_provider_executions`,
    );
    assert.equal(budget.rows[0]?.count, 0);
    assert.equal(journal.rows[0]?.count, 0);
  } finally {
    await pool.end();
  }
});
