import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import test from 'node:test';

import { Queue } from 'bullmq';
import { Redis } from 'ioredis';

import {
  AI_DISCOVERY_SCHEDULER_EVERY_MS,
  AI_DISCOVERY_SCHEDULER_ID,
} from '../src/queue/ai-discovery-scheduler.js';
import { AI_DISCOVERY_AUTOMATION_QUEUE_NAME } from '../src/queue/names.js';

const READY_MARKER = 'AI_AUTOMATION_DISABLED_READY scheduler_enabled=false provider_configured=false';
const backendRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MAX_CAPTURE_BYTES = 64 * 1024;

function requiredEnv(name: 'TEST_DATABASE_URL' | 'TEST_REDIS_URL'): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

function waitForLine(
  child: ReturnType<typeof spawn>,
  expected: string,
  timeoutMs = 15_000,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`timed out waiting for ${expected}; stdout=${stdout}; stderr=${stderr}`));
    }, timeoutMs);
    const appendBounded = (current: string, chunk: string) => {
      const next = current + chunk;
      if (Buffer.byteLength(next, 'utf8') > MAX_CAPTURE_BYTES) {
        return next.slice(-MAX_CAPTURE_BYTES);
      }
      return next;
    };
    const finish = () => {
      if (settled) return;
      if (stdout.split(/\r?\n/u).some((line) => line.trim() === expected)) {
        settled = true;
        clearTimeout(timeout);
        resolvePromise({ stdout, stderr });
      }
    };
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout = appendBounded(stdout, chunk);
      finish();
    });
    child.stderr?.on('data', (chunk: string) => {
      stderr = appendBounded(stderr, chunk);
    });
    child.once('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(new Error(`runtime exited before READY: code=${code} signal=${signal}; stdout=${stdout}; stderr=${stderr}`));
    });
  });
}

test('compiled AI automation runtime removes stale scheduler and stays inert while disabled', async (t) => {
  const databaseUrl = requiredEnv('TEST_DATABASE_URL');
  const redisUrl = requiredEnv('TEST_REDIS_URL');
  const redis = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
  const queue = new Queue(AI_DISCOVERY_AUTOMATION_QUEUE_NAME, { connection: redis });
  t.after(async () => {
    await queue.close();
    await redis.quit();
  });

  await queue.upsertJobScheduler(
    AI_DISCOVERY_SCHEDULER_ID,
    { every: AI_DISCOVERY_SCHEDULER_EVERY_MS },
    {
      name: 'scheduled-ai-discovery',
      data: { schemaVersion: 1 },
      opts: { attempts: 1 },
    },
  );
  const before = await queue.getJobSchedulers(0, 100, true);
  assert.equal(before.some((entry) => entry.key === AI_DISCOVERY_SCHEDULER_ID), true, 'stale scheduler must exist before runtime startup');

  const child = spawn(process.execPath, ['dist/src/ai-automation-worker.js'], {
    cwd: backendRoot,
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      REDIS_URL: redisUrl,
      AI_DISCOVERY_SCHEDULER_ENABLED: 'false',
      AI_DISCOVERY_PROVIDER: 'openai',
      OPENAI_API_KEY: 'dummy-must-be-ignored',
      AI_DISCOVERY_OPENAI_MODEL: 'dummy-must-be-ignored',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  });

  await waitForLine(child, READY_MARKER);
  assert.equal(child.exitCode, null, 'runtime must remain alive after READY');
  assert.equal(child.signalCode, null, 'runtime must not receive a signal before test shutdown');

  const after = await queue.getJobSchedulers(0, 100, true);
  assert.equal(
    after.some((entry) => entry.key === AI_DISCOVERY_SCHEDULER_ID),
    false,
    'stale scheduler must be absent before READY',
  );

  const closed = once(child, 'close');
  child.kill('SIGTERM');
  const [code, signal] = await closed;
  assert.equal(signal, null);
  assert.equal(code, 0);
});
