import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const composeArgs = [
  'compose',
  '--env-file', 'deploy/staging/.env.example',
  '-f', 'deploy/staging/compose.yml',
];
const restoreDb = `release_rehearsal_restore_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
const dumpPath = join(tmpdir(), `${restoreDb}.dump`);

function runDocker(args, options = {}) {
  const result = spawnSync('docker', [...composeArgs, ...args], {
    encoding: options.binary ? null : 'utf8',
    input: options.input,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(options.errorCode ?? 'STAGING_BACKUP_COMMAND_FAILED');
  }
  return result.stdout;
}

function parseEnv(text) {
  const values = new Map();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator > 0) values.set(line.slice(0, separator), line.slice(separator + 1));
  }
  return values;
}

function parseCliState(output) {
  const lines = String(output).trim().split(/\r?\n/).filter(Boolean);
  const jsonLine = [...lines].reverse().find((line) => line.trim().startsWith('{'));
  if (!jsonLine) throw new Error('STAGING_BACKUP_VERIFY_OUTPUT_INVALID');
  return JSON.parse(jsonLine);
}

function verifyViaBackend(extraEnvironment = []) {
  return parseCliState(runDocker([
    'run', '--rm', '-T', '--no-deps',
    '-e', 'STAGING_REHEARSAL_ENABLED=1',
    ...extraEnvironment.flatMap(([key, value]) => ['-e', `${key}=${value}`]),
    'backend',
    'node', 'dist/src/rehearsal/release-rehearsal-cli.js', 'verify',
  ], { errorCode: 'STAGING_BACKUP_PUBLIC_READER_VERIFY_FAILED' }));
}

let restoreCreated = false;
try {
  const sourceState = verifyViaBackend();
  assert.equal(sourceState.activeVersionNumber, 1);

  const dump = runDocker([
    'exec', '-T', 'postgres', 'sh', '-lc',
    'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom',
  ], { binary: true, errorCode: 'STAGING_BACKUP_DUMP_FAILED' });
  await writeFile(dumpPath, dump);

  runDocker([
    'exec', '-T', 'postgres', 'sh', '-lc',
    `createdb -U "$POSTGRES_USER" ${restoreDb}`,
  ], { errorCode: 'STAGING_BACKUP_CREATEDB_FAILED' });
  restoreCreated = true;

  const dumpBytes = await readFile(dumpPath);
  runDocker([
    'exec', '-T', 'postgres', 'sh', '-lc',
    `pg_restore -U "$POSTGRES_USER" -d ${restoreDb} --no-owner --no-privileges`,
  ], {
    input: dumpBytes,
    binary: true,
    errorCode: 'STAGING_BACKUP_RESTORE_FAILED',
  });

  const localEnv = parseEnv(await readFile('deploy/staging/.env.example', 'utf8'));
  const user = encodeURIComponent(localEnv.get('POSTGRES_USER') ?? 'hai_dau');
  const password = encodeURIComponent(localEnv.get('POSTGRES_PASSWORD') ?? '');
  const restoreUrl = `postgresql://${user}:${password}@postgres:5432/${restoreDb}`;
  const restoredState = verifyViaBackend([['DATABASE_URL', restoreUrl]]);
  assert.deepEqual(restoredState, sourceState);

  const count = String(runDocker([
    'exec', '-T', 'postgres', 'sh', '-lc',
    `psql -U "$POSTGRES_USER" -d ${restoreDb} -Atc "select count(*) from publication_versions where publication_id = '8d000000-0000-4000-8000-000000000031'"`,
  ], { errorCode: 'STAGING_BACKUP_VERSION_COUNT_FAILED' })).trim();
  assert.equal(count, '2');

  console.log('staging-backup-restore: restored public authority matches source PASS');
} finally {
  if (restoreCreated) {
    spawnSync('docker', [...composeArgs,
      'exec', '-T', 'postgres', 'sh', '-lc',
      `dropdb -U "$POSTGRES_USER" --if-exists --force ${restoreDb}`,
    ], { encoding: 'utf8' });
  }
  await rm(dumpPath, { force: true });
}
