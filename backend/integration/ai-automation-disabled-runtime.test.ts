import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import test from 'node:test';

import { Queue } from 'bullmq';

import { createQueueConnection } from '../src/queue/connection.js';
import {
  AI_DISCOVERY_SCHEDULER_EVERY_MS,
  AI_DISCOVERY_SCHEDULER_ID,
} from '../src/queue/ai-discovery-scheduler.js';
import {
  AI_DISCOVERY_AUTOMATION_QUEUE_NAME,
  type AiDiscoveryAutomationJobData,
} from '../src/queue/names.js';

const READY_MARKER = 'AI_AUTOMATION_DISABLED_READY scheduler_enabled=false provider_configured=false';
const backendRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const compiledRuntimePath = resolve(backendRoot, 'dist/src/ai-automation-worker.js');

function requiredEnv(name: 'TEST_DATABASE_URL' | 'TEST_REDIS_URL'): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

function waitForLine(
  child: ReturnType<typeof spawn>,
  expected: string,
  timeoutMs = 10_000,
): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    let buffer = '';
    const timer = setTimeout(() => {
      reject(new Error(`timed out waiting for line: ${expected}`));
    }, timeoutMs);
    const onData = (chunk: Buffer | string): void => {
      buffer += chunk.toString();
      const lines = buffer.split(/\r?\n/u);
      buffer = lines.pop() ?? '';
      if (lines.some((line) => line.trim() === expected)) {
        clearTimeout(timer);
        child.stdout?.off('data', onData);
        resolvePromise();
      }
    };
    child.stdout?.on('data', onData);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`AI automation exited before readiness: code=${code} signal=${signal}`));
    });
  });
}

test('compiled disabled AI automation reconciles stale scheduler, becomes ready, stays alive, and exits cleanly', async (t) => {
  const databaseUrl = requiredEnv('TEST_DATABASE_URL');
  const redisUrl = requiredEnv('TEST_REDIS_URL');
  const connection = createQueueConnection(redisUrl);
  const queue = new Queue<AiDiscoveryAutomationJobData>(
    AI_DISCOVERY_AUTOMATION_QUEUE_NAME,
    { connection },
  );
  t.after(async () => {
    await queue.close();
    await connection.quit();
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

  await access(compiledRuntimePath);

  const child = spawn(process.execPath, ['dist/src/ai-automation-worker.js'], {
    cwd: backendRoot,
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      REDIS_URL: redisUrl,
      AI_DISCOVERY_SCHEDULER_ENABLED: 'false',
      OPENAI_API_KEY: 'dummy-must-be-ignored',
      OPENAI_MODEL: 'dummy-must-be-ignored',
      AI_DISCOVERY_PROVIDER: 'openai',
      AI_DISCOVERY_OPENAI_MODEL: 'dummy-must-be-ignored',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  });

  await waitForLine(child, READY_MARKER);
  assert.equal(child.exitCode, null);
  assert.equal(child.signalCode, null);

  const schedulers = await queue.getJobSchedulers(0, 100, true);
  assert.equal(
    schedulers.some((scheduler) => scheduler.key === AI_DISCOVERY_SCHEDULER_ID),
    false,
    'disabled runtime must remove the stale hourly scheduler before readiness',
  );

  child.kill('SIGTERM');
  const [code, signal] = await once(child, 'exit');
  assert.equal(signal, null);
  assert.equal(code, 0);
});
