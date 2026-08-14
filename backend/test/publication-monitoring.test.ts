import assert from 'node:assert/strict';
import test from 'node:test';

import type { Pool } from 'pg';

import {
  evaluateCandidateEligibility,
} from '../src/modules/eligibility/evaluate-candidate-eligibility.js';
import {
  evaluatePublicationMonitoring,
} from '../src/modules/monitoring/evaluate-publication-monitoring.js';
import {
  recordCandidateModerationDecision,
} from '../src/modules/moderation/record-candidate-moderation-decision.js';
import {
  recordClaimEvidenceDecision,
} from '../src/modules/trust/record-claim-evidence-decision.js';
import { CANDIDATE_IDS } from './helpers/candidate.js';
import { resetDatabase, tableCount } from './helpers/database.js';
import {
  GATE_IDS,
  moderationDecisionCommand,
} from './helpers/gate.js';
import {
  insertDirectPublicationGraph,
  PUBLICATION_IDS,
  seedEligiblePublicationContext,
} from './helpers/publication.js';
import {
  evidenceDecisionCommand,
  TRUST_IDS,
} from './helpers/trust.js';

const MONITOR_IDS = {
  needsReviewInputSnapshotId: '7b000000-0000-4000-8000-000000000001',
  needsReviewEvaluationId: '7b000000-0000-4000-8000-000000000002',
  blockedModerationInputSnapshotId: '7b000000-0000-4000-8000-000000000003',
  blockedModerationDecisionId: '7b000000-0000-4000-8000-000000000004',
  blockedEligibilityInputSnapshotId: '7b000000-0000-4000-8000-000000000005',
  blockedEligibilityEvaluationId: '7b000000-0000-4000-8000-000000000006',
  clearModerationInputSnapshotId: '7b000000-0000-4000-8000-000000000007',
  clearModerationDecisionId: '7b000000-0000-4000-8000-000000000008',
  clearEligibilityInputSnapshotId: '7b000000-0000-4000-8000-000000000009',
  clearEligibilityEvaluationId: '7b000000-0000-4000-8000-000000000010',
  lifecycleSourceOutboxId: '7b000000-0000-4000-8000-000000000011',
  restoredEligibilitySourceOutboxId: '7b000000-0000-4000-8000-000000000012',
} as const;

