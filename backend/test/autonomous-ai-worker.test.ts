import assert from 'node:assert/strict';
import test from 'node:test';
import type { Job } from 'bullmq';
import type { Pool } from 'pg';
import { processAiReviewJob, reconcileAiReviewScheduler } from '../src/queue/ai-review-worker.js';
import { autonomousClock } from '../src/modules/ai-review/autonomous-review-journal.js';
test('autonomous scheduler has exact hourly identity, payload and no retry', async () => {
    const calls: unknown[][] = [];
    const queue = { async upsertJobScheduler(...args: unknown[]) { calls.push(args); }, async removeJobScheduler(...args: unknown[]) { calls.push(args); } };
    await reconcileAiReviewScheduler(queue, true);
    await reconcileAiReviewScheduler(queue, false);
    assert.deepEqual(calls, [['ai-review-hourly-v1', { every: 3600000 }, { name: 'scheduled-ai-review', data: { schemaVersion: 1 }, opts: { attempts: 1 } }], ['ai-review-hourly-v1']]);
});
test('disabled review job performs no database or provider work; injected jobs rejected first', async () => {
    const options = { pool: {} as Pool, enabled: false };
    assert.deepEqual(await processAiReviewJob({ name: 'scheduled-ai-review', data: { schemaVersion: 1 } } as Job, options), { outcome: 'AUTONOMOUS_DISABLED' });
    for (const job of [{ name: 'wrong', data: { schemaVersion: 1 } }, { name: 'scheduled-ai-review', data: { schemaVersion: 1, now: '2026-01-01T00:00:00.000Z' } }, { name: 'scheduled-ai-review', data: null }])
        await assert.rejects(processAiReviewJob(job as Job, options), /JOB_INVALID/);
});
test('UTC clock validates canonical trusted timestamps and rolls day boundary', () => {
    assert.deepEqual(autonomousClock('2026-09-11T00:59:00.000Z'), { now: '2026-09-11T00:59:00.000Z', tick: '2026-09-11T00:00:00.000Z', day: '2026-09-11' });
    for (const invalid of ['2026-09-10', '2026-02-30T00:00:00.000Z', '2026-09-10T01:00:00+01:00', 'bad'])
        assert.throws(() => autonomousClock(invalid), /TIMESTAMP_INVALID/);
});
