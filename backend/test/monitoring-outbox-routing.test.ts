import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import {
  MONITORING_QUEUE_NAME,
} from '../src/queue/names.js';
import {
  dispatchOutbox,
  type OutboxQueue,
} from '../src/queue/outbox-dispatcher.js';
import { resetDatabase } from './helpers/database.js';

test('dispatcher sends all monitoring input and output events only to the monitoring queue', async () => {
  const pool = await resetDatabase();
  const events = [
    'CandidateEligibilityEvaluated',
    'PublicationMonitoringRequested',
    'PublicationMonitoringAlertOpened',
    'PublicationMonitoringAlertResolved',
  ] as const;
  const ids = events.map(() => randomUUID());
  for (let index = 0; index < events.length; index += 1) {
    await pool.query(
      `insert into outbox_events
         (outbox_event_id, aggregate_type, aggregate_id, event_type,
          payload, correlation_id)
       values ($1, 'monitoring-test', $2, $3, '{}'::jsonb, $4)`,
      [ids[index], randomUUID(), events[index], randomUUID()],
    );
  }

  const seen: string[] = [];
  const sink = (): OutboxQueue => ({
    async add(_name, _data, options) {
      seen.push(String(options.jobId));
    },
  });
  const monitoringJobs: string[] = [];
  const result = await dispatchOutbox({
    pool,
    queues: {
      eligibility: sink(),
      monitoring: {
        async add(_name, _data, options) {
          monitoringJobs.push(String(options.jobId));
        },
      },
      normalization: sink(),
      publication: sink(),
    },
  });

  assert.equal(MONITORING_QUEUE_NAME, 'hai-dau-monitoring-v1');
  assert.deepEqual(result, { claimed: 4, delivered: 4, failed: 0 });
  assert.deepEqual(monitoringJobs.sort(), [...ids].sort());
  assert.deepEqual(seen, []);
  await pool.end();
});
