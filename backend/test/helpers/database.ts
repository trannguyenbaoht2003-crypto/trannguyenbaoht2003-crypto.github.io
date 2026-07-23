import type { Pool } from 'pg';

import { migrate } from '../../src/database/migrate.js';
import { createPool } from '../../src/database/pool.js';

export function testDatabaseUrl(): string {
  const value = process.env.TEST_DATABASE_URL;
  if (!value) {
    throw new Error('TEST_DATABASE_URL is required for database tests');
  }
  return value;
}

export async function resetDatabase(): Promise<Pool> {
  const pool = createPool(testDatabaseUrl());
  await pool.query('drop schema public cascade; create schema public');
  await migrate(pool);
  return pool;
}

export async function tableCount(pool: Pool, table: string): Promise<number> {
  if (!/^[a-z_]+$/.test(table)) {
    throw new Error('Unsafe table identifier');
  }
  const result = await pool.query<{ count: string }>(`select count(*) from ${table}`);
  return Number(result.rows[0]?.count ?? 0);
}
