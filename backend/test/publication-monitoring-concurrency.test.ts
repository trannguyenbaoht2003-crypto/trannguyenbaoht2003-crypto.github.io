import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  evaluatePublicationMonitoring,
} from '../src/modules/monitoring/evaluate-publication-monitoring.js';
import {
  publishCandidateRevision,
} from '../src/modules/publication/publish-candidate-revision.js';
import {
  rollbackPublication,
} from '../src/modules/publication/rollback-publication.js';
import type {
  PublishCandidateRevisionCommand,
  RollbackPublicationCommand,
} from '../src/modules/publication/types.js';
import { resetDatabase } from './helpers/database.js';
import { GATE_IDS } from './helpers/gate.js';
import {
  PUBLICATION_IDS,
  seedEligiblePublicationContext,
} from './helpers/publication.js';

const IDS = {
  v2: '7f000000-0000-4000-8000-000000000001',
  a2: '7f000000-0000-4000-8000-000000000002',
  audit2: '7f000000-0000-4000-8000-000000000003',
  outbox2: '7f000000-0000-4000-8000-000000000004',
  rollbackActivation: '7f000000-0000-4000-8000-000000000005',
  rollbackAudit: '7f000000-0000-4000-8000-000000000006',
  rollbackOutbox: '7f000000-0000-4000-8000-000000000007',
  tamperedSource: '7f000000-0000-4000-8000-000000000008',
} as const;

function publishV1(): PublishCandidateRevisionCommand {
  return {
    publicationId: PUBLICATION_IDS.publicationId,
    publicationVersionId: PUBLICATION_IDS.publicationVersionId,
    activationId: PUBLICATION_IDS.activationId,
    candidateRevisionId: '62000000-0000-4000-8000-000000000002',
    expectedActiveEligibilityPolicyRevisionId: GATE_IDS.eligibilityPolicyId,
    expectedEligibilityEvaluationId: GATE_IDS.eligibilityEvaluationId,
    expectedModerationDecisionId: GATE_IDS.moderationDecisionId,
    expectedActivePublicationVersionId: null,
    authorization: { actorId: 'publisher', permissions: ['publisher'] },
    auditId: PUBLICATION_IDS.auditId,
    outboxEventId: PUBLICATION_IDS.outboxEventId,
    correlationId: 'monitoring-concurrency-v1',
    idempotencyKey: 'monitoring-concurrency-v1',
    occurredAt: '2026-08-14T09:40:00.000Z',
  };
}

function publishV2(): PublishCandidateRevisionCommand {
  return {
    ...publishV1(),
    publicationVersionId: IDS.v2,
    activationId: IDS.a2,
    expectedActivePublicationVersionId: PUBLICATION_IDS.publicationVersionId,
    auditId: IDS.audit2,
    outboxEventId: IDS.outbox2,
    correlationId: 'monitoring-concurrency-v2',
    idempotencyKey: 'monitoring-concurrency-v2',
    occurredAt: '2026-08-14T09:41:00.000Z',
  };
}

function rollbackToV1(): RollbackPublicationCommand {
  return {
    publicationId: PUBLICATION_IDS.publicationId,
    targetPublicationVersionId: PUBLICATION_IDS.publicationVersionId,
    activationId: IDS.rollbackActivation,
    expectedActivePublicationVersionId: IDS.v2,
    authorization: { actorId: 'publisher', permissions: ['publisher'] },
    auditId: IDS.rollbackAudit,
    outboxEventId: IDS.rollbackOutbox,
    correlationId: 'monitoring-concurrency-rollback',
    idempotencyKey: 'monitoring-concurrency-rollback',
    occurredAt: '2026-08-14T09:42:00.000Z',
  };
}

async function monitoringRequestForActivation(
  pool: Awaited<ReturnType<typeof resetDatabase>>,
  activationId: string,
): Promise<string> {
  const result = await pool.query<{ outbox_event_id: string }>(
    `select outbox_event_id
       from outbox_events
      where event_type = 'PublicationMonitoringRequested'
        and payload ->> 'activationId' = $1
      order by created_at desc
      limit 1`,
    [activationId],
  );
  const id = result.rows[0]?.outbox_event_id;
  assert.ok(id, `missing monitoring request for ${activationId}`);
  return id;
}

async function activeVersion(
  pool: Awaited<ReturnType<typeof resetDatabase>>,
): Promise<string | null> {
  const result = await pool.query<{ publication_version_id: string }>(
    `select publication_version_id
       from active_publication_versions
      where publication_id = $1`,
    [PUBLICATION_IDS.publicationId],
  );
  return result.rows[0]?.publication_version_id ?? null;
}

