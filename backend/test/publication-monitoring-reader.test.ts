import assert from 'node:assert/strict';
import test from 'node:test';

import {
  evaluatePublicationMonitoring,
} from '../src/modules/monitoring/evaluate-publication-monitoring.js';
import {
  readOpenPublicationMonitoringAlerts,
} from '../src/modules/monitoring/read-open-publication-monitoring-alerts.js';
import {
  recordCandidateModerationDecision,
} from '../src/modules/moderation/record-candidate-moderation-decision.js';
import {
  publishCandidateRevision,
} from '../src/modules/publication/publish-candidate-revision.js';
import type {
  PublishCandidateRevisionCommand,
} from '../src/modules/publication/types.js';
import { resetDatabase } from './helpers/database.js';
import {
  GATE_IDS,
  moderationDecisionCommand,
} from './helpers/gate.js';
import {
  PUBLICATION_IDS,
  seedEligiblePublicationContext,
} from './helpers/publication.js';

const IDS = {
  moderationInputSnapshotId: '7e000000-0000-4000-8000-000000000001',
  moderationDecisionId: '7e000000-0000-4000-8000-000000000002',
} as const;

function publishCommand(): PublishCandidateRevisionCommand {
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
    correlationId: 'monitoring-reader-publish',
    idempotencyKey: 'monitoring-reader-publish',
    occurredAt: '2026-08-14T09:30:00.000Z',
  };
}

test('internal reader returns current open monitoring alerts in operator order', async () => {
  const pool = await resetDatabase();
  await seedEligiblePublicationContext(pool);
  await publishCandidateRevision(pool, publishCommand());
  await recordCandidateModerationDecision(pool, moderationDecisionCommand({
    correlationId: 'monitoring-reader-stale-moderation',
    decisionId: IDS.moderationDecisionId,
    evaluatedAt: '2026-08-14T09:31:00.000Z',
    idempotencyKey: 'monitoring-reader-stale-moderation',
    inputSnapshotId: IDS.moderationInputSnapshotId,
    outcome: 'clear',
    reason: 'A newer Moderation decision makes the published Eligibility stale.',
  }));
  const source = await pool.query<{ outbox_event_id: string }>(
    `select outbox_event_id
       from outbox_events
      where event_type = 'PublicationMonitoringRequested'
        and aggregate_id = $1
      order by created_at desc
      limit 1`,
    [PUBLICATION_IDS.publicationId],
  );
  const sourceOutboxEventId = source.rows[0]?.outbox_event_id;
  assert.ok(sourceOutboxEventId);
  await evaluatePublicationMonitoring(pool, {
    sourceOutboxEventId,
    expectedEventType: 'PublicationMonitoringRequested',
  });

  const alerts = await readOpenPublicationMonitoringAlerts(pool);
  assert.equal(alerts.length, 1);
  assert.deepEqual(alerts[0], {
    publicationId: PUBLICATION_IDS.publicationId,
    publicationVersionId: PUBLICATION_IDS.publicationVersionId,
    candidateRevisionId: '62000000-0000-4000-8000-000000000002',
    alertCode: 'ACTIVE_PUBLICATION_REVALIDATION_REQUIRED',
    severity: 'warning',
    eligibilityOutcome: null,
    reasonCode: 'ACTIVE_PUBLICATION_REVALIDATION_REQUIRED',
    evaluatedAt: alerts[0]!.evaluatedAt,
  });
  assert.match(alerts[0]!.evaluatedAt, /^\d{4}-\d{2}-\d{2}T/);
  await pool.end();
});

test('internal reader returns no resolved alerts', async () => {
  const pool = await resetDatabase();
  assert.deepEqual(await readOpenPublicationMonitoringAlerts(pool), []);
  await pool.end();
});
