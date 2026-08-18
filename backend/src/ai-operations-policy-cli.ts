import { pathToFileURL } from 'node:url';

import { Pool } from 'pg';

import {
  activateAiOperationsPolicyRevision,
} from './modules/ai-operations/activate-ai-operations-policy-revision.js';
import {
  registerAiOperationsPolicyRevision,
} from './modules/ai-operations/register-ai-operations-policy-revision.js';
import type {
  ActivateAiOperationsPolicyRevisionCommand,
  ActivateAiOperationsPolicyRevisionResult,
  RegisterAiOperationsPolicyRevisionCommand,
  RegisterAiOperationsPolicyRevisionResult,
} from './modules/ai-operations/types.js';

const MAX_STDIN_BYTES = 256 * 1024;
const REGISTER_KEYS = [
  'action',
  'actorId',
  'correlationId',
  'idempotencyKey',
  'aiOperationsPolicyRevisionId',
  'revision',
  'enabled',
  'maxRunsPerUtcDay',
  'minIntervalSeconds',
  'maxProposalsPerRun',
  'reason',
] as const;
const ACTIVATE_KEYS = [
  'action',
  'actorId',
  'correlationId',
  'idempotencyKey',
  'aiOperationsPolicyRevisionId',
  'expectedCurrentAiOperationsPolicyRevisionId',
  'reason',
] as const;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface AiOperationsPolicyCliConfig {
  databaseUrl: string;
}

export type AiOperationsPolicyCliInput =
  | ({ action: 'register' } & RegisterAiOperationsPolicyRevisionCommand)
  | ({ action: 'activate' } & ActivateAiOperationsPolicyRevisionCommand);

export interface AiOperationsPolicyCliResult {
  exitCode: 0 | 1;
  stdout: string;
  stderr: string;
}

export interface AiOperationsPolicyCliDependencies {
  createPool: (databaseUrl: string) => Pool;
  registerPolicy: (
    pool: Pool,
    command: RegisterAiOperationsPolicyRevisionCommand,
  ) => Promise<RegisterAiOperationsPolicyRevisionResult>;
  activatePolicy: (
    pool: Pool,
    command: ActivateAiOperationsPolicyRevisionCommand,
  ) => Promise<ActivateAiOperationsPolicyRevisionResult>;
}

function configError(): never {
  throw new Error('AI_OPERATIONS_POLICY_CONFIG_INVALID');
}

function inputError(): never {
  throw new Error('AI_OPERATIONS_POLICY_INPUT_INVALID');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(record).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function text(value: unknown, max = 1024): string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value !== value.trim()
    || Buffer.byteLength(value, 'utf8') > max
  ) {
    return inputError();
  }
  return value;
}

function uuid(value: unknown): string {
  const result = text(value, 64);
  if (!UUID_PATTERN.test(result)) return inputError();
  return result.toLowerCase();
}

function integer(value: unknown, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    return inputError();
  }
  return value as number;
}

export function parseAiOperationsPolicyCliConfig(
  env: NodeJS.ProcessEnv,
): AiOperationsPolicyCliConfig {
  const value = env.DATABASE_URL;
  if (!value || value !== value.trim()) return configError();
  return { databaseUrl: value };
}

