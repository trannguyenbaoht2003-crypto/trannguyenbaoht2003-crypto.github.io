import { Worker, type Job } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Pool } from 'pg';

import type { AiDiscoveryProvider } from '../modules/ai-provider/openai-responses-provider.js';
import {
  processScheduledAiDiscoveryTick,
  type ProcessScheduledAiDiscoveryTickResult,
} from '../modules/ai-automation/process-scheduled-ai-discovery-tick.js';
import {
  AI_DISCOVERY_AUTOMATION_QUEUE_NAME,
  type AiDiscoveryAutomationJobData,
} from './names.js';

export interface AiDiscoveryAutomationWorkerResult {
  outcome: ProcessScheduledAiDiscoveryTickResult['outcome'] | 'SCHEDULER_DISABLED';
  scheduledAiDiscoveryTickId: string | null;
  aiDiscoveryRunId: string | null;
}

export interface CreateAiDiscoveryAutomationWorkerOptions {
  connection: Redis;
  pool: Pool;
  schedulerEnabled: boolean;
  provider?: AiDiscoveryProvider;
  modelKey?: string;
  modelRevision?: string;
  concurrency?: number;
  now?: () => string;
  processTick?: typeof processScheduledAiDiscoveryTick;
}

function validJobData(value: unknown): value is AiDiscoveryAutomationJobData {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 1 && record.schemaVersion === 1;
}

export async function processAiDiscoveryAutomationJob(
  job: Job<AiDiscoveryAutomationJobData>,
  options: Omit<CreateAiDiscoveryAutomationWorkerOptions, 'connection' | 'concurrency'>,
): Promise<AiDiscoveryAutomationWorkerResult> {
  if (!validJobData(job.data) || job.name !== 'scheduled-ai-discovery') {
    throw new Error('AI_AUTOMATION_JOB_INVALID');
  }
  if (!options.schedulerEnabled) {
    return {
      outcome: 'SCHEDULER_DISABLED',
      scheduledAiDiscoveryTickId: null,
      aiDiscoveryRunId: null,
    };
  }
  if (!options.provider || !options.modelKey || !options.modelRevision) {
    throw new Error('AI_AUTOMATION_PROVIDER_UNAVAILABLE');
  }

  const processTick = options.processTick ?? processScheduledAiDiscoveryTick;
  const now = options.now ?? (() => new Date().toISOString());
  const result = await processTick(options.pool, {
    actorId: 'system:ai-automation',
    correlationId: `ai-automation-job:${job.id ?? 'unknown'}`,
    provider: options.provider,
    modelKey: options.modelKey,
    modelRevision: options.modelRevision,
    startedAt: now(),
  });
  return result;
}

export function createAiDiscoveryAutomationWorker(
  options: CreateAiDiscoveryAutomationWorkerOptions,
): Worker<AiDiscoveryAutomationJobData, AiDiscoveryAutomationWorkerResult> {
  return new Worker<AiDiscoveryAutomationJobData, AiDiscoveryAutomationWorkerResult>(
    AI_DISCOVERY_AUTOMATION_QUEUE_NAME,
    async (job) => processAiDiscoveryAutomationJob(job, options),
    {
      connection: options.connection,
      concurrency: options.concurrency ?? 1,
    },
  );
}
