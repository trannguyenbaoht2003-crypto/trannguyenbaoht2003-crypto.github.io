import assert from 'node:assert/strict';
import test from 'node:test';

import {
  publishCandidateRevision,
} from '../src/modules/publication/publish-candidate-revision.js';
import type {
  PublishCandidateRevisionCommand,
} from '../src/modules/publication/types.js';
import { resetDatabase, tableCount } from './helpers/database.js';
import { GATE_IDS } from './helpers/gate.js';
import {
  PUBLICATION_IDS,
  SECOND_PUBLICATION_CONTEXT_IDS,
  seedEligiblePublicationContext,
  seedSecondEligiblePublicationContext,
} from './helpers/publication.js';
import { CROSS_PATCH_IDS } from './helpers/trust.js';

const DIRECT_GUARD_IDS = {
  crossActivationId: '7b200000-0000-4000-8000-000000000001',
  crossAuditId: '7b200000-0000-4000-8000-000000000002',
  crossOutboxId: '7b200000-0000-4000-8000-000000000003',
  forgedActivationId: '7b200000-0000-4000-8000-000000000004',
} as const;

function firstPublishCommand(): PublishCandidateRevisionCommand {
  return {
    publicationId: PUBLICATION_IDS.publicationId,
    publicationVersionId: PUBLICATION_IDS.publicationVersionId,
    activationId: PUBLICATION_IDS.activationId,
    candidateRevisionId: '62000000-0000-4000-8000-000000000002',
    expectedActiveEligibilityPolicyRevisionId:
      GATE_IDS.eligibilityPolicyId,
    expectedEligibilityEvaluationId: GATE_IDS.eligibilityEvaluationId,
    expectedModerationDecisionId: GATE_IDS.moderationDecisionId,
    expectedActivePublicationVersionId: null,
    authorization: {
      actorId: 'publication-direct-sql-editor',
      permissions: ['publisher'],
    },
    auditId: PUBLICATION_IDS.auditId,
    outboxEventId: PUBLICATION_IDS.outboxEventId,
    correlationId: 'publication-direct-sql-v1',
    idempotencyKey: 'publication-direct-sql-v1',
    occurredAt: '2026-07-30T04:00:00.000Z',
  };
}

function secondItemPublishCommand(): PublishCandidateRevisionCommand {
  return {
    publicationId: SECOND_PUBLICATION_CONTEXT_IDS.publicationId,
    publicationVersionId:
      SECOND_PUBLICATION_CONTEXT_IDS.publicationVersionId,
    activationId: SECOND_PUBLICATION_CONTEXT_IDS.activationId,
    candidateRevisionId: CROSS_PATCH_IDS.candidateRevisionId,
    expectedActiveEligibilityPolicyRevisionId:
      GATE_IDS.eligibilityPolicyId,
    expectedEligibilityEvaluationId:
      SECOND_PUBLICATION_CONTEXT_IDS.eligibilityEvaluationId,
    expectedModerationDecisionId:
      SECOND_PUBLICATION_CONTEXT_IDS.moderationDecisionId,
    expectedActivePublicationVersionId: null,
    authorization: {
      actorId: 'publication-direct-sql-editor-b',
      permissions: ['publisher'],
    },
    auditId: SECOND_PUBLICATION_CONTEXT_IDS.auditId,
    outboxEventId: SECOND_PUBLICATION_CONTEXT_IDS.outboxEventId,
    correlationId: 'publication-direct-sql-b-v1',
    idempotencyKey: 'publication-direct-sql-b-v1',
    occurredAt: '2026-07-30T04:05:00.000Z',
  };
}

test('PostgreSQL rejects rollback activation targeting a version owned by another Publication', async () => {
  const pool = await resetDatabase();
  await seedEligiblePublicationContext(pool);
  await seedSecondEligiblePublicationContext(pool);
  await publishCandidateRevision(pool, firstPublishCommand());
  await publishCandidateRevision(pool, secondItemPublishCommand());
  const client = await pool.connect();
  let transactionOpen = false;

  try {
    await client.query('begin');
    transactionOpen = true;
    await client.query(
      `insert into audit_events
         (audit_event_id, actor_id, action, reason, correlation_id, payload)
       values ($1, 'direct-sql-cross-publication',
               'publication.version_rolled_back',
               'cross Publication mutation', $2, '{}'::jsonb)`,
      [DIRECT_GUARD_IDS.crossAuditId, DIRECT_GUARD_IDS.crossActivationId],
    );
    await client.query(
      `insert into outbox_events
         (outbox_event_id, aggregate_type, aggregate_id, event_type,
          payload, correlation_id)
       values ($1, 'Publication', $2, 'PublicationRolledBack',
               '{}'::jsonb, $3)`,
      [
        DIRECT_GUARD_IDS.crossOutboxId,
        PUBLICATION_IDS.publicationId,
        DIRECT_GUARD_IDS.crossActivationId,
      ],
    );
    await assert.rejects(
      client.query(
        `insert into publication_activation_history
           (activation_id, publication_id, activation_kind,
            from_publication_version_id, to_publication_version_id,
            actor_id, audit_event_id, outbox_event_id, correlation_id,
            activated_at)
         values ($1, $2, 'rolled_back', $3, $4,
                 'direct-sql-cross-publication', $5, $6, $7,
                 '2026-07-30T04:10:00.000Z')`,
        [
          DIRECT_GUARD_IDS.crossActivationId,
          PUBLICATION_IDS.publicationId,
          PUBLICATION_IDS.publicationVersionId,
          SECOND_PUBLICATION_CONTEXT_IDS.publicationVersionId,
          DIRECT_GUARD_IDS.crossAuditId,
          DIRECT_GUARD_IDS.crossOutboxId,
          DIRECT_GUARD_IDS.crossActivationId,
        ],
      ),
      /foreign key constraint|not present/i,
    );
  } finally {
    if (transactionOpen) {
      await client.query('rollback');
    }
    client.release();
    assert.equal(
      await tableCount(pool, 'publication_activation_history'),
      2,
    );
    assert.equal(await tableCount(pool, 'active_publication_versions'), 2);
    await pool.end();
  }
});

test('PostgreSQL rejects an active pointer without matching activation history', async () => {
  const pool = await resetDatabase();
  await seedEligiblePublicationContext(pool);
  await publishCandidateRevision(pool, firstPublishCommand());

  await assert.rejects(
    pool.query(
      `update active_publication_versions
          set activation_id = $2,
              activation_sequence = activation_sequence + 100
        where publication_id = $1`,
      [
        PUBLICATION_IDS.publicationId,
        DIRECT_GUARD_IDS.forgedActivationId,
      ],
    ),
    /active publication pointer mismatch|foreign key constraint/i,
  );
  const pointer = await pool.query<{
    activation_id: string;
    publication_version_id: string;
  }>(
    `select activation_id, publication_version_id
       from active_publication_versions
      where publication_id = $1`,
    [PUBLICATION_IDS.publicationId],
  );
  assert.deepEqual(pointer.rows[0], {
    activation_id: PUBLICATION_IDS.activationId,
    publication_version_id: PUBLICATION_IDS.publicationVersionId,
  });
  await pool.end();
});
