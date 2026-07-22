import { ADAPTER_METHODS } from '../common/scenarios.mjs';

export const PLATFORM_A_METADATA = Object.freeze({
  platform: 'cloudflare-worker-d1-queues',
  commonHarnessSha: 'dc8deebb478cc5892304662e14dbf8b07ecd1627',
  remoteResourcesAllowed: false,
  productionDeploymentAllowed: false,
});

function notImplemented(method) {
  return async () => {
    throw new Error(`PLATFORM_A_NOT_IMPLEMENTED:${method}`);
  };
}

export async function createCloudflareAdapter(options = {}) {
  if (options.mode !== 'local-test') {
    throw new Error('PLATFORM_A_LOCAL_TEST_ONLY');
  }

  const adapter = Object.fromEntries(ADAPTER_METHODS.map((method) => [method, notImplemented(method)]));
  adapter.close = async () => {};
  return Object.freeze(adapter);
}
