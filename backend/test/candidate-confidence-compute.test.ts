import assert from 'node:assert/strict';
import test from 'node:test';

import {
  computeCandidateConfidence,
  confidenceBandForScore,
} from '../src/modules/confidence/compute-candidate-confidence.js';
import type {
  CandidateConfidenceInput,
} from '../src/modules/confidence/types.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const evaluatedAt = new Date('2026-08-25T00:00:00.000Z');
const freshEvidenceAt = new Date(evaluatedAt.getTime() - DAY_MS);

function confidenceInput(
  overrides: Partial<CandidateConfidenceInput> = {},
): CandidateConfidenceInput {
  return {
    evaluatedAt,
    hasExactPatchSupport: false,
    hasRevalidatedCrossPatchSupport: false,
    newestSupportingEvidenceAt: null,
    provenanceQuality: 0,
    supportingSourceCount: 0,
    ...overrides,
  };
}

function supportedInput(
  overrides: Partial<CandidateConfidenceInput> = {},
): CandidateConfidenceInput {
  return confidenceInput({
    newestSupportingEvidenceAt: freshEvidenceAt,
    supportingSourceCount: 1,
    ...overrides,
  });
}

test('confidence scoring is deterministic for identical explicit input', () => {
  const input = supportedInput({
    hasExactPatchSupport: true,
    provenanceQuality: 30,
    supportingSourceCount: 2,
  });

  assert.deepEqual(
    computeCandidateConfidence(input),
    computeCandidateConfidence(input),
  );
  assert.deepEqual(computeCandidateConfidence(input), {
    band: 'very_high',
    components: {
      evidenceDiversityScore: 25,
      freshnessScore: 15,
      patchAlignmentScore: 20,
      provenanceQualityScore: 30,
    },
    score: 90,
  });
});

test('AI-only provenance with no Evidence remains low', () => {
  assert.deepEqual(computeCandidateConfidence(confidenceInput()), {
    band: 'low',
    components: {
      evidenceDiversityScore: 0,
      freshnessScore: 0,
      patchAlignmentScore: 0,
      provenanceQualityScore: 0,
    },
    score: 0,
  });
});

test('Evidence diversity scores 0, 10, and 25 for zero, one, and multiple sources', () => {
  assert.equal(
    computeCandidateConfidence(confidenceInput({ supportingSourceCount: 0 }))
      .components.evidenceDiversityScore,
    0,
  );
  assert.equal(
    computeCandidateConfidence(supportedInput({ supportingSourceCount: 1 }))
      .components.evidenceDiversityScore,
    10,
  );
  assert.equal(
    computeCandidateConfidence(supportedInput({ supportingSourceCount: 2 }))
      .components.evidenceDiversityScore,
    25,
  );
  assert.equal(
    computeCandidateConfidence(supportedInput({ supportingSourceCount: 8 }))
      .components.evidenceDiversityScore,
    25,
  );
});

test('exact patch support outranks governed revalidated cross-patch support', () => {
  assert.equal(
    computeCandidateConfidence(supportedInput({
      hasExactPatchSupport: true,
      hasRevalidatedCrossPatchSupport: true,
    })).components.patchAlignmentScore,
    20,
  );
  assert.equal(
    computeCandidateConfidence(supportedInput({
      hasRevalidatedCrossPatchSupport: true,
    })).components.patchAlignmentScore,
    10,
  );
  assert.equal(
    computeCandidateConfidence(supportedInput())
      .components.patchAlignmentScore,
    0,
  );
});

test('freshness boundaries are strict before 7 days and inclusive through 30 days', () => {
  const scoreAtAge = (ageMs: number) => computeCandidateConfidence(
    supportedInput({
      newestSupportingEvidenceAt: new Date(evaluatedAt.getTime() - ageMs),
    }),
  ).components.freshnessScore;

  assert.equal(scoreAtAge(6 * DAY_MS), 15);
  assert.equal(scoreAtAge(7 * DAY_MS), 5);
  assert.equal(scoreAtAge(30 * DAY_MS), 5);
  assert.equal(scoreAtAge(31 * DAY_MS), 0);
});

test('future Evidence timestamps are rejected instead of receiving freshness credit', () => {
  assert.throws(
    () => computeCandidateConfidence(supportedInput({
      newestSupportingEvidenceAt: new Date(evaluatedAt.getTime() + 1),
    })),
    /CONFIDENCE_EVIDENCE_TIMESTAMP_IN_FUTURE/,
  );
});

test('confidence band thresholds are stable', () => {
  assert.equal(confidenceBandForScore(0), 'low');
  assert.equal(confidenceBandForScore(39), 'low');
  assert.equal(confidenceBandForScore(40), 'medium');
  assert.equal(confidenceBandForScore(69), 'medium');
  assert.equal(confidenceBandForScore(70), 'high');
  assert.equal(confidenceBandForScore(89), 'high');
  assert.equal(confidenceBandForScore(90), 'very_high');
  assert.throws(() => confidenceBandForScore(-1), /CONFIDENCE_SCORE_OUT_OF_RANGE/);
  assert.throws(() => confidenceBandForScore(91), /CONFIDENCE_SCORE_OUT_OF_RANGE/);
});

test('invalid normalized scoring inputs are rejected', () => {
  assert.throws(
    () => computeCandidateConfidence(confidenceInput({ provenanceQuality: 10 as 0 })),
    /CONFIDENCE_PROVENANCE_QUALITY_INVALID/,
  );
  assert.throws(
    () => computeCandidateConfidence(confidenceInput({ supportingSourceCount: -1 })),
    /CONFIDENCE_SUPPORTING_SOURCE_COUNT_INVALID/,
  );
  assert.throws(
    () => computeCandidateConfidence(confidenceInput({
      evaluatedAt: new Date(Number.NaN),
    })),
    /CONFIDENCE_EVALUATED_AT_INVALID/,
  );
  assert.throws(
    () => computeCandidateConfidence(confidenceInput({
      hasExactPatchSupport: true,
    })),
    /CONFIDENCE_EVIDENCE_FACTS_INCONSISTENT/,
  );
});
