import { parseConfig } from './config.js';
import { createPool } from './database/pool.js';
import {
  registerStoredObservationInTransaction,
} from './modules/candidate/register-stored-observation.js';
import { createWorkerConnection } from './queue/connection.js';
import { createEligibilityWorker } from './queue/eligibility-worker.js';
import { createNormalizationWorker } from './queue/normalization-worker.js';
import {
  createPublicationProjectionWorker,
} from './queue/publication-projection-worker.js';

const config = parseConfig(process.env);
const pool = createPool(config.databaseUrl);
const normalizationConnection = createWorkerConnection(config.redisUrl);
const eligibilityConnection = createWorkerConnection(config.redisUrl);
const publicationConnection = createWorkerConnection(config.redisUrl);
const normalizationWorker = createNormalizationWorker({
  connection: normalizationConnection,
  normalizeObservation: registerStoredObservationInTransaction,
  pool,
});
const eligibilityWorker = createEligibilityWorker({
  connection: eligibilityConnection,
  pool,
});
const publicationWorker = createPublicationProjectionWorker({
  connection: publicationConnection,
  pool,
});

let shutdownPromise: Promise<void> | undefined;
async function shutdown(): Promise<void> {
  shutdownPromise ??= (async () => {
    await Promise.all([
      normalizationWorker.close(),
      eligibilityWorker.close(),
      publicationWorker.close(),
    ]);
    await Promise.all([
      normalizationConnection.quit(),
      eligibilityConnection.quit(),
      publicationConnection.quit(),
    ]);
    await pool.end();
  })();
  await shutdownPromise;
}

process.once('SIGINT', () => {
  void shutdown();
});
process.once('SIGTERM', () => {
  void shutdown();
});
