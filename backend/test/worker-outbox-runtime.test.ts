import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const worker = await readFile(new URL('../src/worker.ts', import.meta.url), 'utf8');

test('worker owns the durable outbox dispatcher and all routed queues', () => {
  assert.match(worker, /dispatchOutbox/);
  assert.match(worker, /runOutboxDispatchLoop/);
  assert.match(worker, /NORMALIZATION_QUEUE_NAME/);
  assert.match(worker, /ELIGIBILITY_QUEUE_NAME/);
  assert.match(worker, /PUBLICATION_QUEUE_NAME/);
  assert.match(worker, /MONITORING_QUEUE_NAME/);
  assert.match(worker, /createMonitoringWorker/);
  assert.match(worker, /new Queue/);
  assert.match(worker, /monitoring:\s*monitoringQueue/);
});

test('worker uses finite-retry Redis connections for every outbox producer queue', () => {
  assert.match(worker, /createQueueConnection/);
  for (const name of [
    'normalizationQueueConnection',
    'eligibilityQueueConnection',
    'publicationQueueConnection',
    'monitoringQueueConnection',
  ]) {
    assert.match(
      worker,
      new RegExp(`const ${name} = createQueueConnection\\(config\\.redisUrl\\)`),
      `${name} must use the finite-retry queue connection`,
    );
  }
});

test('worker gives monitoring its own worker-compatible Redis connection', () => {
  assert.match(
    worker,
    /const monitoringConnection = createWorkerConnection\(config\.redisUrl\)/,
  );
  assert.match(
    worker,
    /createMonitoringWorker\(\{\s*connection: monitoringConnection,\s*pool,\s*\}\)/s,
  );
});

test('worker aborts dispatcher before closing workers and queue resources', () => {
  const abortIndex = worker.indexOf('dispatcherController.abort()');
  const workerCloseIndex = worker.indexOf('monitoringWorker.close()');
  const queueCloseIndex = worker.indexOf('monitoringQueue.close()');
  assert.ok(abortIndex >= 0, 'dispatcher abort must be wired');
  assert.ok(workerCloseIndex > abortIndex, 'monitoring worker closes after dispatcher abort');
  assert.ok(queueCloseIndex > workerCloseIndex, 'monitoring queue closes after workers');
});

test('worker logs dispatcher failures without environment or payload dumps', () => {
  assert.match(worker, /outbox dispatch failed/);
  assert.doesNotMatch(worker, /DATABASE_URL|REDIS_URL|JSON\.stringify\(error\)/);
  assert.doesNotMatch(worker, /outbox dispatch failed[^\n]*(databaseUrl|redisUrl|process\.env|payload)/i);
});
