import { pathToFileURL } from 'node:url';

import { Pool } from 'pg';

import {
  materializeAiCandidateProposal,
} from './modules/ai-discovery/materialize-ai-candidate-proposal.js';
import type {
  MaterializeAiCandidateProposalCommand,
  MaterializeAiCandidateProposalResult,
} from './modules/ai-discovery/types.js';

const MAX_STDIN_BYTES = 256 * 1024;
const COMMAND_KEYS = [
  'actorId',
  'correlationId',
  'idempotencyKey',
  'aiCandidateMaterializationId',
  'aiCandidateProposalId',
  'reason',
  'materializedAt',
] as const;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface AiDiscoveryMaterializeCliConfig {
  databaseUrl: string;
}

export type AiDiscoveryMaterializeCliInput = MaterializeAiCandidateProposalCommand;

export interface AiDiscoveryMaterializeCliResult {
  exitCode: 0 | 1;
  stdout: string;
  stderr: string;
}

export interface AiDiscoveryMaterializeCliDependencies {
  createPool: (databaseUrl: string) => Pool;
  materializeProposal: (
    pool: Pool,
    command: MaterializeAiCandidateProposalCommand,
  ) => Promise<MaterializeAiCandidateProposalResult>;
}

function configError(): never {
  throw new Error('AI_DISCOVERY_MATERIALIZE_CONFIG_INVALID');
}

function inputError(): never {
  throw new Error('AI_DISCOVERY_MATERIALIZE_INPUT_INVALID');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(record: Record<string, unknown>): boolean {
  const actual = Object.keys(record).sort();
  const expected = [...COMMAND_KEYS].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function text(value: unknown, maxBytes: number): string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value !== value.trim()
    || Buffer.byteLength(value, 'utf8') > maxBytes
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

export function parseAiDiscoveryMaterializeCliConfig(
  env: NodeJS.ProcessEnv,
): AiDiscoveryMaterializeCliConfig {
  const value = env.DATABASE_URL;
  if (!value || value !== value.trim()) return configError();
  return { databaseUrl: value };
}

export function parseAiDiscoveryMaterializeCliInput(
  stdinText: string,
): AiDiscoveryMaterializeCliInput {
  if (Buffer.byteLength(stdinText, 'utf8') > MAX_STDIN_BYTES) return inputError();
  let raw: unknown;
  try {
    raw = JSON.parse(stdinText);
  } catch {
    return inputError();
  }
  if (!isRecord(raw) || !exactKeys(raw)) return inputError();
  const materializedAt = text(raw.materializedAt, 64);
  if (Number.isNaN(Date.parse(materializedAt))) return inputError();

  return {
    actorId: text(raw.actorId, 256),
    correlationId: text(raw.correlationId, 256),
    idempotencyKey: text(raw.idempotencyKey, 256),
    aiCandidateMaterializationId: uuid(raw.aiCandidateMaterializationId),
    aiCandidateProposalId: uuid(raw.aiCandidateProposalId),
    reason: text(raw.reason, 2_000),
    materializedAt,
  };
}

const DEFAULT_DEPENDENCIES: AiDiscoveryMaterializeCliDependencies = {
  createPool: (databaseUrl) => new Pool({ connectionString: databaseUrl }),
  materializeProposal: (pool, command) => materializeAiCandidateProposal(pool, command),
};

export async function runAiDiscoveryMaterializeCli(
  stdinText: string,
  env: NodeJS.ProcessEnv = process.env,
  dependencies: AiDiscoveryMaterializeCliDependencies = DEFAULT_DEPENDENCIES,
): Promise<AiDiscoveryMaterializeCliResult> {
  let pool: Pool | null = null;
  try {
    const config = parseAiDiscoveryMaterializeCliConfig(env);
    const input = parseAiDiscoveryMaterializeCliInput(stdinText);
    pool = dependencies.createPool(config.databaseUrl);
    const result = await dependencies.materializeProposal(pool, input);
    return {
      exitCode: 0,
      stdout: `${JSON.stringify({
        materializationId: result.aiCandidateMaterializationId,
        proposalId: result.aiCandidateProposalId,
        candidateId: result.candidateId,
        candidateRevisionId: result.candidateRevisionId,
        replay: result.replayed,
      })}\n`,
      stderr: '',
    };
  } catch {
    return {
      exitCode: 1,
      stdout: '',
      stderr: 'AI_DISCOVERY_MATERIALIZE_FAILED\n',
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
    process.stderr.write('AI_DISCOVERY_MATERIALIZE_FAILED\n');
    process.exitCode = 1;
    return;
  }
  try {
    const result = await runAiDiscoveryMaterializeCli(await readStdinWithLimit());
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    process.exitCode = result.exitCode;
  } catch {
    process.stderr.write('AI_DISCOVERY_MATERIALIZE_FAILED\n');
    process.exitCode = 1;
  }
}

const isDirectExecution = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectExecution) void main();
