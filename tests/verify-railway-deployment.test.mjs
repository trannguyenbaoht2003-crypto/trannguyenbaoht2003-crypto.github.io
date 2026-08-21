import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  DISABLED_READY_MARKER,
  MARKER_POLL_INTERVAL_MS,
  MARKER_TIMEOUT_MS,
  STATUS_POLL_INTERVAL_MS,
  STATUS_TIMEOUT_MS,
  verifyRailwayDeployment,
} from '../scripts/verify-railway-deployment.mjs';

function runVerifierCli(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['scripts/verify-railway-deployment.mjs', ...args], {
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

async function fakeRailwayExecutable() {
  const dir = await mkdtemp(join(tmpdir(), 'railway-verify-'));
  const railwayPath = join(dir, 'railway');
  const argvPath = join(dir, 'argv.jsonl');
  const source = `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_RAILWAY_ARGV, JSON.stringify(args) + '\\n');
if (args[0] === 'deployment' && args[1] === 'list') {
  process.stdout.write(JSON.stringify([{ id: 'dep-1', status: 'SUCCESS' }]) + '\\n');
  process.exit(0);
}
process.exit(2);
`;
  await writeFile(railwayPath, source, 'utf8');
  await chmod(railwayPath, 0o755);
  return {
    env: {
      PATH: `${dir}:${process.env.PATH ?? ''}`,
      FAKE_RAILWAY_ARGV: argvPath,
    },
    async argv() {
      return (await readFile(argvPath, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    },
  };
}

const input = {
  mode: 'status-only',
  project: 'project-1',
  environment: 'production',
  service: 'backend',
  deploymentId: 'dep-1',
};

function deterministicDependencies(runRailway) {
  let clock = 0;
  return {
    runRailway,
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    clock: () => clock,
  };
}

test('verifier constants lock bounded production polling windows', () => {
  assert.equal(STATUS_POLL_INTERVAL_MS, 5_000);
  assert.equal(STATUS_TIMEOUT_MS, 900_000);
  assert.equal(MARKER_POLL_INTERVAL_MS, 5_000);
  assert.equal(MARKER_TIMEOUT_MS, 120_000);
  assert.equal(
    DISABLED_READY_MARKER,
    'AI_AUTOMATION_DISABLED_READY scheduler_enabled=false provider_configured=false',
  );
});

test('CLI accepts SUCCESS for the exact deployment id and keeps all Railway selectors explicit', async () => {
  const fake = await fakeRailwayExecutable();
  const result = await runVerifierCli([
    '--mode', 'status-only',
    '--project', 'project-1',
    '--environment', 'production',
    '--service', 'backend',
    '--deployment-id', 'dep-1',
  ], fake.env);
  assert.equal(result.code, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /railway-deployment: SUCCESS service=backend deployment_id=dep-1/);
  const calls = await fake.argv();
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], [
    'deployment', 'list', '--json',
    '--project', 'project-1',
    '--environment', 'production',
    '--service', 'backend',
    '--limit', '1000',
  ]);
  assert.equal(calls[0].includes('--latest'), false);
});

test('strict CLI rejects extra, duplicate, missing, blank, and unknown mode input', async () => {
  for (const args of [
    ['--mode', 'unknown', '--project', 'p', '--environment', 'e', '--service', 's', '--deployment-id', 'd'],
    ['--mode', 'status-only', '--project', 'p', '--environment', 'e', '--service', 's'],
    ['--mode', 'status-only', '--project', 'p', '--environment', 'e', '--service', 's', '--deployment-id', 'd', 'extra', 'x'],
    ['--mode', 'status-only', '--project', 'p', '--project', 'p2', '--service', 's', '--deployment-id', 'd'],
    ['--mode', 'status-only', '--project', '', '--environment', 'e', '--service', 's', '--deployment-id', 'd'],
  ]) {
    const result = await runVerifierCli(args);
    assert.notEqual(result.code, 0);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /^RAILWAY_DEPLOYMENT_VERIFY_FAILED\n$/u);
  }
});

test('verifier polls the same deployment through BUILDING and temporary absence until SUCCESS', async () => {
  for (const scenario of ['building', 'absent']) {
    let calls = 0;
    const deps = deterministicDependencies(async (args) => {
      calls += 1;
      assert.deepEqual(args.slice(0, 3), ['deployment', 'list', '--json']);
      assert.equal(args.includes('--latest'), false);
      if (calls === 1 && scenario === 'building') {
        return { stdout: JSON.stringify([{ id: 'dep-1', status: 'BUILDING' }]), stderr: '' };
      }
      if (calls === 1 && scenario === 'absent') {
        return { stdout: JSON.stringify([{ id: 'dep-other', status: 'SUCCESS' }]), stderr: '' };
      }
      return { stdout: JSON.stringify([{ id: 'dep-1', status: 'SUCCESS' }]), stderr: '' };
    });
    const result = await verifyRailwayDeployment(input, deps);
    assert.match(result.deploymentLine, /deployment_id=dep-1/);
    assert.equal(calls, 2);
    assert.equal(deps.clock(), STATUS_POLL_INTERVAL_MS);
  }
});

test('verifier fails closed for terminal failure, unknown status, and malformed CLI JSON', async () => {
  for (const status of ['FAILED', 'CRASHED', 'REMOVED', 'REMOVING', 'MYSTERY']) {
    const deps = deterministicDependencies(async () => ({
      stdout: JSON.stringify([{ id: 'dep-1', status }]),
      stderr: '',
    }));
    await assert.rejects(() => verifyRailwayDeployment(input, deps), /RAILWAY_DEPLOYMENT_VERIFY_/u);
  }
  const malformed = deterministicDependencies(async () => ({ stdout: 'not-json', stderr: '' }));
  await assert.rejects(() => verifyRailwayDeployment(input, malformed), /RAILWAY_DEPLOYMENT_VERIFY_JSON_INVALID/u);
});

test('absent exact deployment id times out without selecting another successful deployment', async () => {
  const deps = deterministicDependencies(async () => ({
    stdout: JSON.stringify([{ id: 'dep-other', status: 'SUCCESS' }]),
    stderr: '',
  }));
  await assert.rejects(() => verifyRailwayDeployment(input, deps), /RAILWAY_DEPLOYMENT_VERIFY_TIMEOUT/u);
  assert.equal(deps.clock(), STATUS_TIMEOUT_MS);
});

test('AI verification accepts only the exact trimmed disabled-ready marker from exact deployment logs', async () => {
  const calls = [];
  const exact = deterministicDependencies(async (args) => {
    calls.push(args);
    if (args[0] === 'deployment') {
      return { stdout: JSON.stringify([{ id: 'dep-1', status: 'SUCCESS' }]), stderr: '' };
    }
    return { stdout: `${JSON.stringify({ message: `  ${DISABLED_READY_MARKER}  ` })}\n`, stderr: '' };
  });
  const success = await verifyRailwayDeployment({ ...input, mode: 'status-and-disabled-marker', service: 'ai-automation' }, exact);
  assert.equal(success.markerLine, 'AI_AUTOMATION_DISABLED_DEPLOYMENT_VERIFIED deployment_id=dep-1');
  assert.ok(calls.some((args) => args[0] === 'logs' && args[1] === 'dep-1' && args.includes('--deployment')));
  assert.equal(calls.some((args) => args.includes('--latest')), false);

  const near = deterministicDependencies(async (args) => {
    if (args[0] === 'deployment') {
      return { stdout: JSON.stringify([{ id: 'dep-1', status: 'SUCCESS' }]), stderr: '' };
    }
    return { stdout: `${JSON.stringify({ message: `prefix ${DISABLED_READY_MARKER}` })}\n`, stderr: '' };
  });
  await assert.rejects(
    () => verifyRailwayDeployment({ ...input, mode: 'status-and-disabled-marker', service: 'ai-automation' }, near),
    /AI_AUTOMATION_DISABLED_MARKER_NOT_FOUND/u,
  );
  assert.equal(near.clock(), MARKER_TIMEOUT_MS);
});
