import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
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

async function readRequired(path) {
  const content = await readOptional(path);
  assert.equal(typeof content, 'string', `missing production delivery asset: ${path}`);
  assert.ok(content.length > 0, `production delivery asset must not be empty: ${path}`);
  return content;
}

function runNode(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('Sprint 6A production delivery assets are explicitly versioned', async () => {
  for (const path of REQUIRED_FILES) await readRequired(path);
});

test('Railway production config preserves same-origin and private-backend boundaries', async () => {
  const [caddy, gatewayDocker, gatewayRailway, backendRailway, envExample] = await Promise.all([
    readRequired('deploy/production/Caddyfile'),
    readRequired('deploy/production/Dockerfile.gateway'),
    readRequired('deploy/production/railway.gateway.toml'),
    readRequired('backend/railway.toml'),
    readRequired('deploy/production/production.env.example'),
  ]);

  assert.match(caddy, /reverse_proxy\s+\{\$BACKEND_ORIGIN\}/);
  assert.match(caddy, /Cache-Control\s+"no-store"/);
  assert.match(caddy, /Service temporarily unavailable/);
  assert.doesNotMatch(caddy, /Access-Control-Allow-Origin/i);
  assert.doesNotMatch(caddy, /Authorization/);

  assert.match(gatewayDocker, /NEXT_PUBLIC_PUBLIC_API_BASE_URL=same-origin/);
  assert.match(gatewayDocker, /COPY deploy\/production\/Caddyfile/);
  assert.match(gatewayDocker, /USER 10001:10001/);

  assert.match(gatewayRailway, /builder\s*=\s*"DOCKERFILE"/);
  assert.match(gatewayRailway, /dockerfilePath\s*=\s*"deploy\/production\/Dockerfile\.gateway"/);
  assert.match(gatewayRailway, /healthcheckPath\s*=\s*"\/"/);
  assert.match(gatewayRailway, /healthcheckTimeout\s*=\s*300/);
  assert.match(gatewayRailway, /restartPolicyType\s*=\s*"ON_FAILURE"/);
  assert.match(gatewayRailway, /restartPolicyMaxRetries\s*=\s*10/);

  assert.match(backendRailway, /builder\s*=\s*"DOCKERFILE"/);
  assert.match(backendRailway, /dockerfilePath\s*=\s*"Dockerfile"/);
  assert.match(backendRailway, /preDeployCommand\s*=\s*\["node dist\/src\/migrate-cli\.js"\]/);
  assert.match(backendRailway, /healthcheckPath\s*=\s*"\/health\/ready"/);
  assert.match(backendRailway, /healthcheckTimeout\s*=\s*300/);
  assert.match(backendRailway, /restartPolicyType\s*=\s*"ON_FAILURE"/);
  assert.match(backendRailway, /restartPolicyMaxRetries\s*=\s*10/);

  assert.match(envExample, /BACKEND_ORIGIN=http:\/\/\$\{\{backend\.RAILWAY_PRIVATE_DOMAIN\}\}:3001/);
  assert.match(envExample, /DATABASE_URL=\$\{\{Postgres\.DATABASE_URL\}\}/);
  assert.match(envExample, /REDIS_URL=\$\{\{Redis\.REDIS_URL\}\}/);
  assert.doesNotMatch(envExample, /password\s*=|token\s*=|BEGIN (RSA|OPENSSH|EC) PRIVATE KEY/i);
});

test('production smoke source is bounded, read-only, and secret-safe', async () => {
  const [smoke, browserSmoke] = await Promise.all([
    readRequired('scripts/production-smoke.mjs'),
    readRequired('scripts/production-browser-smoke.mjs'),
  ]);

  for (const endpoint of ['/', '/health/live', '/health/ready', '/api/v1/publications']) {
    assert.ok(smoke.includes(endpoint), `production smoke is missing ${endpoint}`);
  }
  assert.match(smoke, /method:\s*'POST'/);
  assert.match(smoke, /schemaVersion/);
  assert.match(smoke, /PRODUCTION_BASE_URL_MUST_BE_HTTPS/);
  assert.match(smoke, /PRODUCTION_SMOKE_ALLOW_LOCAL/);
  assert.doesNotMatch(smoke, /setTimeout|setInterval|retry/i);
  assert.doesNotMatch(smoke, /console\.log\([^\n]*(baseUrl|DATABASE_URL|REDIS_URL)/);

  assert.match(browserSmoke, /google-chrome/);
  assert.match(browserSmoke, /chromium/);
  assert.match(browserSmoke, /--headless=new/);
  assert.match(browserSmoke, /LÕI/i);
  assert.match(browserSmoke, /Samira/);
  assert.match(browserSmoke, /public-data-status/);
  assert.match(browserSmoke, /8d000000-/);
  assert.doesNotMatch(browserSmoke, /setTimeout|setInterval|retry/i);
});

test('production HTTP smoke accepts local test mode and rejects the Publication mutation route', async (t) => {
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    if (request.method === 'GET' && request.url === '/') {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<html><body>LÕI.META Samira</body></html>');
      return;
    }
    if (request.method === 'GET' && request.url === '/health/live') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"status":"live"}');
      return;
    }
    if (request.method === 'GET' && request.url === '/health/ready') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"status":"ready"}');
      return;
    }
    if (request.method === 'GET' && request.url === '/api/v1/publications') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"schemaVersion":1,"publications":[]}');
      return;
    }
    if (request.method === 'POST' && request.url === '/api/v1/publications') {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end('{"error":"not_found"}');
      return;
    }
    response.writeHead(500);
    response.end();
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const result = await runNode(['scripts/production-smoke.mjs'], {
    PRODUCTION_BASE_URL: baseUrl,
    PRODUCTION_SMOKE_ALLOW_LOCAL: '1',
  });

  assert.equal(result.code, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /production-smoke: PASS/);
  assert.deepEqual(requests, [
    'GET /',
    'GET /health/live',
    'GET /health/ready',
    'GET /api/v1/publications',
    'POST /api/v1/publications',
  ]);
});

