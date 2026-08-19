import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import {
  activateAiOperationsPolicyRevision,
} from '../src/modules/ai-operations/activate-ai-operations-policy-revision.js';
import {
  readAiOperationsSnapshot,
} from '../src/modules/ai-operations/read-ai-operations-snapshot.js';
import {
  registerAiOperationsPolicyRevision,
} from '../src/modules/ai-operations/register-ai-operations-policy-revision.js';
import {
  reserveAiOperationsRunBudget,
} from '../src/modules/ai-operations/reserve-ai-operations-run-budget.js';
import { resetDatabase } from './helpers/database.js';

test('AI operations snapshot exposes only safe policy, budget and proposal aggregates', async () => {
  const pool = await resetDatabase();
  const active = await pool.query<{ ai_operations_policy_revision_id: string }>(
    `select ai_operations_policy_revision_id
       from active_ai_operations_policy_revision
      where scope = 'ai_discovery_provider'`,
  );
  const previous = active.rows[0]!.ai_operations_policy_revision_id;
  const policyId = randomUUID();
  await registerAiOperationsPolicyRevision(pool, {
    actorId: 'operator:test',
    correlationId: 'corr-reader-register',
    idempotencyKey: 'idem-reader-register',
    aiOperationsPolicyRevisionId: policyId,
    revision: 2,
    enabled: true,
    maxRunsPerUtcDay: 3,
    minIntervalSeconds: 0,
    maxProposalsPerRun: 5,
    reason: 'reader fixture policy',
  });
  await activateAiOperationsPolicyRevision(pool, {
    actorId: 'operator:test',
    correlationId: 'corr-reader-activate',
    idempotencyKey: 'idem-reader-activate',
    aiOperationsPolicyRevisionId: policyId,
    expectedCurrentAiOperationsPolicyRevisionId: previous,
    reason: 'activate reader fixture',
  });

  const aiDiscoveryRunId = randomUUID();
  await reserveAiOperationsRunBudget(pool, {
    actorId: 'operator:test',
    correlationId: 'corr-reader-reserve',
    idempotencyKey: 'idem-reader-reserve',
    aiDiscoveryRunId,
    runKey: 'run-reader-fixture',
    gameModeExternalId: 'aram_mayhem',
  });
  await pool.query(
    `insert into ai_discovery_runs
      (ai_discovery_run_id, run_key, provider_key, model_key,
       model_revision, prompt_template_key, prompt_template_version,
       input_hash, output_hash, status, started_at, completed_at)
     values ($1,'run-reader-fixture','fixture-provider','fixture-model','r1',
             'aram-mayhem-discovery',1,$2,$3,'completed',
             '2026-08-18T10:00:00Z','2026-08-18T10:00:01Z')`,
    [aiDiscoveryRunId, 'a'.repeat(64), 'b'.repeat(64)],
  );
  await pool.query(
    `insert into ai_candidate_proposals
      (ai_candidate_proposal_id, ai_discovery_run_id, ordinal,
       proposal_hash, patch_key, game_mode_external_id,
       subject_external_id, augment_external_ids, item_external_ids, rationale)
     values ($1,$2,0,$3,'26.17','aram_mayhem','samira',
             '["1194"]'::jsonb,'["3006"]'::jsonb,'safe fixture rationale')`,
    [randomUUID(), aiDiscoveryRunId, 'c'.repeat(64)],
  );

  const snapshot = await readAiOperationsSnapshot(pool);

  assert.equal(snapshot.activePolicy.aiOperationsPolicyRevisionId, policyId);
  assert.equal(snapshot.activePolicy.revision, 2);
  assert.equal(snapshot.activePolicy.enabled, true);
  assert.equal(snapshot.activePolicy.maxRunsPerUtcDay, 3);
  assert.equal(snapshot.activePolicy.minIntervalSeconds, 0);
  assert.equal(snapshot.activePolicy.maxProposalsPerRun, 5);
  assert.equal(snapshot.activePolicy.gameModeExternalId, 'aram_mayhem');
  assert.match(snapshot.budget.utcDate, /^\d{4}-\d{2}-\d{2}$/u);
  assert.equal(snapshot.budget.usedRuns, 1);
  assert.equal(snapshot.budget.remainingRuns, 2);
  assert.equal(typeof snapshot.budget.lastReservedAt, 'string');
  assert.deepEqual(snapshot.proposals, { pending: 1, materialized: 0 });

  const serialized = JSON.stringify(snapshot).toLowerCase();
  for (const forbidden of [
    'apikey',
    'api_key',
    'authorization',
    'databaseurl',
    'database_url',
    'promptbody',
    'requestbody',
    'responsebody',
    'observations',
  ]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
  await pool.end();
});
