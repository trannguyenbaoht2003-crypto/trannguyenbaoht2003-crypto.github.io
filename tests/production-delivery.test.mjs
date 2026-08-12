import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const REQUIRED_FILES = [
  'deploy/production/Caddyfile',
  'deploy/production/Dockerfile.gateway',
  'deploy/production/railway.gateway.toml',
  'deploy/production/production.env.example',
  'backend/railway.toml',
  'scripts/production-smoke.mjs',
  'scripts/production-browser-smoke.mjs',
  '.github/workflows/production-release-gate.yml',
  'docs/runbooks/production-delivery.md',
];

async function readOptional(path) {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }
}

test('Sprint 6A production delivery assets are explicitly versioned', async () => {
  for (const path of REQUIRED_FILES) {
    const content = await readOptional(path);
    assert.equal(typeof content, 'string', `missing production delivery asset: ${path}`);
    assert.ok(content.length > 0, `production delivery asset must not be empty: ${path}`);
  }
});

test('production delivery package scripts are wired into root regression', async () => {
  const packageJson = JSON.parse(await readFile('package.json', 'utf8'));
  assert.equal(
    packageJson.scripts?.['test:production-contract'],
    'node --test tests/production-delivery.test.mjs',
  );
  assert.match(packageJson.scripts?.test ?? '', /npm run test:production-contract/);
});
