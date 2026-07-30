import assert from 'node:assert/strict';
import test from 'node:test';

import { Pool } from 'pg';

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
import { resetDatabase, tableCount } from './helpers/database.js';
import { GATE_IDS } from './helpers/gate.js';
import {
  PUBLICATION_IDS,
  SECOND_PUBLICATION_CONTEXT_IDS,
  seedEligiblePublicationContext,
  seedSecondEligiblePublicationContext,
} from './helpers/publication.js';
import { CROSS_PATCH_IDS } from './helpers/trust.js';

const CONCURRENCY_IDS = {
  competingPublicationId: '7c000000-0000-4000-8000-000000000001',
  competingVersionId: '7c000000-0000-4000-8000-000000000002',
  competingActivationId: '7c000000-0000-4000-8000-000000000003',
  competingAuditId: '7c000000-0000-4000-8000-000000000004',
  competingOutboxId: '7c000000-0000-4000-8000-000000000005',
  secondVersionId: '7d000000-0000-4000-8000-000000000001',
  secondActivationId: '7d000000-0000-4000-8000-000000000002',
  secondAuditId: '7d000000-0000-4000-8000-000000000003',
  secondOutboxId: '7d000000-0000-4000-8000-000000000004',
  thirdVersionId: '7d000000-0000-4000-8000-000000000005',
  thirdActivationId: '7d000000-0000-4000-8000-000000000006',
  thirdAuditId: '7d000000-0000-4000-8000-000000000007',
  thirdOutboxId: '7d000000-0000-4000-8000-000000000008',
  competingRollbackActivationId:
    '7e000000-0000-4000-8000-000000000001',
  competingRollbackAuditId: '7e000000-0000-4000-8000-000000000002',
  competingRollbackOutboxId: '7e000000-0000-4000-8000-000000000003',
  secondItemVersionTwoId: '7f000000-0000-4000-8000-000000000001',
  secondItemActivationTwoId: '7f000000-0000-4000-8000-000000000002',
  secondItemAuditTwoId: '7f000000-0000-4000-8000-000000000003',
  secondItemOutboxTwoId: '7f000000-0000-4000-8000-000000000004',
  firstItemRollbackActivationId:
    '7f000000-0000-4000-8000-000000000005',
  firstItemRollbackAuditId: '7f000000-0000-4000-8000-000000000006',
  firstItemRollbackOutboxId: '7f000000-0000-4000-8000-000000000007',
  secondItemRollbackActivationId:
    '7f000000-0000-4000-8000-000000000008',
  secondItemRollbackAuditId: '7f000000-0000-4000-8000-000000000009',
  secondItemRollbackOutboxId: '7f000000-0000-4000-8000-000000000010',
} as const;

function databaseUrl(): string {
  const value = process.env.TEST_DATABASE_URL;
  if (!value) {
    throw new Error('TEST_DATABASE_URL is required');
  }
  return value;
}

function boundedPool(): Pool {
  return new Pool({
    application_name: 'hai-dau-publication-concurrency-test',
    connectionString: databaseUrl(),
    max: 1,
    options: '-c lock_timeout=3000 -c statement_timeout=15000',
  });
}

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
      actorId: 'publication-concurrency-editor',
      permissions: ['publisher'],
    },
    auditId: PUBLICATION_IDS.auditId,
    outboxEventId: PUBLICATION_IDS.outboxEventId,
    correlationId: 'publication-concurrency-v1',
    idempotencyKey: 'publication-concurrency-v1',
    occurredAt: '2026-07-30T02:00:00.000Z',
    ...overrides,
  };
}

function secondPublishCommand(): PublishCandidateRevisionCommand {
  return firstPublishCommand({
    publicationVersionId: CONCURRENCY_IDS.secondVersionId,
    activationId: CONCURRENCY_IDS.secondActivationId,
    expectedActivePublicationVersionId:
      PUBLICATION_IDS.publicationVersionId,
    auditId: CONCURRENCY_IDS.secondAuditId,
    outboxEventId: CONCURRENCY_IDS.secondOutboxId,
    correlationId: 'publication-concurrency-v2',
    idempotencyKey: 'publication-concurrency-v2',
    occurredAt: '2026-07-30T02:10:00.000Z',
  });
}

function thirdPublishCommand(): PublishCandidateRevisionCommand {
  return firstPublishCommand({
    publicationVersionId: CONCURRENCY_IDS.thirdVersionId,
    activationId: CONCURRENCY_IDS.thirdActivationId,
    expectedActivePublicationVersionId: CONCURRENCY_IDS.secondVersionId,
    auditId: CONCURRENCY_IDS.thirdAuditId,
    outboxEventId: CONCURRENCY_IDS.thirdOutboxId,
    correlationId: 'publication-concurrency-v3',
    idempotencyKey: 'publication-concurrency-v3',
    occurredAt: '2026-07-30T02:20:00.000Z',
  });
}

