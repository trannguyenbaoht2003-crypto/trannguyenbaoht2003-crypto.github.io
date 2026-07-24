import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { SCENARIOS } from '../common/scenarios.mjs';
import { createPostgresBullmqAdapter } from './adapter.mjs';

let adapter;

before(async () => {
  adapter = await createPostgresBullmqAdapter({ mode: 'local-test' });
});

beforeEach(async () => {
  await adapter.resetEnvironment();
});

after(async () => {
  await adapter.close();
});

function scenario(id) {
  const found = SCENARIOS.find((entry) => entry.id === id);
  assert.ok(found, `missing common scenario ${id}`);
  return found;
}

function meta(prefix, type) {
  return { type, auditId: `audit-${prefix}-${type}`, eventId: `event-${prefix}-${type}` };
}

async function createCandidate(prefix, options = {}) {
  const patchId = options.patchId ?? 'patch-1';
  const claimStates = options.claimStates ?? ['supported'];
  const claims = claimStates.map((_, index) => ({ claimId: `claim-${prefix}-${index + 1}`, required: true }));
  await adapter.executeCommand({
    ...meta(prefix, 'register_candidate'), candidateId: `candidate-${prefix}`,
    fingerprint: options.fingerprint ?? `fingerprint-${prefix}`, patchId,
    catalogRevisionId: options.catalogRevisionId ?? `catalog-${patchId}`,
    origin: options.origin ?? 'editorial', catalogValid: options.catalogValid ?? true,
    provenanceId: `provenance-${prefix}-1`, sourceRef: options.sourceRef ?? `source-${prefix}`, claims,
  });
  for (let index = 0; index < claimStates.length; index += 1) {
    const state = claimStates[index];
    if (state == null) continue;
    await adapter.executeCommand({
      ...meta(`${prefix}-${index + 1}`, 'decide_claim_evidence'),
      decisionId: `evidence-${prefix}-${index + 1}`, claimId: claims[index].claimId,
      patchId: options.evidencePatchId ?? patchId, state,
      inputSnapshot: { source: `snapshot-${prefix}-${index + 1}` },
    });
  }
  if (options.moderation !== undefined && options.moderation !== null) {
    await adapter.executeCommand({
      ...meta(prefix, 'evaluate_moderation'),
      decisionId: options.moderationDecisionId ?? `moderation-${prefix}-1`,
      candidateId: `candidate-${prefix}`, state: options.moderation,
      inputSnapshot: options.moderationSnapshot ?? { signal: 'initial' },
    });
  }
  for (let index = 0; index < (options.reviews ?? 0); index += 1) {
    await adapter.executeCommand({
      ...meta(`${prefix}-${index + 1}`, 'complete_human_review'),
      reviewId: `review-${prefix}-${index + 1}`, candidateId: `candidate-${prefix}`,
      reviewerId: `reviewer-${index + 1}`, confirmed: true,
    });
  }
  let evaluation = null;
  if (options.evaluate !== false) {
    evaluation = await adapter.executeCommand({
      ...meta(prefix, 'evaluate_eligibility'),
      evaluationId: options.evaluationId ?? `eligibility-${prefix}-1`,
      candidateId: `candidate-${prefix}`, reviewQuorum: options.reviewQuorum ?? 1,
    });
  }
  return {
    candidateId: `candidate-${prefix}`, claims, evaluation,
    moderationDecisionId: options.moderationDecisionId ?? (options.moderation == null ? null : `moderation-${prefix}-1`),
  };
}

async function publishCandidate(prefix, seeded, options = {}) {
  return adapter.executeCommand({
    ...meta(`${prefix}-${options.versionNo ?? 1}`, 'publish'),
    publicationId: options.publicationId ?? `publication-${prefix}`,
    versionId: options.versionId ?? `version-${prefix}-${options.versionNo ?? 1}`,
    versionNo: options.versionNo ?? 1, candidateId: seeded.candidateId,
    content: options.content ?? { title: `Build ${prefix}`, version: options.versionNo ?? 1 },
    actorPermissions: options.actorPermissions ?? ['publisher'],
    expectedEligibilityEvaluationId: options.expectedEligibilityEvaluationId ?? seeded.evaluation?.evaluationId,
    expectedModerationDecisionId: options.expectedModerationDecisionId ?? seeded.moderationDecisionId,
  });
}

