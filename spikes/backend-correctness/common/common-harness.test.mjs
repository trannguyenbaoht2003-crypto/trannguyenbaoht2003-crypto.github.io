import test from 'node:test';
import assert from 'node:assert/strict';
import { generateFixture, checksum, candidateFingerprint, deriveEligibility } from './generate-fixture.mjs';
import { ADAPTER_METHODS, FAILURE_POINTS, SCENARIOS, T7_OUTBOX_RULE, TRANSACTION_BOUNDARIES } from './scenarios.mjs';

test('fixture is deterministic', () => {
  const a = generateFixture();
  const b = generateFixture();
  assert.equal(a.checksum, b.checksum);
  assert.deepEqual(a.counts, b.counts);
});

test('fixture counts match locked contract', () => {
  const { counts, fixture } = generateFixture();
  assert.equal(counts.sources, 5);
  assert.equal(counts.sourcePolicyRevisions, 10);
  assert.equal(counts.patches, 3);
  assert.equal(counts.catalogRevisions, 3);
  assert.equal(counts.gameEntityRevisions, 250);
  assert.equal(counts.compatibilityRules, 100);
  assert.equal(counts.rawObservations, 5000);
  assert.equal(counts.normalizedObservations, 5000);
  assert.equal(counts.candidates, 200);
  assert.equal(counts.claims, 400);
  assert.equal(counts.evidenceAssociations, 1000);
  assert.equal(counts.publications, 10);
  assert.equal(counts.publicationVersions, 20);
  assert.equal(counts.activePublicationPointers, 10);
  assert.equal(fixture.candidates.filter((c) => c.moderationDecision == null).length, 20);
  assert.equal(fixture.candidates.filter((c) => c.moderationDecision === 'clear').length, 140);
  assert.equal(fixture.candidates.filter((c) => c.moderationDecision === 'flagged').length, 25);
  assert.equal(fixture.candidates.filter((c) => c.moderationDecision === 'blocked').length, 15);
});

test('origin is excluded from candidate fingerprint', () => {
  const common = { patchScope: 'patch_1', gameMode: 'ranked', subjectGameEntity: 'champion_1', normalizedSignature: 'sig' };
  const collector = candidateFingerprint({ ...common, origin: 'collector_detected' });
  const ai = candidateFingerprint({ ...common, origin: 'ai_generated' });
  assert.equal(collector, ai);
});

test('moderation absence is never implicit clear', () => {
  assert.equal(deriveEligibility({ catalogValid: true, moderationDecision: null, requiredClaimDecisions: ['supported'], origin: 'editorial', aiReviewConfirmed: true }), 'needs_review');
});

test('claim-level evidence aggregation enforces required claims', () => {
  const base = { catalogValid: true, moderationDecision: 'clear', origin: 'editorial', aiReviewConfirmed: true };
  assert.equal(deriveEligibility({ ...base, requiredClaimDecisions: ['supported', 'supported'] }), 'eligible');
  assert.equal(deriveEligibility({ ...base, requiredClaimDecisions: ['supported', 'insufficient'] }), 'needs_review');
  assert.equal(deriveEligibility({ ...base, requiredClaimDecisions: ['supported', 'contradicted'] }), 'ineligible');
});

test('AI publication guard requires confirmed review', () => {
  const base = { catalogValid: true, moderationDecision: 'clear', requiredClaimDecisions: ['supported'], origin: 'ai_generated' };
  assert.equal(deriveEligibility({ ...base, aiReviewConfirmed: false }), 'needs_review');
  assert.equal(deriveEligibility({ ...base, aiReviewConfirmed: true }), 'eligible');
});

test('scenario and failure contracts are complete and platform-neutral', () => {
  assert.equal(SCENARIOS.length, 24);
  assert.equal(new Set(SCENARIOS.map((s) => s.id)).size, 24);
  assert.equal(Object.keys(FAILURE_POINTS).length, 12);
  assert.equal(Object.keys(TRANSACTION_BOUNDARIES).length, 9);
  assert.equal(ADAPTER_METHODS.length, 13);
  const serialized = JSON.stringify({ FAILURE_POINTS, SCENARIOS });
  for (const forbidden of ['postgres', 'd1', 'redis', 'bullmq', 'cloudflare']) {
    assert.equal(serialized.toLowerCase().includes(forbidden), false);
  }
});

test('T7 addendum is encoded exactly', () => {
  assert.deepEqual(T7_OUTBOX_RULE, {
    alwaysCreatesEligibilityEvaluation: true,
    emitsEligibilityChangedOnlyWhenCurrentEligibilityChanges: true,
    unchangedResultRequiresAuditHistoryButNotEligibilityChanged: true,
  });
});

test('canonical checksum is key-order independent', () => {
  assert.equal(checksum({ b: 2, a: 1 }), checksum({ a: 1, b: 2 }));
});
