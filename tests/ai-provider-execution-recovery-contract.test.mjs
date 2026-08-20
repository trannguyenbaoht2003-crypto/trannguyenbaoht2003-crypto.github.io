import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

async function read(path) {
  return readFile(new URL(`../${path}`, import.meta.url), 'utf8');
}

const providerExecutionFiles = [
  'backend/src/modules/ai-provider-execution/types.ts',
  'backend/src/modules/ai-provider-execution/client-request-id.ts',
  'backend/src/modules/ai-provider-execution/prepare-ai-provider-execution.ts',
  'backend/src/modules/ai-provider-execution/claim-ai-provider-execution.ts',
  'backend/src/modules/ai-provider-execution/mark-ai-provider-attempt-in-flight.ts',
  'backend/src/modules/ai-provider-execution/execute-ai-provider-attempt.ts',
  'backend/src/modules/ai-provider-execution/finalize-ai-provider-execution.ts',
  'backend/src/modules/ai-provider-execution/process-ai-provider-execution.ts',
  'backend/src/modules/ai-provider-execution/recover-stale-ai-provider-executions.ts',
  'backend/src/modules/ai-provider-execution/reconcile-ai-provider-execution.ts',
  'backend/src/modules/ai-provider-execution/read-ai-provider-execution-status.ts',
];

test('Sprint 8E durable journal has bounded states, attempts, leases and append-only reconciliation', async () => {
  const migration = await read('backend/migrations/0017_ai_provider_execution_journal.sql');
  for (const table of [
    'ai_provider_executions',
    'ai_provider_execution_attempts',
    'ai_provider_execution_reconciliations',
  ]) assert.match(migration, new RegExp(`create table ${table}`, 'i'));
  for (const status of ['PREPARED', 'IN_FLIGHT', 'COMPLETED', 'FAILED', 'UNCERTAIN']) {
    assert.match(migration, new RegExp(status));
  }
  for (const decision of ['CONFIRMED_NOT_RECEIVED', 'CONFIRMED_RECEIVED', 'ABANDONED']) {
    assert.match(migration, new RegExp(decision));
  }
  assert.match(migration, /current_attempt_ordinal[\s\S]*between 1 and 3/i);
  assert.match(migration, /ordinal[\s\S]*between 1 and 3/i);
  assert.match(migration, /one_active/i);
  assert.match(migration, /lease_token is null[\s\S]*lease_expires_at is null/i);
  assert.match(migration, /reconciliations are append-only/i);
  assert.match(migration, /cannot be deleted/i);
  assert.doesNotMatch(
    migration,
    /\b(api_key|authorization_header|raw_prompt|raw_messages|raw_observation|raw_output|request_body|response_body|output_text)\b/i,
  );
});

