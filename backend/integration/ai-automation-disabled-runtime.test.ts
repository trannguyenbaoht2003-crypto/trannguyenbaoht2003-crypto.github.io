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
const MAX_DIAGNOSTIC_BYTES = 4_096;
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
  timeoutMs = 15_000,
): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    let stdoutBuffer = '';
    let boundedStderr = '';

    const diagnostic = (): string => boundedStderr.trim().slice(0, MAX_DIAGNOSTIC_BYTES);
    const cleanup = (): void => {
      clearTimeout(timer);
      child.stdout?.off('data', onStdout);
      child.stderr?.off('data', onStderr);
      child.off('exit', onExit);
    };
    const onStdout = (chunk: Buffer | string): void => {
      stdoutBuffer += chunk.toString();
      const lines = stdoutBuffer.split(/\r?\n/u);
      stdoutBuffer = lines.pop() ?? '';
      if (lines.some((line) => line.trim() === expected)) {
        cleanup();
        resolvePromise();
      }
    };
    const onStderr = (chunk: Buffer | string): void => {
      if (boundedStderr.length >= MAX_DIAGNOSTIC_BYTES) return;
      boundedStderr += chunk.toString().slice(0, MAX_DIAGNOSTIC_BYTES - boundedStderr.length);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      const stderr = diagnostic();
      cleanup();
      reject(new Error(
        `AI automation exited before readiness: code=${code} signal=${signal}${stderr ? ` stderr=${stderr}` : ''}`,
      ));
    };
    const timer = setTimeout(() => {
      const stderr = diagnostic();
      cleanup();
      reject(new Error(
        `timed out waiting for line: ${expected}${stderr ? ` stderr=${stderr}` : ''}`,
      ));
    }, timeoutMs);

    child.stdout?.on('data', onStdout);
    child.stderr?.on('data', onStderr);
    child.once('exit', onExit);
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
  const seededSchedulers = await queue.getJobSchedulers(0, 100, true);
  assert.equal(
    seededSchedulers.some((scheduler) => scheduler.key === AI_DISCOVERY_SCHEDULER_ID),
    true,
    'integration precondition requires the stale hourly scheduler to exist before startup',
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
  const [code, signal] = await once(child, 'close');
  assert.equal(signal, null);
  assert.equal(code, 0);
});
