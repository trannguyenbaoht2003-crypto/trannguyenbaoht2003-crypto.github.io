import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import test from 'node:test';

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function read(path) {
  return readFile(path, 'utf8');
}

const READY_MARKER = 'AI_AUTOMATION_DISABLED_READY scheduler_enabled=false provider_configured=false';

test('Sprint 8F production delivery surface exists and keeps the AI service private', async () => {
  for (const path of [
    'backend/railway.ai-automation.toml',
    'scripts/verify-railway-deployment.mjs',
    '.github/workflows/sprint-8f-ai-automation-production-delivery.yml',
  ]) {
    assert.equal(await exists(path), true, `missing Sprint 8F artifact: ${path}`);
  }

  const [railway, workflow, envExample] = await Promise.all([
    read('backend/railway.ai-automation.toml'),
    read('.github/workflows/production-release-gate.yml'),
    read('deploy/production/production.env.example'),
  ]);

  assert.match(railway, /builder\s*=\s*"DOCKERFILE"/u);
  assert.match(railway, /dockerfilePath\s*=\s*"Dockerfile"/u);
  assert.match(railway, /startCommand\s*=\s*"node dist\/src\/ai-automation-worker\.js"/u);
  assert.doesNotMatch(railway, /healthcheckPath|public|domain/iu);
  assert.equal(await exists('backend/Dockerfile.ai'), false);
  assert.equal(await exists('backend/Dockerfile.ai-automation'), false);

  assert.match(workflow, /RAILWAY_AI_AUTOMATION_SERVICE/u);
  assert.match(workflow, /railway up --detach --json/u);
  assert.match(workflow, /verify-railway-deployment\.mjs/u);
  assert.match(workflow, /status-and-disabled-marker/u);
  assert.match(workflow, new RegExp(READY_MARKER.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(workflow, /OPENAI_API_KEY|AI_DISCOVERY_SCHEDULER_ENABLED\s*=\s*true/iu);
  assert.doesNotMatch(workflow, /--latest|railway\s+logs\s+--latest/iu);
  assert.doesNotMatch(workflow, /railway\s+(?:init|add)|railway\s+project\s+new/iu);

  assert.match(envExample, /^AI_DISCOVERY_SCHEDULER_ENABLED=false$/mu);
  assert.doesNotMatch(envExample, /OPENAI_API_KEY|OPENAI_MODEL|OPENAI_BASE_URL|OPENAI_ENDPOINT/iu);
});

test('Sprint 8F workflow cannot grant provider-spend or public AI authority', async () => {
  const [workflow, runtime, coreWorker] = await Promise.all([
    read('.github/workflows/production-release-gate.yml'),
    read('backend/src/ai-automation-worker.ts'),
    read('backend/src/worker.ts'),
  ]);

  assert.doesNotMatch(workflow, /inputs:[\s\S]*AI_DISCOVERY_SCHEDULER_ENABLED/iu);
  assert.doesNotMatch(workflow, /OPENAI_API_KEY|OPENAI_MODEL|OPENAI_BASE_URL|OPENAI_ENDPOINT/iu);
  assert.match(runtime, /createAiAutomationProvider/u);
  assert.match(runtime, /AI_AUTOMATION_DISABLED_READY/u);
  assert.equal(coreWorker.includes('createOpenAiResponsesProvider'), false);
  assert.equal(coreWorker.includes('OPENAI_API_KEY'), false);

  const combined = `${runtime}\n${workflow}`;
  for (const forbidden of [
    'materializeAiCandidateProposal',
    'recordHumanReview',
    'moderateCandidate',
    'evaluateCandidateEligibility',
    'recordEvidence',
    'publishCandidate',
    'activatePublication',
  ]) {
    assert.equal(combined.includes(forbidden), false, `forbidden downstream authority: ${forbidden}`);
  }
});