export function parseAiOperationsPolicyCliInput(
  stdinText: string,
): AiOperationsPolicyCliInput {
  if (Buffer.byteLength(stdinText, 'utf8') > MAX_STDIN_BYTES) return inputError();
  let raw: unknown;
  try {
    raw = JSON.parse(stdinText);
  } catch {
    return inputError();
  }
  if (!isRecord(raw) || (raw.action !== 'register' && raw.action !== 'activate')) {
    return inputError();
  }

  if (raw.action === 'register') {
    if (!exactKeys(raw, REGISTER_KEYS)) return inputError();
    if (typeof raw.enabled !== 'boolean') return inputError();
    const maxRunsPerUtcDay = integer(raw.maxRunsPerUtcDay, 0, 64);
    if (raw.enabled && maxRunsPerUtcDay === 0) return inputError();
    return {
      action: 'register',
      actorId: text(raw.actorId, 256),
      correlationId: text(raw.correlationId, 256),
      idempotencyKey: text(raw.idempotencyKey, 256),
      aiOperationsPolicyRevisionId: uuid(raw.aiOperationsPolicyRevisionId),
      revision: integer(raw.revision, 1, Number.MAX_SAFE_INTEGER),
      enabled: raw.enabled,
      maxRunsPerUtcDay,
      minIntervalSeconds: integer(raw.minIntervalSeconds, 0, 86_400),
      maxProposalsPerRun: integer(raw.maxProposalsPerRun, 1, 64),
      reason: text(raw.reason, 1024),
    };
  }

  if (!exactKeys(raw, ACTIVATE_KEYS)) return inputError();
  return {
    action: 'activate',
    actorId: text(raw.actorId, 256),
    correlationId: text(raw.correlationId, 256),
    idempotencyKey: text(raw.idempotencyKey, 256),
    aiOperationsPolicyRevisionId: uuid(raw.aiOperationsPolicyRevisionId),
    expectedCurrentAiOperationsPolicyRevisionId:
      raw.expectedCurrentAiOperationsPolicyRevisionId === null
        ? null
        : uuid(raw.expectedCurrentAiOperationsPolicyRevisionId),
    reason: text(raw.reason, 1024),
  };
}

const DEFAULT_DEPENDENCIES: AiOperationsPolicyCliDependencies = {
  createPool: (databaseUrl) => new Pool({ connectionString: databaseUrl }),
  registerPolicy: (pool, command) => registerAiOperationsPolicyRevision(pool, command),
  activatePolicy: (pool, command) => activateAiOperationsPolicyRevision(pool, command),
};

export async function runAiOperationsPolicyCli(
  stdinText: string,
  env: NodeJS.ProcessEnv = process.env,
  dependencies: AiOperationsPolicyCliDependencies = DEFAULT_DEPENDENCIES,
): Promise<AiOperationsPolicyCliResult> {
  let pool: Pool | null = null;
  try {
    const config = parseAiOperationsPolicyCliConfig(env);
    const input = parseAiOperationsPolicyCliInput(stdinText);
    pool = dependencies.createPool(config.databaseUrl);

    if (input.action === 'register') {
      const { action: _action, ...command } = input;
      const result = await dependencies.registerPolicy(pool, command);
      return {
        exitCode: 0,
        stdout: `${JSON.stringify({
          action: 'register',
          policyRevisionId: result.aiOperationsPolicyRevisionId,
          revision: result.revision,
          replay: result.replayed,
        })}\n`,
        stderr: '',
      };
    }

    const { action: _action, ...command } = input;
    const result = await dependencies.activatePolicy(pool, command);
    return {
      exitCode: 0,
      stdout: `${JSON.stringify({
        action: 'activate',
        policyRevisionId: result.currentAiOperationsPolicyRevisionId,
        previousPolicyRevisionId: result.previousAiOperationsPolicyRevisionId,
        replay: result.replayed,
      })}\n`,
      stderr: '',
    };
  } catch {
    return {
      exitCode: 1,
      stdout: '',
      stderr: 'AI_OPERATIONS_POLICY_FAILED\n',
    };
  } finally {
    if (pool) {
      try {
        await pool.end();
      } catch {
        // Resource cleanup details are intentionally not exposed.
      }
    }
  }
}

async function readStdinWithLimit(): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.byteLength;
    if (size > MAX_STDIN_BYTES) return inputError();
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function main(): Promise<void> {
  if (process.argv.length > 2) {
    process.stderr.write('AI_OPERATIONS_POLICY_FAILED\n');
    process.exitCode = 1;
    return;
  }
  try {
    const result = await runAiOperationsPolicyCli(await readStdinWithLimit());
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    process.exitCode = result.exitCode;
  } catch {
    process.stderr.write('AI_OPERATIONS_POLICY_FAILED\n');
    process.exitCode = 1;
  }
}

const isDirectExecution = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectExecution) void main();
