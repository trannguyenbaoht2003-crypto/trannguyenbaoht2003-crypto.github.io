import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

import { Pool } from 'pg';

import {
  completeHumanReview,
  type CompleteHumanReviewOptions,
} from './modules/trust/complete-human-review.js';
import {
  resolveHumanReviewContext,
  type HumanReviewContext,
} from './modules/trust/resolve-human-review-context.js';
import type {
  CompleteHumanReviewCommand,
  CompleteHumanReviewResult,
  HumanReviewOutcome,
} from './modules/trust/types.js';
import { hashCanonicalJson } from './shared/hash.js';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const PRINTABLE_IDENTIFIER = /^[!-~]+$/u;
const OUTCOMES = new Set<HumanReviewOutcome>([
  'confirmed',
  'changes_requested',
  'declined',
]);

const REQUIRED_FLAGS = [
  '--candidate-revision-id',
  '--actor-id',
  '--outcome',
  '--reason',
  '--idempotency-key',
] as const;

const OPTIONAL_FLAGS = ['--correlation-id'] as const;
const ALL_FLAGS = new Set<string>([...REQUIRED_FLAGS, ...OPTIONAL_FLAGS]);

export interface HumanReviewCliInput {
  candidateRevisionId: string;
  actorId: string;
  outcome: HumanReviewOutcome;
  reason: string;
  idempotencyKey: string;
  correlationId: string | undefined;
}

export interface HumanReviewCliConfig {
  databaseUrl: string;
}

export interface HumanReviewCliResult {
  exitCode: 0 | 2 | 3 | 4 | 5;
  stdout: string;
  stderr: string;
}

export interface HumanReviewCliDependencies {
  createPool: (databaseUrl: string) => Pool;
  resolveContext: (
    pool: Pool,
    candidateRevisionId: string,
  ) => Promise<HumanReviewContext>;
  completeReview: (
    pool: Pool,
    command: CompleteHumanReviewCommand,
    options: CompleteHumanReviewOptions,
  ) => Promise<CompleteHumanReviewResult>;
}

function inputError(): never {
  throw new Error('HUMAN_REVIEW_CLI_INPUT_INVALID');
}

function configError(): never {
  throw new Error('HUMAN_REVIEW_CLI_CONFIG_INVALID');
}

function requireUuid(value: string): string {
  if (!UUID_PATTERN.test(value)) return inputError();
  return value.toLowerCase();
}

function requireIdentifier(value: string, maxBytes: number): string {
  if (
    value.length === 0
    || Buffer.byteLength(value, 'utf8') > maxBytes
    || !PRINTABLE_IDENTIFIER.test(value)
  ) {
    return inputError();
  }
  return value;
}

function requireReason(value: string): string {
  if (
    value.length === 0
    || value.trim().length === 0
    || Buffer.byteLength(value, 'utf8') > 1024
  ) {
    return inputError();
  }
  return value;
}

function deterministicUuid(seed: string): string {
  const bytes = Buffer.from(createHash('sha256').update(seed).digest().subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
}

function cliIdempotencyPayloadHash(
  input: HumanReviewCliInput,
  candidateId: string,
  correlationId: string,
): string {
  return hashCanonicalJson({
    schemaVersion: 1,
    candidateId,
    candidateRevisionId: input.candidateRevisionId,
    actorId: input.actorId,
    outcome: input.outcome,
    reason: input.reason,
    correlationId,
  });
}

function readFlagValue(
  args: readonly string[],
  index: number,
  seen: Set<string>,
): [string, number] {
  const flag = args[index];
  if (flag === undefined || !ALL_FLAGS.has(flag) || seen.has(flag)) {
    return inputError();
  }
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) return inputError();
  seen.add(flag);
  return [value, index + 2];
}

export function parseHumanReviewCliArgs(
  args: readonly string[],
): HumanReviewCliInput {
  const values = new Map<string, string>();
  const seen = new Set<string>();
  let index = 0;
  while (index < args.length) {
    const [value, nextIndex] = readFlagValue(args, index, seen);
    values.set(args[index]!, value);
    index = nextIndex;
  }

  for (const flag of REQUIRED_FLAGS) {
    if (!seen.has(flag)) return inputError();
  }

  const outcome = values.get('--outcome');
  if (outcome === undefined || !OUTCOMES.has(outcome as HumanReviewOutcome)) {
    return inputError();
  }

  return {
    candidateRevisionId: requireUuid(values.get('--candidate-revision-id')!),
    actorId: requireIdentifier(values.get('--actor-id')!, 256),
    outcome: outcome as HumanReviewOutcome,
    reason: requireReason(values.get('--reason')!),
    idempotencyKey: requireIdentifier(values.get('--idempotency-key')!, 256),
    correlationId: seen.has('--correlation-id')
      ? requireIdentifier(values.get('--correlation-id')!, 256)
      : undefined,
  };
}

