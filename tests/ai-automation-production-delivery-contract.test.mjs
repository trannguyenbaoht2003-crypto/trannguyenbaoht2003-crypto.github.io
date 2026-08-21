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

async function readRequired(path) {
  assert.equal(await exists(path), true, `missing Sprint 8F artifact: ${path}`);
  return readFile(path, 'utf8');
}

test('Sprint 8F production-delivery artifacts are versioned and private-by-contract', async () => {
  const required = [
    'backend/railway.ai-automation.toml',
    'scripts/verify-railway-deployment.mjs',
    '.github/workflows/sprint-8f-ai-automation-production-delivery.yml',
  ];
  for (const path of required) {
    assert.equal(await exists(path), true, `missing Sprint 8F artifact: ${path}`);
  }

  const railway = await readRequired('backend/railway.ai-automation.toml');
  assert.match(railway, /builder\s*=\s*"DOCKERFILE"/);
  assert.match(railway, /dockerfilePath\s*=\s*"Dockerfile"/);
  assert.match(railway, /startCommand\s*=\s*"node dist\/src\/ai-automation-worker\.js"/);
  assert.doesNotMatch(railway, /healthcheckPath|healthcheckTimeout|public|port/i);

  const backendFiles = await readdir('backend');
  assert.equal(
    backendFiles.some((name) => /^Dockerfile\.ai/i.test(name)),
    false,
    'Sprint 8F must reuse backend/Dockerfile rather than create an AI-specific image',
  );
});

test('production environment keeps AI automation inert and provider-free', async () => {
  const envExample = await readRequired('deploy/production/production.env.example');
  assert.match(envExample, /^AI_DISCOVERY_SCHEDULER_ENABLED=false$/m);
  for (const forbidden of [
    'OPENAI_API_KEY',
    'AI_DISCOVERY_OPENAI_MODEL',
    'OPENAI_MODEL',
    'OPENAI_BASE_URL',
    'AI_DISCOVERY_OPENAI_ENDPOINT',
  ]) {
    assert.equal(
      envExample.includes(forbidden),
      false,
      `production env example must not provision provider setting: ${forbidden}`,
    );
  }
});

test('production release gate uses exact deployment IDs and verified sequential release order', async () => {
  const workflow = await readRequired('.github/workflows/production-release-gate.yml');

  assert.match(workflow, /RAILWAY_AI_AUTOMATION_SERVICE/);
  assert.match(workflow, /railway up --detach --json/);
  assert.match(workflow, /verify-railway-deployment\.mjs/);
  assert.match(workflow, /status-and-disabled-marker/);
  assert.match(workflow, /timeout-minutes:\s*90/);
  assert.doesNotMatch(workflow, /railway up --ci/);
  assert.doesNotMatch(workflow, /--latest|railway logs --latest/);
  assert.doesNotMatch(workflow, /OPENAI_API_KEY|AI_DISCOVERY_SCHEDULER_ENABLED\s*=\s*true/);

  const serviceTokens = [
    'RAILWAY_BACKEND_SERVICE',
    'RAILWAY_WORKER_SERVICE',
    'RAILWAY_COLLECTOR_SERVICE',
    'RAILWAY_AI_AUTOMATION_SERVICE',
    'RAILWAY_GATEWAY_SERVICE',
  ];
  let cursor = -1;
  for (const token of serviceTokens) {
    const next = workflow.indexOf(token, cursor + 1);
    assert.ok(next > cursor, `production release order is missing or out of order at ${token}`);
    cursor = next;
  }

  const deployBackend = workflow.indexOf('Deploy backend from exact tree');
  const deployWorker = workflow.indexOf('Deploy worker from exact tree');
  const deployCollector = workflow.indexOf('Deploy collector from exact tree');
  const deployAi = workflow.indexOf('Deploy AI automation from exact tree');
  const deployGateway = workflow.indexOf('Deploy gateway from exact tree');
  assert.ok(
    deployBackend >= 0
      && deployBackend < deployWorker
      && deployWorker < deployCollector
      && deployCollector < deployAi
      && deployAi < deployGateway,
    'application deployment steps must be backend -> worker -> collector -> ai-automation -> gateway',
  );
});

test('Sprint 8F repository-only workflow cannot deploy Railway or activate the provider', async () => {
  const workflow = await readRequired('.github/workflows/sprint-8f-ai-automation-production-delivery.yml');

  assert.match(workflow, /AI_AUTOMATION_PRODUCTION_REPO_READY/);
  assert.doesNotMatch(workflow, /railway up|railway redeploy|workflow_dispatch[\s\S]*AI_DISCOVERY_SCHEDULER_ENABLED/i);
  assert.doesNotMatch(workflow, /OPENAI_API_KEY|AI_DISCOVERY_OPENAI_MODEL|AI_DISCOVERY_OPENAI_ENDPOINT/);
  assert.doesNotMatch(workflow, /AI_AUTOMATION_DISABLED_DELIVERY_READY/);
});

test('Sprint 8F adds no public AI HTTP surface or downstream authority', async () => {
  const [server, automation] = await Promise.all([
    readRequired('backend/src/server.ts'),
    readRequired('backend/src/ai-automation-worker.ts'),
  ]);

  assert.doesNotMatch(server, /\/api\/ai\/|\/health\/ai-/);
  assert.doesNotMatch(
    automation,
    /HumanReview|Moderation|Eligibility|PublicationVersion|publishCandidate|createPublication/i,
  );
});
