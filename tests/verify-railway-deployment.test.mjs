import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const MARKER = 'AI_AUTOMATION_DISABLED_READY scheduler_enabled=false provider_configured=false';

function runVerifier(args, env) {
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

async function fakeRailway(t, scenario) {
  const dir = await mkdtemp(join(tmpdir(), 'railway-verify-'));
  const railwayPath = join(dir, 'railway');
  const statePath = join(dir, 'state.json');
  const argvPath = join(dir, 'argv.jsonl');
  const source = `#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_RAILWAY_ARGV, JSON.stringify(args) + '\\n');
const scenario = process.env.FAKE_RAILWAY_SCENARIO;
const statePath = process.env.FAKE_RAILWAY_STATE;
let count = 0;
if (existsSync(statePath)) count = JSON.parse(readFileSync(statePath, 'utf8')).count ?? 0;
count += 1;
writeFileSync(statePath, JSON.stringify({ count }));
if (args[0] === 'deployment' && args[1] === 'list') {
  if (scenario === 'malformed') { process.stdout.write('not-json\\n'); process.exit(0); }
  if (scenario === 'building-success') {
    process.stdout.write(JSON.stringify([{ id: 'dep-1', status: count === 1 ? 'BUILDING' : 'SUCCESS' }]) + '\\n');
    process.exit(0);
  }
  if (scenario === 'absent-success') {
    process.stdout.write(JSON.stringify(count === 1 ? [{ id: 'dep-other', status: 'SUCCESS' }] : [{ id: 'dep-1', status: 'SUCCESS' }]) + '\\n');
    process.exit(0);
  }
  const status = scenario === 'failed' ? 'FAILED' : scenario === 'crashed' ? 'CRASHED' : scenario === 'removed' ? 'REMOVED' : scenario === 'removing' ? 'REMOVING' : scenario === 'unknown' ? 'MYSTERY' : 'SUCCESS';
  process.stdout.write(JSON.stringify([{ id: 'dep-1', status }]) + '\\n');
  process.exit(0);
}
if (args[0] === 'logs') {
  const line = scenario === 'marker-near-match' ? 'prefix ' + ${JSON.stringify(MARKER)} : ${JSON.stringify(MARKER)};
  process.stdout.write(JSON.stringify({ message: line }) + '\\n');
  process.exit(0);
}
process.stderr.write('unexpected fake railway command: ' + args.join(' ') + '\\n');
process.exit(2);
`;
  await writeFile(railwayPath, source, 'utf8');
  await chmod(railwayPath, 0o755);
  t.after(async () => {});
  return {
    env: {
      PATH: `${dir}:${process.env.PATH ?? ''}`,
      FAKE_RAILWAY_SCENARIO: scenario,
      FAKE_RAILWAY_STATE: statePath,
      FAKE_RAILWAY_ARGV: argvPath,
    },
    async argv() {
      try {
        return (await readFile(argvPath, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
      } catch {
        return [];
      }
    },
  };
}

const baseArgs = [
  '--mode', 'status-only',
  '--project', 'project-1',
  '--environment', 'production',
  '--service', 'backend',
  '--deployment-id', 'dep-1',
];

test('verifier accepts SUCCESS for the exact deployment id and keeps all Railway selectors explicit', async (t) => {
  const fake = await fakeRailway(t, 'success');
  const result = await runVerifier(baseArgs, fake.env);
  assert.equal(result.code, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /railway-deployment: SUCCESS service=backend deployment_id=dep-1/);
  const calls = await fake.argv();
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].slice(0, 3), ['deployment', 'list', '--json']);
  assert.ok(calls[0].includes('--project'));
  assert.ok(calls[0].includes('project-1'));
  assert.ok(calls[0].includes('--environment'));
  assert.ok(calls[0].includes('production'));
  assert.ok(calls[0].includes('--service'));
  assert.ok(calls[0].includes('backend'));
  assert.equal(calls[0].includes('--latest'), false);
});

test('verifier polls the same deployment through BUILDING and temporary absence until SUCCESS', async (t) => {
  for (const scenario of ['building-success', 'absent-success']) {
    const fake = await fakeRailway(t, scenario);
    const result = await runVerifier(baseArgs, fake.env);
    assert.equal(result.code, 0, `${scenario}: ${result.stderr || result.stdout}`);
    const calls = await fake.argv();
    assert.ok(calls.length >= 2, `${scenario} should poll more than once`);
    for (const call of calls) assert.equal(call.includes('--latest'), false);
  }
});

test('verifier fails closed for terminal failure, unknown status, and malformed CLI JSON', async (t) => {
  for (const scenario of ['failed', 'crashed', 'removed', 'removing', 'unknown', 'malformed']) {
    const fake = await fakeRailway(t, scenario);
    const result = await runVerifier(baseArgs, fake.env);
    assert.notEqual(result.code, 0, `${scenario} must fail`);
    assert.match(result.stderr, /RAILWAY_DEPLOYMENT_VERIFY_FAILED/);
  }
});

test('AI verification requires the exact trimmed disabled-ready marker from exact deployment logs', async (t) => {
  const aiArgs = [
    '--mode', 'status-and-disabled-marker',
    '--project', 'project-1',
    '--environment', 'production',
    '--service', 'ai-automation',
    '--deployment-id', 'dep-1',
  ];

  const exact = await fakeRailway(t, 'marker-exact');
  const success = await runVerifier(aiArgs, exact.env);
  assert.equal(success.code, 0, success.stderr || success.stdout);
  assert.match(success.stdout, /AI_AUTOMATION_DISABLED_DEPLOYMENT_VERIFIED/);
  const calls = await exact.argv();
  assert.ok(calls.some((call) => call[0] === 'logs' && call[1] === 'dep-1' && call.includes('--deployment')));
  assert.equal(calls.some((call) => call.includes('--latest')), false);

  const near = await fakeRailway(t, 'marker-near-match');
  const rejected = await runVerifier(aiArgs, near.env);
  assert.notEqual(rejected.code, 0);
  assert.match(rejected.stderr, /AI_AUTOMATION_DISABLED_MARKER_NOT_FOUND/);
});
