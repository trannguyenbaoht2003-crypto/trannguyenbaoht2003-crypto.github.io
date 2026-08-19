import assert from 'node:assert/strict';
import test from 'node:test';

import { parseAiAutomationStatusConfig } from '../src/ai-automation-status-cli.js';
import { readAiOperationsSnapshot } from '../src/modules/ai-operations/read-ai-operations-snapshot.js';
import { resetDatabase } from './helpers/database.js';

test('Sprint 8D adds bounded safe automation metadata to the AI operations snapshot', async () => {
  const pool = await resetDatabase();
  try {
    const snapshot = await readAiOperationsSnapshot(pool);
    assert.deepEqual(snapshot.automation, {
      lastCompletedAt: null,
      lastOutcome: null,
      lastScheduledContentHash: null,
      lastAiDiscoveryRunId: null,
      lastBudgetReservedAt: null,
      recentWindowSize: 100,
      recent: {
        ticks: 0,
        noNewInput: 0,
        policyCadenceBlocked: 0,
        completed: 0,
        providerFailedOrAmbiguous: 0,
        incompleteProcessing: 0,
      },
    });
    const serialized = JSON.stringify(snapshot.automation).toLowerCase();
    for (const forbidden of ['prompt', 'observation', 'providerresponse', 'authorization', 'apikey']) {
      assert.equal(serialized.includes(forbidden), false);
    }
  } finally {
    await pool.end();
  }
});

test('status inspection config never requires or reads provider credentials', () => {
  const env = {
    DATABASE_URL: 'postgres://example',
    REDIS_URL: 'redis://example',
    AI_DISCOVERY_SCHEDULER_ENABLED: 'true',
  };
  const status = parseAiAutomationStatusConfig(env);
  assert.deepEqual(status, {
    databaseUrl: 'postgres://example',
    redisUrl: 'redis://example',
    schedulerEnabled: true,
  });
});
