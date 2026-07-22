import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';

export const PLATFORM_A_METADATA = Object.freeze({
  platform: 'cloudflare-worker-d1-queues',
  commonHarnessSha: 'dc8deebb478cc5892304662e14dbf8b07ecd1627',
  remoteResourcesAllowed: false,
  productionDeploymentAllowed: false,
});

const PLATFORM_DIR = fileURLToPath(new URL('.', import.meta.url));
const WORKER_PATH = path.join(PLATFORM_DIR, 'worker.mjs');

function checksum(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export async function createCloudflareAdapter(options = {}) {
  if (options.mode !== 'local-test') {
    throw new Error('PLATFORM_A_LOCAL_TEST_ONLY');
  }

  const runtime = new Miniflare({
    modules: true,
    scriptPath: WORKER_PATH,
    compatibilityDate: '2026-07-22',
    d1Databases: { DB: 'hai-dau-platform-a-correctness' },
    queueProducers: { EVENT_QUEUE: 'hai-dau-platform-a-events' },
    queueConsumers: {
      'hai-dau-platform-a-events': {
        maxBatchSize: 10,
        maxBatchTimeout: 1,
        maxRetries: 3,
      },
    },
    cf: false,
  });

  async function request(pathname, init = {}) {
    const response = await runtime.dispatchFetch(`http://platform-a.local${pathname}`, {
      ...init,
      headers: {
        'content-type': 'application/json',
        ...(init.headers ?? {}),
      },
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(`PLATFORM_A_REQUEST_FAILED:${response.status}:${data.error ?? 'UNKNOWN'}`);
    }
    return data;
  }

  const adapter = {
    async resetEnvironment() {
      await request('/__spike/reset', { method: 'POST' });
    },

    async loadFixture() {
      return { loaded: false, reason: 'fixture-loading-not-implemented-in-smoke-slice' };
    },

    async executeCommand(command) {
      return request('/__spike/command', { method: 'POST', body: JSON.stringify(command) });
    },

    async injectFailure() {
      return { injected: false, reason: 'failure-injection-not-implemented-in-smoke-slice' };
    },

    async releaseBarrier() {
      return { released: false, reason: 'barriers-not-implemented-in-smoke-slice' };
    },

    async dispatchOutbox() {
      return request('/__spike/dispatch-outbox', { method: 'POST' });
    },

    async drainQueue({ timeoutMs = 5000 } = {}) {
      const deadline = Date.now() + timeoutMs;
      let last;
      while (Date.now() < deadline) {
        last = await adapter.snapshotState();
        if (last.consumerEffects >= last.deliveredOutboxEvents) return last;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error(`PLATFORM_A_QUEUE_DRAIN_TIMEOUT:${JSON.stringify(last)}`);
    },

    async snapshotState() {
      return request('/__spike/snapshot');
    },

    async computeChecksums() {
      const state = await adapter.snapshotState();
      return { state: checksum(state) };
    },

    async backupState() {
      return { snapshot: await adapter.snapshotState() };
    },

    async restoreState() {
      throw new Error('PLATFORM_A_NOT_IMPLEMENTED:restoreState');
    },

    async readPublishedContent() {
      return [];
    },

    async collectEvidence() {
      return {
        platform: PLATFORM_A_METADATA.platform,
        state: await adapter.snapshotState(),
      };
    },

    async close() {
      await runtime.dispose();
    },
  };

  return adapter;
}
