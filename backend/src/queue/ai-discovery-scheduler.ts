import type { AiDiscoveryAutomationJobData } from './names.js';

export const AI_DISCOVERY_SCHEDULER_ID = 'ai-discovery-hourly-v1';
export const AI_DISCOVERY_SCHEDULER_EVERY_MS = 3_600_000;

export interface AiDiscoverySchedulerQueue {
  upsertJobScheduler(
    schedulerId: string,
    repeat: { every: number },
    template: {
      name: string;
      data: AiDiscoveryAutomationJobData;
      opts: { attempts: 1 };
    },
  ): Promise<unknown>;
  removeJobScheduler(schedulerId: string): Promise<unknown>;
}

export async function reconcileAiDiscoveryScheduler(
  queue: AiDiscoverySchedulerQueue,
  enabled: boolean,
): Promise<'enabled' | 'disabled'> {
  if (!enabled) {
    await queue.removeJobScheduler(AI_DISCOVERY_SCHEDULER_ID);
    return 'disabled';
  }
  await queue.upsertJobScheduler(
    AI_DISCOVERY_SCHEDULER_ID,
    { every: AI_DISCOVERY_SCHEDULER_EVERY_MS },
    {
      name: 'scheduled-ai-discovery',
      data: { schemaVersion: 1 },
      opts: { attempts: 1 },
    },
  );
  return 'enabled';
}
