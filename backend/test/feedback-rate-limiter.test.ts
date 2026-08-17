import assert from 'node:assert/strict';
import test from 'node:test';

import { Redis } from 'ioredis';

import { createFeedbackFingerprint } from '../src/modules/feedback/feedback-fingerprint.js';
import { createFeedbackRateLimiter } from '../src/modules/feedback/feedback-rate-limiter.js';

function redisUrl(): string {
  const value = process.env.TEST_REDIS_URL;
  if (!value) throw new Error('TEST_REDIS_URL is required');
  return value;
}

const SECRET = '7b-feedback-secret-material-32-bytes-minimum';
const FINGERPRINT = 'a'.repeat(64);
const VERSION = '7b400000-0000-4000-8000-000000000001';

function input(index: number, overrides: Record<string, string> = {}) {
  return {
    fingerprint: FINGERPRINT,
    submissionId: `7b400000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    publicationVersionId: VERSION,
    reasonCode: 'WRONG_ITEMS' as const,
    ...overrides,
  };
}

test('feedback fingerprint validates/canonicalizes IP and returns keyed digest only', () => {
  const ipv6A = createFeedbackFingerprint(SECRET, '2001:0db8:0:0:0:0:0:1');
  const ipv6B = createFeedbackFingerprint(SECRET, '2001:db8::1');
  assert.equal(ipv6A, ipv6B);
  assert.match(ipv6A, /^[a-f0-9]{64}$/);
  assert.equal(
    createFeedbackFingerprint(SECRET, '203.0.113.9'),
    createFeedbackFingerprint(SECRET, '203.0.113.9'),
  );
  assert.notEqual(
    createFeedbackFingerprint(SECRET, '203.0.113.9'),
    createFeedbackFingerprint(`${SECRET}-rotated`, '203.0.113.9'),
  );
  for (const invalid of ['example.com', '999.1.1.1', '', '203.0.113.9, 10.0.0.1']) {
    assert.throws(() => createFeedbackFingerprint(SECRET, invalid), /ip/i);
  }
});

test('same submission id receives replay_pass without consuming quota twice', async () => {
  const redis = new Redis(redisUrl(), { maxRetriesPerRequest: null });
  try {
    await redis.flushdb();
    const limiter = createFeedbackRateLimiter(redis);
    assert.deepEqual(await limiter.check(input(1)), { outcome: 'allowed' });
    assert.deepEqual(await limiter.check(input(1)), { outcome: 'replay_pass' });
    for (let i = 2; i <= 5; i += 1) {
      assert.deepEqual(
        await limiter.check(input(i, { publicationVersionId: `7b400000-0000-4000-8001-${String(i).padStart(12, '0')}` })),
        { outcome: 'allowed' },
      );
    }
    const denied = await limiter.check(input(6, {
      publicationVersionId: '7b400000-0000-4000-8001-000000000006',
    }));
    assert.equal(denied.outcome, 'denied');
  } finally { await redis.quit(); }
});

test('duplicate signal and burst limits are atomic under concurrency', async () => {
  const redis = new Redis(redisUrl(), { maxRetriesPerRequest: null });
  try {
    await redis.flushdb();
    const limiter = createFeedbackRateLimiter(redis);
    const duplicate = await Promise.all([
      limiter.check(input(10)),
      limiter.check(input(11)),
    ]);
    assert.equal(duplicate.filter((result) => result.outcome === 'allowed').length, 1);
    assert.equal(duplicate.filter((result) => result.outcome === 'denied').length, 1);

    await redis.flushdb();
    const burst = await Promise.all(
      Array.from({ length: 8 }, (_, offset) => limiter.check(input(20 + offset, {
        publicationVersionId: `7b400000-0000-4000-8002-${String(offset).padStart(12, '0')}`,
      }))),
    );
    assert.equal(burst.filter((result) => result.outcome === 'allowed').length, 5);
    assert.equal(burst.filter((result) => result.outcome === 'denied').length, 3);
    for (const result of burst.filter((value) => value.outcome === 'denied')) {
      assert.ok(result.outcome === 'denied' && result.retryAfterSeconds > 0 && result.retryAfterSeconds <= 86400);
    }
  } finally { await redis.quit(); }
});

test('daily counter rejects the twenty-first new signal', async () => {
  const redis = new Redis(redisUrl(), { maxRetriesPerRequest: null });
  try {
    await redis.flushdb();
    const limiter = createFeedbackRateLimiter(redis);
    for (let i = 1; i <= 20; i += 1) {
      const result = await limiter.check(input(100 + i, {
        publicationVersionId: `7b400000-0000-4000-8003-${String(i).padStart(12, '0')}`,
      }));
      assert.equal(result.outcome, 'allowed');
      if (i % 5 === 0 && i < 20) {
        const burstKeys = await redis.keys('hai-dau:feedback:v1:burst:*');
        if (burstKeys.length > 0) await redis.del(...burstKeys);
      }
    }
    const denied = await limiter.check(input(121, {
      publicationVersionId: '7b400000-0000-4000-8003-000000000021',
    }));
    assert.equal(denied.outcome, 'denied');
    assert.ok(denied.outcome === 'denied' && denied.retryAfterSeconds > 0);
  } finally { await redis.quit(); }
});

test('Redis command failure fails closed', async () => {
  const redis = new Redis(redisUrl(), { maxRetriesPerRequest: null });
  await redis.quit();
  const limiter = createFeedbackRateLimiter(redis);
  await assert.rejects(limiter.check(input(200)));
});
