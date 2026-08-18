import { pathToFileURL } from 'node:url';

import { Pool } from 'pg';

import {
  parseAiDiscoveryRunCliConfig,
  parseAiDiscoveryRunCliInput,
  type AiDiscoveryRunCliConfig,
  type AiDiscoveryRunCliInput,
} from './ai-discovery-run-cli.js';
import {
  executePolicyGovernedAiDiscoveryRun,
  type ExecutePolicyGovernedAiDiscoveryRunCommand,
  type ExecutePolicyGovernedAiDiscoveryRunResult,
} from './modules/ai-operations/execute-policy-governed-ai-discovery-run.js';
import {
  createOpenAiResponsesProvider,
  type AiDiscoveryProvider,
  type OpenAiResponsesProviderConfig,
} from './modules/ai-provider/openai-responses-provider.js';

const MAX_STDIN_BYTES = 256 * 1024;

export type AiOperationsTickCliConfig = AiDiscoveryRunCliConfig;
export type AiOperationsTickCliInput = AiDiscoveryRunCliInput;

export interface AiOperationsTickCliResult {
  exitCode: 0 | 1;
  stdout: string;
  stderr: string;
}

export interface AiOperationsTickCliDependencies {
  createPool: (databaseUrl: string) => Pool;
  createProvider: (config: OpenAiResponsesProviderConfig) => AiDiscoveryProvider;
  executeRun: (
    pool: Pool,
    command: ExecutePolicyGovernedAiDiscoveryRunCommand,
  ) => Promise<ExecutePolicyGovernedAiDiscoveryRunResult>;
}

function configError(): never {
  throw new Error('AI_OPERATIONS_TICK_CONFIG_INVALID');
}

function inputError(): never {
  throw new Error('AI_OPERATIONS_TICK_INPUT_INVALID');
}

export function parseAiOperationsTickCliConfig(
  env: NodeJS.ProcessEnv,
): AiOperationsTickCliConfig {
  try {
    return parseAiDiscoveryRunCliConfig(env);
  } catch {
    return configError();
  }
}

export function parseAiOperationsTickCliInput(
  stdinText: string,
): AiOperationsTickCliInput {
  if (Buffer.byteLength(stdinText, 'utf8') > MAX_STDIN_BYTES) return inputError();
  try {
    return parseAiDiscoveryRunCliInput(stdinText);
  } catch {
    return inputError();
  }
}

const DEFAULT_DEPENDENCIES: AiOperationsTickCliDependencies = {
  createPool: (databaseUrl) => new Pool({ connectionString: databaseUrl }),
  createProvider: (config) => createOpenAiResponsesProvider(config),
  executeRun: (pool, command) => executePolicyGovernedAiDiscoveryRun(pool, command),
};

export async function runAiOperationsTickCli(
  stdinText: string,
  env: NodeJS.ProcessEnv = process.env,
  dependencies: AiOperationsTickCliDependencies = DEFAULT_DEPENDENCIES,
): Promise<AiOperationsTickCliResult> {
  let pool: Pool | null = null;
  try {
    const config = parseAiOperationsTickCliConfig(env);
    const input = parseAiOperationsTickCliInput(stdinText);
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
        budgetReservationId: result.aiOperationsRunBudgetReservationId,
        budgetReplay: result.budgetReplayed,
        policyRevisionId: result.aiOperationsPolicyRevisionId,
      })}\n`,
      stderr: '',
    };
  } catch {
    return {
      exitCode: 1,
      stdout: '',
      stderr: 'AI_OPERATIONS_TICK_FAILED\n',
    };
  } finally {
    if (pool) {
      try {
        await pool.end();
      } catch {
        // Cleanup details remain private.
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
    process.stderr.write('AI_OPERATIONS_TICK_FAILED\n');
    process.exitCode = 1;
    return;
  }
  try {
    const result = await runAiOperationsTickCli(await readStdinWithLimit());
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    process.exitCode = result.exitCode;
  } catch {
    process.stderr.write('AI_OPERATIONS_TICK_FAILED\n');
    process.exitCode = 1;
  }
}

const isDirectExecution = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectExecution) void main();
