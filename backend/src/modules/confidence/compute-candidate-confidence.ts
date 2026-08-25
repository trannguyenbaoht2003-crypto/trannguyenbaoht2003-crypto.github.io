import type {
  CandidateConfidenceBand,
  CandidateConfidenceInput,
  CandidateConfidenceResult,
  CandidateProvenanceQuality,
} from './types.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * DAY_MS;
const THIRTY_DAYS_MS = 30 * DAY_MS;

function requireValidDate(value: Date, errorCode: string): void {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error(errorCode);
  }
}

function requireProvenanceQuality(
  value: number,
): asserts value is CandidateProvenanceQuality {
  if (value !== 0 && value !== 20 && value !== 30) {
    throw new Error('CONFIDENCE_PROVENANCE_QUALITY_INVALID');
  }
}

function requireSupportingSourceCount(value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error('CONFIDENCE_SUPPORTING_SOURCE_COUNT_INVALID');
  }
}

function requireEvidenceFactConsistency(
  input: CandidateConfidenceInput,
): void {
  if (input.supportingSourceCount === 0) {
    if (
      input.newestSupportingEvidenceAt !== null
      || input.hasExactPatchSupport
      || input.hasRevalidatedCrossPatchSupport
    ) {
      throw new Error('CONFIDENCE_EVIDENCE_FACTS_INCONSISTENT');
    }
    return;
  }

  if (input.newestSupportingEvidenceAt === null) {
    throw new Error('CONFIDENCE_EVIDENCE_FACTS_INCONSISTENT');
  }
}

export function confidenceBandForScore(
  score: number,
): CandidateConfidenceBand {
  if (!Number.isInteger(score) || score < 0 || score > 90) {
    throw new Error('CONFIDENCE_SCORE_OUT_OF_RANGE');
  }
  if (score <= 39) {
    return 'low';
  }
  if (score <= 69) {
    return 'medium';
  }
  if (score <= 89) {
    return 'high';
  }
  return 'very_high';
}

export function computeCandidateConfidence(
  input: CandidateConfidenceInput,
): CandidateConfidenceResult {
  requireValidDate(input.evaluatedAt, 'CONFIDENCE_EVALUATED_AT_INVALID');
  requireProvenanceQuality(input.provenanceQuality);
  requireSupportingSourceCount(input.supportingSourceCount);
  if (input.newestSupportingEvidenceAt !== null) {
    requireValidDate(
      input.newestSupportingEvidenceAt,
      'CONFIDENCE_EVIDENCE_TIMESTAMP_INVALID',
    );
  }
  requireEvidenceFactConsistency(input);

  const evidenceDiversityScore = input.supportingSourceCount >= 2
    ? 25
    : input.supportingSourceCount === 1
      ? 10
      : 0;
  const patchAlignmentScore = input.hasExactPatchSupport
    ? 20
    : input.hasRevalidatedCrossPatchSupport
      ? 10
      : 0;

  let freshnessScore: 0 | 5 | 15 = 0;
  if (input.newestSupportingEvidenceAt !== null) {
    const ageMs = input.evaluatedAt.getTime()
      - input.newestSupportingEvidenceAt.getTime();
    if (ageMs < 0) {
      throw new Error('CONFIDENCE_EVIDENCE_TIMESTAMP_IN_FUTURE');
    }
    freshnessScore = ageMs < SEVEN_DAYS_MS
      ? 15
      : ageMs <= THIRTY_DAYS_MS
        ? 5
        : 0;
  }

  const components = {
    evidenceDiversityScore,
    freshnessScore,
    patchAlignmentScore,
    provenanceQualityScore: input.provenanceQuality,
  } as const;
  const score = components.evidenceDiversityScore
    + components.freshnessScore
    + components.patchAlignmentScore
    + components.provenanceQualityScore;

  return {
    band: confidenceBandForScore(score),
    components,
    score,
  };
}
