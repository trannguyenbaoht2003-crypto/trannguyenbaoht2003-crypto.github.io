import { pathToFileURL } from 'node:url';

import { Queue } from 'bullmq';

import { parseAiAutomationConfig } from './ai-automation-config.js';
import { createPool } from './database/pool.js';
import {
  createOpenAiResponsesProvider,
} from './modules/ai-provider/openai-responses-provider.js';
import {
  createQueueConnection,
  createWorkerConnection,
} from './queue/connection.js';
import {
  createAiDiscoveryAutomationWorker,
} from './queue/ai-discovery-automation-worker.js';
import {
  reconcileAiDiscoveryScheduler,
} from './queue/ai-discovery-scheduler.js';
import {
  AI_DISCOVERY_AUTOMATION_QUEUE_NAME,
  type AiDiscoveryAutomationJobData,
} from './queue/names.js';

export async function startAiAutomationRuntime(
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ close(): Promise<void> }> {
  const config = parseAiAutomationConfig(env);
  const pool = createPool(config.databaseUrl);
  const queueConnection = createQueueConnection(config.redisUrl);
  const workerConnection = createWorkerConnection(config.redisUrl);
  const queue = new Queue<AiDiscoveryAutomationJobData>(
    AI_DISCOVERY_AUTOMATION_QUEUE_NAME,
    { connection: queueConnection },
  );

  try {
    await reconcileAiDiscoveryScheduler(queue, config.schedulerEnabled);
    const provider = config.schedulerEnabled
      ? createOpenAiResponsesProvider(config.providerConfig!)
      : undefined;
    const worker = createAiDiscoveryAutomationWorker({
      connection: workerConnection,
      pool,
      schedulerEnabled: config.schedulerEnabled,
      ...(provider ? {
        provider,
        modelKey: config.providerConfig!.model,
        modelRevision: config.providerConfig!.model,
      } : {}),
    });

    let closePromise: Promise<void> | undefined;
    return {
      async close(): Promise<void> {
        closePromise ??= (async () => {
          await worker.close();
          await queue.close();
          await Promise.all([
            workerConnection.quit(),
            queueConnection.quit(),
          ]);
          await pool.end();
        })();
        await closePromise;
      },
    };
  } catch (error) {
    await Promise.allSettled([
      queue.close(),
      workerConnection.quit(),
      queueConnection.quit(),
      pool.end(),
    ]);
    throw error;
  }
}

async function main(): Promise<void> {
  let runtime: Awaited<ReturnType<typeof startAiAutomationRuntime>> | null = null;
  try {
    runtime = await startAiAutomationRuntime();
  } catch {
    process.stderr.write('AI_AUTOMATION_START_FAILED\n');
    process.exitCode = 1;
    return;
  }

  let shutdownStarted = false;
  const shutdown = (): void => {
    if (shutdownStarted || !runtime) return;
    shutdownStarted = true;
    void runtime.close().catch(() => {
      process.stderr.write('AI_AUTOMATION_SHUTDOWN_FAILED\n');
      process.exitCode = 1;
    });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

const isDirectExecution = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectExecution) void main();
