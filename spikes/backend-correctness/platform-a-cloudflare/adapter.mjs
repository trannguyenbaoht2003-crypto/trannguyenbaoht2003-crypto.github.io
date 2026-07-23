import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';
import { generateFixture } from '../common/generate-fixture.mjs';

export const PLATFORM_A_METADATA = Object.freeze({
  platform: 'cloudflare-worker-d1-queues',
  commonHarnessSha: '65e5ad092f40ef232041967a1a13160bd4ada834',
  remoteResourcesAllowed: false,
  productionDeploymentAllowed: false,
});

const PLATFORM_DIR = fileURLToPath(new URL('.', import.meta.url));
const WORKER_PATH = path.join(PLATFORM_DIR, 'worker.mjs');
const COMPATIBILITY_DATE = '2026-05-22';

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function checksum(value) {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

export async function createCloudflareAdapter(options = {}) {
  if (options.mode !== 'local-test') throw new Error('PLATFORM_A_LOCAL_TEST_ONLY');

  const runtime = new Miniflare({
    modules: true,
    scriptPath: WORKER_PATH,
    compatibilityDate: COMPATIBILITY_DATE,
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
      const error = new Error(`PLATFORM_A_REQUEST_FAILED:${response.status}:${data.error ?? 'UNKNOWN'}`);
      error.status = response.status;
      error.code = data.error ?? 'UNKNOWN';
      throw error;
    }
    return data;
  }

  const adapter = {
    async resetEnvironment() {
      return request('/__spike/reset', { method: 'POST' });
    },

    async loadFixture(input = null) {
      const generated = input ?? generateFixture();
      return request('/__spike/load-fixture', {
        method: 'POST',
        body: JSON.stringify(generated),
      });
    },

    async executeCommand(command) {
      return request('/__spike/command', { method: 'POST', body: JSON.stringify(command) });
    },

    async injectFailure(point) {
      return request('/__spike/inject-failure', { method: 'POST', body: JSON.stringify({ point }) });
    },

    async releaseBarrier(point = null) {
      return request('/__spike/release-failure', { method: 'POST', body: JSON.stringify({ point }) });
    },

    async dispatchOutbox() {
      return request('/__spike/dispatch-outbox', { method: 'POST' });
    },

    async drainQueue({ timeoutMs = 8000, expectedEffects = null } = {}) {
      const deadline = Date.now() + timeoutMs;
      let last;
      while (Date.now() < deadline) {
        last = await adapter.snapshotState();
        const target = expectedEffects ?? last.outboxEvents;
        if (last.consumerEffects >= target) return last;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error(`PLATFORM_A_QUEUE_DRAIN_TIMEOUT:${JSON.stringify(last)}`);
    },

    async snapshotState() {
      return request('/__spike/snapshot');
    },

    async computeChecksums() {
      const state = await adapter.snapshotState();
      return { state: checksum(state), canonicalState: canonical(state) };
    },

    async backupState() {
      return request('/__spike/export');
    },

    async restoreState(snapshot) {
      return request('/__spike/import', { method: 'POST', body: JSON.stringify(snapshot) });
    },

    async readPublishedContent() {
      return request('/__spike/published');
    },

    async collectEvidence() {
      const evidence = await request('/__spike/evidence');
      return {
        platform: PLATFORM_A_METADATA.platform,
        compatibilityDate: COMPATIBILITY_DATE,
        ...evidence,
      };
    },

    async close() {
      await runtime.dispose();
    },
  };

  return adapter;
}