test('S1 transaction atomicity rejects F01/F02 without partial state', async () => {
  scenario('S1');
  for (const point of ['F01', 'F02']) {
    await adapter.resetEnvironment();
    await adapter.injectFailure(point);
    await assert.rejects(createCandidate(`s1-${point}`, { evaluate: false }), /PLATFORM_B_REQUEST_FAILED/);
    const state = await adapter.snapshotState();
    assert.equal(state.counts.candidates, 0);
    assert.equal(state.counts.claims, 0);
    assert.equal(state.counts.outbox_events, 0);
    assert.equal(state.counts.audit_events, 0);
    await adapter.releaseBarrier(point);
  }
});

test('S2 collector idempotency stores one logical observation across 100 deliveries', async () => {
  scenario('S2');
  await adapter.executeCommand({ ...meta('s2', 'activate_source_policy'), policyId: 'policy-s2', sourceId: 'source-s2', revision: 1, storagePermission: 'blob_allowed' });
  const command = { ...meta('s2-observation', 'ingest_observation'), observationId: 'observation-s2', idempotencyKey: 'idempotency-s2', payloadHash: 'payload-hash-s2', sourceId: 'source-s2', reference: { url: 'https://example.invalid/s2' }, blobText: 'allowed raw body' };
  for (let index = 0; index < 100; index += 1) await adapter.executeCommand(command);
  const state = await adapter.snapshotState();
  assert.equal(state.counts.raw_observations, 1);
  assert.equal(state.counts.idempotency_records, 1);
  assert.equal(state.counts.audit_events, 2);
  assert.equal(state.counts.outbox_events, 2);
});

test('S3 same idempotency key with different payload is rejected', async () => {
  scenario('S3');
  await adapter.executeCommand({ ...meta('s3', 'activate_source_policy'), policyId: 'policy-s3', sourceId: 'source-s3', revision: 1, storagePermission: 'reference_only' });
  const command = { ...meta('s3-observation', 'ingest_observation'), observationId: 'observation-s3', idempotencyKey: 'idempotency-s3', payloadHash: 'hash-a', sourceId: 'source-s3', reference: { value: 'a' } };
  await adapter.executeCommand(command);
  const before = await adapter.computeChecksums();
  await assert.rejects(adapter.executeCommand({ ...command, payloadHash: 'hash-b', reference: { value: 'b' } }), /IDEMPOTENCY_PAYLOAD_CONFLICT/);
  assert.equal((await adapter.computeChecksums()).state, before.state);
});

test('S4 outbox and BullMQ delivery are retry safe', async () => {
  scenario('S4');
  await adapter.executeCommand({ ...meta('s4', 'activate_source_policy'), policyId: 'policy-s4', sourceId: 'source-s4', revision: 1, storagePermission: 'reference_only' });
  await adapter.injectFailure('F04');
  await assert.rejects(adapter.dispatchOutbox(), /INJECTED_FAILURE:F04/);
  await adapter.drainQueue({ expectedEffects: 1 });
  let state = await adapter.snapshotState();
  assert.equal(state.consumerEffects, 1);
  assert.equal(state.deliveredOutboxEvents, 0);
  await adapter.releaseBarrier('F04');
  await adapter.dispatchOutbox();
  await adapter.drainQueue({ expectedEffects: 1 });
  state = await adapter.snapshotState();
  assert.equal(state.consumerEffects, 1);
  assert.equal(state.deliveredOutboxEvents, 1);
  await adapter.executeCommand({ type: 'redeliver_event', eventId: 'event-s4-activate_source_policy', eventType: 'SourcePolicyActivated', payload: { policyId: 'policy-s4' } });
  await adapter.drainQueue({ expectedEffects: 1 });
  assert.equal((await adapter.snapshotState()).consumerEffects, 1);
  await adapter.executeCommand({ type: 'simulate_consumer_retry_limit', eventId: 'poison-s4', eventType: 'PoisonEvent', attempts: 3, payload: { unsafe: true } });
  assert.equal((await adapter.snapshotState()).counts.dead_letters, 1);
});

test('S5 concurrent reviews have no lost writes across 20 iterations', async () => {
  scenario('S5');
  for (let index = 0; index < 20; index += 1) {
    const prefix = `s5-${index}`;
    const seeded = await createCandidate(prefix, { origin: 'ai_generated', moderation: 'clear', evaluate: false });
    await Promise.all([
      adapter.executeCommand({ ...meta(`${prefix}-a`, 'complete_human_review'), reviewId: `review-${prefix}-a`, candidateId: seeded.candidateId, reviewerId: `reviewer-${prefix}-a`, confirmed: true }),
      adapter.executeCommand({ ...meta(`${prefix}-b`, 'complete_human_review'), reviewId: `review-${prefix}-b`, candidateId: seeded.candidateId, reviewerId: `reviewer-${prefix}-b`, confirmed: true }),
    ]);
    const evaluation = await adapter.executeCommand({ ...meta(prefix, 'evaluate_eligibility'), evaluationId: `eligibility-${prefix}`, candidateId: seeded.candidateId, reviewQuorum: 2 });
    assert.equal(evaluation.result, 'eligible');
    assert.equal(evaluation.reviewCount, 2);
  }
  assert.equal((await adapter.snapshotState()).counts.human_reviews, 40);
});