test('production smoke rejects non-HTTPS remote origins before network access', async () => {
  const result = await runNode(['scripts/production-smoke.mjs'], {
    PRODUCTION_BASE_URL: 'http://example.com',
  });
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /PRODUCTION_BASE_URL_MUST_BE_HTTPS/);
});

test('production release workflow is exact-SHA gated, exact-deployment verified, and cannot create Railway infrastructure', async () => {
  const workflow = await readRequired('.github/workflows/production-release-gate.yml');

  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /release_sha:/);
  assert.match(workflow, /contents:\s*read/);
  assert.match(workflow, /git merge-base --is-ancestor/);
  assert.match(workflow, /git rev-parse HEAD/);
  assert.match(workflow, /needs:\s*verify/);
  assert.match(workflow, /environment:\s*production/);
  assert.match(workflow, /@railway\/cli@5\.30\.1/);
  assert.match(workflow, /timeout-minutes:\s*90/);
  assert.match(workflow, /railway up --detach --json/);
  assert.match(workflow, /verify-railway-deployment\.mjs/);
  assert.match(workflow, /RAILWAY_BACKEND_SERVICE/);
  assert.match(workflow, /RAILWAY_WORKER_SERVICE/);
  assert.match(workflow, /RAILWAY_COLLECTOR_SERVICE/);
  assert.match(workflow, /RAILWAY_AI_AUTOMATION_SERVICE/);
  assert.match(workflow, /RAILWAY_GATEWAY_SERVICE/);
  assert.match(workflow, /status-and-disabled-marker/);
  assert.match(workflow, /--project "\$RAILWAY_PROJECT_ID"/);
  assert.match(workflow, /--environment "\$RAILWAY_ENVIRONMENT"/);
  assert.match(workflow, /PRODUCTION_DEPLOYED_AND_SMOKE_VERIFIED/);
  assert.doesNotMatch(workflow, /PRODUCTION_DELIVERY_READY/);
  assert.doesNotMatch(workflow, /railway up --ci/);
  assert.doesNotMatch(workflow, /--latest|railway logs --latest/);
  assert.doesNotMatch(workflow, /OPENAI_API_KEY|AI_DISCOVERY_SCHEDULER_ENABLED\s*=\s*true/);

  const orderedSteps = [
    'Deploy backend from exact tree',
    'Verify backend exact deployment',
    'Deploy worker from exact tree',
    'Verify worker exact deployment',
    'Deploy collector from exact tree',
    'Verify collector exact deployment',
    'Deploy AI automation from exact tree',
    'Verify AI automation exact disabled deployment',
    'Deploy gateway from exact tree',
    'Verify gateway exact deployment',
    'Production HTTP smoke',
    'Production browser smoke',
  ];
  let cursor = -1;
  for (const step of orderedSteps) {
    const next = workflow.indexOf(step, cursor + 1);
    assert.ok(next > cursor, `production workflow release sequence is missing or invalid at: ${step}`);
    cursor = next;
  }

  for (const forbidden of [
    '--new',
    'railway init',
    'railway add',
    'railway project new',
    'contents: write',
    'pages: write',
    'id-token: write',
    'printenv',
    'set -x',
  ]) {
    assert.ok(!workflow.includes(forbidden), `production workflow contains forbidden operation: ${forbidden}`);
  }
});

test('production runbook separates repository readiness from real Railway delivery', async () => {
  const runbook = await readRequired('docs/runbooks/production-delivery.md');
  for (const contract of [
    'One-time Railway bootstrap',
    'Disable GitHub autodeploy',
    'Gateway is the only public service',
    'BACKEND_ORIGIN',
    'DATABASE_URL',
    'REDIS_URL',
    'RAILWAY_TOKEN',
    'production GitHub environment',
    'release_sha',
    'Production smoke',
    'Rollback rehearsal',
    'PRODUCTION_REPO_READY',
    'PRODUCTION_DELIVERY_READY',
    'No rehearsal Publication seed',
  ]) {
    assert.ok(runbook.includes(contract), `production runbook is missing contract: ${contract}`);
  }
  assert.match(runbook, /real Railway environment/i);
  assert.match(runbook, /cannot be emitted by CI-only validation/i);
});

test('production delivery package scripts are wired into root regression', async () => {
  const packageJson = JSON.parse(await readFile('package.json', 'utf8'));
  assert.equal(
    packageJson.scripts?.['test:production-contract'],
    'node --test tests/production-delivery.test.mjs',
  );
  assert.equal(packageJson.scripts?.['production:smoke'], 'node scripts/production-smoke.mjs');
  assert.equal(packageJson.scripts?.['production:browser-smoke'], 'node scripts/production-browser-smoke.mjs');
  assert.match(packageJson.scripts?.test ?? '', /npm run test:production-contract/);
});
