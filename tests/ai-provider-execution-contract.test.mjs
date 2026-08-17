import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import test from 'node:test';

const ROOT = new URL('../', import.meta.url);
const read = (path) => readFile(new URL(path, ROOT), 'utf8');

async function collectFiles(relativeDirectory, extensions = ['.ts', '.tsx', '.js', '.mjs', '.json', '.yml', '.yaml']) {
  const directory = new URL(relativeDirectory, ROOT);
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relative = join(relativeDirectory, entry.name).replaceAll('\\', '/');
    if (entry.isDirectory()) files.push(...await collectFiles(`${relative}/`, extensions));
    else if (entry.isFile() && extensions.includes(extname(entry.name))) files.push(relative);
  }
  return files;
}

async function collectText(relativeDirectory) {
  const files = await collectFiles(relativeDirectory);
  return (await Promise.all(files.map(async (path) => `\n/* ${path} */\n${await read(path)}`))).join('\n');
}

test('Sprint 8B repository contains the private provider execution artifacts only', async () => {
  for (const path of [
    'backend/src/modules/ai-provider/types.ts',
    'backend/src/modules/ai-provider/normalize-provider-execution-input.ts',
    'backend/src/modules/ai-provider/build-provider-request.ts',
    'backend/src/modules/ai-provider/openai-responses-provider.ts',
    'backend/src/modules/ai-provider/execute-ai-discovery-provider-run.ts',
    'backend/src/ai-discovery-run-cli.ts',
  ]) {
    assert.equal(existsSync(new URL(path, ROOT)), true, `missing ${path}`);
  }

  const backendPackage = JSON.parse(await read('backend/package.json'));
  assert.equal(backendPackage.scripts['ai-discovery:run'], 'node dist/src/ai-discovery-run-cli.js');
  const dependencyNames = [
    ...Object.keys(backendPackage.dependencies ?? {}),
    ...Object.keys(backendPackage.devDependencies ?? {}),
  ];
  for (const providerSdk of ['openai', 'anthropic', '@google/generative-ai']) {
    assert.equal(dependencyNames.includes(providerSdk), false, `provider SDK added: ${providerSdk}`);
  }
});

test('Sprint 8A authority module remains provider and network independent', async () => {
  const aiDiscoveryText = await collectText('backend/src/modules/ai-discovery/');
  assert.doesNotMatch(aiDiscoveryText, /api\.openai\.com|OPENAI_API_KEY|AI_DISCOVERY_OPENAI_MODEL/i);
  assert.doesNotMatch(aiDiscoveryText, /from\s+['"][^'"]*ai-provider\//i);
  assert.doesNotMatch(aiDiscoveryText, /\bfetch\s*\(/i);
});

test('AI provider execution cannot import downstream trust or publication mutation authority', async () => {
  const providerText = await collectText('backend/src/modules/ai-provider/');
  for (const forbidden of [
    /materialize-ai-candidate-proposal/i,
    /modules\/evidence|\.\.\/evidence/i,
    /human-review/i,
    /modules\/moderation|\.\.\/moderation/i,
    /modules\/eligibility|\.\.\/eligibility/i,
    /modules\/publication|\.\.\/publication/i,
    /publication-version/i,
    /post-publication-monitoring/i,
    /feedback-intake/i,
  ]) {
    assert.doesNotMatch(providerText, forbidden);
  }

  const orchestrator = await read('backend/src/modules/ai-provider/execute-ai-discovery-provider-run.ts');
  assert.match(orchestrator, /recordAiDiscoveryRun/);
  assert.doesNotMatch(orchestrator, /materializeAiCandidateProposal|publish|rollback|retract/i);
});

test('provider execution has no public Fastify, operator-browser, Caddy, Railway or worker exposure', async () => {
  const publicSurfaces = [
    await read('backend/src/server.ts'),
    await read('backend/src/operator-server.ts'),
    await read('backend/src/worker.ts'),
    await collectText('app/'),
    await read('deploy/production/Caddyfile'),
    await read('deploy/staging/Caddyfile'),
    await collectText('deploy/production/'),
    await collectText('deploy/staging/'),
  ].join('\n');

  assert.doesNotMatch(publicSurfaces, /ai-discovery-run-cli|execute-ai-discovery-provider-run|openai-responses-provider/i);
  assert.doesNotMatch(publicSurfaces, /\/api\/ai(?:\/|['"`])|ai-provider-execution/i);
});

test('provider credentials are referenced only by the private CLI production source', async () => {
  const sourceFiles = await collectFiles('backend/src/', ['.ts']);
  const references = [];
  for (const path of sourceFiles) {
    const text = await read(path);
    if (/OPENAI_API_KEY/.test(text)) references.push(path);
  }
  assert.deepEqual(references, ['backend/src/ai-discovery-run-cli.ts']);

  const provider = await read('backend/src/modules/ai-provider/openai-responses-provider.ts');
  assert.doesNotMatch(provider, /process\.env|OPENAI_API_KEY/);
  assert.match(provider, /store:\s*false/);
});

test('Sprint 8B root test orchestration includes the dedicated provider execution contract', async () => {
  const rootPackage = JSON.parse(await read('package.json'));
  assert.equal(
    rootPackage.scripts['test:ai-provider-execution'],
    'node --test tests/ai-provider-execution-contract.test.mjs',
  );
  assert.match(rootPackage.scripts.test, /test:ai-provider-execution/);
});

test('Sprint 8B runbook locks private invocation, logging, authority and production boundaries', async () => {
  const path = 'docs/runbooks/ai-provider-execution.md';
  assert.equal(existsSync(new URL(path, ROOT)), true, `missing ${path}`);
  const runbook = await read(path);
  for (const phrase of [
    'No public route',
    'AI output is not Evidence',
    'No automatic materialization',
    'No automatic publication',
    'No production credential provisioning',
    'Raw prompts and raw provider output are not logged',
    'Production deployment is out of scope',
    'Issue #23',
    'DATABASE_URL',
    'AI_DISCOVERY_PROVIDER',
    'OPENAI_API_KEY',
    'AI_DISCOVERY_OPENAI_MODEL',
    'AI_DISCOVERY_RUN_FAILED',
  ]) {
    assert.match(runbook, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
  }
});