test('S6 evidence and moderation remain independent', async () => {
  scenario('S6');
  const seeded = await createCandidate('s6', { claimStates: ['supported'], moderation: 'blocked' });
  assert.equal(seeded.evaluation.result, 'ineligible');
  const backup = await adapter.backupState();
  assert.equal(backup.tables.evidence_decisions[0].state, 'supported');
  assert.equal(backup.tables.moderation_decisions[0].state, 'blocked');
});

test('S7 AI candidate cannot publish without confirmed review', async () => {
  scenario('S7');
  const seeded = await createCandidate('s7', { origin: 'ai_generated', moderation: 'clear' });
  assert.equal(seeded.evaluation.result, 'needs_review');
  await assert.rejects(publishCandidate('s7', seeded), /CANDIDATE_NOT_ELIGIBLE/);
});

test('S8 publisher permission is mandatory', async () => {
  scenario('S8');
  const seeded = await createCandidate('s8', { moderation: 'clear' });
  await assert.rejects(publishCandidate('s8', seeded, { actorPermissions: [] }), /PUBLISHER_PERMISSION_REQUIRED/);
  assert.equal((await adapter.snapshotState()).currentEligibility[0].result, 'eligible');
  assert.equal((await adapter.snapshotState()).counts.publication_versions, 0);
});

test('S9 stale moderation blocks publication', async () => {
  scenario('S9');
  const seeded = await createCandidate('s9', { moderation: 'clear', moderationDecisionId: 'moderation-s9-clear' });
  await adapter.executeCommand({ ...meta('s9-blocked', 'evaluate_moderation'), decisionId: 'moderation-s9-blocked', candidateId: seeded.candidateId, state: 'blocked', inputSnapshot: { signal: 'new-block' } });
  await assert.rejects(publishCandidate('s9', seeded, { expectedModerationDecisionId: 'moderation-s9-clear' }), /(MODERATION_NOT_CLEAR|STALE_MODERATION_DECISION)/);
});

test('S10 versions remain immutable and rollback is idempotent', async () => {
  scenario('S10');
  const seeded = await createCandidate('s10', { moderation: 'clear' });
  await adapter.injectFailure('F08');
  await assert.rejects(publishCandidate('s10', seeded), /PLATFORM_B_REQUEST_FAILED/);
  assert.equal((await adapter.snapshotState()).counts.publication_versions, 0);
  await adapter.releaseBarrier('F08');
  await publishCandidate('s10', seeded, { versionNo: 1, versionId: 'version-s10-1' });
  await publishCandidate('s10', seeded, { versionNo: 2, versionId: 'version-s10-2' });
  const rollback = { ...meta('s10', 'rollback'), publicationId: 'publication-s10', targetVersionId: 'version-s10-1', actorPermissions: ['publisher'], idempotencyKey: 'rollback-s10', payloadHash: 'rollback-hash-s10' };
  await adapter.executeCommand(rollback);
  assert.equal((await adapter.executeCommand(rollback)).replayed, true);
  const evidence = await adapter.collectEvidence();
  assert.equal(evidence.snapshot.counts.publication_versions, 2);
  assert.equal(evidence.snapshot.activePublications[0].version_id, 'version-s10-1');
  assert.equal(evidence.outboxLedger.filter((entry) => entry.event_type === 'PublicationRolledBack').length, 1);
});

test('S11 reference-only source never stores raw blob', async () => {
  scenario('S11');
  await adapter.executeCommand({ ...meta('s11', 'activate_source_policy'), policyId: 'policy-s11', sourceId: 'source-s11', revision: 1, storagePermission: 'reference_only' });
  const result = await adapter.executeCommand({ ...meta('s11-observation', 'ingest_observation'), observationId: 'observation-s11', idempotencyKey: 'idempotency-s11', payloadHash: 'hash-s11', sourceId: 'source-s11', reference: { url: 'https://example.invalid/reference' }, blobText: 'forbidden blob' });
  assert.equal(result.blobStored, false);
  const row = (await adapter.backupState()).tables.raw_observations[0];
  assert.equal(row.blob_text, null);
  assert.match(row.reference_json, /reference/);
});

