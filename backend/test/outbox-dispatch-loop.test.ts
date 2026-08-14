import assert from 'node:assert/strict';
import test from 'node:test';

import {
  runOutboxDispatchLoop,
} from '../src/queue/outbox-dispatch-loop.js';

test('outbox dispatch loop serializes iterations and stops after abort', async () => {
  const controller = new AbortController();
  let active = 0;
  let maximumActive = 0;
  let dispatches = 0;

  await runOutboxDispatchLoop({
    dispatch: async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await Promise.resolve();
      dispatches += 1;
      active -= 1;
      if (dispatches === 3) controller.abort();
    },
    signal: controller.signal,
    sleepMs: 0,
    sleep: async () => {},
  });

  assert.equal(dispatches, 3);
  assert.equal(maximumActive, 1);
});

test('outbox dispatch loop reports a transient error and continues', async () => {
  const controller = new AbortController();
  const errors: string[] = [];
  let attempts = 0;

  await runOutboxDispatchLoop({
    dispatch: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('temporary database failure');
      controller.abort();
    },
    onError: (error) => {
      errors.push(error instanceof Error ? error.message : String(error));
    },
    signal: controller.signal,
    sleepMs: 0,
    sleep: async () => {},
  });

  assert.equal(attempts, 2);
  assert.deepEqual(errors, ['temporary database failure']);
});

test('already-aborted loop performs no dispatch', async () => {
  const controller = new AbortController();
  controller.abort();
  let dispatches = 0;

  await runOutboxDispatchLoop({
    dispatch: async () => { dispatches += 1; },
    signal: controller.signal,
    sleepMs: 0,
    sleep: async () => {},
  });

  assert.equal(dispatches, 0);
});