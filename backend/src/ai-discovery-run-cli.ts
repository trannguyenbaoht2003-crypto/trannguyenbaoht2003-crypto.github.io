import { pathToFileURL } from 'node:url';

import { Pool } from 'pg';

import type { RecordAiDiscoveryRunResult } from './modules/ai-discovery/types.js';
import {
  executeAiDiscoveryProviderRun,
  type ExecuteAiDiscoveryProviderRunCommand,
} from './modules/ai-provider/execute-ai-discovery-provider-run.js';
import { normalizeAiProviderExecutionInput } from './modules/ai-provider/normalize-provider-execution-input.js';
import {
  createOpenAiResponsesProvider,
  type AiDiscoveryProvider,
  type OpenAiResponsesProviderConfig,
} from './modules/ai-provider/openai-responses-provider.js';
import type { NormalizedAiProviderExecutionInput } from './modules/ai-provider/types.js';

const MAX_STDIN_BYTES = 256 * 1024;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_METADATA_LENGTH = 256;
const PRINTABLE_METADATA_PATTERN = /^[!-~]+$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const CLI_KEYS = [
  'actorId',
  'aiDiscoveryRunId',
  'correlationId',
  'idempotencyKey',
  'input',
  'startedAt',
] as const;

export interface AiDiscoveryRunCliConfig {
  databaseUrl: string;
  provider: 'openai';
  apiKey: string;
  model: string;
  timeoutMs: number;
  endpoint?: string;
}

export interface AiDiscoveryRunCliInput {
  actorId: string;
  correlationId: string;
  idempotencyKey: string;
  aiDiscoveryRunId: string;
  startedAt: string;
  input: NormalizedAiProviderExecutionInput;
}

export interface AiDiscoveryRunCliResult {
  exitCode: 0 | 1;
  stdout: string;
  stderr: string;
}

export interface AiDiscoveryRunCliDependencies {
  createPool: (databaseUrl: string) => Pool;
  createProvider: (config: OpenAiResponsesProviderConfig) => AiDiscoveryProvider;
  executeRun: (
    pool: Pool,
    command: ExecuteAiDiscoveryProviderRunCommand,
  ) => Promise<RecordAiDiscoveryRunResult>;
}

function configError(): never {
  throw new Error('AI_PROVIDER_CONFIG_INVALID');
}

function inputError(): never {
  throw new Error('AI_PROVIDER_INPUT_INVALID');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(record).sort();
  const required = [...expected].sort();
  return keys.length === required.length && keys.every((key, index) => key === required[index]);
}

function requireEnvString(value: string | undefined): string {
  if (!value || value !== value.trim()) return configError();
  return value;
}

function requireMetadata(value: unknown): string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > MAX_METADATA_LENGTH
    || value !== value.trim()
    || !PRINTABLE_METADATA_PATTERN.test(value)
  ) {
    return inputError();
  }
  return value;
}