test('S12 catalog mismatch makes candidate ineligible', async () => {
  scenario('S12');
  assert.equal((await createCandidate('s12', { catalogValid: false, moderation: 'clear' })).evaluation.result, 'ineligible');
});

test('S13 backup and restore preserve canonical checksum', async () => {
  scenario('S13');
  const fixture = await adapter.loadFixture();
  assert.equal(fixture.checksum, '4f0310375a872d376efc80578e7524d2479c66970887370beaea2a13e2b08b93');
  const backup = await adapter.backupState();
  const before = await adapter.computeChecksums();
  await adapter.executeCommand({ ...meta('s13', 'activate_source_policy'), policyId: 'policy-s13', sourceId: 'source-s13', revision: 1, storagePermission: 'reference_only' });
  assert.notEqual((await adapter.computeChecksums()).state, before.state);
  await adapter.restoreState(backup);
  assert.equal((await adapter.computeChecksums()).state, before.state);
});

test('S14 public read path works before BullMQ projection runs', async () => {
  scenario('S14');
  const seeded = await createCandidate('s14', { moderation: 'clear' });
  await publishCandidate('s14', seeded, { content: { title: 'Published S14' } });
  const rows = await adapter.readPublishedContent();
  assert.equal(rows[0].content.title, 'Published S14');
  assert.equal((await adapter.snapshotState()).candidateProjection[0].monitoring, 0);
});

test('S15 missing moderation is never implicit clear', async () => {
  scenario('S15');
  const seeded = await createCandidate('s15', { moderation: null });
  assert.equal(seeded.evaluation.result, 'needs_review');
  assert.equal((await adapter.snapshotState()).currentModeration.length, 0);
  await assert.rejects(publishCandidate('s15', seeded), /CANDIDATE_NOT_ELIGIBLE/);
});

test('S16 first moderation decision can explicitly be clear, flagged or blocked', async () => {
  scenario('S16');
  for (const state of ['clear', 'flagged', 'blocked']) await createCandidate(`s16-${state}`, { moderation: state, evaluate: false });
  assert.deepEqual((await adapter.snapshotState()).currentModeration.map((entry) => entry.state).sort(), ['blocked', 'clear', 'flagged']);
});

test('S17 moderation snapshots are immutable', async () => {
  scenario('S17');
  const seeded = await createCandidate('s17', { moderation: 'clear', moderationDecisionId: 'moderation-s17-1', moderationSnapshot: { signal: 'old' }, evaluate: false });
  await adapter.executeCommand({ ...meta('s17-new', 'evaluate_moderation'), decisionId: 'moderation-s17-2', candidateId: seeded.candidateId, state: 'flagged', inputSnapshot: { signal: 'new' } });
  const rows = (await adapter.backupState()).tables.moderation_decisions;
  assert.deepEqual(rows.map((row) => JSON.parse(row.input_snapshot_json).signal), ['old', 'new']);
});

test('S18 superseded moderation cannot race into publication', async () => {
  scenario('S18');
  const seeded = await createCandidate('s18', { moderation: 'clear', moderationDecisionId: 'moderation-s18-clear' });
  await adapter.executeCommand({ ...meta('s18-block', 'evaluate_moderation'), decisionId: 'moderation-s18-blocked', candidateId: seeded.candidateId, state: 'blocked', inputSnapshot: { signal: 'block' } });
  await assert.rejects(publishCandidate('s18', seeded, { expectedModerationDecisionId: 'moderation-s18-clear' }), /(MODERATION_NOT_CLEAR|STALE_MODERATION_DECISION)/);
  const reevaluated = await adapter.executeCommand({ ...meta('s18-second', 'evaluate_eligibility'), evaluationId: 'eligibility-s18-2', candidateId: seeded.candidateId });
  assert.equal(reevaluated.result, 'ineligible');
});

test('S19 eligibility aggregates evidence at claim level', async () => {
  scenario('S19');
  const seeded = await createCandidate('s19', { claimStates: ['supported', 'supported', 'insufficient'], moderation: 'clear' });
  assert.equal(seeded.evaluation.result, 'needs_review');
  assert.equal(seeded.evaluation.claimStates.length, 3);
});

test('S20 cross-patch evidence must be revalidated', async () => {
  scenario('S20');
  const seeded = await createCandidate('s20', { patchId: 'patch-2', evidencePatchId: 'patch-1', moderation: 'clear' });
  assert.equal(seeded.evaluation.result, 'needs_review');
  await adapter.executeCommand({ ...meta('s20-p2', 'decide_claim_evidence'), decisionId: 'evidence-s20-p2', claimId: seeded.claims[0].claimId, patchId: 'patch-2', state: 'supported', inputSnapshot: { patch: 'patch-2' } });
  assert.equal((await adapter.executeCommand({ ...meta('s20-second', 'evaluate_eligibility'), evaluationId: 'eligibility-s20-2', candidateId: seeded.candidateId })).result, 'eligible');
});

