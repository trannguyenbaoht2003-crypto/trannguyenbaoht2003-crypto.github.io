import assert from 'node:assert/strict';
import { access, readFile, readdir } from 'node:fs/promises';
import test from 'node:test';

async function text(path) {
  return readFile(path, 'utf8');
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

test('operator runtime remains private and loopback-only', async () => {
  const [config, server, productionCaddy, stagingCaddy] = await Promise.all([
    text('backend/src/operator/config.ts'),
    text('backend/src/operator-server.ts'),
    text('deploy/production/Caddyfile'),
    text('deploy/staging/Caddyfile'),
  ]);

  assert.match(config, /127\.0\.0\.1/);
  assert.match(config, /::1/);
  assert.match(config, /localhost/);
  assert.doesNotMatch(config, /0\.0\.0\.0/);
  assert.match(server, /app\.listen\(\{\s*host:\s*config\.host,\s*port:\s*config\.port\s*\}\)/s);
  assert.doesNotMatch(productionCaddy, /operator/i);
  assert.doesNotMatch(stagingCaddy, /operator/i);
  assert.equal(await exists('app/operator'), false, 'public Next app/operator route must not exist');
});

test('Railway and production deployment files do not expose operator runtime', async () => {
  const entries = await readdir('deploy/production');
  const deploymentFiles = entries.filter((name) => /railway|dockerfile|\.sh$|\.env/i.test(name));
  const combined = (await Promise.all(
    deploymentFiles.map((name) => text(`deploy/production/${name}`)),
  )).join('\n');

  assert.doesNotMatch(combined, /operator-server|operator:dev|npm\s+run\s+operator\b/i);
});

test('operator assets are self-contained and render untrusted text safely', async () => {
  const assets = await text('backend/src/operator/assets.ts');
  assert.match(assets, /\/api\/operator\/v1\/candidate-review-queue/);
  assert.match(assets, /Candidate review/);
  assert.match(assets, /Monitoring &amp; feedback/);
  assert.match(assets, /textContent/);
  assert.doesNotMatch(assets, /innerHTML/);
  assert.doesNotMatch(assets, /setInterval|localStorage|sessionStorage/);
  assert.doesNotMatch(assets, /https?:\/\//);
});

test('operator runbook locks private read-only operating boundary', async () => {
  const runbook = await text('docs/runbooks/operator-surface.md');
  for (const required of [
    "DATABASE_URL='postgres://...' npm run operator:dev",
    'http://127.0.0.1:3011',
    'Never set `OPERATOR_HOST=0.0.0.0`',
    'never expose the operator port through Caddy or Railway',
    'PostgreSQL is the only runtime dependency',
    'GET /api/operator/v1/candidate-review-queue',
    '`limit=1..100`',
    'never evaluated on read',
    '`unscored`',
    'textContent',
    'Production delivery remains a separate gate',
  ]) {
    assert.ok(runbook.includes(required), `runbook missing contract: ${required}`);
  }
});
