import { Queue } from 'bullmq';

import { parseConfig } from './config.js';
import { createPool } from './database/pool.js';
import {
  registerStoredObservationInTransaction,
} from './modules/candidate/register-stored-observation.js';
import {
  createQueueConnection,
  createWorkerConnection,
} from './queue/connection.js';
import { createEligibilityWorker } from './queue/eligibility-worker.js';
import {
  ELIGIBILITY_QUEUE_NAME,
  MONITORING_QUEUE_NAME,
  NORMALIZATION_QUEUE_NAME,
  PUBLICATION_QUEUE_NAME,
} from './queue/names.js';
import { createMonitoringWorker } from './queue/monitoring-worker.js';
import { createNormalizationWorker } from './queue/normalization-worker.js';
import { dispatchOutbox } from './queue/outbox-dispatcher.js';
import { runOutboxDispatchLoop } from './queue/outbox-dispatch-loop.js';
import {
  createPublicationProjectionWorker,
} from './queue/publication-projection-worker.js';

const config = parseConfig(process.env);
const pool = createPool(config.databaseUrl);
const normalizationConnection = createWorkerConnection(config.redisUrl);
const eligibilityConnection = createWorkerConnection(config.redisUrl);
const publicationConnection = createWorkerConnection(config.redisUrl);
const monitoringConnection = createWorkerConnection(config.redisUrl);
const normalizationQueueConnection = createQueueConnection(config.redisUrl);
const eligibilityQueueConnection = createQueueConnection(config.redisUrl);
const publicationQueueConnection = createQueueConnection(config.redisUrl);
const monitoringQueueConnection = createQueueConnection(config.redisUrl);

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
const monitoringWorker = createMonitoringWorker({
  connection: monitoringConnection,
  pool,
});

const normalizationQueue = new Queue(NORMALIZATION_QUEUE_NAME, {
  connection: normalizationQueueConnection,
});
const eligibilityQueue = new Queue(ELIGIBILITY_QUEUE_NAME, {
  connection: eligibilityQueueConnection,
});
const publicationQueue = new Queue(PUBLICATION_QUEUE_NAME, {
  connection: publicationQueueConnection,
});
const monitoringQueue = new Queue(MONITORING_QUEUE_NAME, {
  connection: monitoringQueueConnection,
});

const dispatcherController = new AbortController();
const dispatcherPromise = runOutboxDispatchLoop({
  dispatch: async () => {
    await dispatchOutbox({
      pool,
      queues: {
        eligibility: eligibilityQueue,
        monitoring: monitoringQueue,
        normalization: normalizationQueue,
        publication: publicationQueue,
      },
    });
  },
  onError: (error) => {
    const message = error instanceof Error ? error.message : 'UNKNOWN_ERROR';
    process.stderr.write(`worker: outbox dispatch failed: ${message}\n`);
  },
  signal: dispatcherController.signal,
  sleepMs: 1_000,
});

let shutdownPromise: Promise<void> | undefined;
async function shutdown(): Promise<void> {
  shutdownPromise ??= (async () => {
    dispatcherController.abort();
    await dispatcherPromise;
    await Promise.all([
      normalizationWorker.close(),
      eligibilityWorker.close(),
      publicationWorker.close(),
      monitoringWorker.close(),
    ]);
    await Promise.all([
      normalizationQueue.close(),
      eligibilityQueue.close(),
      publicationQueue.close(),
      monitoringQueue.close(),
    ]);
    await Promise.all([
      normalizationConnection.quit(),
      eligibilityConnection.quit(),
      publicationConnection.quit(),
      monitoringConnection.quit(),
      normalizationQueueConnection.quit(),
      eligibilityQueueConnection.quit(),
      publicationQueueConnection.quit(),
      monitoringQueueConnection.quit(),
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
