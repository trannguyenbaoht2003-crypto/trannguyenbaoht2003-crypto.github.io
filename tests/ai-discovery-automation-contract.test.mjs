import assert from 'node:assert/strict';
import { access, readFile, readdir } from 'node:fs/promises';
import test from 'node:test';

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function aiAutomationSource() {
  const moduleFiles = (await readdir('backend/src/modules/ai-automation'))
    .filter((name) => name.endsWith('.ts'))
    .map((name) => `backend/src/modules/ai-automation/${name}`);
  const paths = [
    ...moduleFiles,
    'backend/src/queue/ai-discovery-scheduler.ts',
    'backend/src/queue/ai-discovery-automation-worker.ts',
    'backend/src/ai-automation-config.ts',
    'backend/src/ai-automation-worker.ts',
    'backend/src/ai-automation-status-cli.ts',
  ];
  return (await Promise.all(paths.map((path) => readFile(path, 'utf8')))).join('\n');
}

test('Sprint 8D repository surface exists and remains private', async () => {
  for (const path of [
    'backend/migrations/0016_ai_discovery_automation.sql',
    'backend/src/ai-automation-worker.ts',
    'backend/src/ai-automation-status-cli.ts',
    'backend/src/queue/ai-discovery-scheduler.ts',
    'backend/src/queue/ai-discovery-automation-worker.ts',
    '.github/workflows/sprint-8d-ai-discovery-automation.yml',
    'docs/runbooks/ai-discovery-automation.md',
  ]) {
    assert.equal(await exists(path), true, `missing Sprint 8D artifact: ${path}`);
  }

  const backendPackage = JSON.parse(await readFile('backend/package.json', 'utf8'));
  const rootPackage = JSON.parse(await readFile('package.json', 'utf8'));
  assert.equal(backendPackage.scripts['start:ai-automation'], 'node dist/src/ai-automation-worker.js');
  assert.equal(backendPackage.scripts['ai-automation:status'], 'node dist/src/ai-automation-status-cli.js');
  assert.equal(rootPackage.scripts['test:ai-discovery-automation'], 'node --test tests/ai-discovery-automation-contract.test.mjs');
  assert.match(
    rootPackage.scripts.test,
    /^npm run test:ai-provider-execution-recovery && npm run test:ai-discovery-automation &&/u,
  );
});

test('Sprint 8D scheduled graph stops at durable AI proposals', async () => {
  const source = await aiAutomationSource();
  for (const forbidden of [
    'materializeAiCandidateProposal',
    'recordHumanReview',
    'moderateCandidate',
    'evaluateCandidateEligibility',
    'recordEvidence',
    'publishCandidate',
    'activatePublication',
  ]) {
    assert.equal(source.includes(forbidden), false, `forbidden automation authority: ${forbidden}`);
  }

  const [scheduledTick, governedRun, durablePreparation] = await Promise.all([
    readFile('backend/src/modules/ai-automation/process-scheduled-ai-discovery-tick.ts', 'utf8'),
    readFile('backend/src/modules/ai-operations/execute-policy-governed-ai-discovery-run.ts', 'utf8'),
    readFile('backend/src/modules/ai-provider-execution/prepare-ai-provider-execution.ts', 'utf8'),
  ]);
  assert.match(source, /executePolicyGovernedAiDiscoveryRun/u);
  assert.match(scheduledTick, /SCHEDULED_INTERVAL_SECONDS\s*=\s*3_600/u);
  assert.match(
    scheduledTick,
    /minimumIntervalFloorSeconds\s*:\s*SCHEDULED_INTERVAL_SECONDS/u,
  );
  assert.match(governedRun, /processAiProviderExecution/u);
  assert.match(durablePreparation, /reserveAiOperationsRunBudgetInTransaction/u);
});

test('Sprint 8D locks queue payload, cadence, disabled default, and secret isolation', async () => {
  const scheduler = await readFile('backend/src/queue/ai-discovery-scheduler.ts', 'utf8');
  const names = await readFile('backend/src/queue/names.ts', 'utf8');
  const config = await readFile('backend/src/ai-automation-config.ts', 'utf8');
  const coreWorker = await readFile('backend/src/worker.ts', 'utf8');
  assert.match(names, /hai-dau-ai-discovery-automation-v1/u);
  assert.match(scheduler, /ai-discovery-hourly-v1/u);
  assert.match(scheduler, /3_600_000/u);
  assert.match(scheduler, /data: \{ schemaVersion: 1 \}/u);
  assert.match(scheduler, /opts: \{ attempts: 1 \}/u);
  assert.match(config, /value === undefined \|\| value === 'false'/u);
  assert.equal(coreWorker.includes('OPENAI_API_KEY'), false);
  assert.equal(coreWorker.includes('createOpenAiResponsesProvider'), false);
});

test('Sprint 8D workflow is read-only, fake-provider-only, and deployment guarded', async () => {
  const workflow = await readFile('.github/workflows/sprint-8d-ai-discovery-automation.yml', 'utf8');
  assert.match(workflow, /^permissions:\n  contents: read$/m);
  assert.doesNotMatch(workflow, /(contents|packages|pages|id-token):[ \t]*write/u);
  assert.equal(workflow.includes('OPENAI_API_KEY'), false);
  assert.doesNotMatch(
    workflow,
    /railway\s+up|wrangler\s+deploy|docker\s+push|kubectl|terraform|pulumi/iu,
  );
});

test('Sprint 8D runbook requires separate activation authorization and preserves history on rollback', async () => {
  const runbook = await readFile('docs/runbooks/ai-discovery-automation.md', 'utf8');
  for (const phrase of [
    'AI_DISCOVERY_SCHEDULER_ENABLED=false',
    'separate explicit authorization',
    'Do not delete PostgreSQL history',
    'does not materialize Candidates',
    'does not publish',
  ]) {
    assert.ok(runbook.includes(phrase), `runbook missing safety contract: ${phrase}`);
  }
});
