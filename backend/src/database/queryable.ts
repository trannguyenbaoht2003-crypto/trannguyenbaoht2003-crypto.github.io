import type { Pool } from 'pg';

/** Narrow PostgreSQL read boundary implemented by both Pool and PoolClient. */
export type PgQueryable = Pick<Pool, 'query'>;
