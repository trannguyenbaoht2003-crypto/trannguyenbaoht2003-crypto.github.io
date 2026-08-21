import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const STATUS_POLL_INTERVAL_MS = 5_000;
export const STATUS_TIMEOUT_MS = 900_000;
export const MARKER_POLL_INTERVAL_MS = 5_000;
export const MARKER_TIMEOUT_MS = 120_000;
export const DISABLED_READY_MARKER = 'AI_AUTOMATION_DISABLED_READY scheduler_enabled=false provider_configured=false';

const MAX_IDENTIFIER_LENGTH = 128;
const MAX_CAPTURE_BYTES = 1024 * 1024;
const NON_TERMINAL = new Set(['BUILDING', 'DEPLOYING', 'INITIALIZING', 'WAITING', 'QUEUED']);
const FAIL_TERMINAL = new Set(['FAILED', 'CRASHED', 'REMOVING', 'REMOVED']);
const MODES = new Set(['status-only', 'status-and-disabled-marker']);
const FLAG_NAMES = new Set(['--mode', '--project', '--environment', '--service', '--deployment-id']);

function verifierError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function requireBoundedIdentifier(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_IDENTIFIER_LENGTH || value !== value.trim()) {
    throw verifierError('RAILWAY_DEPLOYMENT_VERIFY_INPUT_INVALID');
  }
  return value;
}

function parseCli(argv) {
  if (argv.length !== 10) throw verifierError('RAILWAY_DEPLOYMENT_VERIFY_INPUT_INVALID');
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!FLAG_NAMES.has(flag) || values.has(flag) || value === undefined || value.startsWith('--')) {
      throw verifierError('RAILWAY_DEPLOYMENT_VERIFY_INPUT_INVALID');
    }
    values.set(flag, value);
  }
  if (values.size !== FLAG_NAMES.size) throw verifierError('RAILWAY_DEPLOYMENT_VERIFY_INPUT_INVALID');
  const mode = requireBoundedIdentifier(values.get('--mode'));
  if (!MODES.has(mode)) throw verifierError('RAILWAY_DEPLOYMENT_VERIFY_INPUT_INVALID');
  return {
    mode,
    project: requireBoundedIdentifier(values.get('--project')),
    environment: requireBoundedIdentifier(values.get('--environment')),
    service: requireBoundedIdentifier(values.get('--service')),
    deploymentId: requireBoundedIdentifier(values.get('--deployment-id')),
  };
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runRailwayCommand(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('railway', args, {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const fail = (code) => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(verifierError(code));
    };

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout, 'utf8') > MAX_CAPTURE_BYTES) fail('RAILWAY_DEPLOYMENT_VERIFY_OUTPUT_OVERFLOW');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      if (Buffer.byteLength(stderr, 'utf8') > MAX_CAPTURE_BYTES) fail('RAILWAY_DEPLOYMENT_VERIFY_OUTPUT_OVERFLOW');
    });
    child.once('error', () => fail('RAILWAY_DEPLOYMENT_VERIFY_COMMAND_FAILED'));
    child.once('close', (code) => {
      if (settled) return;
      settled = true;
      if (code !== 0) {
        reject(verifierError('RAILWAY_DEPLOYMENT_VERIFY_COMMAND_FAILED'));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function parseDeploymentList(stdout) {
  let value;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw verifierError('RAILWAY_DEPLOYMENT_VERIFY_JSON_INVALID');
  }
  if (!Array.isArray(value)) throw verifierError('RAILWAY_DEPLOYMENT_VERIFY_JSON_INVALID');
  return value;
}

function markerPresent(stdout) {
  const lines = stdout.split(/\r?\n/u).filter((line) => line.length > 0);
  for (const line of lines) {
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      throw verifierError('RAILWAY_DEPLOYMENT_VERIFY_JSON_INVALID');
    }
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      if (typeof value.message === 'string' && value.message.trim() === DISABLED_READY_MARKER) return true;
    }
  }
  return false;
}

export async function verifyRailwayDeployment(input, dependencies = {}) {
  const mode = requireBoundedIdentifier(input?.mode);
  if (!MODES.has(mode)) throw verifierError('RAILWAY_DEPLOYMENT_VERIFY_INPUT_INVALID');
  const project = requireBoundedIdentifier(input?.project);
  const environment = requireBoundedIdentifier(input?.environment);
  const service = requireBoundedIdentifier(input?.service);
  const deploymentId = requireBoundedIdentifier(input?.deploymentId);
  const runRailway = dependencies.runRailway ?? runRailwayCommand;
  const sleep = dependencies.sleep ?? defaultSleep;
  const now = dependencies.now ?? Date.now;

  const statusDeadline = now() + STATUS_TIMEOUT_MS;
  while (true) {
    const { stdout } = await runRailway([
      'deployment', 'list', '--json',
      '--project', project,
      '--environment', environment,
      '--service', service,
      '--limit', '1000',
    ]);
    const entries = parseDeploymentList(stdout);
    const target = entries.find((entry) => entry !== null && typeof entry === 'object' && !Array.isArray(entry) && entry.id === deploymentId);
    if (target !== undefined) {
      if (typeof target.status !== 'string') throw verifierError('RAILWAY_DEPLOYMENT_VERIFY_STATUS_INVALID');
      if (target.status === 'SUCCESS') break;
      if (FAIL_TERMINAL.has(target.status)) throw verifierError('RAILWAY_DEPLOYMENT_VERIFY_TERMINAL_FAILURE');
      if (!NON_TERMINAL.has(target.status)) throw verifierError('RAILWAY_DEPLOYMENT_VERIFY_STATUS_INVALID');
    }
    if (now() >= statusDeadline) throw verifierError('RAILWAY_DEPLOYMENT_VERIFY_TIMEOUT');
    await sleep(STATUS_POLL_INTERVAL_MS);
  }

  if (mode === 'status-and-disabled-marker') {
    const markerDeadline = now() + MARKER_TIMEOUT_MS;
    while (true) {
      const { stdout } = await runRailway([
        'logs', deploymentId,
        '--deployment', '--json', '--lines', '200',
        '--project', project,
        '--environment', environment,
        '--service', service,
      ]);
      if (markerPresent(stdout)) break;
      if (now() >= markerDeadline) throw verifierError('AI_AUTOMATION_DISABLED_MARKER_NOT_FOUND');
      await sleep(MARKER_POLL_INTERVAL_MS);
    }
  }

  return {
    deploymentLine: `railway-deployment: SUCCESS service=${service} deployment_id=${deploymentId}`,
    markerLine: mode === 'status-and-disabled-marker'
      ? `AI_AUTOMATION_DISABLED_DEPLOYMENT_VERIFIED deployment_id=${deploymentId}`
      : null,
  };
}

async function main() {
  try {
    const input = parseCli(process.argv.slice(2));
    const result = await verifyRailwayDeployment(input);
    process.stdout.write(`${result.deploymentLine}\n`);
    if (result.markerLine !== null) process.stdout.write(`${result.markerLine}\n`);
  } catch (error) {
    const code = error && typeof error === 'object' && typeof error.code === 'string'
      ? error.code
      : 'RAILWAY_DEPLOYMENT_VERIFY_FAILED';
    if (code === 'AI_AUTOMATION_DISABLED_MARKER_NOT_FOUND') {
      process.stderr.write('AI_AUTOMATION_DISABLED_MARKER_NOT_FOUND\n');
    } else {
      process.stderr.write('RAILWAY_DEPLOYMENT_VERIFY_FAILED\n');
    }
    process.exitCode = 1;
  }
}

const isDirectExecution = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectExecution) void main();
