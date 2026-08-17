import assert from 'node:assert/strict';
import test from 'node:test';

import {
  OPERATOR_CSS,
  OPERATOR_HTML,
  OPERATOR_JS,
} from '../src/operator/assets.js';
import { buildOperatorApp } from '../src/operator/http.js';
import type { OperatorSnapshot } from '../src/modules/operator/types.js';

const EMPTY_SNAPSHOT: OperatorSnapshot = {
  schemaVersion: 1,
  generatedAt: '2026-08-17T04:00:00.000Z',
  sinceHours: 168,
  summary: { critical: 0, warning: 0, feedbackOnly: 0, total: 0 },
  signals: [],
};

function expectedSecurityHeaders(headers: Record<string, string | string[] | undefined>) {
  assert.equal(headers['cache-control'], 'no-store');
  assert.equal(headers['x-content-type-options'], 'nosniff');
  assert.equal(headers['referrer-policy'], 'no-referrer');
  const csp = headers['content-security-policy'];
  assert.equal(typeof csp, 'string');
  assert.match(String(csp), /default-src 'none'/);
  assert.match(String(csp), /connect-src 'self'/);
  assert.match(String(csp), /frame-ancestors 'none'/);
}

test('operator snapshot route returns a closed snapshot and passes strict bounded options', async () => {
  let observedOptions: unknown;
  const app = buildOperatorApp({
    logger: false,
    checkPostgres: async () => true,
    readSnapshot: async (options) => {
      observedOptions = options;
      return {
        ...EMPTY_SNAPSHOT,
        generatedAt: options.now.toISOString(),
        sinceHours: options.sinceHours,
      };
    },
    now: () => new Date('2026-08-17T05:00:00.000Z'),
  });

  const response = await app.inject({
    method: 'GET',
    url: '/api/operator/v1/snapshot?sinceHours=24&limit=10&detailSampleLimit=2',
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    ...EMPTY_SNAPSHOT,
    generatedAt: '2026-08-17T05:00:00.000Z',
    sinceHours: 24,
  });
  assert.deepEqual(observedOptions, {
    sinceHours: 24,
    limit: 10,
    detailSampleLimit: 2,
    now: new Date('2026-08-17T05:00:00.000Z'),
  });
  expectedSecurityHeaders(response.headers);
  await app.close();
});

test('operator snapshot route applies exact defaults', async () => {
  let observedOptions: unknown;
  const app = buildOperatorApp({
    logger: false,
    checkPostgres: async () => true,
    readSnapshot: async (options) => {
      observedOptions = options;
      return EMPTY_SNAPSHOT;
    },
  });

  const response = await app.inject({ method: 'GET', url: '/api/operator/v1/snapshot' });
  assert.equal(response.statusCode, 200);
  assert.ok(observedOptions && typeof observedOptions === 'object');
  const defaults = observedOptions as {
    sinceHours: number;
    limit: number;
    detailSampleLimit: number;
    now: unknown;
  };
  assert.equal(defaults.sinceHours, 168);
  assert.equal(defaults.limit, 50);
  assert.equal(defaults.detailSampleLimit, 3);
  assert.ok(defaults.now instanceof Date);
  await app.close();
});

test('operator snapshot rejects malformed, out-of-range, duplicate, and unknown query parameters before reading', async () => {
  let reads = 0;
  const app = buildOperatorApp({
    logger: false,
    checkPostgres: async () => true,
    readSnapshot: async () => {
      reads += 1;
      return EMPTY_SNAPSHOT;
    },
  });

  const invalidUrls = [
    '/api/operator/v1/snapshot?sinceHours=0',
    '/api/operator/v1/snapshot?sinceHours=721',
    '/api/operator/v1/snapshot?sinceHours=1.5',
    '/api/operator/v1/snapshot?limit=0',
    '/api/operator/v1/snapshot?limit=101',
    '/api/operator/v1/snapshot?detailSampleLimit=-1',
    '/api/operator/v1/snapshot?detailSampleLimit=6',
    '/api/operator/v1/snapshot?limit=1&limit=2',
    '/api/operator/v1/snapshot?unexpected=1',
  ];

  for (const url of invalidUrls) {
    const response = await app.inject({ method: 'GET', url });
    assert.equal(response.statusCode, 400, url);
    assert.deepEqual(response.json(), {
      error: {
        code: 'INVALID_OPERATOR_QUERY',
        message: 'Invalid operator snapshot query',
      },
    });
  }
  assert.equal(reads, 0);
  await app.close();
});

test('operator snapshot failure is sanitized and write methods are absent', async () => {
  const app = buildOperatorApp({
    logger: false,
    checkPostgres: async () => true,
    readSnapshot: async () => {
      throw new Error('postgres://secret-user:secret-password@database/internal');
    },
  });

  const failed = await app.inject({ method: 'GET', url: '/api/operator/v1/snapshot' });
  assert.equal(failed.statusCode, 503);
  assert.deepEqual(failed.json(), {
    error: {
      code: 'OPERATOR_SNAPSHOT_UNAVAILABLE',
      message: 'Operator snapshot is temporarily unavailable',
    },
  });
  assert.doesNotMatch(failed.body, /secret|postgres:\/\//i);

  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
    const response = await app.inject({ method, url: '/api/operator/v1/snapshot' });
    assert.equal(response.statusCode, 404, method);
  }
  await app.close();
});

test('operator readiness checks PostgreSQL only and shell assets stay available', async () => {
  let checks = 0;
  const app = buildOperatorApp({
    logger: false,
    checkPostgres: async () => {
      checks += 1;
      return false;
    },
    readSnapshot: async () => EMPTY_SNAPSHOT,
  });

  const live = await app.inject({ method: 'GET', url: '/health/live' });
  assert.equal(live.statusCode, 200);
  assert.deepEqual(live.json(), { status: 'live' });

  const ready = await app.inject({ method: 'GET', url: '/health/ready' });
  assert.equal(ready.statusCode, 503);
  assert.deepEqual(ready.json(), { status: 'not_ready' });
  assert.equal(checks, 1);

  for (const [url, contentType] of [
    ['/', 'text/html'],
    ['/operator.js', 'text/javascript'],
    ['/operator.css', 'text/css'],
  ] as const) {
    const response = await app.inject({ method: 'GET', url });
    assert.equal(response.statusCode, 200, url);
    assert.match(String(response.headers['content-type']), new RegExp(contentType));
    expectedSecurityHeaders(response.headers);
  }
  await app.close();
});

test('operator assets are self-contained, manual-refresh only, and render untrusted detail as text', () => {
  const assets = `${OPERATOR_HTML}\n${OPERATOR_CSS}\n${OPERATOR_JS}`;
  assert.doesNotMatch(assets, /https?:\/\//i);
  assert.doesNotMatch(assets, /localStorage|sessionStorage|indexedDB/i);
  assert.doesNotMatch(assets, /innerHTML|insertAdjacentHTML|document\.write/i);
  assert.doesNotMatch(assets, /setInterval|setTimeout/i);
  assert.match(OPERATOR_JS, /textContent/);
  assert.match(OPERATOR_JS, /Làm mới/);
  assert.match(OPERATOR_JS, /\/api\/operator\/v1\/snapshot/);
});
