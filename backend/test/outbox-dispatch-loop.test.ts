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
test('idle mode gives follow-up jobs a grace period then allows database suspension', async () => {
  const controller = new AbortController();
  let now = 0;
  const delays: number[] = [];
  const claims = [1, 0, 0, 0, 1, 0];
  await runOutboxDispatchLoop({
    dispatch: async () => ({ claimed: claims.shift()! }),
    signal: controller.signal,
    sleepMs: 1_000,
    idleSleepMs: 1_800_000,
    activeGraceMs: 2_000,
    now: () => now,
    sleep: async (ms) => {
      delays.push(ms);
      now += ms;
      if (delays.length === 6) controller.abort();
    },
  });
  assert.deepEqual(delays, [1_000, 1_000, 1_800_000, 1_800_000, 1_000, 1_000]);
});

test('idle mode backs off database errors and resumes processing on recovery', async () => {
  const controller = new AbortController();
  const delays: number[] = [];
  let attempts = 0;
  let errors = 0;
  await runOutboxDispatchLoop({
    dispatch: async () => {
      if (++attempts === 1) throw new Error('quota exceeded');
      return { claimed: 1 };
    },
    onError: () => { errors += 1; },
    signal: controller.signal,
    sleepMs: 1_000,
    idleSleepMs: 1_800_000,
    sleep: async (ms) => {
      delays.push(ms);
      if (delays.length === 2) controller.abort();
    },
  });
  assert.deepEqual(delays, [1_800_000, 1_000]);
  assert.equal(errors, 1);
});

test('abort interrupts a long idle sleep without another database query', async () => {
  const controller = new AbortController();
  let dispatches = 0;
  await runOutboxDispatchLoop({
    dispatch: async () => {
      dispatches += 1;
      setImmediate(() => controller.abort());
      return { claimed: 0 };
    },
    signal: controller.signal,
    sleepMs: 1_000,
    idleSleepMs: 1_800_000,
    activeGraceMs: 0,
  });
  assert.equal(dispatches, 1);
});

test('returned delivery failures back off instead of keeping the database awake', async () => {
  const controller = new AbortController();
  const delays: number[] = [];
  await runOutboxDispatchLoop({
    dispatch: async () => ({ claimed: 1, failed: 1 }),
    signal: controller.signal,
    sleepMs: 1_000,
    idleSleepMs: 1_800_000,
    sleep: async (ms) => { delays.push(ms); controller.abort(); },
  });
  assert.deepEqual(delays, [1_800_000]);
});
