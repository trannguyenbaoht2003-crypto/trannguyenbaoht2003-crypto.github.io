import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { registerAiReviewPolicy, loadAiReviewContext, completeAiReview } from '../src/modules/ai-review/review-authority.js';
import { completeHumanReview } from '../src/modules/trust/complete-human-review.js';
import { resolveHumanReviewContext } from '../src/modules/trust/resolve-human-review-context.js';
import { registerTrustPolicyRevision } from '../src/modules/trust/register-trust-policy-revision.js';
import { recordClaimEvidenceDecision } from '../src/modules/trust/record-claim-evidence-decision.js';
import { registerEligibilityPolicyRevision } from '../src/modules/eligibility/register-eligibility-policy-revision.js';
import { activateEligibilityPolicyRevision } from '../src/modules/eligibility/activate-eligibility-policy-revision.js';
import { evaluateCandidateEligibility } from '../src/modules/eligibility/evaluate-candidate-eligibility.js';
import { publishCandidateRevision } from '../src/modules/publication/publish-candidate-revision.js';
import { recordCandidateModerationDecision } from '../src/modules/moderation/record-candidate-moderation-decision.js';
import { resetDatabase, tableCount } from './helpers/database.js';
import { seedActivatedGateContext, seedModerationContext, eligibilityPolicyCommand, activationCommand, GATE_IDS, moderationDecisionCommand } from './helpers/gate.js';
import { humanReviewCommand, appendAiProvenance, evidenceDecisionCommand } from './helpers/trust.js';

const candidateId = '62000000-0000-4000-8000-000000000001';
const candidateRevisionId = '62000000-0000-4000-8000-000000000002';
const reviewPolicyRevisionId = '79000000-0000-4000-8000-000000000001';
const policyCommand = () => ({ actorId: 'policy-operator', reviewPolicyRevisionId, policyKey: 'ai-review-v1', revision: 1, model: 'test-model', promptVersion: 1, reason: 'Explicit AI review authority', correlationId: 'ai-policy', idempotencyKey: 'ai-policy' });
async function seed(pool: Awaited<ReturnType<typeof resetDatabase>>, includeEvidence = true) {
  if (includeEvidence) {
    await seedActivatedGateContext(pool);
  } else {
    await seedModerationContext(pool);
    await registerEligibilityPolicyRevision(pool, eligibilityPolicyCommand());
    await activateEligibilityPolicyRevision(pool, activationCommand());
  }
  await registerAiReviewPolicy(pool, policyCommand());
  await registerEligibilityPolicyRevision(pool, eligibilityPolicyCommand({ eligibilityPolicyRevisionId: GATE_IDS.alternateEligibilityPolicyId, reviewPolicyRevisionId, revision: 2, idempotencyKey: 'ai-eligibility', correlationId: 'ai-eligibility' }));
  await activateEligibilityPolicyRevision(pool, activationCommand({ eligibilityPolicyRevisionId: GATE_IDS.alternateEligibilityPolicyId, expectedCurrentEligibilityPolicyRevisionId: GATE_IDS.eligibilityPolicyId, idempotencyKey: 'ai-activate', correlationId: 'ai-activate' }));
}
async function command(pool: Awaited<ReturnType<typeof resetDatabase>>) {
  const context = await loadAiReviewContext(pool, candidateId, candidateRevisionId);
  return { actorId: 'system:ai-reviewer', candidateId, candidateRevisionId, reviewPolicyRevisionId, expectedInputHash: context.inputHash, aiReviewId: randomUUID(), reviewInputSnapshotId: randomUUID(), reviewQuorumEvaluationId: randomUUID(), model: 'test-model', promptVersion: 1, requestHash: 'a'.repeat(64), responseHash: 'b'.repeat(64), providerResponseId: 'provider-response-1', outcome: 'confirmed' as const, reason: 'Required evidence is supported', completedAt: '2026-09-08T01:00:00.000Z', correlationId: 'ai-complete', idempotencyKey: randomUUID() };
}

