import assert from 'node:assert/strict';
import test from 'node:test';

import type { Pool } from 'pg';

import { CANDIDATE_IDS } from './helpers/candidate.js';
import { resetDatabase } from './helpers/database.js';
import { GATE_IDS } from './helpers/gate.js';
import {
  insertDirectPublicationGraph,
  PUBLICATION_IDS,
  seedEligiblePublicationContext,
} from './helpers/publication.js';

const IDS = {
  triggerOutboxId: '7a000000-0000-4000-8000-000000000001',
  evaluationId: '7a000000-0000-4000-8000-000000000002',
  alertEventId: '7a000000-0000-4000-8000-000000000003',
  alertAuditId: '7a000000-0000-4000-8000-000000000004',
  alertOutboxId: '7a000000-0000-4000-8000-000000000005',
} as const;

async function seedPublication(pool: Pool): Promise<void> {
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

async function seedMonitoringEvaluation(pool: Pool): Promise<void> {
  await seedPublication(pool);
  const evaluation = await pool.query<{ input_hash: string }>(
    `select input_hash
       from candidate_eligibility_evaluations
      where candidate_eligibility_evaluation_id = $1`,
    [GATE_IDS.eligibilityEvaluationId],
  );
  const inputHash = evaluation.rows[0]?.input_hash;
  assert.ok(inputHash);

  await pool.query(
    `insert into outbox_events
       (outbox_event_id, aggregate_type, aggregate_id, event_type,
        payload, correlation_id)
     values ($1, 'candidate_revision', $2, 'CandidateEligibilityEvaluated',
             $3::jsonb, 'monitoring-migration')`,
    [
      IDS.triggerOutboxId,
      CANDIDATE_IDS.candidateRevisionId,
      JSON.stringify({
        candidateId: CANDIDATE_IDS.candidateId,
        candidateRevisionId: CANDIDATE_IDS.candidateRevisionId,
        evaluationId: GATE_IDS.eligibilityEvaluationId,
      }),
    ],
  );
  await pool.query(
    `insert into publication_monitoring_evaluations
       (publication_monitoring_evaluation_id, trigger_outbox_event_id,
        publication_id, publication_version_id, candidate_id,
        candidate_revision_id, candidate_eligibility_evaluation_id,
        eligibility_policy_revision_id, eligibility_input_hash,
        monitoring_version, outcome, reason_code, evaluated_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9,
             'post-publication-monitor-v1', 'critical',
             'ACTIVE_PUBLICATION_INELIGIBLE',
             '2026-08-14T09:00:00.000Z')`,
    [
      IDS.evaluationId,
      IDS.triggerOutboxId,
      PUBLICATION_IDS.publicationId,
      PUBLICATION_IDS.publicationVersionId,
      CANDIDATE_IDS.candidateId,
      CANDIDATE_IDS.candidateRevisionId,
      GATE_IDS.eligibilityEvaluationId,
      GATE_IDS.eligibilityPolicyId,
      inputHash,
    ],
  );
}

async function seedAlertEvent(pool: Pool): Promise<void> {
  await seedMonitoringEvaluation(pool);
  await pool.query(
    `insert into audit_events
       (audit_event_id, actor_id, action, reason, correlation_id, payload)
     values ($1, 'post-publication-monitor-v1',
             'monitoring.publication_alert_opened',
             'ACTIVE_PUBLICATION_INELIGIBLE',
             'monitoring-migration', '{}'::jsonb)`,
    [IDS.alertAuditId],
  );
  await pool.query(
    `insert into outbox_events
       (outbox_event_id, aggregate_type, aggregate_id, event_type,
        payload, correlation_id)
     values ($1, 'publication_monitoring_alert', $2,
             'PublicationMonitoringAlertOpened', $3::jsonb,
             'monitoring-migration')`,
    [
      IDS.alertOutboxId,
      IDS.alertEventId,
      JSON.stringify({
        schemaVersion: 1,
        publicationMonitoringAlertEventId: IDS.alertEventId,
        publicationId: PUBLICATION_IDS.publicationId,
        alertCode: 'ACTIVE_PUBLICATION_INELIGIBLE',
        state: 'open',
      }),
    ],
  );
  await pool.query(
    `insert into publication_monitoring_alert_events
       (publication_monitoring_alert_event_id, publication_id,
        publication_version_id, publication_monitoring_evaluation_id,
        alert_code, severity, state, audit_event_id, outbox_event_id,
        correlation_id, actor_id)
     values ($1, $2, $3, $4, 'ACTIVE_PUBLICATION_INELIGIBLE',
             'critical', 'open', $5, $6, 'monitoring-migration',
             'post-publication-monitor-v1')`,
    [
      IDS.alertEventId,
      PUBLICATION_IDS.publicationId,
      PUBLICATION_IDS.publicationVersionId,
      IDS.evaluationId,
      IDS.alertAuditId,
      IDS.alertOutboxId,
    ],
  );
}

test('monitoring migration creates closed authority tables', async () => {
  const pool = await resetDatabase();
  for (const table of [
    'publication_monitoring_evaluations',
    'publication_monitoring_alert_events',
    'current_publication_monitoring_alerts',
    'publication_monitoring_effects',
    'publication_monitoring_delivery_effects',
  ]) {
    const result = await pool.query<{ name: string | null }>(
      'select to_regclass($1) as name',
      [`public.${table}`],
    );
    assert.equal(result.rows[0]?.name, table);
  }

  await assert.rejects(
    pool.query(
      `insert into publication_monitoring_effects
         (trigger_outbox_event_id, effect_outcome)
       values ('7a000000-0000-4000-8000-000000000099', 'duplicate_noop')`,
    ),
    /check|violates/i,
  );
  await pool.end();
});

test('monitoring evaluation history is append-only', async () => {
  const pool = await resetDatabase();
  await seedMonitoringEvaluation(pool);

  await assert.rejects(
    pool.query(
      `update publication_monitoring_evaluations
          set outcome = 'healthy'
        where publication_monitoring_evaluation_id = $1`,
      [IDS.evaluationId],
    ),
    /immutable/i,
  );
  await assert.rejects(
    pool.query(
      `delete from publication_monitoring_evaluations
        where publication_monitoring_evaluation_id = $1`,
      [IDS.evaluationId],
    ),
    /immutable/i,
  );
  await pool.end();
});

test('monitoring evaluation cannot cross publication version ownership', async () => {
  const pool = await resetDatabase();
  await seedPublication(pool);
  await pool.query(
    `insert into outbox_events
       (outbox_event_id, aggregate_type, aggregate_id, event_type,
        payload, correlation_id)
     values ($1, 'candidate_revision', $2, 'CandidateEligibilityEvaluated',
             '{}'::jsonb, 'monitoring-migration')`,
    [IDS.triggerOutboxId, CANDIDATE_IDS.candidateRevisionId],
  );

  await assert.rejects(
    pool.query(
      `insert into publication_monitoring_evaluations
         (publication_monitoring_evaluation_id, trigger_outbox_event_id,
          publication_id, publication_version_id, candidate_id,
          candidate_revision_id, monitoring_version, outcome,
          evaluated_at)
       values ($1, $2, $3, $4, $5,
               '62000000-0000-4000-8000-000000000099',
               'post-publication-monitor-v1', 'warning',
               '2026-08-14T09:00:00.000Z')`,
      [
        IDS.evaluationId,
        IDS.triggerOutboxId,
        PUBLICATION_IDS.publicationId,
        PUBLICATION_IDS.publicationVersionId,
        CANDIDATE_IDS.candidateId,
      ],
    ),
    /foreign key|violates/i,
  );
  await pool.end();
});

test('alert history and current pointers preserve alert ownership', async () => {
  const pool = await resetDatabase();
  await seedAlertEvent(pool);

  await assert.rejects(
    pool.query(
      `update publication_monitoring_alert_events
          set severity = 'warning'
        where publication_monitoring_alert_event_id = $1`,
      [IDS.alertEventId],
    ),
    /immutable/i,
  );
  await assert.rejects(
    pool.query(
      `insert into current_publication_monitoring_alerts
         (publication_id, alert_code,
          publication_monitoring_alert_event_id, state, severity,
          publication_version_id)
       values ($1, 'ACTIVE_PUBLICATION_NEEDS_REVIEW', $2,
               'open', 'critical', $3)`,
      [
        PUBLICATION_IDS.publicationId,
        IDS.alertEventId,
        PUBLICATION_IDS.publicationVersionId,
      ],
    ),
    /foreign key|violates/i,
  );
  await pool.end();
});

test('monitoring delivery effects cannot represent an unrelated alert', async () => {
  const pool = await resetDatabase();
  await seedAlertEvent(pool);

  await assert.rejects(
    pool.query(
      `insert into publication_monitoring_delivery_effects
         (outbox_event_id, publication_monitoring_alert_event_id,
          publication_id, event_type)
       values ($1, $2, '77000000-0000-4000-8000-000000000099',
               'PublicationMonitoringAlertOpened')`,
      [IDS.alertOutboxId, IDS.alertEventId],
    ),
    /foreign key|violates/i,
  );
  await pool.end();
});
