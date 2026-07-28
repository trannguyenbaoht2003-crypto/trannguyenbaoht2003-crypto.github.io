import assert from 'node:assert/strict';
import test from 'node:test';

import { buildApp } from '../src/app.js';
import type { ResourceHealth } from '../src/resources.js';

const failingResources: ResourceHealth = {
  async checkPostgres() {
    return false;
  },
  async checkRedis() {
    return false;
  },
};

const healthyResources: ResourceHealth = {
  async checkPostgres() {
    return true;
  },
  async checkRedis() {
    return true;
  },
};

test('live endpoint does not depend on external resources', async () => {
  const app = buildApp({ resources: failingResources, logger: false });

  const response = await app.inject({ method: 'GET', url: '/health/live' });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { status: 'live' });
  await app.close();
});

test('ready endpoint fails closed without leaking resource detail', async () => {
  const app = buildApp({ resources: failingResources, logger: false });

  const response = await app.inject({ method: 'GET', url: '/health/ready' });

  assert.equal(response.statusCode, 503);
  assert.deepEqual(response.json(), { status: 'not_ready' });
  assert.doesNotMatch(response.body, /postgres:|redis:|password/i);
  await app.close();
});

test('ready endpoint reports ready only when every resource is healthy', async () => {
  const app = buildApp({ resources: healthyResources, logger: false });

  const response = await app.inject({ method: 'GET', url: '/health/ready' });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { status: 'ready' });
  await app.close();
});