test('Sprint 8E provider execution graph cannot mutate downstream trust or publication authorities', async () => {
  const source = (await Promise.all(providerExecutionFiles.map(read))).join('\n');
  for (const forbidden of [
    'materializeAiCandidateProposal',
    'completeHumanReview',
    'recordHumanReview',
    'recordEvidence',
    'createPublication',
    'activatePublication',
    'recordModeration',
    'evaluateEligibility',
  ]) assert.doesNotMatch(source, new RegExp(forbidden, 'i'));
  assert.doesNotMatch(source, /from ['"](?:bullmq|ioredis|fastify)['"]/i);
  assert.doesNotMatch(source, /OPENAI_API_KEY|Authorization:\s*Bearer|raw prompt|raw model output/i);
});

test('Sprint 8E retry authority is bounded to three attempts, 120-second leases and received HTTP 429', async () => {
  const [migration, claim, attempt, process, finalization] = await Promise.all([
    read('backend/migrations/0017_ai_provider_execution_journal.sql'),
    read('backend/src/modules/ai-provider-execution/claim-ai-provider-execution.ts'),
    read('backend/src/modules/ai-provider-execution/execute-ai-provider-attempt.ts'),
    read('backend/src/modules/ai-provider-execution/process-ai-provider-execution.ts'),
    read('backend/src/modules/ai-provider-execution/finalize-ai-provider-execution.ts'),
  ]);
  assert.match(migration, /ordinal[\s\S]*between 1 and 3/i);
  assert.match(claim, /leaseSeconds:\s*120/);
  assert.match(claim, /command\.leaseSeconds !== 120/);
  assert.equal((attempt.match(/SAFE_RETRYABLE/g) ?? []).length, 1);
  assert.match(attempt, /failureCode === 'PROVIDER_RATE_LIMITED'[\s\S]*SAFE_RETRYABLE/);
  assert.doesNotMatch(attempt, /PROVIDER_(?:TIMEOUT|UNAVAILABLE|TRANSPORT_ERROR)'[\s\S]{0,120}SAFE_RETRYABLE/);
  assert.match(process, /RETRY_DELAYS_MS\s*=\s*\[500,\s*1_500\]/);
  assert.match(finalization, /command\.ordinal\s*===\s*3/);
  assert.doesNotMatch(finalization, /ordinal\s*=\s*4|attempt\s*4/i);
});

test('Sprint 8E operator recovery/status/reconciliation is database-only and provider-secret free', async () => {
  const [cli, reader, recovery, reconciliation] = await Promise.all([
    read('backend/src/ai-provider-execution-cli.ts'),
    read('backend/src/modules/ai-provider-execution/read-ai-provider-execution-status.ts'),
    read('backend/src/modules/ai-provider-execution/recover-stale-ai-provider-executions.ts'),
    read('backend/src/modules/ai-provider-execution/reconcile-ai-provider-execution.ts'),
  ]);
  assert.match(cli, /status/);
  assert.match(cli, /recover/);
  assert.match(cli, /reconcile/);
  const source = [cli, reader, recovery, reconciliation].join('\n');
  assert.doesNotMatch(source, /OPENAI_API_KEY|createOpenAiResponsesProvider|provider\.execute|Authorization/);
  assert.doesNotMatch(source, /materializeAiCandidateProposal|createPublication|activatePublication/);
});

test('Sprint 8E preserves scheduler fail-closed defaults and recovery-before-dispatch ordering', async () => {
  const [config, runtime, worker] = await Promise.all([
    read('backend/src/ai-automation-config.ts'),
    read('backend/src/ai-automation-worker.ts'),
    read('backend/src/queue/ai-discovery-automation-worker.ts'),
  ]);
  assert.match(config, /value === undefined \|\| value === 'false'\) return false/);
  assert.ok(
    runtime.indexOf('recoverStaleAiProviderExecutions(pool)') <
      runtime.indexOf('reconcileAiDiscoveryScheduler(queue'),
    'runtime recovery must occur before scheduler reconciliation',
  );
  assert.ok(
    worker.indexOf('if (!options.schedulerEnabled)') <
      worker.indexOf('await recoverStaleAiProviderExecutions(options.pool)'),
    'disabled stale jobs must no-op before recovery/provider work',
  );
  assert.doesNotMatch(runtime, /AI_DISCOVERY_SCHEDULER_ENABLED\s*=\s*true/);
});

test('Sprint 8E aggregate observability exposes counts only and no provider payloads or identifiers', async () => {
  const [types, reader] = await Promise.all([
    read('backend/src/modules/ai-operations/types.ts'),
    read('backend/src/modules/ai-operations/read-ai-operations-snapshot.ts'),
  ]);
  for (const field of [
    'prepared', 'inFlight', 'completed', 'failed', 'uncertain',
    'stalePrepared', 'staleInFlight', 'attemptsToday', 'safeRetriesToday',
    'uncertainExecutions', 'unreconciledUncertain', 'lastExecutionAt',
  ]) assert.match(types, new RegExp(field));
  assert.match(reader, /unreconciled_uncertain/);
  assert.doesNotMatch(
    reader,
    /provider_request_id|provider_response_id|client_request_id|output_text|request_body|response_body|authorization/i,
  );
});

test('Sprint 8E root orchestration and runbook keep the feature review-only and production-disabled', async () => {
  const [rootPackage, backendPackage, runbook] = await Promise.all([
    read('package.json'),
    read('backend/package.json'),
    read('docs/runbooks/ai-provider-execution-recovery.md'),
  ]);
  const root = JSON.parse(rootPackage);
  const backend = JSON.parse(backendPackage);
  assert.equal(
    root.scripts['test:ai-provider-execution-recovery'],
    'node --test tests/ai-provider-execution-recovery-contract.test.mjs',
  );
  assert.match(root.scripts.test, /^npm run test:ai-provider-execution-recovery && /);
  assert.equal(backend.scripts['ai-provider-execution'], 'node dist/src/ai-provider-execution-cli.js');
  for (const phrase of [
    'PREPARED', 'IN_FLIGHT', 'UNCERTAIN', 'CONFIRMED_NOT_RECEIVED',
    'CONFIRMED_RECEIVED', 'ABANDONED', 'X-Client-Request-Id',
    'only HTTP 429', 'AI_DISCOVERY_SCHEDULER_ENABLED=false',
    'No production deployment', 'No production OpenAI credential',
  ]) assert.match(runbook, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
});

test('Sprint 8E dedicated workflow runs the recovery gate without deployment or provider secrets', async () => {
  const workflow = await read('.github/workflows/sprint-8e-ai-provider-execution-recovery.yml');
  assert.match(workflow, /^name: Sprint 8E AI provider execution recovery gate$/m);
  assert.match(workflow, /^permissions:\n  contents: read$/m);
  assert.match(workflow, /npm run test:ai-provider-execution-recovery/);
  assert.match(workflow, /npm --prefix backend run typecheck/);
  assert.match(workflow, /postgres:17/);
  assert.match(workflow, /redis:7/);
  assert.doesNotMatch(workflow, /OPENAI_API_KEY|railway\s+up|wrangler\s+deploy|docker\s+push|kubectl|terraform|pulumi/i);
  assert.doesNotMatch(workflow, /(contents|packages|pages|id-token):\s*write/i);
});