async function assertNoStaleOpenAlert(
  pool: Awaited<ReturnType<typeof resetDatabase>>,
): Promise<void> {
  const result = await pool.query<{ count: string }>(
    `select count(*)
       from current_publication_monitoring_alerts current
       left join active_publication_versions active
         on active.publication_id = current.publication_id
      where current.state = 'open'
        and (
          active.publication_version_id is null
          or active.publication_version_id <> current.publication_version_id
        )`,
  );
  assert.equal(result.rows[0]?.count, '0');
}

function assertNoDeadlock(results: PromiseSettledResult<unknown>[]): void {
  for (const result of results) {
    if (result.status === 'rejected') {
      const text = result.reason instanceof Error
        ? `${result.reason.message} ${String(result.reason.cause ?? '')}`
        : String(result.reason);
      assert.doesNotMatch(text, /40P01|deadlock/i);
      assert.fail(`concurrent operation rejected: ${text}`);
    }
  }
}

test('monitoring and publish settle through the emitted lifecycle request without stale alerts', async () => {
  const pool = await resetDatabase();
  await seedEligiblePublicationContext(pool);
  await publishCandidateRevision(pool, publishV1());
  const sourceV1 = await monitoringRequestForActivation(
    pool,
    PUBLICATION_IDS.activationId,
  );

  const concurrent = await Promise.allSettled([
    evaluatePublicationMonitoring(pool, {
      sourceOutboxEventId: sourceV1,
      expectedEventType: 'PublicationMonitoringRequested',
    }),
    publishCandidateRevision(pool, publishV2()),
  ]);
  assertNoDeadlock(concurrent);
  assert.equal(await activeVersion(pool), IDS.v2);

  const sourceV2 = await monitoringRequestForActivation(pool, IDS.a2);
  await evaluatePublicationMonitoring(pool, {
    sourceOutboxEventId: sourceV2,
    expectedEventType: 'PublicationMonitoringRequested',
  });
  await assertNoStaleOpenAlert(pool);
  await pool.end();
});

test('monitoring and rollback settle through the emitted rollback request without stale alerts', async () => {
  const pool = await resetDatabase();
  await seedEligiblePublicationContext(pool);
  await publishCandidateRevision(pool, publishV1());
  await publishCandidateRevision(pool, publishV2());
  const sourceV2 = await monitoringRequestForActivation(pool, IDS.a2);

  const concurrent = await Promise.allSettled([
    evaluatePublicationMonitoring(pool, {
      sourceOutboxEventId: sourceV2,
      expectedEventType: 'PublicationMonitoringRequested',
    }),
    rollbackPublication(pool, rollbackToV1()),
  ]);
  assertNoDeadlock(concurrent);
  assert.equal(await activeVersion(pool), PUBLICATION_IDS.publicationVersionId);

  const rollbackSource = await monitoringRequestForActivation(
    pool,
    IDS.rollbackActivation,
  );
  await evaluatePublicationMonitoring(pool, {
    sourceOutboxEventId: rollbackSource,
    expectedEventType: 'PublicationMonitoringRequested',
  });
  await assertNoStaleOpenAlert(pool);
  await pool.end();
});

test('tampered monitoring source cannot change the active Publication pointer', async () => {
  const pool = await resetDatabase();
  await seedEligiblePublicationContext(pool);
  await publishCandidateRevision(pool, publishV1());
  const before = await activeVersion(pool);
  await pool.query(
    `insert into outbox_events
       (outbox_event_id, aggregate_type, aggregate_id, event_type,
        payload, correlation_id)
     values ($1, 'publication', $2, 'PublicationMonitoringRequested',
             $3::jsonb, 'tampered-monitoring-source')`,
    [
      IDS.tamperedSource,
      PUBLICATION_IDS.publicationId,
      JSON.stringify({
        activationId: PUBLICATION_IDS.activationId,
        publicationId: '7f000000-0000-4000-8000-000000000099',
        requestedReason: 'published',
        schemaVersion: 1,
      }),
    ],
  );
  await assert.rejects(
    evaluatePublicationMonitoring(pool, {
      sourceOutboxEventId: IDS.tamperedSource,
      expectedEventType: 'PublicationMonitoringRequested',
    }),
    /INVALID_PUBLICATION_MONITORING_SOURCE_EVENT/,
  );
  assert.equal(await activeVersion(pool), before);
  await pool.end();
});

test('monitoring production modules cannot import or write Publication mutation authority', async () => {
  const sources = await Promise.all([
    readFile(new URL('../src/modules/monitoring/evaluate-publication-monitoring.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/modules/monitoring/read-open-publication-monitoring-alerts.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/queue/monitoring-worker.ts', import.meta.url), 'utf8'),
  ]);
  const text = sources.join('\n');
  assert.doesNotMatch(text, /publish-candidate-revision|rollback-publication/);
  assert.doesNotMatch(
    text,
    /(?:insert\s+into|update|delete\s+from)\s+(?:publications|publication_versions|publication_activation_history|active_publication_versions)\b/i,
  );
});
