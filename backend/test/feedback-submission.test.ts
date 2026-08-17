import assert from 'node:assert/strict';
import test from 'node:test';

import { createPool } from '../src/database/pool.js';
import { migrate } from '../src/database/migrate.js';
import { publishCandidateRevision } from '../src/modules/publication/publish-candidate-revision.js';
import { submitPublicationFeedback } from '../src/modules/feedback/submit-publication-feedback.js';
import { GATE_IDS } from './helpers/gate.js';
import {
  PUBLICATION_IDS,
  insertDirectPublicationGraph,
  seedEligiblePublicationContext,
} from './helpers/publication.js';
import { withTransaction } from '../src/database/transaction.js';

function dbUrl(): string {
  const value = process.env.TEST_DATABASE_URL;
  if (!value) throw new Error('TEST_DATABASE_URL is required');
  return value;
}

async function reset() {
  const pool = createPool(dbUrl());
  await pool.query('drop schema public cascade; create schema public');
  await migrate(pool);
  await seedEligiblePublicationContext(pool);
  await withTransaction(pool, (client) => insertDirectPublicationGraph(client));
  return pool;
}

const baseCommand = {
  schemaVersion: 1 as const,
  submissionId: '7b300000-0000-4000-8000-000000000001',
  publicationId: PUBLICATION_IDS.publicationId,
  publicationVersionId: PUBLICATION_IDS.publicationVersionId,
  reasonCode: 'WRONG_ITEMS' as const,
  details: 'Sai trang bị',
  requestHash: 'd'.repeat(64),
  receivedAt: new Date('2026-08-17T02:00:00.000Z'),
};

test('first submission inserts once and exact replay remains one row', async () => {
  const pool = await reset();
  try {
    assert.deepEqual(await submitPublicationFeedback(pool, baseCommand), {
      outcome: 'accepted', replayed: false,
    });
    assert.deepEqual(await submitPublicationFeedback(pool, baseCommand), {
      outcome: 'accepted', replayed: true,
    });
    const rows = await pool.query('select * from publication_feedback_submissions');
    assert.equal(rows.rowCount, 1);
    assert.equal(rows.rows[0]?.was_active_at_submission, true);
  } finally { await pool.end(); }
});

test('same client submission id with a different request hash conflicts', async () => {
  const pool = await reset();
  try {
    await submitPublicationFeedback(pool, baseCommand);
    assert.deepEqual(
      await submitPublicationFeedback(pool, { ...baseCommand, requestHash: 'e'.repeat(64) }),
      { outcome: 'conflict' },
    );
  } finally { await pool.end(); }
});

test('unknown Publication/version ownership returns not_found without persistence', async () => {
  const pool = await reset();
  try {
    assert.deepEqual(
      await submitPublicationFeedback(pool, {
        ...baseCommand,
        submissionId: '7b300000-0000-4000-8000-000000000002',
        publicationVersionId: '7b300000-0000-4000-8000-000000000003',
        requestHash: 'f'.repeat(64),
      }),
      { outcome: 'not_found' },
    );
    const count = await pool.query<{ count: string }>('select count(*) from publication_feedback_submissions');
    assert.equal(count.rows[0]?.count, '0');
  } finally { await pool.end(); }
});

test('historical immutable PublicationVersion remains a valid feedback target', async () => {
  const pool = await reset();
  try {
    const secondVersionId = '7b300000-0000-4000-8000-000000000010';
    await publishCandidateRevision(pool, {
      publicationId: PUBLICATION_IDS.publicationId,
      publicationVersionId: secondVersionId,
      activationId: '7b300000-0000-4000-8000-000000000011',
      candidateRevisionId: '62000000-0000-4000-8000-000000000002',
      expectedActiveEligibilityPolicyRevisionId: GATE_IDS.eligibilityPolicyId,
      expectedEligibilityEvaluationId: GATE_IDS.eligibilityEvaluationId,
      expectedModerationDecisionId: GATE_IDS.moderationDecisionId,
      expectedActivePublicationVersionId: PUBLICATION_IDS.publicationVersionId,
      authorization: { actorId: 'feedback-test', permissions: ['publisher'] },
      auditId: '7b300000-0000-4000-8000-000000000012',
      outboxEventId: '7b300000-0000-4000-8000-000000000013',
      correlationId: 'feedback-same-publication-v2',
      idempotencyKey: 'feedback-same-publication-v2',
      occurredAt: '2026-08-17T02:10:00.000Z',
    });

    const active = await pool.query<{ publication_version_id: string }>(
      'select publication_version_id from active_publication_versions where publication_id = $1',
      [PUBLICATION_IDS.publicationId],
    );
    assert.equal(active.rows[0]?.publication_version_id, secondVersionId);

    const result = await submitPublicationFeedback(pool, {
      ...baseCommand,
      submissionId: '7b300000-0000-4000-8000-000000000004',
      requestHash: '1'.repeat(64),
    });
    assert.deepEqual(result, { outcome: 'accepted', replayed: false });
    const row = await pool.query<{ was_active_at_submission: boolean }>(
      'select was_active_at_submission from publication_feedback_submissions where client_submission_id = $1',
      ['7b300000-0000-4000-8000-000000000004'],
    );
    assert.equal(row.rows[0]?.was_active_at_submission, false);
  } finally { await pool.end(); }
});
