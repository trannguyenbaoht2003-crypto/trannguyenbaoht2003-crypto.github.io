import test from 'node:test';
import assert from 'node:assert/strict';
import { assertAdapterContract } from '../common/scenarios.mjs';
import { createCloudflareAdapter, PLATFORM_A_METADATA } from './adapter.mjs';

test('Platform A identifies the locked Cloudflare spike stack', () => {
  assert.deepEqual(PLATFORM_A_METADATA, {
    platform: 'cloudflare-worker-d1-queues',
    commonHarnessSha: 'dc8deebb478cc5892304662e14dbf8b07ecd1627',
    remoteResourcesAllowed: false,
    productionDeploymentAllowed: false,
  });
});

test('Platform A implements the complete common adapter contract', async () => {
  const adapter = await createCloudflareAdapter({ mode: 'local-test' });
  assert.equal(assertAdapterContract(adapter), true);
  await adapter.close?.();
});
