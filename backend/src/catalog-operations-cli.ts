import { pathToFileURL } from 'node:url';

import { Pool } from 'pg';

import { activateCatalogRevision } from './modules/catalog/activate-catalog-revision.js';
import { MAX_CATALOG_INPUT_BYTES, parseCatalogOperationsInput } from './modules/catalog/catalog-operations-input.js';
import { importCatalogRevision } from './modules/catalog/import-catalog-revision.js';
import { normalizeCatalogSnapshot } from './modules/catalog/normalize-catalog-snapshot.js';
import { validateCatalogRevision } from './modules/catalog/validate-catalog-revision.js';
import { registerPatchEvent } from './modules/patch/register-patch-event.js';

const SAFE_ERRORS = new Set([
  'CATALOG_OPERATIONS_INPUT_INVALID', 'CATALOG_OPERATIONS_CONFIG_INVALID',
  'CATALOG_PATCH_NOT_FOUND', 'CATALOG_PATCH_KEY_MISMATCH', 'CATALOG_PATCH_NOT_ACTIVE',
  'CATALOG_SOURCE_POLICY_NOT_ACTIVE', 'CATALOG_CONTENT_ALREADY_IMPORTED',
  'CATALOG_REVISION_NOT_FOUND', 'CATALOG_REVISION_NOT_SEALED',
  'CATALOG_PATCH_MISMATCH', 'CATALOG_VALIDATION_REQUIRED', 'CATALOG_ACTIVE_POINTER_CONFLICT',
  'IDEMPOTENCY_PAYLOAD_CONFLICT', 'IDEMPOTENCY_OPERATION_IN_PROGRESS',
  'PATCH_NOT_FOUND', 'PATCH_IDENTITY_CONFLICT',
]);

export interface CatalogOperationsResult {
  exitCode: 0 | 1;
  stdout: string;
  stderr: string;
}

function output(value: unknown, exitCode: 0 | 1 = 0): CatalogOperationsResult {
  return { exitCode, stdout: `${JSON.stringify(value)}\n`, stderr: '' };
}

function failure(error: unknown): CatalogOperationsResult {
  const code = error instanceof Error && SAFE_ERRORS.has(error.message)
    ? error.message : 'CATALOG_OPERATIONS_FAILED';
  return { exitCode: 1, stdout: '', stderr: `${code}\n` };
}

export async function runCatalogOperationsCli(
  stdin: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CatalogOperationsResult> {
  let pool: Pool | undefined;
  try {
    const input = parseCatalogOperationsInput(stdin);
    if (input.action === 'inspect') {
      const { snapshot, contentHash } = normalizeCatalogSnapshot(input.snapshot);
      const entityCounts = { champion: 0, item: 0, augment: 0, mode: 0 };
      for (const entity of snapshot.entities) entityCounts[entity.entityType] += 1;
      return output({
        action: 'inspect', patchKey: snapshot.patchKey,
        gameModeExternalId: snapshot.gameModeExternalId, contentHash,
        entityCounts, ruleCount: snapshot.rules.length,
        sourceVerified: false, databaseValidated: false,
      });
    }

    const databaseUrl = env.DATABASE_URL;
    if (!databaseUrl || databaseUrl !== databaseUrl.trim()) {
      throw new Error('CATALOG_OPERATIONS_CONFIG_INVALID');
    }
    pool = new Pool({
      connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 10_000,
      statement_timeout: 30_000, application_name: 'hai-dau-catalog-operations',
    });
    if (input.action === 'register-patch') {
      const { action, ...command } = input;
      return output({ action, ...await registerPatchEvent(pool, command) });
    }
    if (input.action === 'import') {
      const { action, ...command } = input;
      return output({ action, ...await importCatalogRevision(pool, command) });
    }
    if (input.action === 'validate') {
      const { action, ...command } = input;
      const result = await validateCatalogRevision(pool, command);
      return output({ action, ...result }, result.result === 'passed' ? 0 : 1);
    }
    const { action, ...command } = input;
    return output({ action, ...await activateCatalogRevision(pool, command) });
  } catch (error) {
    return failure(error);
  } finally {
    try { await pool?.end(); } catch { /* Do not expose private connection details. */ }
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.byteLength;
    if (size > MAX_CATALOG_INPUT_BYTES) throw new Error('CATALOG_OPERATIONS_INPUT_INVALID');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function main(): Promise<void> {
  let result: CatalogOperationsResult;
  try {
    if (process.argv.length !== 2) throw new Error('CATALOG_OPERATIONS_INPUT_INVALID');
    result = await runCatalogOperationsCli(await readStdin());
  } catch (error) {
    result = failure(error);
  }
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
