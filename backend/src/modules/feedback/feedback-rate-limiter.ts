import type { Redis } from 'ioredis';

import type {
  FeedbackRateLimiter,
  FeedbackRateLimitInput,
  FeedbackRateLimitResult,
} from './types.js';

const PREFIX = 'hai-dau:feedback:v1:';
const BURST_TTL_SECONDS = 10 * 60;
const DAILY_TTL_SECONDS = 24 * 60 * 60;
const DUPLICATE_TTL_SECONDS = 30 * 60;
const REPLAY_TTL_SECONDS = 24 * 60 * 60;

const RATE_LIMIT_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 1 then
  return {2, 0}
end

local duplicate_ttl = redis.call('TTL', KEYS[4])
if duplicate_ttl > 0 then
  return {0, duplicate_ttl}
end

local burst = tonumber(redis.call('GET', KEYS[2]) or '0')
if burst >= tonumber(ARGV[1]) then
  local ttl = redis.call('TTL', KEYS[2])
  if ttl < 1 then ttl = 1 end
  return {0, ttl}
end

local daily = tonumber(redis.call('GET', KEYS[3]) or '0')
if daily >= tonumber(ARGV[2]) then
  local ttl = redis.call('TTL', KEYS[3])
  if ttl < 1 then ttl = 1 end
  return {0, ttl}
end

local next_burst = redis.call('INCR', KEYS[2])
if next_burst == 1 then redis.call('EXPIRE', KEYS[2], tonumber(ARGV[3])) end
local next_daily = redis.call('INCR', KEYS[3])
if next_daily == 1 then redis.call('EXPIRE', KEYS[3], tonumber(ARGV[4])) end
redis.call('SET', KEYS[4], '1', 'EX', tonumber(ARGV[5]))
redis.call('SET', KEYS[1], '1', 'EX', tonumber(ARGV[6]))
return {1, 0}
`;

function keyPart(value: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error('Invalid feedback limiter key component');
  }
  return value;
}

function clampRetryAfter(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return 1;
  return Math.max(1, Math.min(DAILY_TTL_SECONDS, Math.ceil(numeric)));
}

export function createFeedbackRateLimiter(redis: Redis): FeedbackRateLimiter {
  return {
    async check(input: FeedbackRateLimitInput): Promise<FeedbackRateLimitResult> {
      const fingerprint = keyPart(input.fingerprint);
      const submissionId = keyPart(input.submissionId);
      const publicationVersionId = keyPart(input.publicationVersionId);
      const reasonCode = keyPart(input.reasonCode);

      const result = await redis.eval(
        RATE_LIMIT_SCRIPT,
        4,
        `${PREFIX}replay:${fingerprint}:${submissionId}`,
        `${PREFIX}burst:${fingerprint}`,
        `${PREFIX}daily:${fingerprint}`,
        `${PREFIX}duplicate:${fingerprint}:${publicationVersionId}:${reasonCode}`,
        5,
        20,
        BURST_TTL_SECONDS,
        DAILY_TTL_SECONDS,
        DUPLICATE_TTL_SECONDS,
        REPLAY_TTL_SECONDS,
      );

      if (!Array.isArray(result) || result.length < 2) {
        throw new Error('Invalid feedback limiter response');
      }
      const status = Number(result[0]);
      if (status === 1) return { outcome: 'allowed' };
      if (status === 2) return { outcome: 'replay_pass' };
      if (status === 0) {
        return {
          outcome: 'denied',
          retryAfterSeconds: clampRetryAfter(result[1]),
        };
      }
      throw new Error('Invalid feedback limiter status');
    },
  };
}