test('S21 origin-independent fingerprint retains both provenance records', async () => {
  scenario('S21');
  const first = await createCandidate('s21-collector', { fingerprint: 'shared-fingerprint-s21', origin: 'collector_detected', evaluate: false });
  const duplicate = await adapter.executeCommand({ ...meta('s21-ai', 'register_candidate'), candidateId: 'candidate-s21-ai', fingerprint: 'shared-fingerprint-s21', patchId: 'patch-1', catalogRevisionId: 'catalog-patch-1', origin: 'ai_generated', catalogValid: true, provenanceId: 'provenance-s21-ai', sourceRef: 'ai', claims: [] });
  assert.equal(duplicate.candidateId, first.candidateId);
  assert.equal(duplicate.deduplicated, true);
  const state = await adapter.snapshotState();
  assert.equal(state.counts.candidates, 1);
  assert.equal(state.counts.candidate_provenance, 2);
});

test('S22 monitoring is an idempotent PublicationPublished projection', async () => {
  scenario('S22');
  const seeded = await createCandidate('s22', { moderation: 'clear' });
  await publishCandidate('s22', seeded);
  const target = (await adapter.snapshotState()).outboxEvents;
  await adapter.dispatchOutbox();
  await adapter.drainQueue({ expectedEffects: target });
  let projection = (await adapter.snapshotState()).candidateProjection[0];
  assert.equal(projection.monitoring, 1);
  assert.equal(projection.transition_count, 1);
  await adapter.executeCommand({ type: 'redeliver_event', eventId: 'event-s22-1-publish', eventType: 'PublicationPublished', payload: { publicationId: 'publication-s22', versionId: 'version-s22-1', candidateId: seeded.candidateId } });
  await adapter.drainQueue({ expectedEffects: target });
  projection = (await adapter.snapshotState()).candidateProjection[0];
  assert.equal(projection.transition_count, 1);
});

test('S23 AI quorum requires two distinct confirmed reviewers', async () => {
  scenario('S23');
  const seeded = await createCandidate('s23', { origin: 'ai_generated', moderation: 'clear', evaluate: false });
  await adapter.executeCommand({ ...meta('s23-1', 'complete_human_review'), reviewId: 'review-s23-1', candidateId: seeded.candidateId, reviewerId: 'reviewer-s23-1', confirmed: true });
  assert.equal((await adapter.executeCommand({ ...meta('s23-first', 'evaluate_eligibility'), evaluationId: 'eligibility-s23-1', candidateId: seeded.candidateId, reviewQuorum: 2 })).result, 'needs_review');
  await adapter.executeCommand({ ...meta('s23-2', 'complete_human_review'), reviewId: 'review-s23-2', candidateId: seeded.candidateId, reviewerId: 'reviewer-s23-2', confirmed: true });
  assert.equal((await adapter.executeCommand({ ...meta('s23-second', 'evaluate_eligibility'), evaluationId: 'eligibility-s23-2', candidateId: seeded.candidateId, reviewQuorum: 2 })).result, 'eligible');
});

test('S24 rollback changes only the targeted publication pointer', async () => {
  scenario('S24');
  const first = await createCandidate('s24-a', { moderation: 'clear' });
  const second = await createCandidate('s24-b', { moderation: 'clear' });
  await publishCandidate('s24-a', first, { versionNo: 1, versionId: 'version-s24-a-1' });
  await publishCandidate('s24-a', first, { versionNo: 2, versionId: 'version-s24-a-2' });
  await publishCandidate('s24-b', second, { versionNo: 1, versionId: 'version-s24-b-1' });
  await publishCandidate('s24-b', second, { versionNo: 2, versionId: 'version-s24-b-2' });
  await adapter.executeCommand({ ...meta('s24', 'rollback'), publicationId: 'publication-s24-a', targetVersionId: 'version-s24-a-1', actorPermissions: ['publisher'], idempotencyKey: 'rollback-s24', payloadHash: 'rollback-s24-hash' });
  assert.deepEqual((await adapter.snapshotState()).activePublications, [
    { publication_id: 'publication-s24-a', version_id: 'version-s24-a-1' },
    { publication_id: 'publication-s24-b', version_id: 'version-s24-b-2' },
  ]);
});
