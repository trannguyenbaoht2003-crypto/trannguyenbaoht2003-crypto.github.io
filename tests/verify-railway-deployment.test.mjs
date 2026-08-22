import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import test from 'node:test';

const VERIFY_SCRIPT = 'scripts/verify-railway-deployment.mjs';
const READY_MARKER = 'AI_AUTOMATION_DISABLED_READY scheduler_enabled=false provider_configured=false';

function runVerifier(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [VERIFY_SCRIPT, ...args], {
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

async function createFakeRailway(t, scenario) {
  const dir = await mkdtemp(join(tmpdir(), 'sprint-8f-railway-'));
  const scenarioPath = join(dir, 'scenario.json');
  const statePath = join(dir, 'state.json');
  const callsPath = join(dir, 'calls.jsonl');
  const railwayPath = join(dir, 'railway');

  await writeFile(scenarioPath, JSON.stringify(scenario));
  await writeFile(statePath, JSON.stringify({ deployment: 0, logs: 0 }));
  await writeFile(callsPath, '');

  await writeFile(railwayPath, `#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
const scenario = JSON.parse(readFileSync(process.env.FAKE_RAILWAY_SCENARIO, 'utf8'));
const state = JSON.parse(readFileSync(process.env.FAKE_RAILWAY_STATE, 'utf8'));
appendFileSync(process.env.FAKE_RAILWAY_CALLS, JSON.stringify(process.argv.slice(2)) + '\\n');
const args = process.argv.slice(2);
let key;
if (args[0] === 'deployment' && args[1] === 'list' && args.includes('--json')) key = 'deployment';
if (args[0] === 'logs' && args[2] === '--deployment' && args.includes('--json')) key = 'logs';
if (!key) {
  process.stderr.write('FAKE_RAILWAY_UNEXPECTED_COMMAND\\n');
  process.exit(64);
} else {
  const responses = scenario[key] ?? [];
  const index = state[key] ?? 0;
  const response = responses[Math.min(index, Math.max(0, responses.length - 1))];
  state[key] = index + 1;
  writeFileSync(process.env.FAKE_RAILWAY_STATE, JSON.stringify(state));
  if (response === '__MALFORMED__') {
    process.stdout.write('{malformed-json\\n');
  } else if (response && typeof response === 'object' && response.__stderr) {
    process.stderr.write(String(response.__stderr) + '\\n');
    process.exit(Number(response.__exitCode ?? 1));
  } else {
    process.stdout.write(JSON.stringify(response ?? []) + '\\n');
  }
}
`);
  await chmod(railwayPath, 0o755);
  t.after(async () => {
    // Temporary directory cleanup is intentionally left to the runner.
  });

  return {
    env: {
      PATH: `${dir}${delimiter}${process.env.PATH ?? ''}`,
      FAKE_RAILWAY_SCENARIO: scenarioPath,
      FAKE_RAILWAY_STATE: statePath,
      FAKE_RAILWAY_CALLS: callsPath,
      NODE_ENV: 'test',
      RAILWAY_VERIFY_TEST_POLL_MS: '5',
      RAILWAY_VERIFY_TEST_TIMEOUT_MS: '1000',
    },
    callsPath,
  };
}

function baseArgs(mode = 'status-only') {
  return [
    '--mode', mode,
    '--project', 'project-1',
    '--environment', 'production',
    '--service', 'backend',
    '--deployment-id', 'dep-1',
  ];
}

function deployment(id, status) {
  return { id, status };
}

test('status-only accepts SUCCESS for the exact requested deployment and records scoped Railway argv', async (t) => {
  const fake = await createFakeRailway(t, {
    deployment: [[deployment('dep-1', 'SUCCESS')]],
  });
  const result = await runVerifier(baseArgs(), fake.env);
  assert.equal(result.code, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /railway-deployment: SUCCESS service=backend deployment_id=dep-1/);

  const calls = (await readFile(fake.callsPath, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(calls[0], [
    'deployment', 'list', '--json',
    '--project', 'project-1',
    '--environment', 'production',
    '--service', 'backend',
    '--limit', '1000',
  ]);
});

test('CLI rejects bounded identifiers longer than 128 characters', async () => {
  const args = baseArgs();
  args[3] = 'p'.repeat(129);
  const result = await runVerifier(args);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /railway-deployment: VERIFY_FAILED/);
});

test('status-only polls BUILDING until the exact deployment reaches SUCCESS', async (t) => {
  const fake = await createFakeRailway(t, {
    deployment: [
      [deployment('dep-1', 'BUILDING')],
      [deployment('dep-1', 'SUCCESS')],
    ],
  });
  const result = await runVerifier(baseArgs(), fake.env);
  assert.equal(result.code, 0, result.stderr || result.stdout);
  const calls = (await readFile(fake.callsPath, 'utf8')).trim().split('\n');
  assert.equal(calls.length, 2);
});

test('status-only tolerates the exact deployment being temporarily absent', async (t) => {
  const fake = await createFakeRailway(t, {
    deployment: [
      [deployment('other', 'SUCCESS')],
      [deployment('dep-1', 'SUCCESS')],
    ],
  });
  const result = await runVerifier(baseArgs(), fake.env);
  assert.equal(result.code, 0, result.stderr || result.stdout);
});

for (const status of ['FAILED', 'CRASHED', 'REMOVED', 'REMOVING']) {
  test(`status-only fails closed on terminal ${status}`, async (t) => {
    const fake = await createFakeRailway(t, {
      deployment: [[deployment('dep-1', status)]],
    });
    const result = await runVerifier(baseArgs(), fake.env);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /railway-deployment: VERIFY_FAILED/);
  });
}

test('status-only fails closed on an unknown exact-deployment status', async (t) => {
  const fake = await createFakeRailway(t, {
    deployment: [[deployment('dep-1', 'MYSTERY')]],
  });
  const result = await runVerifier(baseArgs(), fake.env);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /railway-deployment: VERIFY_FAILED/);
});

test('status-only fails closed on malformed Railway JSON', async (t) => {
  const fake = await createFakeRailway(t, { deployment: ['__MALFORMED__'] });
  const result = await runVerifier(baseArgs(), fake.env);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /railway-deployment: VERIFY_FAILED/);
});

