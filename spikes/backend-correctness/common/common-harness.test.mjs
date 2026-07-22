import test from 'node:test';
import assert from 'node:assert/strict';
import { generateFixture, checksum, candidateFingerprint, deriveEligibility } from './generate-fixture.mjs';
import { ADAPTER_METHODS, FAILURE_POINTS, SCENARIOS, T7_OUTBOX_RULE, TRANSACTION_BOUNDARIES } from './scenarios.mjs';
import { EVIDENCE_ARTIFACTS } from './evidence-schema.mjs';

test('fixture is deterministic', () => {
  const a = generateFixture();
  const b = generateFixture();
  assert.equal(a.checksum, b.checksum);
  assert.deepEqual(a.counts, b.counts);
  assert.deepEqual(a.fixture, b.fixture);
});

test('fixture counts match locked contract', () => {
  const { counts, fixture } = generateFixture();
  assert.deepEqual({
    sources: counts.sources,
    sourcePolicyRevisions: counts.sourcePolicyRevisions,
    patches: counts.patches,
    catalogRevisions: counts.catalogRevisions,
    gameEntityRevisions: counts.gameEntityRevisions,
    compatibilityRules: counts.compatibilityRules,
    rawObservations: counts.rawObservations,
    normalizedObservations: counts.normalizedObservations,
    candidates: counts.candidates,
    claims: counts.claims,
    evidenceAssociations: counts.evidenceAssociations,
    publications: counts.publications,
    publicationVersions: counts.publicationVersions,
    activePublicationPointers: counts.activePublicationPointers,
  }, {
    sources: 5,
    sourcePolicyRevisions: 10,
    patches: 3,
    catalogRevisions: 3,
    gameEntityRevisions: 250,
    compatibilityRules: 100,
    rawObservations: 5000,
    normalizedObservations: 5000,
    candidates: 200,
    claims: 400,
    evidenceAssociations: 1000,
    publications: 10,
    publicationVersions: 20,
    activePublicationPointers: 10,
  });
  assert.equal(fixture.candidates.filter((c) => c.moderationDecision == null).length, 20);
  assert.equal(fixture.candidates.filter((c) => c.moderationDecision === 'clear').length, 140);
  assert.equal(fixture.candidates.filter((c) => c.moderationDecision === 'flagged').length, 25);
  assert.equal(fixture.candidates.filter((c) => c.moderationDecision === 'blocked').length, 15);
});

test('origin is excluded from candidate fingerprint', () => {
  const common = { patchScope: 'patch_1', gameMode: 'ranked', subjectGameEntity: 'champion_1', normalizedSignature: 'sig' };
  assert.equal(
    candidateFingerprint({ ...common, origin: 'collector_detected' }),
    candidateFingerprint({ ...common, origin: 'ai_generated' }),
  );
});

test('locked eligibility rules are enforced', () => {
  const base = { catalogValid: true, moderationDecision: 'clear', origin: 'editorial', aiReviewConfirmed: true };
  assert.equal(deriveEligibility({ ...base, moderationDecision: null, requiredClaimDecisions: ['supported'] }), 'needs_review');
  assert.equal(deriveEligibility({ ...base, moderationDecision: 'flagged', requiredClaimDecisions: ['supported'] }), 'needs_review');
  assert.equal(deriveEligibility({ ...base, moderationDecision: 'blocked', requiredClaimDecisions: ['supported'] }), 'ineligible');
  assert.equal(deriveEligibility({ ...base, requiredClaimDecisions: ['supported', 'supported'] }), 'eligible');
  assert.equal(deriveEligibility({ ...base, requiredClaimDecisions: ['supported', 'insufficient'] }), 'needs_review');
  assert.equal(deriveEligibility({ ...base, requiredClaimDecisions: ['supported', 'contradicted'] }), 'ineligible');
  assert.equal(deriveEligibility({ ...base, origin: 'ai_generated', aiReviewConfirmed: false, requiredClaimDecisions: ['supported'] }), 'needs_review');
});

test('scenario contracts are executable specifications, not labels', () => {
  assert.equal(SCENARIOS.length, 24);
  assert.equal(new Set(SCENARIOS.map((s) => s.id)).size, 24);
  for (const scenario of SCENARIOS) {
    assert.match(scenario.id, /^S(?:[1-9]|1\d|2[0-4])$/);
    assert.ok(scenario.name);
    assert.ok(Array.isArray(scenario.boundaries));
    assert.ok(scenario.initialState && typeof scenario.initialState === 'object');
    assert.ok(Array.isArray(scenario.commands) && scenario.commands.length > 0);
    assert.ok(scenario.expected && typeof scenario.expected === 'object');
    assert.ok(Array.isArray(scenario.expected.assertions) && scenario.expected.assertions.length > 0);
    assert.ok(Array.isArray(scenario.passReasonCodes) && scenario.passReasonCodes.length > 0);
    assert.ok(Array.isArray(scenario.failReasonCodes) && scenario.failReasonCodes.length > 0);
    assert.equal(typeof scenario.expected.checksumMode, 'string');
  }
});

test('transaction and failure contracts are complete and platform-neutral', () => {
  assert.equal(Object.keys(FAILURE_POINTS).length, 12);
  assert.equal(Object.keys(TRANSACTION_BOUNDARIES).length, 9);
  assert.equal(ADAPTER_METHODS.length, 13);
  const serialized = JSON.stringify({ FAILURE_POINTS, SCENARIOS, TRANSACTION_BOUNDARIES });
  for (const forbidden of ['postgres', 'd1', 'redis', 'bullmq', 'cloudflare', 'wrangler']) {
    assert.equal(serialized.toLowerCase().includes(forbidden), false);
  }
});

test('T7 addendum is encoded exactly', () => {
  assert.deepEqual(T7_OUTBOX_RULE, {
    alwaysCreatesEligibilityEvaluation: true,
    emitsEligibilityChangedOnlyWhenCurrentEligibilityChanges: true,
    unchangedResultRequiresAuditHistoryButNotEligibilityChanged: true,
  });
  const s4 = SCENARIOS.find((scenario) => scenario.id === 'S4');
  assert.equal(s4.expected.outboxRule, 'required_only_when_domain_event_required');
});

test('evidence bundle contract is complete', () => {
  assert.deepEqual(EVIDENCE_ARTIFACTS, [
    'run-manifest.json',
    'scenario-results.jsonl',
    'test-report.xml',
    'failure-injection.jsonl',
    'record-counts-before.json',
    'record-counts-after.json',
    'checksums-before.json',
    'checksums-after.json',
    'duplicate-effects.json',
    'audit-coverage.json',
    'outbox-ledger.json',
    'restore-report.json',
    'immutable-diff.json',
    'correctness-summary.md',
  ]);
});

test('canonical checksum is key-order independent', () => {
  assert.equal(checksum({ b: 2, a: 1 }), checksum({ a: 1, b: 2 }));
});
