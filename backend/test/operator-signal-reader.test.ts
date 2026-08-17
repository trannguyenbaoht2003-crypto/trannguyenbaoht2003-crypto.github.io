import assert from 'node:assert/strict';
import test from 'node:test';

import type { Pool } from 'pg';

import type { PublicationFeedbackSignal } from '../src/modules/feedback/types.js';
import type { OpenPublicationMonitoringAlert } from '../src/modules/monitoring/types.js';
import {
  readOperatorPublicationSignals,
} from '../src/modules/operator/read-operator-publication-signals.js';

const PUBLICATION_A = '11111111-1111-4111-8111-111111111111';
const VERSION_A1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const VERSION_A2 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
const REVISION_A = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PUBLICATION_B = '22222222-2222-4222-8222-222222222222';
const VERSION_B = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const REVISION_B = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

function monitoringAlert(
  overrides: Partial<OpenPublicationMonitoringAlert> = {},
): OpenPublicationMonitoringAlert {
  return {
    publicationId: PUBLICATION_A,
    publicationVersionId: VERSION_A1,
    candidateRevisionId: REVISION_A,
    alertCode: 'ACTIVE_PUBLICATION_INELIGIBLE',
    severity: 'critical',
    evaluatedAt: '2026-08-17T02:00:00.000Z',
    eligibilityOutcome: 'ineligible',
    eligibilityReason: 'CURRENT_EVIDENCE_INSUFFICIENT',
    ...overrides,
  };
}

function feedbackSignal(
  overrides: Partial<PublicationFeedbackSignal> = {},
): PublicationFeedbackSignal {
  return {
    publicationId: PUBLICATION_A,
    publicationVersionId: VERSION_A1,
    isActive: true,
    totalCount: 4,
    countsByReason: { WRONG_ITEMS: 3, OUTDATED: 1 },
    newestReceivedAt: '2026-08-17T03:00:00.000Z',
    recentDetails: [
      {
        reasonCode: 'WRONG_ITEMS',
        details: 'Trang bị thứ hai có vẻ không đúng.',
        receivedAt: '2026-08-17T03:00:00.000Z',
      },
    ],
    ...overrides,
  };
}

function fakePool() {
  const transactionSql: string[] = [];
  let released = 0;
  const client = {
    async query(sql: string) {
      transactionSql.push(sql);
      return { rows: [], rowCount: 0 };
    },
    release() {
      released += 1;
    },
  };
  const pool = {
    async connect() {
      return client;
    },
  } as unknown as Pool;
  return {
    pool,
    client,
    transactionSql,
    released: () => released,
  };
}

