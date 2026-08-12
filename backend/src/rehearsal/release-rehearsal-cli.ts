import { pathToFileURL } from 'node:url';

import { createPool } from '../database/pool.js';
import {
  assertReleaseRehearsalEnabled,
  seedReleaseRehearsalV1,
  verifyReleaseRehearsal,
} from './release-rehearsal-data.js';
import {
  publishReleaseRehearsalV2,
  rollbackReleaseRehearsalToV1,
} from './release-rehearsal-versioning.js';

export type ReleaseRehearsalOperation =
  | 'seed-v1'
  | 'publish-v2'
  | 'rollback-v1'
  | 'verify';

export interface ReleaseRehearsalCliOptions {
  argv?: readonly string[];
  env?: NodeJS.ProcessEnv;
  writeLine?: (line: string) => void;
}

function requireDatabaseUrl(env: NodeJS.ProcessEnv): string {
  const value = env.DATABASE_URL?.trim();
  if (!value) {
    throw new Error('DATABASE_URL_REQUIRED');
  }
  return value;
}

function requireOperation(argv: readonly string[]): ReleaseRehearsalOperation {
  const operation = argv[0];
  if (
    operation !== 'seed-v1'
    && operation !== 'publish-v2'
    && operation !== 'rollback-v1'
    && operation !== 'verify'
  ) {
    throw new Error('RELEASE_REHEARSAL_OPERATION_INVALID');
  }
  return operation;
}

export async function runReleaseRehearsalCli(
  options: ReleaseRehearsalCliOptions = {},
): Promise<void> {
  const env = options.env ?? process.env;
  const argv = options.argv ?? process.argv.slice(2);
  const writeLine = options.writeLine ?? console.log;

  assertReleaseRehearsalEnabled(env);
  const operation = requireOperation(argv);
  const pool = createPool(requireDatabaseUrl(env));

  try {
    const state = operation === 'seed-v1'
      ? await seedReleaseRehearsalV1(pool)
      : operation === 'publish-v2'
        ? await publishReleaseRehearsalV2(pool)
        : operation === 'rollback-v1'
          ? await rollbackReleaseRehearsalToV1(pool)
          : await verifyReleaseRehearsal(pool);

    writeLine(JSON.stringify(state));
  } finally {
    await pool.end();
  }
}

const invokedPath = process.argv[1];
const isDirectInvocation = invokedPath !== undefined
  && import.meta.url === pathToFileURL(invokedPath).href;

if (isDirectInvocation) {
  runReleaseRehearsalCli().catch((error: unknown) => {
    const message = error instanceof Error
      ? error.message
      : 'RELEASE_REHEARSAL_FAILED';
    console.error(message);
    process.exitCode = 1;
  });
}
