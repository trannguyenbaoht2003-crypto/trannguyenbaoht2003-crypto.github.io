import test from 'node:test';
import assert from 'node:assert/strict';
import { assertAdapterContract } from '../common/scenarios.mjs';
import { createPostgresBullmqAdapter, PLATFORM_B_METADATA } from './adapter.mjs';

test('Platform B identifies the locked PostgreSQL and BullMQ spike stack', () => {
  assert.deepEqual(PLATFORM_B_METADATA, {
    platform: 'node-fastify-postgresql-bullmq-redis',
    commonHarnessSha: 'dc8deebb478cc5892304662e14dbf8b07ecd1627',
    remoteResourcesAllowed: false,
    productionDeploymentAllowed: false,
  });
});

test('Platform B implements the complete common adapter contract', async () => {
  const adapter = await createPostgresBullmqAdapter({ mode: 'local-test' });
  assert.equal(assertAdapterContract(adapter), true);
  await adapter.close?.();
});
