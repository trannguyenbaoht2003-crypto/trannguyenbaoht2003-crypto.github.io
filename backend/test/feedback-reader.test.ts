import assert from 'node:assert/strict';
import test from 'node:test';

import { readPublicationFeedbackSignals } from '../src/modules/feedback/read-publication-feedback-signals.js';
import { publishCandidateRevision } from '../src/modules/publication/publish-candidate-revision.js';
import { resetDatabase } from './helpers/database.js';
import { GATE_IDS } from './helpers/gate.js';
import { PUBLICATION_IDS, seedEligiblePublicationContext } from './helpers/publication.js';

const v2 = {
  version: '7b700000-0000-4000-8000-000000000001',
  activation: '7b700000-0000-4000-8000-000000000002',
  audit: '7b700000-0000-4000-8000-000000000003',
  outbox: '7b700000-0000-4000-8000-000000000004',
};

async function seed() {
  const pool = await resetDatabase();
  await seedEligiblePublicationContext(pool);
  const base = {
    publicationId: PUBLICATION_IDS.publicationId,
    candidateRevisionId: '62000000-0000-4000-8000-000000000002',
    expectedActiveEligibilityPolicyRevisionId: GATE_IDS.eligibilityPolicyId,
    expectedEligibilityEvaluationId: GATE_IDS.eligibilityEvaluationId,
    expectedModerationDecisionId: GATE_IDS.moderationDecisionId,
    authorization: { actorId: 'feedback-reader', permissions: ['publisher'] as const },
  };
  await publishCandidateRevision(pool, {
    ...base,
    publicationVersionId: PUBLICATION_IDS.publicationVersionId,
    activationId: PUBLICATION_IDS.activationId,
    expectedActivePublicationVersionId: null,
    auditId: PUBLICATION_IDS.auditId,
    outboxEventId: PUBLICATION_IDS.outboxEventId,
    correlationId: 'feedback-reader-v1',
    idempotencyKey: 'feedback-reader-v1',
    occurredAt: '2026-08-17T02:20:00.000Z',
  });
  await publishCandidateRevision(pool, {
    ...base,
    publicationVersionId: v2.version,
    activationId: v2.activation,
    expectedActivePublicationVersionId: PUBLICATION_IDS.publicationVersionId,
    auditId: v2.audit,
    outboxEventId: v2.outbox,
    correlationId: 'feedback-reader-v2',
    idempotencyKey: 'feedback-reader-v2',
    occurredAt: '2026-08-17T02:21:00.000Z',
  });

  const receipts = [
    ['01','11',PUBLICATION_IDS.publicationVersionId,'OUTDATED',null,false,'2026-08-17T02:22:00Z'],
    ['02','12',v2.version,'WRONG_ITEMS','Sai trang bị 1',true,'2026-08-17T02:23:00Z'],
    ['03','13',v2.version,'WRONG_ITEMS','Sai trang bị 2',true,'2026-08-17T02:24:00Z'],
    ['04','14',v2.version,'WRONG_AUGMENTS','Sai lõi',true,'2026-08-17T02:25:00Z'],
  ] as const;
  for (const [id, client, version, reason, details, active, received] of receipts) {
    await pool.query(
      `insert into publication_feedback_submissions
       (id,client_submission_id,request_hash,publication_id,publication_version_id,
        reason_code,details,was_active_at_submission,received_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        `7b700000-0000-4000-8100-0000000000${id}`,
        `7b700000-0000-4000-8200-0000000000${client}`,
        id.repeat(32), PUBLICATION_IDS.publicationId, version,
        reason, details, active, received,
      ],
    );
  }
  return pool;
}

test('reader groups exact versions, prioritizes active version, and bounds samples', async () => {
  const pool = await seed();
  try {
    const signals = await readPublicationFeedbackSignals(pool, {
      sinceHours: 720, limit: 50, detailSampleLimit: 2,
      now: new Date('2026-08-17T03:00:00Z'),
    });
    assert.equal(signals.length, 2);
    assert.equal(signals[0]?.publicationVersionId, v2.version);
    assert.equal(signals[0]?.isActive, true);
    assert.equal(signals[0]?.totalCount, 3);
    assert.deepEqual(signals[0]?.countsByReason, { WRONG_ITEMS: 2, WRONG_AUGMENTS: 1 });
    assert.equal(signals[0]?.recentDetails.length, 2);
    assert.equal(signals[1]?.publicationVersionId, PUBLICATION_IDS.publicationVersionId);
    assert.equal(signals[1]?.isActive, false);
  } finally {
    await pool.end();
  }
});
