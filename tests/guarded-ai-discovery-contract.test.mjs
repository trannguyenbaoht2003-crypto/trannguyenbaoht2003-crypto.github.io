import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import test from 'node:test';

const ROOT = new URL('../', import.meta.url);
const read = (path) => readFile(new URL(path, ROOT), 'utf8');

async function collectText(relativeDirectory) {
  const directory = new URL(relativeDirectory, ROOT);
  const entries = await readdir(directory, { withFileTypes: true });
  const chunks = [];
  for (const entry of entries) {
    const relative = join(relativeDirectory, entry.name).replaceAll('\\', '/');
    if (entry.isDirectory()) chunks.push(...await collectText(`${relative}/`));
    else if (entry.isFile() && ['.ts', '.tsx', '.js', '.mjs', '.json', '.toml'].includes(extname(entry.name))) {
      chunks.push(await read(relative));
    }
  }
  return chunks;
}

test('Sprint 8A repository contains guarded AI authority artifacts', async () => {
  for (const path of [
    'backend/migrations/0014_guarded_ai_discovery.sql',
    'backend/src/modules/ai-discovery/types.ts',
    'backend/src/modules/ai-discovery/normalize-ai-discovery-input.ts',
    'backend/src/modules/ai-discovery/record-ai-discovery-run.ts',
    'backend/src/modules/ai-discovery/materialize-ai-candidate-proposal.ts',
    'backend/src/modules/ai-discovery/read-ai-discovery-proposals.ts',
    'docs/runbooks/guarded-ai-discovery.md',
  ]) {
    assert.equal(existsSync(new URL(path, ROOT)), true, `missing ${path}`);
  }
  const candidateTypes = await read('backend/src/modules/candidate/types.ts');
  assert.match(candidateTypes, /'ai_generated'/);
  const materializer = await read('backend/src/modules/ai-discovery/materialize-ai-candidate-proposal.ts');
  assert.match(materializer, /registerNormalizedObservationInTransaction/);
  assert.doesNotMatch(
    materializer,
    /\b(?:insert\s+into|update|delete\s+from)\s+(?:candidates|candidate_revisions|normalized_observations|candidate_provenance)\b/i,
  );
});

test('Sprint 8A adds no public AI route, provider SDK, queue, or deployment wiring', async () => {
  const rootPackage = JSON.parse(await read('package.json'));
  const backendPackage = JSON.parse(await read('backend/package.json'));
  const dependencyNames = [
    ...Object.keys(rootPackage.dependencies ?? {}),
    ...Object.keys(rootPackage.devDependencies ?? {}),
    ...Object.keys(backendPackage.dependencies ?? {}),
    ...Object.keys(backendPackage.devDependencies ?? {}),
  ];
  for (const forbidden of ['openai', 'anthropic', '@google/generative-ai']) {
    assert.equal(dependencyNames.includes(forbidden), false, `provider SDK added: ${forbidden}`);
  }

  const appText = (await collectText('app/')).join('\n');
  assert.doesNotMatch(appText, /ai-discovery|\/api\/ai(?:\/|['"`])/i);

  const productionCaddy = await read('deploy/production/Caddyfile');
  const stagingCaddy = await read('deploy/staging/Caddyfile');
  assert.doesNotMatch(productionCaddy, /ai-discovery|\/api\/ai/i);
  assert.doesNotMatch(stagingCaddy, /ai-discovery|\/api\/ai/i);

  const productionFiles = (await collectText('deploy/production/')).join('\n');
  assert.doesNotMatch(productionFiles, /ai-discovery|openai|anthropic|generative-ai/i);
});

test('Sprint 8A runbook and root orchestration lock the provider-neutral safety boundary', async () => {
  const runbook = await read('docs/runbooks/guarded-ai-discovery.md');
  for (const phrase of [
    'AI output is not Evidence',
    'materialization is not approval',
    'No live provider',
    'Production deployment is out of scope',
    'ai_generated',
  ]) {
    assert.match(runbook, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
  }

  const rootPackage = JSON.parse(await read('package.json'));
  assert.equal(
    rootPackage.scripts['test:guarded-ai-discovery'],
    'node --test tests/guarded-ai-discovery-contract.test.mjs',
  );
  assert.match(rootPackage.scripts.test, /test:guarded-ai-discovery/);
});