test('AI confirmed receipt reaches existing eligibility and publication with zero human reviews', async (t) => {
  const pool = await resetDatabase(); t.after(() => pool.end()); await seed(pool);
  const input = await command(pool);
  const receipt = await completeAiReview(pool, input);
  assert.equal(receipt.quorumSatisfied, true);
  assert.equal(await tableCount(pool, 'human_reviews'), 0);
  assert.equal(await tableCount(pool, 'ai_reviews'), 1);
  await recordCandidateModerationDecision(pool, moderationDecisionCommand());
  await evaluateCandidateEligibility(pool, { actorId: 'evaluator', candidateId, candidateRevisionId, correlationId: 'eligible', evaluatedAt: '2026-09-08T02:00:00.000Z', evaluationId: GATE_IDS.eligibilityEvaluationId, idempotencyKey: 'eligible', inputSnapshotId: GATE_IDS.eligibilityInputSnapshotId });
  const publicationId = randomUUID();
  const published = await publishCandidateRevision(pool, { publicationId, publicationVersionId: randomUUID(), activationId: randomUUID(), candidateRevisionId, expectedActiveEligibilityPolicyRevisionId: GATE_IDS.alternateEligibilityPolicyId, expectedEligibilityEvaluationId: GATE_IDS.eligibilityEvaluationId, expectedModerationDecisionId: GATE_IDS.moderationDecisionId, expectedActivePublicationVersionId: null, authorization: { actorId: 'system:publisher', permissions: ['publisher'] }, auditId: randomUUID(), outboxEventId: randomUUID(), correlationId: 'publish', idempotencyKey: 'publish', occurredAt: '2026-09-08T03:00:00.000Z' });
  assert.equal(published.publicationId, publicationId);
  assert.equal(await tableCount(pool, 'human_reviews'), 0);
});

test('AI and human policies reject the other authority in APIs and direct SQL', async (t) => {
  const pool = await resetDatabase(); t.after(() => pool.end()); await seed(pool);
  await assert.rejects(completeHumanReview(pool, humanReviewCommand({ reviewPolicyRevisionId })), /REVIEW_AUTHORITY|REVIEW_INPUT_STALE/);
  await assert.rejects(completeHumanReview(pool, humanReviewCommand({ reviewPolicyRevisionId }), { requireActiveReviewPolicy: true }), /REVIEW_AUTHORITY|REVIEW_INPUT_STALE/);
  await assert.rejects(resolveHumanReviewContext(pool, candidateRevisionId), /REVIEW_INPUT_STALE/);
  const input = await command(pool);
  await assert.rejects(completeAiReview(pool, { ...input, reviewPolicyRevisionId: humanReviewCommand().reviewPolicyRevisionId }), /REVIEW_INPUT_STALE|REVIEW_AUTHORITY/);
  await completeAiReview(pool, input);
  await assert.rejects(pool.query(`insert into human_reviews (human_review_id,candidate_id,candidate_revision_id,review_input_snapshot_id,input_hash,review_policy_revision_id,reviewer_actor_id,status,outcome,permission_used,reason,correlation_id,completed_at) values ($1,$2,$3,$4,$5,$6,'human','completed','confirmed','reviewer','forged','forged',now())`, [randomUUID(),candidateId,candidateRevisionId,input.reviewInputSnapshotId,input.expectedInputHash,reviewPolicyRevisionId]), /authority/i);
});

for (const outcome of ['changes_requested', 'declined'] as const) {
  test(`${outcome} AI receipt never satisfies quorum`, async (t) => {
    const pool = await resetDatabase(); t.after(() => pool.end()); await seed(pool);
    assert.equal((await completeAiReview(pool, { ...await command(pool), outcome })).quorumSatisfied, false);
    assert.equal(await tableCount(pool, 'review_quorum_evaluation_ai_reviews'), 0);
  });
}

test('exact idempotent AI receipt replays after provenance changes; changed payload conflicts', async (t) => {
  const pool = await resetDatabase(); t.after(() => pool.end()); await seed(pool);
  const input = await command(pool); const first = await completeAiReview(pool, input);
  await appendAiProvenance(pool);
  assert.deepEqual(await completeAiReview(pool, input), { ...first, replayed: true });
  await assert.rejects(completeAiReview(pool, { ...input, responseHash: 'c'.repeat(64) }), /IDEMPOTENCY_PAYLOAD_CONFLICT/);
  assert.equal(await tableCount(pool, 'ai_reviews'), 1);
});

