import type { Redis } from 'ioredis';
import type { Pool } from 'pg';

export interface ResourceHealth {
  checkPostgres(): Promise<boolean>;
  checkRedis(): Promise<boolean>;
}

export function createResourceHealth(pool: Pool, redis: Redis): ResourceHealth {
  return {
    async checkPostgres() {
      try {
        await pool.query('select 1');
        return true;
      } catch {
        return false;
      }
    },
    async checkRedis() {
      try {
        return (await redis.ping()) === 'PONG';
      } catch {
        return false;
      }
    },
  };
}