export function parseHumanReviewCliConfig(
  env: NodeJS.ProcessEnv,
): HumanReviewCliConfig {
  const databaseUrl = env.DATABASE_URL;
  if (
    databaseUrl === undefined
    || databaseUrl.length === 0
    || databaseUrl.trim() !== databaseUrl
  ) {
    return configError();
  }
  return { databaseUrl };
}

const DEFAULT_DEPENDENCIES: HumanReviewCliDependencies = {
  createPool: (databaseUrl) => new Pool({ connectionString: databaseUrl }),
  resolveContext: (pool, candidateRevisionId) => (
    resolveHumanReviewContext(pool, candidateRevisionId)
  ),
  completeReview: (pool, command, options) => (
    completeHumanReview(pool, command, options)
  ),
};

function errorCode(error: unknown): string {
  return error instanceof Error ? error.message : '';
}

function mapExitCode(error: unknown): 2 | 3 | 4 | 5 {
  const code = errorCode(error);
  if (
    code === 'HUMAN_REVIEW_CLI_INPUT_INVALID'
    || code === 'HUMAN_REVIEW_CLI_CONFIG_INVALID'
    || code === 'IDEMPOTENCY_PAYLOAD_CONFLICT'
  ) return 2;
  if (code === 'REVIEW_ALREADY_COMPLETED') return 4;
  if (
    code === 'REVIEW_INPUT_STALE'
    || code === 'CLAIM_SET_NOT_SEALED'
    || code.startsWith('TRUST_')
  ) return 3;
  return 5;
}

function sanitizedErrorMessage(exitCode: 2 | 3 | 4 | 5): string {
  switch (exitCode) {
    case 2:
      return 'HUMAN_REVIEW_CLI_INPUT_INVALID';
    case 3:
      return 'HUMAN_REVIEW_CLI_REVIEW_STALE';
    case 4:
      return 'HUMAN_REVIEW_CLI_REVIEW_ALREADY_COMPLETED';
    default:
      return 'HUMAN_REVIEW_CLI_UNAVAILABLE';
  }
}

export async function runHumanReviewCli(
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  dependencies: HumanReviewCliDependencies = DEFAULT_DEPENDENCIES,
): Promise<HumanReviewCliResult> {
  let pool: Pool | null = null;
  try {
    const config = parseHumanReviewCliConfig(env);
    const input = parseHumanReviewCliArgs(args);
    pool = dependencies.createPool(config.databaseUrl);
    const context = await dependencies.resolveContext(
      pool,
      input.candidateRevisionId,
    );
    const correlationId = input.correlationId
      ?? deterministicUuid(`human-review-cli:correlation:${input.idempotencyKey}`);
    const command: CompleteHumanReviewCommand = {
      actorId: input.actorId,
      candidateId: context.candidateId,
      candidateRevisionId: input.candidateRevisionId,
      completedAt: new Date().toISOString(),
      correlationId,
      humanReviewId: deterministicUuid(
        `human-review-cli:review:${input.candidateRevisionId}:${input.idempotencyKey}`,
      ),
      idempotencyKey: input.idempotencyKey,
      outcome: input.outcome,
      permissionUsed: 'reviewer',
      reason: input.reason,
      reviewInputSnapshotId: deterministicUuid(
        `human-review-cli:snapshot:${input.candidateRevisionId}:${input.idempotencyKey}`,
      ),
      reviewPolicyRevisionId: context.reviewPolicyRevisionId,
      reviewQuorumEvaluationId: deterministicUuid(
        `human-review-cli:quorum:${input.candidateRevisionId}:${input.idempotencyKey}`,
      ),
    };
    const result = await dependencies.completeReview(
      pool,
      command,
      {
        requireActiveReviewPolicy: true,
        idempotencyScope: 'human_review_cli_completion',
        idempotencyPayloadHash: cliIdempotencyPayloadHash(
          input,
          context.candidateId,
          correlationId,
        ),
      },
    );
    return {
      exitCode: 0,
      stdout: `${JSON.stringify({
        candidateRevisionId: result.candidateRevisionId,
        humanReviewId: result.humanReviewId,
        outcome: input.outcome,
        confirmedReviewerCount: result.confirmedReviewerCount,
        requiredConfirmedReviews: result.requiredConfirmedReviews,
        quorumSatisfied: result.quorumSatisfied,
        replayed: result.replayed,
      })}\n`,
      stderr: '',
    };
  } catch (error) {
    const exitCode = mapExitCode(error);
    return {
      exitCode,
      stdout: '',
      stderr: `${sanitizedErrorMessage(exitCode)}\n`,
    };
  } finally {
    if (pool) {
      try {
        await pool.end();
      } catch {
        // Cleanup failures never expose database details.
      }
    }
  }
}

async function main(): Promise<void> {
  const result = await runHumanReviewCli(process.argv.slice(2));
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}

const isDirectExecution = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectExecution) {
  void main().catch(() => {
    process.stderr.write('HUMAN_REVIEW_CLI_UNAVAILABLE\n');
    process.exitCode = 5;
  });
}
