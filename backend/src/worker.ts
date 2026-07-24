import { parseConfig } from './config.js';
import { createPool } from './database/pool.js';
import { createWorkerConnection } from './queue/connection.js';
import { createNormalizationWorker } from './queue/normalization-worker.js';

const config = parseConfig(process.env);
const pool = createPool(config.databaseUrl);
const connection = createWorkerConnection(config.redisUrl);
const worker = createNormalizationWorker({
  connection,
  normalizeObservation: async () => undefined,
  pool,
});

async function shutdown(): Promise<void> {
  await worker.close();
  await connection.quit();
  await pool.end();
}

process.once('SIGINT', () => {
  void shutdown();
});
process.once('SIGTERM', () => {
  void shutdown();
});
