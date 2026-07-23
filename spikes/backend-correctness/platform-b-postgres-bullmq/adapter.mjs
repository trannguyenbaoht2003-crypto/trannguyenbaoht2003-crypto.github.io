import { createHash, randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import pg from 'pg';
import IORedis from 'ioredis';
import { Queue, Worker } from 'bullmq';
import { generateFixture } from '../common/generate-fixture.mjs';
import { createPostgresDomain } from './domain.mjs';

const { Pool } = pg;

export const PLATFORM_B_METADATA = Object.freeze({
  platform: 'node-fastify-postgresql-bullmq-redis',
  commonHarnessSha: 'dc8deebb478cc5892304662e14dbf8b07ecd1627',
  remoteResourcesAllowed: false,
  productionDeploymentAllowed: false,
});

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}

function checksum(value) {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

function redisConnection(url) {
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: Number(parsed.port || 6379),
    username: parsed.username || undefined,
    password: parsed.password || undefined,
    db: parsed.pathname && parsed.pathname !== '/' ? Number(parsed.pathname.slice(1)) : 0,
    maxRetriesPerRequest: null,
  };
}

export async function createPostgresBullmqAdapter(options = {}) {
  if (options.mode !== 'local-test') throw new Error('PLATFORM_B_LOCAL_TEST_ONLY');

  const databaseUrl = options.databaseUrl ?? process.env.PLATFORM_B_DATABASE_URL;
  const redisUrl = options.redisUrl ?? process.env.PLATFORM_B_REDIS_URL;
  if (!databaseUrl || !redisUrl) throw new Error('PLATFORM_B_LOCAL_SERVICES_REQUIRED');

  const pool = new Pool({ connectionString: databaseUrl, max: 20 });
  await pool.query('SELECT 1');

  const connection = redisConnection(redisUrl);
  const redis = new IORedis(redisUrl, { maxRetriesPerRequest: null });
  await redis.ping();

  const queueName = `hai-dau-platform-b-${process.pid}-${randomUUID()}`;
  const queue = new Queue(queueName, { connection });
  let domain;
  const enqueue = async (body) => queue.add('domain-event', body, {
    jobId: `event-${randomUUID()}`,
    removeOnComplete: true,
    removeOnFail: false,
  });
  domain = createPostgresDomain({ pool, enqueue });

  const worker = new Worker(queueName, async (job) => domain.processEvent(job.data), {
    connection,
    concurrency: 4,
    settings: { backoffStrategy: () => 10 },
  });
  worker.on('error', () => {});
  await Promise.all([queue.waitUntilReady(), worker.waitUntilReady()]);

  const app = Fastify({ logger: false, bodyLimit: 64 * 1024 * 1024 });
  app.setErrorHandler((error, _request, reply) => {
    reply.code(error.status ?? 500).send({ error: error.message });
  });
  app.post('/__spike/reset', async () => domain.reset());
  app.post('/__spike/command', async (request) => domain.executeCommand(request.body));
  app.post('/__spike/inject-failure', async (request) => domain.injectFailure(request.body.point));
  app.post('/__spike/release-failure', async (request) => domain.releaseFailure(request.body.point ?? null));
  app.post('/__spike/dispatch-outbox', async () => domain.dispatchOutbox());
  app.post('/__spike/load-fixture', async (request) => domain.loadFixture(request.body));
  app.post('/__spike/import', async (request) => domain.importState(request.body));
  app.get('/__spike/export', async () => domain.exportState());
  app.get('/__spike/snapshot', async () => domain.snapshot());
  app.get('/__spike/published', async () => domain.publishedContent());
  app.get('/__spike/evidence', async () => domain.collectEvidence());
  app.get('/__spike/health', async () => ({ ok: true, runtime: 'node-fastify', bindings: ['PostgreSQL', 'BullMQ', 'Redis'] }));
  await app.ready();

  async function request(pathname, init = {}) {
    const hasBody = init.body !== undefined && init.body !== null;
    const response = await app.inject({
      method: init.method ?? 'GET',
      url: pathname,
      headers: hasBody ? { 'content-type': 'application/json', ...(init.headers ?? {}) } : (init.headers ?? {}),
      ...(hasBody ? { payload: init.body } : {}),
    });
    const data = response.json();
    if (response.statusCode >= 400) {
      const error = new Error(`PLATFORM_B_REQUEST_FAILED:${response.statusCode}:${data.error ?? 'UNKNOWN'}`);
      error.status = response.statusCode;
      error.code = data.error ?? 'UNKNOWN';
      throw error;
    }
    return data;
  }

  const adapter = {
    async resetEnvironment() {
      await queue.obliterate({ force: true }).catch(() => {});
      return request('/__spike/reset', { method: 'POST' });
    },

    async loadFixture(input = null) {
      const generated = input ?? generateFixture();
      return request('/__spike/load-fixture', { method: 'POST', body: JSON.stringify(generated) });
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

    async drainQueue({ timeoutMs = 10000, expectedEffects = null } = {}) {
      const deadline = Date.now() + timeoutMs;
      let last;
      while (Date.now() < deadline) {
        last = await adapter.snapshotState();
        const target = expectedEffects ?? last.outboxEvents;
        if (last.consumerEffects >= target) return last;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error(`PLATFORM_B_QUEUE_DRAIN_TIMEOUT:${JSON.stringify(last)}`);
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
      return { platform: PLATFORM_B_METADATA.platform, runtime: 'Node.js/Fastify/PostgreSQL/BullMQ/Redis', ...evidence };
    },

    async close() {
      await app.close();
      await worker.close();
      await queue.close();
      await redis.quit();
      await pool.end();
    },
  };

  return adapter;
}
