import assert from 'node:assert/strict';
import test from 'node:test';

import {
  publishCandidateRevision,
} from '../src/modules/publication/publish-candidate-revision.js';
import {
  readActivePublicationById,
  readActivePublications,
} from '../src/modules/publication/read-active-publications.js';
import {
  rollbackPublication,
} from '../src/modules/publication/rollback-publication.js';
import type {
  ActivePublicationRead,
  PublishCandidateRevisionCommand,
  RollbackPublicationCommand,
} from '../src/modules/publication/types.js';
import { CANDIDATE_IDS } from './helpers/candidate.js';
import { tableCount, resetDatabase } from './helpers/database.js';
import { GATE_IDS } from './helpers/gate.js';
import {
  PUBLICATION_IDS,
  SECOND_PUBLICATION_CONTEXT_IDS,
  seedEligiblePublicationContext,
  seedSecondEligiblePublicationContext,
} from './helpers/publication.js';
import { CROSS_PATCH_IDS } from './helpers/trust.js';

const ROLLBACK_IDS = {
  secondVersionId: '79000000-0000-4000-8000-000000000001',
  secondActivationId: '79000000-0000-4000-8000-000000000002',
  secondAuditId: '79000000-0000-4000-8000-000000000003',
  secondOutboxEventId: '79000000-0000-4000-8000-000000000004',
  rollbackActivationId: '79000000-0000-4000-8000-000000000005',
  rollbackAuditId: '79000000-0000-4000-8000-000000000006',
  rollbackOutboxEventId: '79000000-0000-4000-8000-000000000007',
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
      actorId: 'publication-editor',
      permissions: ['publisher'],
    },
    auditId: PUBLICATION_IDS.auditId,
    outboxEventId: PUBLICATION_IDS.outboxEventId,
    correlationId: 'publication-publish-v1',
    idempotencyKey: 'publication-publish-v1',
    occurredAt: '2026-07-29T02:00:00.000Z',
    ...overrides,
  };
}

function secondPublishCommand(
  overrides: Partial<PublishCandidateRevisionCommand> = {},
): PublishCandidateRevisionCommand {
  return firstPublishCommand({
    publicationVersionId: ROLLBACK_IDS.secondVersionId,
    activationId: ROLLBACK_IDS.secondActivationId,
    expectedActivePublicationVersionId:
      PUBLICATION_IDS.publicationVersionId,
    auditId: ROLLBACK_IDS.secondAuditId,
    outboxEventId: ROLLBACK_IDS.secondOutboxEventId,
    correlationId: 'publication-publish-v2',
    idempotencyKey: 'publication-publish-v2',
    occurredAt: '2026-07-29T02:10:00.000Z',
    ...overrides,
  });
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
      actorId: 'second-publication-editor',
      permissions: ['publisher'],
    },
    auditId: SECOND_PUBLICATION_CONTEXT_IDS.auditId,
    outboxEventId: SECOND_PUBLICATION_CONTEXT_IDS.outboxEventId,
    correlationId: 'second-publication-publish-v1',
    idempotencyKey: 'second-publication-publish-v1',
    occurredAt: '2026-07-29T02:05:00.000Z',
  };
}

function rollbackCommand(
  overrides: Partial<RollbackPublicationCommand> = {},
): RollbackPublicationCommand {
  return {
    publicationId: PUBLICATION_IDS.publicationId,
    targetPublicationVersionId: PUBLICATION_IDS.publicationVersionId,
    activationId: ROLLBACK_IDS.rollbackActivationId,
    expectedActivePublicationVersionId: ROLLBACK_IDS.secondVersionId,
    authorization: {
      actorId: 'publication-editor',
      permissions: ['publisher'],
    },
    auditId: ROLLBACK_IDS.rollbackAuditId,
    outboxEventId: ROLLBACK_IDS.rollbackOutboxEventId,
    correlationId: 'publication-rollback-v1',
    idempotencyKey: 'publication-rollback-v1',
    occurredAt: '2026-07-29T02:20:00.000Z',
    ...overrides,
  };
}

