import assert from 'node:assert/strict';
import test from 'node:test';

import type { PoolClient } from 'pg';

import {
  publishCandidateRevision,
} from '../src/modules/publication/publish-candidate-revision.js';
import type {
  PublishCandidateRevisionCommand,
} from '../src/modules/publication/types.js';
import { resetDatabase } from './helpers/database.js';
import { GATE_IDS } from './helpers/gate.js';
import {
  PUBLICATION_IDS,
  seedEligiblePublicationContext,
} from './helpers/publication.js';

const HARDENING_IDS = {
  secondVersionId: '7a000000-0000-4000-8000-000000000001',
  secondActivationId: '7a000000-0000-4000-8000-000000000002',
  secondAuditId: '7a000000-0000-4000-8000-000000000003',
  secondOutboxEventId: '7a000000-0000-4000-8000-000000000004',
  oldVersionPublishActivationId: '7a000000-0000-4000-8000-000000000005',
  oldVersionPublishAuditId: '7a000000-0000-4000-8000-000000000006',
  oldVersionPublishOutboxEventId: '7a000000-0000-4000-8000-000000000007',
  pointerlessRollbackActivationId: '7a000000-0000-4000-8000-000000000008',
  pointerlessRollbackAuditId: '7a000000-0000-4000-8000-000000000009',
  pointerlessRollbackOutboxEventId: '7a000000-0000-4000-8000-000000000010',
  noopRollbackActivationId: '7a000000-0000-4000-8000-000000000011',
  noopRollbackAuditId: '7a000000-0000-4000-8000-000000000012',
  noopRollbackOutboxEventId: '7a000000-0000-4000-8000-000000000013',
} as const;

function firstPublishCommand(
  overrides: Partial<PublishCandidateRevisionCommand> = {},
): PublishCandidateRevisionCommand {
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
      actorId: 'publication-hardening-editor',
      permissions: ['publisher'],
    },
    auditId: PUBLICATION_IDS.auditId,
    outboxEventId: PUBLICATION_IDS.outboxEventId,
    correlationId: 'publication-hardening-v1',
    idempotencyKey: 'publication-hardening-v1',
    occurredAt: '2026-07-30T01:00:00.000Z',
    ...overrides,
  };
}

function secondPublishCommand(): PublishCandidateRevisionCommand {
  return firstPublishCommand({
    publicationVersionId: HARDENING_IDS.secondVersionId,
    activationId: HARDENING_IDS.secondActivationId,
    expectedActivePublicationVersionId:
      PUBLICATION_IDS.publicationVersionId,
    auditId: HARDENING_IDS.secondAuditId,
    outboxEventId: HARDENING_IDS.secondOutboxEventId,
    correlationId: 'publication-hardening-v2',
    idempotencyKey: 'publication-hardening-v2',
    occurredAt: '2026-07-30T01:10:00.000Z',
  });
}

async function seedTwoVersions(
  pool: Awaited<ReturnType<typeof resetDatabase>>,
): Promise<void> {
  await seedEligiblePublicationContext(pool);
  await publishCandidateRevision(pool, firstPublishCommand());
  await publishCandidateRevision(pool, secondPublishCommand());
}

async function insertActivationEnvelope(
  client: PoolClient,
  input: {
    activationId: string;
    auditId: string;
    outboxEventId: string;
    eventType: 'PublicationPublished' | 'PublicationRolledBack';
    action:
      | 'publication.version_published'
      | 'publication.version_rolled_back';
  },
): Promise<void> {
  await client.query(
    `insert into audit_events
       (audit_event_id, actor_id, action, reason, correlation_id, payload)
     values ($1, 'direct-sql-hardening', $2,
             'direct SQL mutation hardening', $3, '{}'::jsonb)`,
    [input.auditId, input.action, input.activationId],
  );
  await client.query(
    `insert into outbox_events
       (outbox_event_id, aggregate_type, aggregate_id, event_type,
        payload, correlation_id)
     values ($1, 'Publication', $2, $3, '{}'::jsonb, $4)`,
    [
      input.outboxEventId,
      PUBLICATION_IDS.publicationId,
      input.eventType,
      input.activationId,
    ],
  );
}

async function closeClient(
  client: PoolClient,
  transactionOpen: boolean,
): Promise<void> {
  if (transactionOpen) {
    await client.query('rollback');
  }
  client.release();
}