test('operator signal reader joins exact versions, ranks deterministically, and uses one read-only repeatable-read transaction', async () => {
  const db = fakePool();
  const now = new Date('2026-08-17T04:00:00.000Z');
  let monitoringClient: unknown;
  let feedbackClient: unknown;
  let observedFeedbackOptions: unknown;

  const snapshot = await readOperatorPublicationSignals(
    db.pool,
    { sinceHours: 24, limit: 25, detailSampleLimit: 2, now },
    {
      readMonitoring: async (queryable) => {
        monitoringClient = queryable;
        return [
          monitoringAlert(),
          monitoringAlert({
            publicationId: PUBLICATION_B,
            publicationVersionId: VERSION_B,
            candidateRevisionId: REVISION_B,
            alertCode: 'ACTIVE_PUBLICATION_NEEDS_REVIEW',
            severity: 'warning',
            evaluatedAt: '2026-08-17T03:30:00.000Z',
            eligibilityOutcome: 'needs_review',
            eligibilityReason: 'POLICY_REVIEW_REQUIRED',
          }),
        ];
      },
      readFeedback: async (queryable, options) => {
        feedbackClient = queryable;
        observedFeedbackOptions = options;
        return [
          feedbackSignal(),
          feedbackSignal({
            publicationVersionId: VERSION_A2,
            isActive: false,
            totalCount: 9,
            countsByReason: { OUTDATED: 9 },
            newestReceivedAt: '2026-08-17T03:45:00.000Z',
          }),
        ];
      },
    },
  );

  assert.equal(monitoringClient, db.client);
  assert.equal(feedbackClient, db.client);
  assert.deepEqual(observedFeedbackOptions, {
    sinceHours: 24,
    limit: 25,
    detailSampleLimit: 2,
    now,
  });
  assert.deepEqual(db.transactionSql, [
    'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
    'COMMIT',
  ]);
  assert.equal(db.released(), 1);

  assert.equal(snapshot.schemaVersion, 1);
  assert.equal(snapshot.generatedAt, now.toISOString());
  assert.equal(snapshot.sinceHours, 24);
  assert.deepEqual(snapshot.summary, {
    critical: 1,
    warning: 1,
    feedbackOnly: 1,
    total: 3,
  });
  assert.deepEqual(snapshot.signals.map((signal) => signal.priority), [
    'critical',
    'warning',
    'feedback',
  ]);

  const critical = snapshot.signals[0];
  assert.ok(critical);
  assert.equal(critical.publicationVersionId, VERSION_A1);
  assert.equal(critical.isActiveVersion, true);
  assert.equal(critical.monitoringAlert?.severity, 'critical');
  assert.equal(critical.feedback?.totalCount, 4);

  const warning = snapshot.signals[1];
  assert.ok(warning);
  assert.equal(warning.publicationId, PUBLICATION_B);
  assert.equal(warning.feedback, null);

  const historicalFeedback = snapshot.signals[2];
  assert.ok(historicalFeedback);
  assert.equal(historicalFeedback.publicationVersionId, VERSION_A2);
  assert.equal(historicalFeedback.isActiveVersion, false);
  assert.equal(historicalFeedback.monitoringAlert, null);
  assert.equal(historicalFeedback.feedback?.totalCount, 9);
});

test('operator signal reader never cross-joins feedback from another version of the same publication', async () => {
  const db = fakePool();
  const snapshot = await readOperatorPublicationSignals(
    db.pool,
    { now: new Date('2026-08-17T04:00:00.000Z') },
    {
      readMonitoring: async () => [monitoringAlert()],
      readFeedback: async () => [
        feedbackSignal({ publicationVersionId: VERSION_A2, isActive: false }),
      ],
    },
  );

  assert.equal(snapshot.signals.length, 2);
  const monitoringOnly = snapshot.signals[0];
  const feedbackOnly = snapshot.signals[1];
  assert.ok(monitoringOnly);
  assert.ok(feedbackOnly);
  assert.equal(monitoringOnly.publicationVersionId, VERSION_A1);
  assert.equal(monitoringOnly.feedback, null);
  assert.equal(feedbackOnly.publicationVersionId, VERSION_A2);
  assert.equal(feedbackOnly.monitoringAlert, null);
});

test('operator signal reader rolls back and releases the transaction client when a source reader fails', async () => {
  const db = fakePool();

  await assert.rejects(
    readOperatorPublicationSignals(
      db.pool,
      { now: new Date('2026-08-17T04:00:00.000Z') },
      {
        readMonitoring: async () => {
          throw new Error('monitoring authority unavailable');
        },
        readFeedback: async () => [],
      },
    ),
    /monitoring authority unavailable/,
  );

  assert.deepEqual(db.transactionSql, [
    'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
    'ROLLBACK',
  ]);
  assert.equal(db.released(), 1);
});

test('operator signal reader returns an empty closed snapshot when there are no signals', async () => {
  const db = fakePool();
  const now = new Date('2026-08-17T04:00:00.000Z');
  const snapshot = await readOperatorPublicationSignals(
    db.pool,
    { now },
    {
      readMonitoring: async () => [],
      readFeedback: async () => [],
    },
  );

  assert.deepEqual(snapshot, {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    sinceHours: 168,
    summary: { critical: 0, warning: 0, feedbackOnly: 0, total: 0 },
    signals: [],
  });
});
