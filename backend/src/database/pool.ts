import { Pool } from 'pg';

export function createPool(connectionString: string): Pool {
  return new Pool({
    application_name: 'hai-dau-backend',
    connectionString,
    max: 10,
    statement_timeout: 15_000,
  });
}
