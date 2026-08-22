import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const STATUS_POLL_INTERVAL_MS = 5_000;
export const STATUS_TIMEOUT_MS = 900_000;
export const MARKER_POLL_INTERVAL_MS = 5_000;
export const MARKER_TIMEOUT_MS = 120_000;
export const DISABLED_READY_MARKER =
  'AI_AUTOMATION_DISABLED_READY scheduler_enabled=false provider_configured=false';

const NON_TERMINAL = new Set(['BUILDING', 'DEPLOYING', 'INITIALIZING', 'WAITING', 'QUEUED']);
const FAIL_TERMINAL = new Set(['FAILED', 'CRASHED', 'REMOVING', 'REMOVED']);
const MODES = new Set(['status-only', 'status-and-disabled-marker']);
const BOUNDED_VALUE = /^[A-Za-z0-9._:@/-]{1,128}$/u;
const MAX_OUTPUT_BYTES = 1024 * 1024;

function fail() {
  throw new Error('RAILWAY_DEPLOYMENT_VERIFY_FAILED');
}

function requireBounded(value) {
  if (typeof value !== 'string' || !BOUNDED_VALUE.test(value)) fail();
  return value;
}

function parseCli(argv) {
  if (argv.length !== 10) fail();
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || value === undefined) fail();
    const name = key.slice(2);
    if (Object.hasOwn(values, name)) fail();
    values[name] = value;
  }
  const expected = ['mode', 'project', 'environment', 'service', 'deployment-id'];
  if (Object.keys(values).length !== expected.length || expected.some((key) => !(key in values))) fail();
  if (!MODES.has(values.mode)) fail();
  return {
    mode: values.mode,
    project: requireBounded(values.project),
    environment: requireBounded(values.environment),
    service: requireBounded(values.service),
    deploymentId: requireBounded(values['deployment-id']),
  };
}

function defaultRunRailway(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('railway', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
      shell: false,
    });
    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let overflowed = false;

    const collect = (target) => (chunk) => {
      const chunkBytes = Buffer.byteLength(chunk);
      if (target === 'stdout') {
        stdoutBytes += chunkBytes;
        if (stdoutBytes > MAX_OUTPUT_BYTES) overflowed = true;
        else stdout += chunk;
      } else {
        stderrBytes += chunkBytes;
        if (stderrBytes > MAX_OUTPUT_BYTES) overflowed = true;
        else stderr += chunk;
      }
      if (overflowed) child.kill('SIGKILL');
    };

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', collect('stdout'));
    child.stderr.on('data', collect('stderr'));
    child.once('error', () => reject(new Error('RAILWAY_DEPLOYMENT_VERIFY_FAILED')));
    child.once('close', (code) => {
      if (overflowed || code !== 0) {
        reject(new Error('RAILWAY_DEPLOYMENT_VERIFY_FAILED'));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function testOverride(name, fallback) {
  if (process.env.NODE_ENV !== 'test') return fallback;
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function parseJsonArray(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail();
  }
  if (!Array.isArray(parsed)) fail();
  return parsed;
}

function deploymentStatus(entry) {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) fail();
  const id = entry.id;
  const status = entry.status;
  if (typeof id !== 'string' || typeof status !== 'string') fail();
  return { id, status };
}

function parseLogRecords(text) {
  const trimmed = text.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && typeof parsed === 'object') return [parsed];
  } catch {
    const records = [];
    for (const line of trimmed.split(/\r?\n/u)) {
      try {
        records.push(JSON.parse(line));
      } catch {
        fail();
      }
    }
    return records;
  }
  fail();
}

function recordMessage(record) {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) return null;
  return typeof record.message === 'string' ? record.message : null;
}

async function verifyStatus(input, dependencies, timing) {
  const deadline = dependencies.now() + timing.statusTimeoutMs;
  for (;;) {
    const { stdout } = await dependencies.runRailway([
      'deployment',
      'list',
      '--json',
      '--project',
      input.project,
      '--environment',
      input.environment,
      '--service',
      input.service,
      '--limit',
      '1000',
    ]);
    const entries = parseJsonArray(stdout).map(deploymentStatus);
    const target = entries.find((entry) => entry.id === input.deploymentId);

    if (target?.status === 'SUCCESS') return;
    if (target && FAIL_TERMINAL.has(target.status)) fail();
    if (target && !NON_TERMINAL.has(target.status)) fail();
    if (dependencies.now() >= deadline) fail();
    await dependencies.sleep(timing.statusPollIntervalMs);
  }
}

async function verifyMarker(input, dependencies, timing) {
  const deadline = dependencies.now() + timing.markerTimeoutMs;
  for (;;) {
    const { stdout } = await dependencies.runRailway([
      'logs',
      input.deploymentId,
      '--deployment',
      '--json',
      '--lines',
      '200',
      '--project',
      input.project,
      '--environment',
      input.environment,
      '--service',
      input.service,
    ]);
    const found = parseLogRecords(stdout).some((record) => {
      const message = recordMessage(record);
      return message !== null && message.trim() === DISABLED_READY_MARKER;
    });
    if (found) return;
    if (dependencies.now() >= deadline) fail();
    await dependencies.sleep(timing.markerPollIntervalMs);
  }
}

export async function verifyRailwayDeployment(input, dependencies = {}) {
  const safeInput = {
    mode: input?.mode,
    project: requireBounded(input?.project),
    environment: requireBounded(input?.environment),
    service: requireBounded(input?.service),
    deploymentId: requireBounded(input?.deploymentId),
  };
  if (!MODES.has(safeInput.mode)) fail();

  const deps = {
    runRailway: dependencies.runRailway ?? defaultRunRailway,
    sleep: dependencies.sleep ?? defaultSleep,
    now: dependencies.now ?? Date.now,
  };
  const timing = {
    statusPollIntervalMs:
      dependencies.statusPollIntervalMs
      ?? testOverride('RAILWAY_VERIFY_TEST_POLL_MS', STATUS_POLL_INTERVAL_MS),
    statusTimeoutMs:
      dependencies.statusTimeoutMs
      ?? testOverride('RAILWAY_VERIFY_TEST_TIMEOUT_MS', STATUS_TIMEOUT_MS),
    markerPollIntervalMs:
      dependencies.markerPollIntervalMs
      ?? testOverride('RAILWAY_VERIFY_TEST_POLL_MS', MARKER_POLL_INTERVAL_MS),
    markerTimeoutMs:
      dependencies.markerTimeoutMs
      ?? testOverride('RAILWAY_VERIFY_TEST_TIMEOUT_MS', MARKER_TIMEOUT_MS),
  };

  await verifyStatus(safeInput, deps, timing);
  process.stdout.write(
    `railway-deployment: SUCCESS service=${safeInput.service} deployment_id=${safeInput.deploymentId}\n`,
  );
  if (safeInput.mode === 'status-and-disabled-marker') {
    await verifyMarker(safeInput, deps, timing);
    process.stdout.write(
      `AI_AUTOMATION_DISABLED_DEPLOYMENT_VERIFIED deployment_id=${safeInput.deploymentId}\n`,
    );
  }
}

async function main() {
  try {
    const input = parseCli(process.argv.slice(2));
    await verifyRailwayDeployment(input);
  } catch {
    process.stderr.write('railway-deployment: VERIFY_FAILED\n');
    process.exitCode = 1;
  }
}

const isDirectExecution = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectExecution) void main();
