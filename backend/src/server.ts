import { Redis } from 'ioredis';
import { Pool } from 'pg';

import { buildApp } from './app.js';
import { parseConfig } from './config.js';
import { createResourceHealth } from './resources.js';

async function main(): Promise<void> {
  const config = parseConfig(process.env);
  const pool = new Pool({ connectionString: config.databaseUrl });
  const redis = new Redis(config.redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: null,
  });
  await redis.connect();

  const app = buildApp({
    resources: createResourceHealth(pool, redis),
  });

  const shutdown = async (signal: NodeJS.Signals) => {
    app.log.info({ signal }, 'shutting down');
    await app.close();
    await Promise.all([pool.end(), redis.quit()]);
  };

  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ host: config.host, port: config.port });
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'unknown startup error';
  process.stderr.write(`Backend startup failed: ${message}\n`);
  process.exitCode = 1;
});