async function seedTwoVersions(
  pool: Awaited<ReturnType<typeof resetDatabase>>,
): Promise<void> {
  await seedEligiblePublicationContext(pool);
  await publishCandidateRevision(pool, firstPublishCommand());
  await publishCandidateRevision(pool, secondPublishCommand());
}

function firstPublicationRead(
  publicationVersionId: string,
  versionNumber: number,
  publishedAt: string,
): ActivePublicationRead {
  return {
    publicationId: PUBLICATION_IDS.publicationId,
    candidateId: CANDIDATE_IDS.candidateId,
    candidateRevisionId: CANDIDATE_IDS.candidateRevisionId,
    publicationVersionId,
    versionNumber,
    publishedAt,
    payload: {
      schemaVersion: 1,
      mode: 'aram_mayhem',
      patchKey: '26.15',
      catalogRevisionId: '40000000-0000-4000-8000-000000000005',
      championExternalId: 'samira',
      augmentExternalIds: ['1194'],
      itemExternalIds: ['3006', '6672'],
    },
  };
}

test('public read hides eligible but unpublished Candidates', async () => {
  const pool = await resetDatabase();
  await seedEligiblePublicationContext(pool);

  assert.deepEqual(await readActivePublications(pool), []);
  assert.equal(
    await readActivePublicationById(
      pool,
      PUBLICATION_IDS.publicationId,
    ),
    null,
  );
  await pool.end();
});

test('public read returns only the active immutable PublicationVersion', async () => {
  const pool = await resetDatabase();
  await seedTwoVersions(pool);
  const expected = firstPublicationRead(
    ROLLBACK_IDS.secondVersionId,
    2,
    '2026-07-29T02:10:00.000Z',
  );

  assert.deepEqual(await readActivePublications(pool), [expected]);
  assert.deepEqual(
    await readActivePublicationById(
      pool,
      PUBLICATION_IDS.publicationId,
    ),
    expected,
  );
  await pool.end();
});

test('public read follows rollback without exposing the inactive version', async () => {
  const pool = await resetDatabase();
  await seedTwoVersions(pool);
  await rollbackPublication(pool, rollbackCommand());
  const expected = firstPublicationRead(
    PUBLICATION_IDS.publicationVersionId,
    1,
    '2026-07-29T02:00:00.000Z',
  );

  assert.deepEqual(await readActivePublications(pool), [expected]);
  assert.deepEqual(
    await readActivePublicationById(
      pool,
      PUBLICATION_IDS.publicationId,
    ),
    expected,
  );
  await pool.end();
});

test('public read orders active Publications deterministically', async () => {
  const pool = await resetDatabase();
  await seedEligiblePublicationContext(pool);
  await seedSecondEligiblePublicationContext(pool);
  await publishCandidateRevision(pool, firstPublishCommand());
  await publishCandidateRevision(pool, secondItemPublishCommand());

  const reads = await readActivePublications(pool);

  assert.deepEqual(
    reads.map((read: ActivePublicationRead) => read.publicationId),
    [
      PUBLICATION_IDS.publicationId,
      SECOND_PUBLICATION_CONTEXT_IDS.publicationId,
    ],
  );
  await pool.end();
});

test('public read does not require Redis, workers, or projection effects', async () => {
  const pool = await resetDatabase();
  await seedEligiblePublicationContext(pool);
  await publishCandidateRevision(pool, firstPublishCommand());
  assert.equal(await tableCount(pool, 'publication_projection_effects'), 0);
  const testRedisUrl = process.env.TEST_REDIS_URL;
  const redisUrl = process.env.REDIS_URL;
  process.env.TEST_REDIS_URL = 'redis://127.0.0.1:1';
  process.env.REDIS_URL = 'redis://127.0.0.1:1';

  try {
    assert.deepEqual(
      await readActivePublications(pool),
      [
        firstPublicationRead(
          PUBLICATION_IDS.publicationVersionId,
          1,
          '2026-07-29T02:00:00.000Z',
        ),
      ],
    );
  } finally {
    if (testRedisUrl === undefined) {
      delete process.env.TEST_REDIS_URL;
    } else {
      process.env.TEST_REDIS_URL = testRedisUrl;
    }
    if (redisUrl === undefined) {
      delete process.env.REDIS_URL;
    } else {
      process.env.REDIS_URL = redisUrl;
    }
    await pool.end();
  }
});