test('stale provenance and evidence cannot confirm; current unsupported evidence cannot confirm', async (t) => {
  const pool = await resetDatabase(); t.after(() => pool.end()); await seed(pool);
  const input = await command(pool); await appendAiProvenance(pool);
  await assert.rejects(completeAiReview(pool, input), /REVIEW_INPUT_STALE/);
  const beforeEvidence = await command(pool);
  await recordClaimEvidenceDecision(pool, evidenceDecisionCommand({ decisionId: randomUUID(), evidenceInputSnapshotId: randomUUID(), idempotencyKey: 'insufficient', associations: [], decision: 'insufficient' }));
  await assert.rejects(completeAiReview(pool, beforeEvidence), /REVIEW_INPUT_STALE/);
  await assert.rejects(completeAiReview(pool, await command(pool)), /AI_REVIEW_EVIDENCE_UNSUPPORTED|evidence/i);
  assert.equal(await tableCount(pool, 'ai_reviews'), 0);
});

test('policy registration is immutable and idempotent with explicit authority discriminator', async (t) => {
  const pool = await resetDatabase(); t.after(() => pool.end()); await seed(pool);
  assert.equal((await registerAiReviewPolicy(pool, policyCommand())).replayed, true);
  await assert.rejects(registerAiReviewPolicy(pool, { ...policyCommand(), model: 'changed' }), /IDEMPOTENCY_PAYLOAD_CONFLICT/);
  const row = await pool.query('select review_authority,required_permission,minimum_confirmed_reviews from review_policy_revisions where review_policy_revision_id=$1', [reviewPolicyRevisionId]);
  assert.deepEqual(row.rows[0], { review_authority: 'ai', required_permission: 'ai_reviewer', minimum_confirmed_reviews: 1 });
  await assert.rejects(pool.query('update ai_review_policy_configs set model=$1 where review_policy_revision_id=$2', ['changed',reviewPolicyRevisionId]), /immutable/i);
});

test('direct SQL rejects forged AI receipt metadata and a satisfied quorum without confirmed members', async (t) => {
  const pool = await resetDatabase(); t.after(() => pool.end()); await seed(pool);
  const input = await command(pool); await completeAiReview(pool, { ...input, outcome: 'declined' });
  await assert.rejects(pool.query(`insert into ai_reviews (ai_review_id,candidate_id,candidate_revision_id,review_input_snapshot_id,input_hash,review_policy_revision_id,reviewer_actor_id,model,prompt_version,request_hash,response_hash,provider_response_id,outcome,reason,correlation_id,completed_at) values ($1,$2,$3,$4,$5,$6,'system:ai-reviewer','wrong-model',1,$7,$8,'forged','confirmed','forged','forged',now())`, [randomUUID(),candidateId,candidateRevisionId,input.reviewInputSnapshotId,input.expectedInputHash,reviewPolicyRevisionId,input.requestHash,input.responseHash]), /policy|model|foreign key|authority/i);
  await assert.rejects(pool.query(`insert into review_quorum_evaluations (review_quorum_evaluation_id,candidate_id,candidate_revision_id,review_input_snapshot_id,input_hash,review_policy_revision_id,required_confirmed_count,counted_review_count,quorum_satisfied,evaluated_at) values ($1,$2,$3,$4,$5,$6,1,1,true,now())`, [randomUUID(),candidateId,candidateRevisionId,input.reviewInputSnapshotId,input.expectedInputHash,reviewPolicyRevisionId]), /quorum result mismatch/i);
});

// Validation tests exercise the public API without requiring a database. Any
// attempt to connect is an unexpected failure, rather than a mocked success.
const unavailablePool = { connect: async () => { throw new Error('UNEXPECTED_DATABASE_ACCESS'); } } as unknown as import('pg').Pool;
const validCompletion = () => ({
  actorId: 'system:ai-reviewer', candidateId, candidateRevisionId, reviewPolicyRevisionId,
  expectedInputHash: '0'.repeat(64), aiReviewId: randomUUID(), reviewInputSnapshotId: randomUUID(),
  reviewQuorumEvaluationId: randomUUID(), model: 'test-model', promptVersion: 1,
  requestHash: 'a'.repeat(64), responseHash: 'b'.repeat(64), providerResponseId: 'response-1',
  outcome: 'confirmed' as const, reason: 'Supported evidence', completedAt: '2026-09-08T01:00:00.000Z',
  correlationId: 'validation', idempotencyKey: 'validation',
});

