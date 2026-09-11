import { pathToFileURL } from 'node:url';

import { Queue } from 'bullmq';
import { createAiReviewProvider } from './modules/ai-review/ai-review-provider.js';
import { ensureAutonomousReviewPolicy } from './modules/ai-review/run-autonomous-review.js';
import { AI_REVIEW_QUEUE_NAME, createAiReviewWorker, reconcileAiReviewScheduler, type AiReviewJobData } from './queue/ai-review-worker.js';

import {
  parseAiAutomationConfig,
  type AiAutomationConfig,
} from './ai-automation-config.js';
import { createPool } from './database/pool.js';
import {
  createOpenAiResponsesProvider,
  type AiDiscoveryProvider,
  type OpenAiResponsesProviderConfig,
} from './modules/ai-provider/openai-responses-provider.js';
import { recoverStaleAiProviderExecutions } from './modules/ai-provider-execution/recover-stale-ai-provider-executions.js';
import { createQueueConnection, createWorkerConnection } from './queue/connection.js';
import { createAiDiscoveryAutomationWorker } from './queue/ai-discovery-automation-worker.js';
import { reconcileAiDiscoveryScheduler } from './queue/ai-discovery-scheduler.js';
import {
  AI_DISCOVERY_AUTOMATION_QUEUE_NAME,
  type AiDiscoveryAutomationJobData,
} from './queue/names.js';

export type AiAutomationProviderFactory = (
  config: OpenAiResponsesProviderConfig,
) => AiDiscoveryProvider;

export function createAiAutomationProvider(
  config: AiAutomationConfig,
  factory: AiAutomationProviderFactory,
): AiDiscoveryProvider | undefined {
  if (!config.schedulerEnabled) return undefined;
  return factory(config.providerConfig!);
}

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

  const reviewQueue = new Queue<AiReviewJobData>(AI_REVIEW_QUEUE_NAME, { connection: queueConnection });
  let worker: ReturnType<typeof createAiDiscoveryAutomationWorker> | undefined;
  let reviewWorker: ReturnType<typeof createAiReviewWorker> | undefined;
  const cleanup = async (): Promise<void> => {
    await Promise.allSettled([worker?.close(), reviewWorker?.close()]);
    await Promise.allSettled([queue.close(), reviewQueue.close()]);
    await Promise.allSettled([workerConnection.quit(), queueConnection.quit()]);
    await pool.end();
  };
  try {
    await recoverStaleAiProviderExecutions(pool);
    if (config.autonomousPublicationEnabled) await ensureAutonomousReviewPolicy(pool, {model: config.reviewProviderConfig!.model});
    await reconcileAiReviewScheduler(reviewQueue, config.autonomousPublicationEnabled);
    await reconcileAiDiscoveryScheduler(queue, config.schedulerEnabled);

    const provider = createAiAutomationProvider(config, createOpenAiResponsesProvider);
    worker = createAiDiscoveryAutomationWorker({
      connection: workerConnection,
      pool,
      schedulerEnabled: config.schedulerEnabled,
      ...(provider
        ? {
            provider,
            modelKey: config.providerConfig!.model,
            modelRevision: config.providerConfig!.model,
          }
        : {}),
    });

    const reviewProvider = config.autonomousPublicationEnabled ? createAiReviewProvider(config.reviewProviderConfig!) : undefined;
    reviewWorker = createAiReviewWorker({connection: workerConnection, pool, enabled: config.autonomousPublicationEnabled, ...(reviewProvider ? {provider: reviewProvider, model: config.reviewProviderConfig!.model} : {})});
    await Promise.all([worker.waitUntilReady(), reviewWorker.waitUntilReady()]);
    if (!config.schedulerEnabled && !config.autonomousPublicationEnabled) {
      process.stdout.write(
        'AI_AUTOMATION_DISABLED_READY scheduler_enabled=false provider_configured=false\n',
      );
    } else {
      process.stdout.write(`AI_AUTOMATION_READY scheduler_enabled=${config.schedulerEnabled} autonomous_publication_enabled=${config.autonomousPublicationEnabled}\n`);
    }

    let closePromise: Promise<void> | undefined;
    return {
      async close(): Promise<void> {
        closePromise ??= cleanup();
        await closePromise;
      },
    };
  } catch (error) {
    await cleanup().catch(() => undefined);
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