test('Publication rollback requires explicit publisher permission without effects', async () => {
  const pool = await resetDatabase();
  await seedTwoVersions(pool);

  await assert.rejects(
    rollbackPublication(pool, rollbackCommand({
      authorization: {
        actorId: 'reader',
        permissions: [],
      },
    })),
    /PUBLISHER_PERMISSION_REQUIRED/,
  );
  assert.equal(await tableCount(pool, 'publication_versions'), 2);
  assert.equal(await tableCount(pool, 'publication_activation_history'), 2);
  await pool.end();
});

test('Publication rollback moves only the pointer and preserves immutable versions', async () => {
  const pool = await resetDatabase();
  await seedTwoVersions(pool);

  const result = await rollbackPublication(pool, rollbackCommand());

  assert.deepEqual(result, {
    publicationId: PUBLICATION_IDS.publicationId,
    previousActivePublicationVersionId: ROLLBACK_IDS.secondVersionId,
    activePublicationVersionId: PUBLICATION_IDS.publicationVersionId,
    replayed: false,
  });
  assert.equal(await tableCount(pool, 'publication_versions'), 2);
  assert.equal(await tableCount(pool, 'publication_activation_history'), 3);
  const pointer = await pool.query<{
    publication_version_id: string;
  }>(
    `select publication_version_id
       from active_publication_versions
      where publication_id = $1`,
    [PUBLICATION_IDS.publicationId],
  );
  assert.equal(
    pointer.rows[0]?.publication_version_id,
    PUBLICATION_IDS.publicationVersionId,
  );
  const activation = await pool.query<{
    activation_kind: string;
    from_publication_version_id: string;
    to_publication_version_id: string;
  }>(
    `select activation_kind,
            from_publication_version_id,
            to_publication_version_id
       from publication_activation_history
      where activation_id = $1`,
    [ROLLBACK_IDS.rollbackActivationId],
  );
  assert.deepEqual(activation.rows[0], {
    activation_kind: 'rolled_back',
    from_publication_version_id: ROLLBACK_IDS.secondVersionId,
    to_publication_version_id: PUBLICATION_IDS.publicationVersionId,
  });
  await pool.end();
});

test('Publication rollback replay is side-effect free and changed input conflicts', async () => {
  const pool = await resetDatabase();
  await seedTwoVersions(pool);
  const command = rollbackCommand();
  const first = await rollbackPublication(pool, command);
  const replay = await rollbackPublication(pool, command);

  assert.deepEqual(replay, { ...first, replayed: true });
  assert.equal(await tableCount(pool, 'publication_activation_history'), 3);
  await assert.rejects(
    rollbackPublication(pool, rollbackCommand({
      occurredAt: '2026-07-29T02:21:00.000Z',
    })),
    /IDEMPOTENCY_PAYLOAD_CONFLICT/,
  );
  await pool.end();
});

test('Publication rollback rejects a stale expected active pointer', async () => {
  const pool = await resetDatabase();
  await seedTwoVersions(pool);

  await assert.rejects(
    rollbackPublication(pool, rollbackCommand({
      expectedActivePublicationVersionId:
        PUBLICATION_IDS.publicationVersionId,
    })),
    /PUBLICATION_ACTIVE_POINTER_CONFLICT/,
  );
  assert.equal(await tableCount(pool, 'publication_activation_history'), 2);
  await pool.end();
});