test('validation rejects invalid authority, UUIDs, hashes, model metadata, outcomes and timestamps before database access', async () => {
  const invalid = [
    { actorId: 'human-reviewer' }, { candidateId: 'not-a-uuid' }, { candidateRevisionId: 'not-a-uuid' },
    { reviewPolicyRevisionId: 'not-a-uuid' }, { aiReviewId: 'not-a-uuid' },
    { reviewInputSnapshotId: 'not-a-uuid' }, { reviewQuorumEvaluationId: 'not-a-uuid' },
    { expectedInputHash: 'score:0.99' }, { requestHash: 'bad' }, { responseHash: 'bad' },
    { model: '' }, { promptVersion: 2 }, { providerResponseId: '' },
    { outcome: 'approved' }, { completedAt: 'yesterday' }, { reason: '' },
    { correlationId: '' }, { idempotencyKey: '' }, { extra: 'not accepted' },
  ];
  for (const patch of invalid) {
    await assert.rejects(completeAiReview(unavailablePool, { ...validCompletion(), ...patch } as Parameters<typeof completeAiReview>[1]),
      /REVIEW_AUTHORITY|TRUST_|AI_REVIEW_/);
  }
  await assert.rejects(loadAiReviewContext(unavailablePool, 'invalid', candidateRevisionId), /TRUST_UUID_INVALID/);
  await assert.rejects(loadAiReviewContext(unavailablePool, candidateId, 'invalid'), /TRUST_UUID_INVALID/);
});

test('validation rejects malformed AI policy registration before database access', async () => {
  for (const patch of [{ revision: 0 }, { revision: 1.5 }, { revision: 2147483648 }, { promptVersion: 2 },
    { reviewPolicyRevisionId: 'invalid' }, { model: '' }, { policyKey: 'space forbidden' }, { extra: true }]) {
    await assert.rejects(registerAiReviewPolicy(unavailablePool, { ...policyCommand(), ...patch }), /TRUST_|AI_REVIEW_/);
  }
});

async function insertReceipt(pool: import('pg').Pool, input: Awaited<ReturnType<typeof command>>, overrides: {
  candidateId?: string; inputHash?: string; reviewPolicyRevisionId?: string;
  reviewerActorId?: string; model?: string;
} = {}) {
  return pool.query(`insert into ai_reviews
    (ai_review_id,candidate_id,candidate_revision_id,review_input_snapshot_id,input_hash,review_policy_revision_id,
     reviewer_actor_id,model,prompt_version,request_hash,response_hash,provider_response_id,outcome,reason,correlation_id,completed_at)
    values ($1,$2,$3,$4,$5,$6,$7,$8,1,$9,$10,'direct-sql','confirmed','direct-sql','direct-sql',now())`,
  [randomUUID(),overrides.candidateId ?? candidateId,candidateRevisionId,input.reviewInputSnapshotId,
    overrides.inputHash ?? input.expectedInputHash,overrides.reviewPolicyRevisionId ?? reviewPolicyRevisionId,
    overrides.reviewerActorId ?? 'system:ai-reviewer',overrides.model ?? input.model,input.requestHash,input.responseHash]);
}

test('direct SQL rejects snapshot mismatch, human policy, invalid actor, and stale provenance receipts', async (t) => {
  const pool = await resetDatabase(); t.after(() => pool.end()); await seed(pool);
  const input = await command(pool);
  await completeAiReview(pool, { ...input, outcome: 'declined' });
  await assert.rejects(insertReceipt(pool, input, { inputHash: 'c'.repeat(64) }), /foreign key/i);
  await assert.rejects(insertReceipt(pool, input, { candidateId: randomUUID() }), /foreign key/i);
  await assert.rejects(insertReceipt(pool, input, { reviewPolicyRevisionId: humanReviewCommand().reviewPolicyRevisionId }), /foreign key|authority/i);
  await assert.rejects(insertReceipt(pool, input, { reviewerActorId: 'human' }), /check constraint/i);
  await appendAiProvenance(pool);
  await assert.rejects(insertReceipt(pool, input), /stale/i);
  assert.equal(await tableCount(pool, 'ai_reviews'), 1);
});

