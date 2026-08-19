import { pathToFileURL } from 'node:url';

import { Queue } from 'bullmq';
import { Pool } from 'pg';

import { readAiOperationsSnapshot } from './modules/ai-operations/read-ai-operations-snapshot.js';
import { createQueueConnection } from './queue/connection.js';
import {
  AI_DISCOVERY_SCHEDULER_EVERY_MS,
  AI_DISCOVERY_SCHEDULER_ID,
} from './queue/ai-discovery-scheduler.js';
import {
  AI_DISCOVERY_AUTOMATION_QUEUE_NAME,
  type AiDiscoveryAutomationJobData,
} from './queue/names.js';

export interface AiAutomationStatusConfig {
  databaseUrl: string;
  redisUrl: string;
  schedulerEnabled: boolean;
}

function required(env: NodeJS.ProcessEnv, name: 'DATABASE_URL' | 'REDIS_URL'): string {
  const value = env[name]?.trim();
  if (!value) throw new Error('AI_AUTOMATION_STATUS_CONFIG_INVALID');
  return value;
}

export function parseAiAutomationStatusConfig(env: NodeJS.ProcessEnv): AiAutomationStatusConfig {
  const flag = env.AI_DISCOVERY_SCHEDULER_ENABLED;
  if (flag !== undefined && flag !== 'true' && flag !== 'false') {
    throw new Error('AI_AUTOMATION_STATUS_CONFIG_INVALID');
  }
  return {
    databaseUrl: required(env, 'DATABASE_URL'),
    redisUrl: required(env, 'REDIS_URL'),
    schedulerEnabled: flag === 'true',
  };
}

function safeSchedulerEntry(entry: unknown): Record<string, unknown> | null {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const record = entry as Record<string, unknown>;
  const identity = record.key ?? record.id;
  if (identity !== AI_DISCOVERY_SCHEDULER_ID) return null;
  return {
    id: AI_DISCOVERY_SCHEDULER_ID,
    everyMs: typeof record.every === 'number'
      ? record.every
      : AI_DISCOVERY_SCHEDULER_EVERY_MS,
    next: typeof record.next === 'number' ? record.next : null,
  };
}

export async function runAiAutomationStatus(
  env: NodeJS.ProcessEnv = process.env,
): Promise<Record<string, unknown>> {
  const config = parseAiAutomationStatusConfig(env);
  const pool = new Pool({ connectionString: config.databaseUrl });
  const connection = createQueueConnection(config.redisUrl);
  const queue = new Queue<AiDiscoveryAutomationJobData>(
    AI_DISCOVERY_AUTOMATION_QUEUE_NAME,
    { connection },
  );
  try {
    const [snapshot, entries] = await Promise.all([
      readAiOperationsSnapshot(pool),
      queue.getJobSchedulers(0, 100, true),
    ]);
    const scheduler = entries.map(safeSchedulerEntry).find((entry) => entry !== null) ?? null;
    return {
      desiredSchedulerEnabled: config.schedulerEnabled,
      scheduler,
      automation: snapshot.automation,
      activePolicy: snapshot.activePolicy,
      budget: snapshot.budget,
      proposals: snapshot.proposals,
    };
  } finally {
    await Promise.allSettled([
      queue.close(),
      connection.quit(),
      pool.end(),
    ]);
  }
}

async function main(): Promise<void> {
  if (process.argv.length > 2) {
    process.stderr.write('AI_AUTOMATION_STATUS_FAILED\n');
    process.exitCode = 1;
    return;
  }
  try {
    process.stdout.write(`${JSON.stringify(await runAiAutomationStatus())}\n`);
  } catch {
    process.stderr.write('AI_AUTOMATION_STATUS_FAILED\n');
    process.exitCode = 1;
  }
}

const isDirectExecution = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectExecution) void main();
