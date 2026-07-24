import assert from 'node:assert/strict';
import test from 'node:test';

import { parseConfig } from '../src/config.js';

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
  assert.throws(
    () =>
      parseConfig({
        DATABASE_URL: 'postgres://db',
        REDIS_URL: 'redis://cache',
        PORT: 'abc',
      }),
    /PORT must be an integer/,
  );
});

test('configuration applies safe network defaults', () => {
  const config = parseConfig({
    DATABASE_URL: 'postgres://db',
    REDIS_URL: 'redis://cache',
  });

  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.port, 3001);
});
