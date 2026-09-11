import { Worker, type Job } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Pool } from 'pg';
import type { AiReviewProvider } from '../modules/ai-review/ai-review-provider.js';
import { processAutonomousReviewTick } from '../modules/ai-review/run-autonomous-review.js';
export const AI_REVIEW_QUEUE_NAME = 'hai-dau-ai-review-v1';
export const AI_REVIEW_SCHEDULER_ID = 'ai-review-hourly-v1';
export interface AiReviewJobData {
    schemaVersion: 1;
}
interface SchedulerQueue {
    upsertJobScheduler(id: string, repeat: {
        every: number;
    }, template: {
        name: string;
        data: AiReviewJobData;
        opts: {
            attempts: 1;
        };
    }): Promise<unknown>;
    removeJobScheduler(id: string): Promise<unknown>;
}
export async function reconcileAiReviewScheduler(queue: SchedulerQueue, enabled: boolean) {
    if (!enabled) {
        await queue.removeJobScheduler(AI_REVIEW_SCHEDULER_ID);
        return;
    }
    await queue.upsertJobScheduler(AI_REVIEW_SCHEDULER_ID, { every: 3600000 }, { name: 'scheduled-ai-review', data: { schemaVersion: 1 }, opts: { attempts: 1 } });
}
interface ReviewWorkerOptions {
    pool: Pool;
    enabled: boolean;
    provider?: AiReviewProvider;
    model?: string;
    now?: () => string;
}
export async function processAiReviewJob(job: Job, options: ReviewWorkerOptions) {
    const data: unknown = job.data;
    if (job.name !== 'scheduled-ai-review' || !data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).length !== 1 || (data as Record<string, unknown>).schemaVersion !== 1)
        throw new Error('AI_REVIEW_JOB_INVALID');
    if (!options.enabled)
        return { outcome: 'AUTONOMOUS_DISABLED' };
    if (!options.provider || !options.model)
        throw new Error('AI_REVIEW_PROVIDER_UNAVAILABLE');
    return processAutonomousReviewTick(options.pool, { provider: options.provider, model: options.model, ...(options.now ? { now: options.now() } : {}) });
}
export function createAiReviewWorker(options: ReviewWorkerOptions & {
    connection: Redis;
}) {
    return new Worker<AiReviewJobData, Awaited<ReturnType<typeof processAiReviewJob>>>(AI_REVIEW_QUEUE_NAME, job => processAiReviewJob(job, options), { connection: options.connection, concurrency: 1 });
}