export function parseAiDiscoveryRunCliConfig(env: NodeJS.ProcessEnv): AiDiscoveryRunCliConfig {
  const databaseUrl = requireEnvString(env.DATABASE_URL);
  const provider = requireEnvString(env.AI_DISCOVERY_PROVIDER);
  if (provider !== 'openai') return configError();
  const apiKey = requireEnvString(env.OPENAI_API_KEY);
  const model = requireEnvString(env.AI_DISCOVERY_OPENAI_MODEL);
  if (model.length > 128) return configError();

  const timeoutRaw = env.AI_DISCOVERY_TIMEOUT_MS;
  const timeoutMs = timeoutRaw === undefined ? DEFAULT_TIMEOUT_MS : Number(timeoutRaw);
  if (
    !Number.isSafeInteger(timeoutMs)
    || timeoutMs < MIN_TIMEOUT_MS
    || timeoutMs > MAX_TIMEOUT_MS
  ) {
    return configError();
  }

  const endpointRaw = env.AI_DISCOVERY_OPENAI_ENDPOINT;
  if (endpointRaw !== undefined) {
    const endpoint = requireEnvString(endpointRaw);
    if (env.NODE_ENV === 'production') return configError();
    let parsed: URL;
    try {
      parsed = new URL(endpoint);
    } catch {
      return configError();
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return configError();
    return { databaseUrl, provider: 'openai', apiKey, model, timeoutMs, endpoint };
  }

  return { databaseUrl, provider: 'openai', apiKey, model, timeoutMs };
}

export function parseAiDiscoveryRunCliInput(stdinText: string): AiDiscoveryRunCliInput {
  if (Buffer.byteLength(stdinText, 'utf8') > MAX_STDIN_BYTES) return inputError();

  let raw: unknown;
  try {
    raw = JSON.parse(stdinText);
  } catch {
    return inputError();
  }
  if (!isRecord(raw) || !hasExactKeys(raw, CLI_KEYS)) return inputError();

  const aiDiscoveryRunId = requireMetadata(raw.aiDiscoveryRunId);
  if (!UUID_PATTERN.test(aiDiscoveryRunId)) return inputError();
  if (typeof raw.startedAt !== 'string' || Number.isNaN(Date.parse(raw.startedAt))) return inputError();

  return {
    actorId: requireMetadata(raw.actorId),
    correlationId: requireMetadata(raw.correlationId),
    idempotencyKey: requireMetadata(raw.idempotencyKey),
    aiDiscoveryRunId,
    startedAt: raw.startedAt,
    input: normalizeAiProviderExecutionInput(raw.input),
  };
}

const DEFAULT_DEPENDENCIES: AiDiscoveryRunCliDependencies = {
  createPool: (databaseUrl) => new Pool({ connectionString: databaseUrl }),
  createProvider: (config) => createOpenAiResponsesProvider(config),
  executeRun: (pool, command) => executeAiDiscoveryProviderRun(pool, command),
};

export async function runAiDiscoveryRunCli(
  stdinText: string,
  env: NodeJS.ProcessEnv = process.env,
  dependencies: AiDiscoveryRunCliDependencies = DEFAULT_DEPENDENCIES,
): Promise<AiDiscoveryRunCliResult> {
  let pool: Pool | null = null;
  try {
    const config = parseAiDiscoveryRunCliConfig(env);
    const input = parseAiDiscoveryRunCliInput(stdinText);
    const providerConfig: OpenAiResponsesProviderConfig = config.endpoint === undefined
      ? {
          apiKey: config.apiKey,
          model: config.model,
          timeoutMs: config.timeoutMs,
        }
      : {
          apiKey: config.apiKey,
          model: config.model,
          timeoutMs: config.timeoutMs,
          endpoint: config.endpoint,
        };
    const provider = dependencies.createProvider(providerConfig);
    pool = dependencies.createPool(config.databaseUrl);

    const result = await dependencies.executeRun(pool, {
      actorId: input.actorId,
      correlationId: input.correlationId,
      idempotencyKey: input.idempotencyKey,
      aiDiscoveryRunId: input.aiDiscoveryRunId,
      provider,
      modelKey: config.model,
      modelRevision: config.model,
      input: input.input,
      startedAt: input.startedAt,
    });

    return {
      exitCode: 0,
      stdout: `${JSON.stringify({
        runId: result.aiDiscoveryRunId,
        status: result.status,
        proposalCount: result.proposalCount,
        replay: result.replayed,
      })}\n`,
      stderr: '',
    };
  } catch {
    return {
      exitCode: 1,
      stdout: '',
      stderr: 'AI_DISCOVERY_RUN_FAILED\n',
    };
  } finally {
    if (pool) {
      try {
        await pool.end();
      } catch {
        // Resource cleanup failure is intentionally not surfaced with raw details.
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
    process.stderr.write('AI_DISCOVERY_RUN_FAILED\n');
    process.exitCode = 1;
    return;
  }
  try {
    const stdinText = await readStdinWithLimit();
    const result = await runAiDiscoveryRunCli(stdinText);
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    process.exitCode = result.exitCode;
  } catch {
    process.stderr.write('AI_DISCOVERY_RUN_FAILED\n');
    process.exitCode = 1;
  }
}

const isDirectExecution = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectExecution) {
  void main();
}