for (const decision of ['insufficient', 'contradicted'] as const) {
  test(`direct SQL and API cannot confirm ${decision} required evidence`, async (t) => {
    const pool = await resetDatabase(); t.after(() => pool.end()); await seed(pool, false);
    await recordClaimEvidenceDecision(pool, evidenceDecisionCommand({ decisionId: randomUUID(), evidenceInputSnapshotId: randomUUID(),
      idempotencyKey: decision, decision, associations: decision === 'insufficient' ? [] : evidenceDecisionCommand().associations.map(a => ({ ...a, stance: 'contradicts' as const })) }));
    const input = await command(pool);
    await completeAiReview(pool, { ...input, outcome: 'changes_requested' });
    await assert.rejects(insertReceipt(pool, input), /evidence unsupported/i);
    await assert.rejects(completeAiReview(pool, { ...input, aiReviewId: randomUUID(), idempotencyKey: randomUUID() }), /AI_REVIEW_EVIDENCE_UNSUPPORTED/);
    assert.equal(await tableCount(pool, 'review_quorum_evaluation_ai_reviews'), 0);
  });
}

test('AI quorum rejects declined membership, foreign authority, and late forged counts', async (t) => {
  const pool = await resetDatabase(); t.after(() => pool.end()); await seed(pool);
  const input = await command(pool);
  await completeAiReview(pool, { ...input, outcome: 'declined' });
  await assert.rejects(pool.query(`insert into review_quorum_evaluation_ai_reviews
    (review_quorum_evaluation_id,ai_review_id,candidate_id,candidate_revision_id,review_policy_revision_id,input_hash,ordinal)
    values ($1,$2,$3,$4,$5,$6,1)`,
  [input.reviewQuorumEvaluationId,input.aiReviewId,candidateId,candidateRevisionId,reviewPolicyRevisionId,input.expectedInputHash]), /membership authority/i);
  await assert.rejects(pool.query(`insert into review_quorum_evaluation_reviews
    (review_quorum_evaluation_id,human_review_id,candidate_id,candidate_revision_id,review_policy_revision_id,input_hash,reviewer_actor_id,ordinal)
    values ($1,$2,$3,$4,$5,$6,'human',1)`,
  [input.reviewQuorumEvaluationId,randomUUID(),candidateId,candidateRevisionId,reviewPolicyRevisionId,input.expectedInputHash]), /authority/i);
  const confirmed = { ...input, aiReviewId: randomUUID(), reviewQuorumEvaluationId: randomUUID(), idempotencyKey: randomUUID() };
  await completeAiReview(pool, confirmed);
  await assert.rejects(pool.query(`insert into review_quorum_evaluation_ai_reviews
    (review_quorum_evaluation_id,ai_review_id,candidate_id,candidate_revision_id,review_policy_revision_id,input_hash,ordinal)
    values ($1,$2,$3,$4,$5,$6,1)`,
  [input.reviewQuorumEvaluationId,confirmed.aiReviewId,candidateId,candidateRevisionId,reviewPolicyRevisionId,input.expectedInputHash]), /quorum result mismatch/i);
  await assert.rejects(pool.query('update ai_reviews set reason=$1 where ai_review_id=$2', ['changed',confirmed.aiReviewId]), /immutable/i);
  await assert.rejects(pool.query('delete from review_quorum_evaluation_ai_reviews where ai_review_id=$1', [confirmed.aiReviewId]), /immutable/i);
});

