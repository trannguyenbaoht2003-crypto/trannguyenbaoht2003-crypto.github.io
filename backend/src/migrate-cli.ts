import { Pool } from 'pg';

import { parseConfig } from './config.js';
import { migrate } from './database/migrate.js';

async function main(): Promise<void> {
  const config = parseConfig(process.env);
  const pool = new Pool({ connectionString: config.databaseUrl });
  try {
    await migrate(pool);
  } finally {
    await pool.end();
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'unknown migration error';
  process.stderr.write(`Migration failed: ${message}\n`);
  process.exitCode = 1;
});
