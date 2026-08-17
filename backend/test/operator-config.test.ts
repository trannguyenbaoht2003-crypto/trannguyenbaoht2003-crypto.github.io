import assert from 'node:assert/strict';
import test from 'node:test';

import { parseOperatorConfig } from '../src/operator/config.js';

const DATABASE_URL = 'postgres://operator-local';

test('operator config defaults to loopback port 3011 and requires only DATABASE_URL', () => {
  assert.deepEqual(parseOperatorConfig({ DATABASE_URL }), {
    host: '127.0.0.1',
    port: 3011,
    databaseUrl: DATABASE_URL,
  });
});

test('operator config accepts only the exact loopback host allowlist', () => {
  for (const host of ['127.0.0.1', '::1', 'localhost']) {
    assert.equal(
      parseOperatorConfig({ DATABASE_URL, OPERATOR_HOST: host }).host,
      host,
    );
  }

  for (const host of [
    '0.0.0.0',
    '::',
    '192.168.1.10',
    '10.0.0.5',
    'operator.internal',
    'example.com',
  ]) {
    assert.throws(
      () => parseOperatorConfig({ DATABASE_URL, OPERATOR_HOST: host }),
      /OPERATOR_HOST must be loopback-only/,
    );
  }
});

test('operator config validates the dedicated operator port strictly', () => {
  assert.equal(
    parseOperatorConfig({ DATABASE_URL, OPERATOR_PORT: '4242' }).port,
    4242,
  );

  for (const port of ['0', '65536', '1.5', 'abc', '']) {
    assert.throws(
      () => parseOperatorConfig({ DATABASE_URL, OPERATOR_PORT: port }),
      /OPERATOR_PORT must be an integer between 1 and 65535/,
    );
  }
});

test('operator config fails closed without a database URL and ignores public backend dependencies', () => {
  assert.throws(
    () => parseOperatorConfig({}),
    /DATABASE_URL is required/,
  );

  assert.deepEqual(
    parseOperatorConfig({
      DATABASE_URL,
      REDIS_URL: '',
      FEEDBACK_FINGERPRINT_SECRET: '',
      FEEDBACK_INTAKE_ENABLED: 'true',
    }),
    {
      host: '127.0.0.1',
      port: 3011,
      databaseUrl: DATABASE_URL,
    },
  );
});
