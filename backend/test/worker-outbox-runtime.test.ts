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
  assert.match(worker, /new Queue/);
});

test('worker aborts dispatcher before closing queue resources', () => {
  const abortIndex = worker.indexOf('dispatcherController.abort()');
  const queueCloseIndex = worker.indexOf('.close()');
  assert.ok(abortIndex >= 0, 'dispatcher abort must be wired');
  assert.ok(queueCloseIndex > abortIndex, 'dispatcher must abort before queue shutdown');
});

test('worker logs dispatcher failures without environment or payload dumps', () => {
  assert.match(worker, /outbox dispatch failed/);
  assert.doesNotMatch(worker, /DATABASE_URL|REDIS_URL|JSON\.stringify\(error\)|process\.env/);
});