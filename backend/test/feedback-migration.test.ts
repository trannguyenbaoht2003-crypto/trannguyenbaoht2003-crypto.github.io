import assert from 'node:assert/strict';
import test from 'node:test';

import { createPool } from '../src/database/pool.js';
import { migrate } from '../src/database/migrate.js';
import { withTransaction } from '../src/database/transaction.js';
import {
  publishCandidateRevision,
} from '../src/modules/publication/publish-candidate-revision.js';
import { GATE_IDS } from './helpers/gate.js';
import {
  PUBLICATION_IDS,
  SECOND_PUBLICATION_CONTEXT_IDS,
  insertDirectPublicationGraph,
  seedEligiblePublicationContext,
  seedSecondEligiblePublicationContext,
} from './helpers/publication.js';
import { CROSS_PATCH_IDS } from './helpers/trust.js';

function testDatabaseUrl(): string {
  const value = process.env.TEST_DATABASE_URL;
  if (!value) throw new Error('TEST_DATABASE_URL is required for feedback migration tests');
  return value;
}

async function resetDatabase() {
  const pool = createPool(testDatabaseUrl());
  await pool.query('drop schema public cascade; create schema public');
  await migrate(pool);
  return pool;
}

test('feedback migration creates only the bounded receipt columns', async () => {
  const pool = await resetDatabase();
  try {
    const result = await pool.query<{ column_name: string }>(
      `select column_name
         from information_schema.columns
        where table_schema = 'public'
          and table_name = 'publication_feedback_submissions'
        order by ordinal_position`,
    );

    assert.deepEqual(result.rows.map((row) => row.column_name), [
      'id',
      'client_submission_id',
      'request_hash',
      'publication_id',
      'publication_version_id',
      'reason_code',
      'details',
      'was_active_at_submission',
      'received_at',
      'created_at',
    ]);
    for (const forbidden of [
      'ip', 'ip_address', 'fingerprint', 'user_agent', 'cookie',
      'authorization', 'session_id', 'email', 'account_id',
    ]) {
      assert.ok(!result.rows.some((row) => row.column_name === forbidden));
    }
  } finally {
    await pool.end();
  }
});

test('feedback receipt constraints reject invalid reasons, missing OTHER details, and mutation', async () => {
  const pool = await resetDatabase();
  try {
    await seedEligiblePublicationContext(pool);
    await withTransaction(pool, (client) => insertDirectPublicationGraph(client));

    const baseParams = [
      '7b100000-0000-4000-8000-000000000001',
      '7b100000-0000-4000-8000-000000000002',
      'a'.repeat(64),
      PUBLICATION_IDS.publicationId,
      PUBLICATION_IDS.publicationVersionId,
    ];

    await assert.rejects(
      pool.query(
        `insert into publication_feedback_submissions
           (id, client_submission_id, request_hash, publication_id,
            publication_version_id, reason_code, details,
            was_active_at_submission, received_at)
         values ($1,$2,$3,$4,$5,'NOT_A_REASON',null,true,clock_timestamp())`,
        baseParams,
      ),
      /check constraint|violates check/i,
    );

    await assert.rejects(
      pool.query(
        `insert into publication_feedback_submissions
           (id, client_submission_id, request_hash, publication_id,
            publication_version_id, reason_code, details,
            was_active_at_submission, received_at)
         values ($1,$2,$3,$4,$5,'OTHER',null,true,clock_timestamp())`,
        baseParams,
      ),
      /check constraint|violates check/i,
    );

    await pool.query(
      `insert into publication_feedback_submissions
         (id, client_submission_id, request_hash, publication_id,
          publication_version_id, reason_code, details,
          was_active_at_submission, received_at)
       values
         ('7b100000-0000-4000-8000-000000000003',
          '7b100000-0000-4000-8000-000000000004',
          $1,$2,$3,'WRONG_ITEMS','Sai trang bị',true,clock_timestamp())`,
      ['b'.repeat(64), PUBLICATION_IDS.publicationId, PUBLICATION_IDS.publicationVersionId],
    );

    await assert.rejects(
      pool.query(`update publication_feedback_submissions set reason_code = 'OUTDATED'`),
      /immutable/i,
    );
    await assert.rejects(
      pool.query('delete from publication_feedback_submissions'),
      /immutable/i,
    );
  } finally {
    await pool.end();
  }
});

test('feedback receipt composite foreign key rejects a version paired with another Publication', async () => {
  const pool = await resetDatabase();
  try {
    await seedEligiblePublicationContext(pool);
    await withTransaction(pool, (client) => insertDirectPublicationGraph(client));
    await seedSecondEligiblePublicationContext(pool);
    await publishCandidateRevision(pool, {
      publicationId: SECOND_PUBLICATION_CONTEXT_IDS.publicationId,
      publicationVersionId: SECOND_PUBLICATION_CONTEXT_IDS.publicationVersionId,
      activationId: SECOND_PUBLICATION_CONTEXT_IDS.activationId,
      candidateRevisionId: CROSS_PATCH_IDS.candidateRevisionId,
      expectedActiveEligibilityPolicyRevisionId: GATE_IDS.eligibilityPolicyId,
      expectedEligibilityEvaluationId:
        SECOND_PUBLICATION_CONTEXT_IDS.eligibilityEvaluationId,
      expectedModerationDecisionId:
        SECOND_PUBLICATION_CONTEXT_IDS.moderationDecisionId,
      expectedActivePublicationVersionId: null,
      authorization: {
        actorId: 'feedback-fk-test',
        permissions: ['publisher'],
      },
      auditId: SECOND_PUBLICATION_CONTEXT_IDS.auditId,
      outboxEventId: SECOND_PUBLICATION_CONTEXT_IDS.outboxEventId,
      correlationId: 'feedback-fk-second-publication',
      idempotencyKey: 'feedback-fk-second-publication',
      occurredAt: '2026-08-17T01:00:00.000Z',
    });

    await assert.rejects(
      pool.query(
        `insert into publication_feedback_submissions
           (id, client_submission_id, request_hash, publication_id,
            publication_version_id, reason_code, details,
            was_active_at_submission, received_at)
         values
           ('7b100000-0000-4000-8000-000000000006',
            '7b100000-0000-4000-8000-000000000007',
            $1,$2,$3,'OUTDATED',null,false,clock_timestamp())`,
        [
          'c'.repeat(64),
          SECOND_PUBLICATION_CONTEXT_IDS.publicationId,
          PUBLICATION_IDS.publicationVersionId,
        ],
      ),
      /foreign key|violates foreign key/i,
    );
  } finally {
    await pool.end();
  }
});
