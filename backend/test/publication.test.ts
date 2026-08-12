import assert from 'node:assert/strict';
import test from 'node:test';

import {
  publishCandidateRevision,
} from '../src/modules/publication/publish-candidate-revision.js';
import type {
  PublishCandidateRevisionCommand,
} from '../src/modules/publication/types.js';
import {
  recordCandidateModerationDecision,
} from '../src/modules/moderation/record-candidate-moderation-decision.js';
import { tableCount, resetDatabase } from './helpers/database.js';
import {
  GATE_IDS,
  moderationDecisionCommand,
} from './helpers/gate.js';
import {
  PUBLICATION_IDS,
  seedEligiblePublicationContext,
} from './helpers/publication.js';

function publishCommand(
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

test('Publication publish requires explicit publisher permission without side effects', async () => {
  const pool = await resetDatabase();
  await seedEligiblePublicationContext(pool);

  await assert.rejects(
    publishCandidateRevision(pool, publishCommand({
      authorization: {
        actorId: 'reader',
        permissions: [],
      },
    })),
    /PUBLISHER_PERMISSION_REQUIRED/,
  );
  assert.equal(await tableCount(pool, 'publication_versions'), 0);
  assert.equal(await tableCount(pool, 'publication_activation_history'), 0);
  await pool.end();
});

test('Publication publish appends version one and activates it atomically', async () => {
  const pool = await resetDatabase();
  await seedEligiblePublicationContext(pool);

  const result = await publishCandidateRevision(pool, publishCommand());

  assert.deepEqual(result, {
    publicationId: PUBLICATION_IDS.publicationId,
    publicationVersionId: PUBLICATION_IDS.publicationVersionId,
    candidateId: '62000000-0000-4000-8000-000000000001',
    candidateRevisionId: '62000000-0000-4000-8000-000000000002',
    versionNumber: 1,
    activePublicationVersionId: PUBLICATION_IDS.publicationVersionId,
    replayed: false,
  });
  assert.equal(await tableCount(pool, 'publications'), 1);
  assert.equal(await tableCount(pool, 'publication_versions'), 1);
  assert.equal(
    await tableCount(pool, 'publication_version_input_required_claims'),
    1,
  );
  assert.equal(await tableCount(pool, 'publication_activation_history'), 1);
  assert.equal(await tableCount(pool, 'active_publication_versions'), 1);
  await pool.end();
});

test('Publication publish replay is side-effect free and changed input conflicts', async () => {
  const pool = await resetDatabase();
  await seedEligiblePublicationContext(pool);
  const command = publishCommand();
  const first = await publishCandidateRevision(pool, command);
  const replay = await publishCandidateRevision(pool, command);

  assert.deepEqual(replay, { ...first, replayed: true });
  assert.equal(await tableCount(pool, 'publication_versions'), 1);
  assert.equal(await tableCount(pool, 'publication_activation_history'), 1);
  await assert.rejects(
    publishCandidateRevision(pool, publishCommand({
      occurredAt: '2026-07-29T02:01:00.000Z',
    })),
    /IDEMPOTENCY_PAYLOAD_CONFLICT/,
  );
  await pool.end();
});

test('Publication publish rejects caller-authored content before connecting', async () => {
  const pool = await resetDatabase();
  await seedEligiblePublicationContext(pool);

  await assert.rejects(
    publishCandidateRevision(pool, {
      ...publishCommand(),
      content: { title: 'untrusted' },
    } as never),
    /PUBLICATION_COMMAND_INVALID/,
  );
  assert.equal(await tableCount(pool, 'publication_versions'), 0);
  await pool.end();
});

test('Publication publish fails closed for stale expected Eligibility authority', async () => {
  const pool = await resetDatabase();
  await seedEligiblePublicationContext(pool);

  await assert.rejects(
    publishCandidateRevision(pool, publishCommand({
      expectedEligibilityEvaluationId:
        '77000000-0000-4000-8000-000000000099',
    })),
    /STALE_ELIGIBILITY_EVALUATION/,
  );
  assert.equal(await tableCount(pool, 'publication_versions'), 0);
  await pool.end();
});

test('Publication publish rejects Moderation superseded to blocked', async () => {
  const pool = await resetDatabase();
  await seedEligiblePublicationContext(pool);
  await recordCandidateModerationDecision(
    pool,
    moderationDecisionCommand({
      correlationId: 'publication-blocked-moderation',
      decisionId: GATE_IDS.secondModerationDecisionId,
      evaluatedAt: '2026-07-29T01:30:00.000Z',
      idempotencyKey: 'publication-blocked-moderation',
      inputSnapshotId: GATE_IDS.secondModerationInputSnapshotId,
      outcome: 'blocked',
    }),
  );

  await assert.rejects(
    publishCandidateRevision(pool, publishCommand()),
    /STALE_MODERATION_DECISION|MODERATION_NOT_CLEAR/,
  );
  assert.equal(await tableCount(pool, 'publication_versions'), 0);
  await pool.end();
});

test('late Publication audit failure rolls back version, activation, outbox, and idempotency', async () => {
  const pool = await resetDatabase();
  await seedEligiblePublicationContext(pool);
  await pool.query(`
    create function reject_publication_audit()
    returns trigger
    language plpgsql
    as $$
    begin
      if new.action = 'publication.version_published' then
        raise exception 'injected Publication audit failure';
      end if;
      return new;
    end;
    $$;
    create trigger reject_publication_audit
    before insert on audit_events
    for each row execute function reject_publication_audit();
  `);

  await assert.rejects(
    publishCandidateRevision(pool, publishCommand()),
    /injected Publication audit failure/,
  );
  assert.equal(await tableCount(pool, 'publications'), 0);
  assert.equal(await tableCount(pool, 'publication_versions'), 0);
  assert.equal(await tableCount(pool, 'publication_activation_history'), 0);
  const idempotency = await pool.query<{ count: string }>(
    `select count(*) from idempotency_records
      where scope = 'publication_publish'`,
  );
  assert.equal(idempotency.rows[0]?.count, '0');
  await pool.end();
});