function firstItemRollbackCommand(): RollbackPublicationCommand {
  return {
    publicationId: PUBLICATION_IDS.publicationId,
    targetPublicationVersionId: PUBLICATION_IDS.publicationVersionId,
    activationId: CONCURRENCY_IDS.firstItemRollbackActivationId,
    expectedActivePublicationVersionId: CONCURRENCY_IDS.secondVersionId,
    authorization: {
      actorId: 'publication-concurrency-editor',
      permissions: ['publisher'],
    },
    auditId: CONCURRENCY_IDS.firstItemRollbackAuditId,
    outboxEventId: CONCURRENCY_IDS.firstItemRollbackOutboxId,
    correlationId: 'publication-concurrency-rollback-a',
    idempotencyKey: 'publication-concurrency-rollback-a',
    occurredAt: '2026-07-30T02:30:00.000Z',
  };
}

function competingRollbackCommand(): RollbackPublicationCommand {
  return {
    ...firstItemRollbackCommand(),
    activationId: CONCURRENCY_IDS.competingRollbackActivationId,
    auditId: CONCURRENCY_IDS.competingRollbackAuditId,
    outboxEventId: CONCURRENCY_IDS.competingRollbackOutboxId,
    correlationId: 'publication-concurrency-publish-vs-rollback',
    idempotencyKey: 'publication-concurrency-publish-vs-rollback',
  };
}

function secondItemPublishCommand(
  overrides: Partial<PublishCandidateRevisionCommand> = {},
): PublishCandidateRevisionCommand {
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
      actorId: 'second-publication-concurrency-editor',
      permissions: ['publisher'],
    },
    auditId: SECOND_PUBLICATION_CONTEXT_IDS.auditId,
    outboxEventId: SECOND_PUBLICATION_CONTEXT_IDS.outboxEventId,
    correlationId: 'second-publication-concurrency-v1',
    idempotencyKey: 'second-publication-concurrency-v1',
    occurredAt: '2026-07-30T02:05:00.000Z',
    ...overrides,
  };
}

function secondItemVersionTwoCommand(): PublishCandidateRevisionCommand {
  return secondItemPublishCommand({
    publicationVersionId: CONCURRENCY_IDS.secondItemVersionTwoId,
    activationId: CONCURRENCY_IDS.secondItemActivationTwoId,
    expectedActivePublicationVersionId:
      SECOND_PUBLICATION_CONTEXT_IDS.publicationVersionId,
    auditId: CONCURRENCY_IDS.secondItemAuditTwoId,
    outboxEventId: CONCURRENCY_IDS.secondItemOutboxTwoId,
    correlationId: 'second-publication-concurrency-v2',
    idempotencyKey: 'second-publication-concurrency-v2',
    occurredAt: '2026-07-30T02:15:00.000Z',
  });
}

function secondItemRollbackCommand(): RollbackPublicationCommand {
  return {
    publicationId: SECOND_PUBLICATION_CONTEXT_IDS.publicationId,
    targetPublicationVersionId:
      SECOND_PUBLICATION_CONTEXT_IDS.publicationVersionId,
    activationId: CONCURRENCY_IDS.secondItemRollbackActivationId,
    expectedActivePublicationVersionId:
      CONCURRENCY_IDS.secondItemVersionTwoId,
    authorization: {
      actorId: 'second-publication-concurrency-editor',
      permissions: ['publisher'],
    },
    auditId: CONCURRENCY_IDS.secondItemRollbackAuditId,
    outboxEventId: CONCURRENCY_IDS.secondItemRollbackOutboxId,
    correlationId: 'second-publication-concurrency-rollback',
    idempotencyKey: 'second-publication-concurrency-rollback',
    occurredAt: '2026-07-30T02:35:00.000Z',
  };
}

function rejectionError(
  result: PromiseSettledResult<unknown>,
): Error & { code?: string } {
  assert.equal(result.status, 'rejected');
  assert.ok(result.reason instanceof Error);
  return result.reason as Error & { code?: string };
}

function assertNoDeadlock(error: Error & { code?: string }): void {
  assert.notEqual(error.code, '40P01');
  assert.doesNotMatch(error.message, /deadlock detected/i);
}

async function assertPointerMatchesLatestActivation(pool: Pool): Promise<void> {
  const mismatch = await pool.query<{ count: string }>(
    `select count(*)
       from active_publication_versions pointer
       left join publication_activation_history activation
         on activation.activation_id = pointer.activation_id
        and activation.publication_id = pointer.publication_id
        and activation.to_publication_version_id =
            pointer.publication_version_id
        and activation.activation_sequence = pointer.activation_sequence
      where activation.activation_id is null
         or pointer.activation_sequence <>
            (select max(history.activation_sequence)
               from publication_activation_history history
              where history.publication_id = pointer.publication_id)`,
  );
  assert.equal(mismatch.rows[0]?.count, '0');
}

