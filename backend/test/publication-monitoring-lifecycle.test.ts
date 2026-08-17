import assert from 'node:assert/strict';
import test from 'node:test';

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
  secondVersionId: '7c000000-0000-4000-8000-000000000001',
  secondActivationId: '7c000000-0000-4000-8000-000000000002',
  secondAuditId: '7c000000-0000-4000-8000-000000000003',
  secondOutboxEventId: '7c000000-0000-4000-8000-000000000004',
  rollbackActivationId: '7c000000-0000-4000-8000-000000000005',
  rollbackAuditId: '7c000000-0000-4000-8000-000000000006',
  rollbackOutboxEventId: '7c000000-0000-4000-8000-000000000007',
} as const;

function firstPublishCommand(
  overrides: Partial<PublishCandidateRevisionCommand> = {},
): PublishCandidateRevisionCommand {
  return {
    publicationId: PUBLICATION_IDS.publicationId,
    publicationVersionId: PUBLICATION_IDS.publicationVersionId,
    activationId: PUBLICATION_IDS.activationId,
    candidateRevisionId: '62000000-0000-4000-8000-000000000002',
    expectedActiveEligibilityPolicyRevisionId: GATE_IDS.eligibilityPolicyId,
    expectedEligibilityEvaluationId: GATE_IDS.eligibilityEvaluationId,
    expectedModerationDecisionId: GATE_IDS.moderationDecisionId,
    expectedActivePublicationVersionId: null,
    authorization: {
      actorId: 'publication-editor',
      permissions: ['publisher'],
    },
    auditId: PUBLICATION_IDS.auditId,
    outboxEventId: PUBLICATION_IDS.outboxEventId,
    correlationId: 'monitoring-lifecycle-publish-v1',
    idempotencyKey: 'monitoring-lifecycle-publish-v1',
    occurredAt: '2026-08-14T09:10:00.000Z',
    ...overrides,
  };
}

function secondPublishCommand(): PublishCandidateRevisionCommand {
  return firstPublishCommand({
    publicationVersionId: IDS.secondVersionId,
    activationId: IDS.secondActivationId,
    expectedActivePublicationVersionId: PUBLICATION_IDS.publicationVersionId,
    auditId: IDS.secondAuditId,
    outboxEventId: IDS.secondOutboxEventId,
    correlationId: 'monitoring-lifecycle-publish-v2',
    idempotencyKey: 'monitoring-lifecycle-publish-v2',
    occurredAt: '2026-08-14T09:11:00.000Z',
  });
}

function rollbackCommand(): RollbackPublicationCommand {
  return {
    publicationId: PUBLICATION_IDS.publicationId,
    targetPublicationVersionId: PUBLICATION_IDS.publicationVersionId,
    activationId: IDS.rollbackActivationId,
    expectedActivePublicationVersionId: IDS.secondVersionId,
    authorization: {
      actorId: 'publication-editor',
      permissions: ['publisher'],
    },
    auditId: IDS.rollbackAuditId,
    outboxEventId: IDS.rollbackOutboxEventId,
    correlationId: 'monitoring-lifecycle-rollback-v1',
    idempotencyKey: 'monitoring-lifecycle-rollback-v1',
    occurredAt: '2026-08-14T09:12:00.000Z',
  };
}

async function monitoringRequests(
  pool: Awaited<ReturnType<typeof resetDatabase>>,
): Promise<Array<{
  aggregate_id: string;
  aggregate_type: string;
  correlation_id: string;
  payload: Record<string, unknown>;
}>> {
  const result = await pool.query<{
    aggregate_id: string;
    aggregate_type: string;
    correlation_id: string;
    payload: Record<string, unknown>;
  }>(
    `select aggregate_id, aggregate_type, correlation_id, payload
       from outbox_events
      where event_type = 'PublicationMonitoringRequested'
      order by created_at, outbox_event_id`,
  );
  return result.rows;
}

test('publish emits exactly one monitoring request and replay adds no duplicate', async () => {
  const pool = await resetDatabase();
  await seedEligiblePublicationContext(pool);
  const command = firstPublishCommand();

  await publishCandidateRevision(pool, command);
  assert.deepEqual(await monitoringRequests(pool), [{
    aggregate_id: PUBLICATION_IDS.publicationId,
    aggregate_type: 'publication',
    correlation_id: command.correlationId,
    payload: {
      activationId: PUBLICATION_IDS.activationId,
      publicationId: PUBLICATION_IDS.publicationId,
      requestedReason: 'published',
      schemaVersion: 1,
    },
  }]);

  const replay = await publishCandidateRevision(pool, command);
  assert.equal(replay.replayed, true);
  assert.equal((await monitoringRequests(pool)).length, 1);
  await pool.end();
});

test('rollback emits its own monitoring request after two publish activations', async () => {
  const pool = await resetDatabase();
  await seedEligiblePublicationContext(pool);
  await publishCandidateRevision(pool, firstPublishCommand());
  await publishCandidateRevision(pool, secondPublishCommand());
  await rollbackPublication(pool, rollbackCommand());

  const requests = await monitoringRequests(pool);
  assert.equal(requests.length, 3);
  assert.deepEqual(requests.map((row) => row.payload), [
    {
      activationId: PUBLICATION_IDS.activationId,
      publicationId: PUBLICATION_IDS.publicationId,
      requestedReason: 'published',
      schemaVersion: 1,
    },
    {
      activationId: IDS.secondActivationId,
      publicationId: PUBLICATION_IDS.publicationId,
      requestedReason: 'published',
      schemaVersion: 1,
    },
    {
      activationId: IDS.rollbackActivationId,
      publicationId: PUBLICATION_IDS.publicationId,
      requestedReason: 'rolled_back',
      schemaVersion: 1,
    },
  ]);
  assert.ok(requests.every((row) => row.aggregate_type === 'publication'));
  assert.ok(requests.every((row) => row.aggregate_id === PUBLICATION_IDS.publicationId));
  await pool.end();
});