test('completion rejects model mismatch and replays exactly after active policy changes', async (t) => {
  const pool = await resetDatabase(); t.after(() => pool.end()); await seed(pool);
  const input = await command(pool);
  await assert.rejects(completeAiReview(pool, { ...input, model: 'other-model' }), /POLICY_METADATA_MISMATCH/);
  const first = await completeAiReview(pool, input);
  await activateEligibilityPolicyRevision(pool, activationCommand({
    expectedCurrentEligibilityPolicyRevisionId: GATE_IDS.alternateEligibilityPolicyId,
    idempotencyKey: 'restore-human', correlationId: 'restore-human',
  }));
  assert.deepEqual(await completeAiReview(pool, input), { ...first, replayed: true });
  await assert.rejects(completeAiReview(pool, { ...input, aiReviewId: randomUUID(), idempotencyKey: randomUUID() }), /REVIEW_INPUT_STALE/);
  for (const patch of [{ aiReviewId: randomUUID() }, { completedAt: '2026-09-08T01:00:01.000Z' }, { requestHash: 'd'.repeat(64) }, { reason: 'changed' }, { correlationId: 'changed' }]) {
    await assert.rejects(completeAiReview(pool, { ...input, ...patch }), /IDEMPOTENCY_PAYLOAD_CONFLICT/);
  }
});

test('confirmation requires a supported decision under the active evidence policy', async (t) => {
  const pool = await resetDatabase(); t.after(() => pool.end()); await seed(pool);
  const evidencePolicyRevisionId = randomUUID();
  await registerTrustPolicyRevision(pool, {
    actorId: 'policy-operator', policyKind: 'evidence', policyRevisionId: evidencePolicyRevisionId,
    policyKey: 'new-evidence-policy', revision: 1, schemaVersion: 1, reason: 'New evidence authority',
    correlationId: 'new-evidence-policy', idempotencyKey: 'new-evidence-policy',
  });
  const eligibilityPolicyRevisionId = randomUUID();
  await registerEligibilityPolicyRevision(pool, eligibilityPolicyCommand({ eligibilityPolicyRevisionId,
    evidencePolicyRevisionId, reviewPolicyRevisionId, revision: 3,
    idempotencyKey: 'new-evidence-eligibility', correlationId: 'new-evidence-eligibility' }));
  await activateEligibilityPolicyRevision(pool, activationCommand({ eligibilityPolicyRevisionId,
    expectedCurrentEligibilityPolicyRevisionId: GATE_IDS.alternateEligibilityPolicyId,
    idempotencyKey: 'activate-new-evidence', correlationId: 'activate-new-evidence' }));
  const input = await command(pool);
  await assert.rejects(completeAiReview(pool, input), /AI_REVIEW_EVIDENCE_UNSUPPORTED/);
  await completeAiReview(pool, { ...input, outcome: 'declined' });
  await assert.rejects(insertReceipt(pool, input), /evidence unsupported/i);
});

test('missing evidence decisions cannot confirm and stale evidence snapshots cannot be reused through SQL', async (t) => {
  const pool = await resetDatabase(); t.after(() => pool.end()); await seed(pool, false);
  const absent = await command(pool);
  await assert.rejects(completeAiReview(pool, absent), /AI_REVIEW_EVIDENCE_UNSUPPORTED/);
  await completeAiReview(pool, { ...absent, outcome: 'declined' });
  await assert.rejects(insertReceipt(pool, absent), /evidence unsupported/i);
  await recordClaimEvidenceDecision(pool, evidenceDecisionCommand());
  await assert.rejects(insertReceipt(pool, absent), /stale/i);
  const supported = await command(pool);
  await completeAiReview(pool, supported);
  assert.equal(await tableCount(pool, 'human_reviews'), 0);
});

test('concurrent retries preserve one AI receipt, quorum, audit and outbox result', async (t) => {
  const pool = await resetDatabase(); t.after(() => pool.end()); await seed(pool);
  const input = await command(pool);
  const results = await Promise.all([completeAiReview(pool, input), completeAiReview(pool, input)]);
  assert.equal(results.filter(result => result.replayed).length, 1);
  assert.deepEqual(results.map(result => ({ ...result, replayed: false })), [results[0], results[0]].map(result => ({ ...result, replayed: false })));
  assert.equal(await tableCount(pool, 'ai_reviews'), 1);
  assert.equal(await tableCount(pool, 'review_quorum_evaluations'), 1);
  assert.equal((await pool.query("select count(*)::int as count from audit_events where action='review.ai_review_completed'")).rows[0].count, 1);
  assert.equal((await pool.query("select count(*)::int as count from outbox_events where event_type='AiReviewCompleted'")).rows[0].count, 1);
});