test('concurrent first publishes create one Publication aggregate and one version-one winner', async () => {
  const setupPool = await resetDatabase();
  await seedEligiblePublicationContext(setupPool);
  const left = boundedPool();
  const right = boundedPool();

  try {
    const results = await Promise.allSettled([
      publishCandidateRevision(left, firstPublishCommand()),
      publishCandidateRevision(right, firstPublishCommand({
        publicationId: CONCURRENCY_IDS.competingPublicationId,
        publicationVersionId: CONCURRENCY_IDS.competingVersionId,
        activationId: CONCURRENCY_IDS.competingActivationId,
        auditId: CONCURRENCY_IDS.competingAuditId,
        outboxEventId: CONCURRENCY_IDS.competingOutboxId,
        correlationId: 'publication-concurrency-competing-v1',
        idempotencyKey: 'publication-concurrency-competing-v1',
      })),
    ]);
    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');

    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    const error = rejectionError(rejected[0]!);
    assertNoDeadlock(error);
    assert.match(error.message, /PUBLICATION_CANDIDATE_CONFLICT/);
    assert.equal(await tableCount(setupPool, 'publications'), 1);
    assert.equal(await tableCount(setupPool, 'publication_versions'), 1);
    assert.equal(
      await tableCount(setupPool, 'publication_activation_history'),
      1,
    );
    assert.equal(await tableCount(setupPool, 'active_publication_versions'), 1);
    await assertPointerMatchesLatestActivation(setupPool);
  } finally {
    await Promise.all([left.end(), right.end(), setupPool.end()]);
  }
});

test('concurrent version-three publish and rollback have one CAS winner without orphan history', async () => {
  const setupPool = await resetDatabase();
  await seedEligiblePublicationContext(setupPool);
  await publishCandidateRevision(setupPool, firstPublishCommand());
  await publishCandidateRevision(setupPool, secondPublishCommand());
  const left = boundedPool();
  const right = boundedPool();

  try {
    const results = await Promise.allSettled([
      publishCandidateRevision(left, thirdPublishCommand()),
      rollbackPublication(right, competingRollbackCommand()),
    ]);
    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');

    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    const error = rejectionError(rejected[0]!);
    assertNoDeadlock(error);
    assert.match(error.message, /PUBLICATION_ACTIVE_POINTER_CONFLICT/);
    assert.equal(
      await tableCount(setupPool, 'publication_activation_history'),
      3,
    );
    const orphanVersions = await setupPool.query<{ count: string }>(
      `select count(*)
         from publication_versions version
         left join publication_activation_history activation
           on activation.publication_id = version.publication_id
          and activation.to_publication_version_id =
              version.publication_version_id
        where activation.activation_id is null`,
    );
    assert.equal(orphanVersions.rows[0]?.count, '0');
    await assertPointerMatchesLatestActivation(setupPool);
  } finally {
    await Promise.all([left.end(), right.end(), setupPool.end()]);
  }
});

test('concurrent rollbacks of different Publication items proceed independently', async () => {
  const setupPool = await resetDatabase();
  await seedEligiblePublicationContext(setupPool);
  await seedSecondEligiblePublicationContext(setupPool);
  await publishCandidateRevision(setupPool, firstPublishCommand());
  await publishCandidateRevision(setupPool, secondPublishCommand());
  await publishCandidateRevision(setupPool, secondItemPublishCommand());
  await publishCandidateRevision(setupPool, secondItemVersionTwoCommand());
  const left = boundedPool();
  const right = boundedPool();

  try {
    const results = await Promise.allSettled([
      rollbackPublication(left, firstItemRollbackCommand()),
      rollbackPublication(right, secondItemRollbackCommand()),
    ]);

    for (const result of results) {
      if (result.status === 'rejected') {
        assertNoDeadlock(rejectionError(result));
      }
    }
    assert.ok(results.every((result) => result.status === 'fulfilled'));
    const pointers = await setupPool.query<{
      publication_id: string;
      publication_version_id: string;
    }>(
      `select publication_id, publication_version_id
         from active_publication_versions
        order by publication_id`,
    );
    assert.deepEqual(pointers.rows, [
      {
        publication_id: PUBLICATION_IDS.publicationId,
        publication_version_id: PUBLICATION_IDS.publicationVersionId,
      },
      {
        publication_id: SECOND_PUBLICATION_CONTEXT_IDS.publicationId,
        publication_version_id:
          SECOND_PUBLICATION_CONTEXT_IDS.publicationVersionId,
      },
    ]);
    assert.equal(
      await tableCount(setupPool, 'publication_activation_history'),
      6,
    );
    await assertPointerMatchesLatestActivation(setupPool);
  } finally {
    await Promise.all([left.end(), right.end(), setupPool.end()]);
  }
});
