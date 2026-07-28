import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { Pool } from 'pg';

import { withTransaction } from './transaction.js';

const migrationNamePattern = /^\d{4}_[a-z0-9_]+\.sql$/;

function checksum(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

export async function migrate(
  pool: Pool,
  migrationsDirectory = resolve(process.cwd(), 'migrations'),
): Promise<void> {
  await pool.query(`
    create table if not exists schema_migrations (
      version text primary key,
      checksum text not null,
      applied_at timestamptz not null default clock_timestamp()
    )
  `);

  const files = (await readdir(migrationsDirectory))
    .filter((file) => migrationNamePattern.test(file))
    .sort();

  for (const version of files) {
    const sql = await readFile(resolve(migrationsDirectory, version), 'utf8');
    const expectedChecksum = checksum(sql);
    const existing = await pool.query<{ checksum: string }>(
      'select checksum from schema_migrations where version = $1',
      [version],
    );

    if (existing.rowCount === 1) {
      if (existing.rows[0]?.checksum !== expectedChecksum) {
        throw new Error(`Migration checksum mismatch: ${version}`);
      }
      continue;
    }

    await withTransaction(pool, async (client) => {
      await client.query(sql);
      await client.query(
        'insert into schema_migrations (version, checksum) values ($1, $2)',
        [version, expectedChecksum],
      );
    });
  }
}