async function seedActivePublication(pool: Pool): Promise<void> {
  await seedEligiblePublicationContext(pool);
  const client = await pool.connect();
  try {
    await client.query('begin');
    await insertDirectPublicationGraph(client);
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

async function eligibilityOutboxId(
  pool: Pool,
  evaluationId: string,
): Promise<string> {
  const result = await pool.query<{ outbox_event_id: string }>(
    `select outbox_event_id
       from outbox_events
      where event_type = 'CandidateEligibilityEvaluated'
        and payload ->> 'evaluationId' = $1
      order by created_at desc
      limit 1`,
    [evaluationId],
  );
  const value = result.rows[0]?.outbox_event_id;
  assert.ok(value, `missing CandidateEligibilityEvaluated for ${evaluationId}`);
  return value;
}

async function evaluateEligibility(
  pool: Pool,
  input: {
    correlationId: string;
    evaluatedAt: string;
    evaluationId: string;
    idempotencyKey: string;
    inputSnapshotId: string;
  },
): Promise<'eligible' | 'needs_review' | 'ineligible'> {
  const result = await evaluateCandidateEligibility(pool, {
    actorId: 'monitoring-test-eligibility',
    candidateId: CANDIDATE_IDS.candidateId,
    candidateRevisionId: CANDIDATE_IDS.candidateRevisionId,
    ...input,
  });
  return result.outcome;
}

async function makeNeedsReview(pool: Pool): Promise<string> {
  await recordClaimEvidenceDecision(pool, evidenceDecisionCommand({
    associations: [],
    correlationId: 'monitoring-needs-review-evidence',
    decision: 'insufficient',
    decisionId: TRUST_IDS.secondEvidenceDecisionId,
    evaluatedAt: '2026-08-14T08:01:00.000Z',
    evidenceInputSnapshotId: TRUST_IDS.secondEvidenceInputSnapshotId,
    idempotencyKey: 'monitoring-needs-review-evidence',
    reason: 'Monitoring test makes required Evidence insufficient.',
  }));
  assert.equal(await evaluateEligibility(pool, {
    correlationId: 'monitoring-needs-review-eligibility',
    evaluatedAt: '2026-08-14T08:02:00.000Z',
    evaluationId: MONITOR_IDS.needsReviewEvaluationId,
    idempotencyKey: 'monitoring-needs-review-eligibility',
    inputSnapshotId: MONITOR_IDS.needsReviewInputSnapshotId,
  }), 'needs_review');
  return eligibilityOutboxId(pool, MONITOR_IDS.needsReviewEvaluationId);
}

async function makeBlocked(pool: Pool): Promise<string> {
  await recordCandidateModerationDecision(pool, moderationDecisionCommand({
    correlationId: 'monitoring-blocked-moderation',
    decisionId: MONITOR_IDS.blockedModerationDecisionId,
    evaluatedAt: '2026-08-14T08:03:00.000Z',
    idempotencyKey: 'monitoring-blocked-moderation',
    inputSnapshotId: MONITOR_IDS.blockedModerationInputSnapshotId,
    outcome: 'blocked',
    reason: 'Monitoring test blocks the active CandidateRevision.',
  }));
  assert.equal(await evaluateEligibility(pool, {
    correlationId: 'monitoring-blocked-eligibility',
    evaluatedAt: '2026-08-14T08:04:00.000Z',
    evaluationId: MONITOR_IDS.blockedEligibilityEvaluationId,
    idempotencyKey: 'monitoring-blocked-eligibility',
    inputSnapshotId: MONITOR_IDS.blockedEligibilityInputSnapshotId,
  }), 'ineligible');
  return eligibilityOutboxId(pool, MONITOR_IDS.blockedEligibilityEvaluationId);
}

async function makeClear(pool: Pool): Promise<string> {
  await recordCandidateModerationDecision(pool, moderationDecisionCommand({
    correlationId: 'monitoring-clear-moderation',
    decisionId: MONITOR_IDS.clearModerationDecisionId,
    evaluatedAt: '2026-08-14T08:05:00.000Z',
    idempotencyKey: 'monitoring-clear-moderation',
    inputSnapshotId: MONITOR_IDS.clearModerationInputSnapshotId,
    outcome: 'clear',
    reason: 'Monitoring test restores clear Moderation.',
  }));
  assert.equal(await evaluateEligibility(pool, {
    correlationId: 'monitoring-clear-eligibility',
    evaluatedAt: '2026-08-14T08:06:00.000Z',
    evaluationId: MONITOR_IDS.clearEligibilityEvaluationId,
    idempotencyKey: 'monitoring-clear-eligibility',
    inputSnapshotId: MONITOR_IDS.clearEligibilityInputSnapshotId,
  }), 'eligible');
  return eligibilityOutboxId(pool, MONITOR_IDS.clearEligibilityEvaluationId);
}

async function insertLifecycleSource(pool: Pool): Promise<string> {
  await pool.query(
    `insert into outbox_events
       (outbox_event_id, aggregate_type, aggregate_id, event_type,
        payload, correlation_id)
     values ($1, 'publication', $2, 'PublicationMonitoringRequested',
             $3::jsonb, 'monitoring-lifecycle-test')`,
    [
      MONITOR_IDS.lifecycleSourceOutboxId,
      PUBLICATION_IDS.publicationId,
      JSON.stringify({
        activationId: PUBLICATION_IDS.activationId,
        publicationId: PUBLICATION_IDS.publicationId,
        requestedReason: 'published',
        schemaVersion: 1,
      }),
    ],
  );
  return MONITOR_IDS.lifecycleSourceOutboxId;
}

async function openAlerts(pool: Pool): Promise<Array<{
  alert_code: string;
  publication_version_id: string;
  severity: string;
}>> {
  const result = await pool.query<{
    alert_code: string;
    publication_version_id: string;
    severity: string;
  }>(
    `select alert_code, publication_version_id, severity
       from current_publication_monitoring_alerts
      where state = 'open'
      order by alert_code`,
  );
  return result.rows;
}

test('active needs-review drift opens one warning and duplicate source is side-effect free', async () => {
  const pool = await resetDatabase();
  await seedActivePublication(pool);
  const sourceOutboxEventId = await makeNeedsReview(pool);

  const first = await evaluatePublicationMonitoring(pool, {
    sourceOutboxEventId,
    expectedEventType: 'CandidateEligibilityEvaluated',
  });
  assert.equal(first.outcome, 'evaluated');
  assert.equal(first.publicationId, PUBLICATION_IDS.publicationId);
  assert.equal(first.publicationVersionId, PUBLICATION_IDS.publicationVersionId);
  assert.equal(first.alertCode, 'ACTIVE_PUBLICATION_NEEDS_REVIEW');
  assert.deepEqual(await openAlerts(pool), [{
    alert_code: 'ACTIVE_PUBLICATION_NEEDS_REVIEW',
    publication_version_id: PUBLICATION_IDS.publicationVersionId,
    severity: 'warning',
  }]);

  const counts = {
    evaluations: await tableCount(pool, 'publication_monitoring_evaluations'),
    alerts: await tableCount(pool, 'publication_monitoring_alert_events'),
    audits: Number((await pool.query<{ count: string }>(
      `select count(*) from audit_events
        where action like 'monitoring.publication_alert_%'`,
    )).rows[0]?.count ?? 0),
    outputs: Number((await pool.query<{ count: string }>(
      `select count(*) from outbox_events
        where event_type like 'PublicationMonitoringAlert%'`,
    )).rows[0]?.count ?? 0),
  };

  const replay = await evaluatePublicationMonitoring(pool, {
    sourceOutboxEventId,
    expectedEventType: 'CandidateEligibilityEvaluated',
  });
  assert.equal(replay.outcome, 'duplicate_noop');
  assert.equal(await tableCount(pool, 'publication_monitoring_evaluations'), counts.evaluations);
  assert.equal(await tableCount(pool, 'publication_monitoring_alert_events'), counts.alerts);
  assert.equal(Number((await pool.query<{ count: string }>(
    `select count(*) from audit_events
      where action like 'monitoring.publication_alert_%'`,
  )).rows[0]?.count ?? 0), counts.audits);
  assert.equal(Number((await pool.query<{ count: string }>(
    `select count(*) from outbox_events
      where event_type like 'PublicationMonitoringAlert%'`,
  )).rows[0]?.count ?? 0), counts.outputs);
  await pool.end();
});

test('warning to ineligible resolves warning and opens critical atomically', async () => {
  const pool = await resetDatabase();
  await seedActivePublication(pool);
  const warningSource = await makeNeedsReview(pool);
  await evaluatePublicationMonitoring(pool, {
    sourceOutboxEventId: warningSource,
    expectedEventType: 'CandidateEligibilityEvaluated',
  });

  const criticalSource = await makeBlocked(pool);
  const result = await evaluatePublicationMonitoring(pool, {
    sourceOutboxEventId: criticalSource,
    expectedEventType: 'CandidateEligibilityEvaluated',
  });
  assert.equal(result.alertCode, 'ACTIVE_PUBLICATION_INELIGIBLE');
  assert.deepEqual(await openAlerts(pool), [{
    alert_code: 'ACTIVE_PUBLICATION_INELIGIBLE',
    publication_version_id: PUBLICATION_IDS.publicationVersionId,
    severity: 'critical',
  }]);
  const transitions = await pool.query<{ alert_code: string; state: string }>(
    `select alert_code, state
       from publication_monitoring_alert_events
      order by created_at, publication_monitoring_alert_event_id`,
  );
  assert.deepEqual(transitions.rows.map((row) => [row.alert_code, row.state]), [
    ['ACTIVE_PUBLICATION_NEEDS_REVIEW', 'open'],
    ['ACTIVE_PUBLICATION_NEEDS_REVIEW', 'resolved'],
    ['ACTIVE_PUBLICATION_INELIGIBLE', 'open'],
  ]);
  await pool.end();
});

test('critical to eligible resolves the critical alert', async () => {
  const pool = await resetDatabase();
  await seedActivePublication(pool);
  const criticalSource = await makeBlocked(pool);
  await evaluatePublicationMonitoring(pool, {
    sourceOutboxEventId: criticalSource,
    expectedEventType: 'CandidateEligibilityEvaluated',
  });

  const healthySource = await makeClear(pool);
  const result = await evaluatePublicationMonitoring(pool, {
    sourceOutboxEventId: healthySource,
    expectedEventType: 'CandidateEligibilityEvaluated',
  });
  assert.equal(result.outcome, 'evaluated');
  assert.equal(result.alertCode, null);
  assert.deepEqual(await openAlerts(pool), []);
  const current = await pool.query<{ state: string }>(
    `select state
       from current_publication_monitoring_alerts
      where publication_id = $1
        and alert_code = 'ACTIVE_PUBLICATION_INELIGIBLE'`,
    [PUBLICATION_IDS.publicationId],
  );
  assert.equal(current.rows[0]?.state, 'resolved');
  await pool.end();
});

test('lifecycle source fails closed without a current eligibility pointer and later eligible source resolves it', async () => {
  const pool = await resetDatabase();
  await seedActivePublication(pool);
  await pool.query(
    `delete from current_candidate_eligibility_evaluations
      where candidate_revision_id = $1
        and eligibility_policy_revision_id = $2`,
    [CANDIDATE_IDS.candidateRevisionId, GATE_IDS.eligibilityPolicyId],
  );
  const lifecycleSource = await insertLifecycleSource(pool);
  const warning = await evaluatePublicationMonitoring(pool, {
    sourceOutboxEventId: lifecycleSource,
    expectedEventType: 'PublicationMonitoringRequested',
  });
  assert.equal(warning.alertCode, 'ACTIVE_PUBLICATION_REVALIDATION_REQUIRED');

  const evaluation = await pool.query<{ input_hash: string }>(
    `select input_hash
       from candidate_eligibility_evaluations
      where candidate_eligibility_evaluation_id = $1`,
    [GATE_IDS.eligibilityEvaluationId],
  );
  const inputHash = evaluation.rows[0]?.input_hash;
  assert.ok(inputHash);
  await pool.query(
    `insert into current_candidate_eligibility_evaluations
       (candidate_revision_id, eligibility_policy_revision_id,
        candidate_id, input_hash, candidate_eligibility_evaluation_id)
     values ($1, $2, $3, $4, $5)`,
    [
      CANDIDATE_IDS.candidateRevisionId,
      GATE_IDS.eligibilityPolicyId,
      CANDIDATE_IDS.candidateId,
      inputHash,
      GATE_IDS.eligibilityEvaluationId,
    ],
  );
  await pool.query(
    `insert into outbox_events
       (outbox_event_id, aggregate_type, aggregate_id, event_type,
        payload, correlation_id)
     select $1, aggregate_type, aggregate_id, event_type, payload,
            'monitoring-restored-eligibility'
       from outbox_events
      where event_type = 'CandidateEligibilityEvaluated'
        and payload ->> 'evaluationId' = $2
      order by created_at
      limit 1`,
    [MONITOR_IDS.restoredEligibilitySourceOutboxId, GATE_IDS.eligibilityEvaluationId],
  );
  const healthy = await evaluatePublicationMonitoring(pool, {
    sourceOutboxEventId: MONITOR_IDS.restoredEligibilitySourceOutboxId,
    expectedEventType: 'CandidateEligibilityEvaluated',
  });
  assert.equal(healthy.alertCode, null);
  assert.deepEqual(await openAlerts(pool), []);
  await pool.end();
});

test('old eligibility source observes currentness drift and never trusts its old eligible payload', async () => {
  const pool = await resetDatabase();
  await seedActivePublication(pool);
  const oldSource = await eligibilityOutboxId(pool, GATE_IDS.eligibilityEvaluationId);
  await recordClaimEvidenceDecision(pool, evidenceDecisionCommand({
    associations: [],
    correlationId: 'monitoring-stale-evidence',
    decision: 'insufficient',
    decisionId: TRUST_IDS.secondEvidenceDecisionId,
    evaluatedAt: '2026-08-14T08:07:00.000Z',
    evidenceInputSnapshotId: TRUST_IDS.secondEvidenceInputSnapshotId,
    idempotencyKey: 'monitoring-stale-evidence',
    reason: 'Trust changed after the older Eligibility event.',
  }));

  const result = await evaluatePublicationMonitoring(pool, {
    sourceOutboxEventId: oldSource,
    expectedEventType: 'CandidateEligibilityEvaluated',
  });
  assert.equal(result.alertCode, 'ACTIVE_PUBLICATION_REVALIDATION_REQUIRED');
  assert.deepEqual(await openAlerts(pool), [{
    alert_code: 'ACTIVE_PUBLICATION_REVALIDATION_REQUIRED',
    publication_version_id: PUBLICATION_IDS.publicationVersionId,
    severity: 'warning',
  }]);
  await pool.end();
});

test('eligibility source with no Publication records not-applicable only', async () => {
  const pool = await resetDatabase();
  await seedEligiblePublicationContext(pool);
  const sourceOutboxEventId = await eligibilityOutboxId(
    pool,
    GATE_IDS.eligibilityEvaluationId,
  );

  const result = await evaluatePublicationMonitoring(pool, {
    sourceOutboxEventId,
    expectedEventType: 'CandidateEligibilityEvaluated',
  });
  assert.deepEqual(result, {
    outcome: 'not_applicable',
    publicationId: null,
    publicationVersionId: null,
    alertCode: null,
  });
  assert.equal(await tableCount(pool, 'publication_monitoring_evaluations'), 0);
  assert.equal(await tableCount(pool, 'publication_monitoring_alert_events'), 0);
  assert.equal(await tableCount(pool, 'publication_monitoring_effects'), 1);
  await pool.end();
});