test('Publication rollback rejects a new command targeting the active version', async () => {
  const pool = await resetDatabase();
  await seedTwoVersions(pool);
  await rollbackPublication(pool, rollbackCommand());

  await assert.rejects(
    rollbackPublication(pool, rollbackCommand({
      activationId: '79000000-0000-4000-8000-000000000008',
      expectedActivePublicationVersionId:
        PUBLICATION_IDS.publicationVersionId,
      auditId: '79000000-0000-4000-8000-000000000009',
      outboxEventId: '79000000-0000-4000-8000-000000000010',
      correlationId: 'publication-rollback-already-active',
      idempotencyKey: 'publication-rollback-already-active',
      occurredAt: '2026-07-29T02:30:00.000Z',
    })),
    /PUBLICATION_VERSION_ALREADY_ACTIVE/,
  );
  assert.equal(await tableCount(pool, 'publication_activation_history'), 3);
  await pool.end();
});

test('Publication rollback rejects a target owned by another Publication', async () => {
  const pool = await resetDatabase();
  await seedEligiblePublicationContext(pool);
  await seedSecondEligiblePublicationContext(pool);
  await publishCandidateRevision(pool, firstPublishCommand());
  await publishCandidateRevision(pool, secondPublishCommand());
  await publishCandidateRevision(pool, secondItemPublishCommand());

  await assert.rejects(
    rollbackPublication(pool, rollbackCommand({
      targetPublicationVersionId:
        SECOND_PUBLICATION_CONTEXT_IDS.publicationVersionId,
    })),
    /PUBLICATION_ROLLBACK_TARGET_CONFLICT/,
  );
  assert.equal(await tableCount(pool, 'publication_activation_history'), 3);
  await pool.end();
});

test('Publication rollback of item A does not change item B', async () => {
  const pool = await resetDatabase();
  await seedEligiblePublicationContext(pool);
  await seedSecondEligiblePublicationContext(pool);
  await publishCandidateRevision(pool, firstPublishCommand());
  await publishCandidateRevision(pool, secondPublishCommand());
  await publishCandidateRevision(pool, secondItemPublishCommand());

  await rollbackPublication(pool, rollbackCommand());

  const pointers = await pool.query<{
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
  await pool.end();
});

test('late Publication rollback audit failure rolls back pointer, outbox, and idempotency', async () => {
  const pool = await resetDatabase();
  await seedTwoVersions(pool);
  await pool.query(`
    create function reject_publication_rollback_audit()
    returns trigger
    language plpgsql
    as $$
    begin
      if new.action = 'publication.version_rolled_back' then
        raise exception 'injected Publication rollback audit failure';
      end if;
      return new;
    end;
    $$;
    create trigger reject_publication_rollback_audit
    before insert on audit_events
    for each row execute function reject_publication_rollback_audit();
  `);

  await assert.rejects(
    rollbackPublication(pool, rollbackCommand()),
    /injected Publication rollback audit failure/,
  );
  assert.equal(await tableCount(pool, 'publication_activation_history'), 2);
  const pointer = await pool.query<{
    publication_version_id: string;
  }>(
    `select publication_version_id
       from active_publication_versions
      where publication_id = $1`,
    [PUBLICATION_IDS.publicationId],
  );
  assert.equal(
    pointer.rows[0]?.publication_version_id,
    ROLLBACK_IDS.secondVersionId,
  );
  const outbox = await pool.query<{ count: string }>(
    `select count(*)
       from outbox_events
      where outbox_event_id = $1`,
    [ROLLBACK_IDS.rollbackOutboxEventId],
  );
  assert.equal(outbox.rows[0]?.count, '0');
  const idempotency = await pool.query<{ count: string }>(
    `select count(*)
       from idempotency_records
      where scope = 'publication_rollback'`,
  );
  assert.equal(idempotency.rows[0]?.count, '0');
  await pool.end();
});
