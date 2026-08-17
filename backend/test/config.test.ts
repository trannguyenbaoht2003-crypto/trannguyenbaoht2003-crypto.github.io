import assert from 'node:assert/strict';
import test from 'node:test';

import { parseConfig } from '../src/config.js';

const base = {
  DATABASE_URL: 'postgres://db',
  REDIS_URL: 'redis://cache',
};

test('production configuration requires the database URL', () => {
  assert.throws(
    () => parseConfig({ NODE_ENV: 'production', REDIS_URL: 'redis://cache' }),
    /DATABASE_URL is required/,
  );
});

test('production configuration requires the Redis URL', () => {
  assert.throws(
    () => parseConfig({ NODE_ENV: 'production', DATABASE_URL: 'postgres://db' }),
    /REDIS_URL is required/,
  );
});

test('configuration rejects a non-integer port', () => {
  assert.throws(() => parseConfig({ ...base, PORT: 'abc' }), /PORT must be an integer/);
});

test('configuration applies safe network and feedback defaults', () => {
  const config = parseConfig(base);
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.port, 3001);
  assert.equal(config.feedbackIntakeEnabled, false);
  assert.equal(config.feedbackFingerprintSecret, undefined);
});

test('feedback intake accepts only explicit boolean strings', () => {
  assert.equal(parseConfig({ ...base, FEEDBACK_INTAKE_ENABLED: 'false' }).feedbackIntakeEnabled, false);
  assert.throws(
    () => parseConfig({ ...base, FEEDBACK_INTAKE_ENABLED: 'yes' }),
    /FEEDBACK_INTAKE_ENABLED/i,
  );
});

test('enabled feedback intake requires at least 32 UTF-8 bytes of secret material', () => {
  assert.throws(
    () => parseConfig({ ...base, FEEDBACK_INTAKE_ENABLED: 'true' }),
    /FEEDBACK_FINGERPRINT_SECRET/i,
  );
  assert.throws(
    () => parseConfig({
      ...base,
      FEEDBACK_INTAKE_ENABLED: 'true',
      FEEDBACK_FINGERPRINT_SECRET: 'too-short',
    }),
    /32 bytes/i,
  );

  const config = parseConfig({
    ...base,
    FEEDBACK_INTAKE_ENABLED: 'true',
    FEEDBACK_FINGERPRINT_SECRET: '12345678901234567890123456789012',
  });
  assert.equal(config.feedbackIntakeEnabled, true);
  assert.equal(config.feedbackFingerprintSecret, '12345678901234567890123456789012');
});