test('status-only never substitutes another successful deployment for a missing target id', async (t) => {
  const fake = await createFakeRailway(t, {
    deployment: [
      [deployment('other-success', 'SUCCESS')],
      [deployment('dep-1', 'FAILED')],
    ],
  });
  const result = await runVerifier(baseArgs(), fake.env);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /railway-deployment: VERIFY_FAILED/);
});

test('status-and-disabled-marker requires the exact trimmed marker from the exact deployment logs', async (t) => {
  const fake = await createFakeRailway(t, {
    deployment: [[deployment('dep-1', 'SUCCESS')]],
    logs: [[{ message: `  ${READY_MARKER}  ` }]],
  });
  const result = await runVerifier(baseArgs('status-and-disabled-marker'), fake.env);
  assert.equal(result.code, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /AI_AUTOMATION_DISABLED_DEPLOYMENT_VERIFIED deployment_id=dep-1/);

  const calls = (await readFile(fake.callsPath, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(calls.at(-1), [
    'logs', 'dep-1', '--deployment', '--json', '--lines', '200',
    '--project', 'project-1',
    '--environment', 'production',
    '--service', 'backend',
  ]);
});

test('status-and-disabled-marker ignores non-message fields even when they equal the marker', async (t) => {
  const fake = await createFakeRailway(t, {
    deployment: [[deployment('dep-1', 'SUCCESS')]],
    logs: [[{ text: READY_MARKER }]],
  });
  const result = await runVerifier(baseArgs('status-and-disabled-marker'), fake.env);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /railway-deployment: VERIFY_FAILED/);
});

test('status-and-disabled-marker rejects near-match marker text', async (t) => {
  const fake = await createFakeRailway(t, {
    deployment: [[deployment('dep-1', 'SUCCESS')]],
    logs: [[{ message: `${READY_MARKER} extra` }]],
  });
  const result = await runVerifier(baseArgs('status-and-disabled-marker'), fake.env);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /railway-deployment: VERIFY_FAILED/);
});
