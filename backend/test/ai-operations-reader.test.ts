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

test('AI operations snapshot exposes only safe policy, budget, proposal and provider execution aggregates', async () => {
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
  const reservation = await reserveAiOperationsRunBudget(pool, {
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

  const executionId = randomUUID();
  const attemptId = randomUUID();
  await pool.query(
    `insert into ai_provider_executions
      (ai_provider_execution_id, ai_discovery_run_id,
       ai_operations_run_budget_reservation_id, run_key, idempotency_key,
       provider_key, model_key, model_revision, prompt_template_key,
       prompt_template_version, input_hash, status, current_attempt_ordinal,
       terminal_at)
     values ($1,$2,$3,'run-reader-fixture','idem-reader-execution',
             'fixture-provider','fixture-model','r1','aram-mayhem-discovery',1,
             $4,'COMPLETED',1,clock_timestamp())`,
    [executionId, aiDiscoveryRunId, reservation.aiOperationsRunBudgetReservationId, 'a'.repeat(64)],
  );
  await pool.query(
    `insert into ai_provider_execution_attempts
      (ai_provider_execution_attempt_id, ai_provider_execution_id, ordinal,
       client_request_id, status, dispatch_started_at, completed_at)
     values ($1,$2,1,$3,'COMPLETED',clock_timestamp(),clock_timestamp())`,
    [attemptId, executionId, randomUUID()],
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
  assert.deepEqual(snapshot.providerExecution, {
    prepared: 0,
    inFlight: 0,
    completed: 1,
    failed: 0,
    uncertain: 0,
    stalePrepared: 0,
    staleInFlight: 0,
    attemptsToday: 1,
    safeRetriesToday: 0,
    uncertainExecutions: 0,
    unreconciledUncertain: 0,
    lastExecutionAt: snapshot.providerExecution.lastExecutionAt,
  });
  assert.equal(typeof snapshot.providerExecution.lastExecutionAt, 'string');

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
    'outputtext',
    'providerresponsebody',
  ]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
  await pool.end();
});