test('PostgreSQL rejects publish activation targeting an older version', async () => {
  const pool = await resetDatabase();
  await seedTwoVersions(pool);
  const client = await pool.connect();
  let transactionOpen = false;

  try {
    await client.query('begin');
    transactionOpen = true;
    await insertActivationEnvelope(client, {
      activationId: HARDENING_IDS.oldVersionPublishActivationId,
      auditId: HARDENING_IDS.oldVersionPublishAuditId,
      outboxEventId: HARDENING_IDS.oldVersionPublishOutboxEventId,
      eventType: 'PublicationPublished',
      action: 'publication.version_published',
    });
    const activation = await client.query<{ activation_sequence: string }>(
      `insert into publication_activation_history
         (activation_id, publication_id, activation_kind,
          from_publication_version_id, to_publication_version_id,
          actor_id, audit_event_id, outbox_event_id, correlation_id,
          activated_at)
       values ($1, $2, 'published', $3, $4,
               'direct-sql-hardening', $5, $6, $7,
               '2026-07-30T01:20:00.000Z')
       returning activation_sequence::text`,
      [
        HARDENING_IDS.oldVersionPublishActivationId,
        PUBLICATION_IDS.publicationId,
        HARDENING_IDS.secondVersionId,
        PUBLICATION_IDS.publicationVersionId,
        HARDENING_IDS.oldVersionPublishAuditId,
        HARDENING_IDS.oldVersionPublishOutboxEventId,
        HARDENING_IDS.oldVersionPublishActivationId,
      ],
    );
    await client.query(
      `update active_publication_versions
          set publication_version_id = $2,
              activation_id = $3,
              activation_sequence = $4::bigint,
              updated_at = clock_timestamp()
        where publication_id = $1`,
      [
        PUBLICATION_IDS.publicationId,
        PUBLICATION_IDS.publicationVersionId,
        HARDENING_IDS.oldVersionPublishActivationId,
        activation.rows[0]!.activation_sequence,
      ],
    );

    const commit = client.query('commit').finally(() => {
      transactionOpen = false;
    });
    await assert.rejects(commit, /publication activation transition mismatch/);
  } finally {
    await closeClient(client, transactionOpen);
    await pool.end();
  }
});

test('PostgreSQL rejects activation history without a matching active pointer', async () => {
  const pool = await resetDatabase();
  await seedTwoVersions(pool);
  const client = await pool.connect();
  let transactionOpen = false;

  try {
    await client.query('begin');
    transactionOpen = true;
    await insertActivationEnvelope(client, {
      activationId: HARDENING_IDS.pointerlessRollbackActivationId,
      auditId: HARDENING_IDS.pointerlessRollbackAuditId,
      outboxEventId: HARDENING_IDS.pointerlessRollbackOutboxEventId,
      eventType: 'PublicationRolledBack',
      action: 'publication.version_rolled_back',
    });
    await client.query(
      `insert into publication_activation_history
         (activation_id, publication_id, activation_kind,
          from_publication_version_id, to_publication_version_id,
          actor_id, audit_event_id, outbox_event_id, correlation_id,
          activated_at)
       values ($1, $2, 'rolled_back', $3, $4,
               'direct-sql-hardening', $5, $6, $7,
               '2026-07-30T01:30:00.000Z')`,
      [
        HARDENING_IDS.pointerlessRollbackActivationId,
        PUBLICATION_IDS.publicationId,
        HARDENING_IDS.secondVersionId,
        PUBLICATION_IDS.publicationVersionId,
        HARDENING_IDS.pointerlessRollbackAuditId,
        HARDENING_IDS.pointerlessRollbackOutboxEventId,
        HARDENING_IDS.pointerlessRollbackActivationId,
      ],
    );

    const commit = client.query('commit').finally(() => {
      transactionOpen = false;
    });
    await assert.rejects(commit, /active publication pointer mismatch/);
  } finally {
    await closeClient(client, transactionOpen);
    await pool.end();
  }
});

test('PostgreSQL rejects no-op rollback activation targeting the active version', async () => {
  const pool = await resetDatabase();
  await seedTwoVersions(pool);
  const client = await pool.connect();
  let transactionOpen = false;

  try {
    await client.query('begin');
    transactionOpen = true;
    await insertActivationEnvelope(client, {
      activationId: HARDENING_IDS.noopRollbackActivationId,
      auditId: HARDENING_IDS.noopRollbackAuditId,
      outboxEventId: HARDENING_IDS.noopRollbackOutboxEventId,
      eventType: 'PublicationRolledBack',
      action: 'publication.version_rolled_back',
    });
    await assert.rejects(
      client.query(
        `insert into publication_activation_history
           (activation_id, publication_id, activation_kind,
            from_publication_version_id, to_publication_version_id,
            actor_id, audit_event_id, outbox_event_id, correlation_id,
            activated_at)
         values ($1, $2, 'rolled_back', $3, $3,
                 'direct-sql-hardening', $4, $5, $6,
                 '2026-07-30T01:40:00.000Z')`,
        [
          HARDENING_IDS.noopRollbackActivationId,
          PUBLICATION_IDS.publicationId,
          HARDENING_IDS.secondVersionId,
          HARDENING_IDS.noopRollbackAuditId,
          HARDENING_IDS.noopRollbackOutboxEventId,
          HARDENING_IDS.noopRollbackActivationId,
        ],
      ),
      /publication_activation_history_check|check constraint/i,
    );
  } finally {
    await closeClient(client, transactionOpen);
    await pool.end();
  }
});
