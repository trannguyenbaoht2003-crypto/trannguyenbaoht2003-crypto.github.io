import type { Pool } from 'pg';

import type {
  OperatorCandidateConfidence,
  OperatorCandidateReviewClaim,
  OperatorCandidateReviewDossier,
  OperatorCandidateReviewDossierOptions,
  OperatorCandidateReviewEvidence,
  OperatorCandidateReviewProvenance,
  OperatorDossierReference,
  OperatorDossierSource,
} from './types.js';

interface ActiveReviewPolicyRow {
  minimum_confirmed_reviews: unknown;
  review_policy_revision_id: unknown;
}

interface DossierHeaderRow {
  band: unknown;
  candidate_claim_set_seal_id: unknown;
  candidate_confidence_score_id: unknown;
  candidate_id: unknown;
  candidate_revision_id: unknown;
  canonical_payload: unknown;
  catalog_revision_id: unknown;
  claim_count: unknown;
  claim_set_hash: unknown;
  confidence_created_at: unknown;
  counted_review_count: unknown;
  created_at: unknown;
  evaluated_at: unknown;
  evidence_diversity_score: unknown;
  freshness_score: unknown;
  patch_alignment_score: unknown;
  patch_id: unknown;
  patch_key: unknown;
  provenance_quality_score: unknown;
  required_confirmed_count: unknown;
  review_quorum_evaluation_id: unknown;
  revision: unknown;
  score: unknown;
  scoring_version: unknown;
  subject_external_id: unknown;
}

interface ClaimRow {
  association_count: unknown;
  candidate_claim_set_seal_id: unknown;
  candidate_id: unknown;
  candidate_revision_id: unknown;
  catalog_revision_id: unknown;
  claim_evidence_decision_id: unknown;
  claim_id: unknown;
  claim_key: unknown;
  claim_set_hash: unknown;
  claim_statement_hash: unknown;
  claim_type: unknown;
  decision: unknown;
  decision_candidate_id: unknown;
  decision_candidate_revision_id: unknown;
  decision_catalog_revision_id: unknown;
  decision_patch_id: unknown;
  evaluated_at: unknown;
  evidence_input_snapshot_id: unknown;
  evidence_policy_revision_id: unknown;
  importance: unknown;
  patch_id: unknown;
  reason: unknown;
  statement: unknown;
  statement_hash: unknown;
}

interface EvidenceRow {
  association_candidate_id: unknown;
  association_candidate_revision_id: unknown;
  association_catalog_revision_id: unknown;
  association_evidence_patch_id: unknown;
  claim_evidence_decision_id: unknown;
  claim_id: unknown;
  collected_at: unknown;
  cross_patch_revalidated: unknown;
  decision_patch_id: unknown;
  display_name: unknown;
  evidence_association_id: unknown;
  evidence_created_at: unknown;
  evidence_id: unknown;
  evidence_input_snapshot_id: unknown;
  evidence_patch_id: unknown;
  evidence_patch_key: unknown;
  external_reference: unknown;
  observed_at: unknown;
  ordinal: unknown;
  revalidation_reason: unknown;
  source_id: unknown;
  source_key: unknown;
  source_policy_revision_id: unknown;
  source_status: unknown;
  stance: unknown;
  storage_permission: unknown;
}

interface ProvenanceRow {
  candidate_provenance_id: unknown;
  collected_at: unknown;
  display_name: unknown;
  external_reference: unknown;
  observed_at: unknown;
  origin: unknown;
  provenance_catalog_revision_id: unknown;
  provenance_patch_id: unknown;
  source_id: unknown;
  source_key: unknown;
  source_policy_revision_id: unknown;
  source_status: unknown;
  storage_permission: unknown;
}

interface CandidateSelectionPayloadV1 {
  schemaVersion: 1;
  augmentExternalIds: string[];
  itemExternalIds: string[];
}

interface HeaderContext {
  candidateId: string;
  candidateRevisionId: string;
  patchId: string;
  catalogRevisionId: string;
  claimSetSealId: string;
  claimSetHash: string;
}

interface MappedClaim {
  claim: OperatorCandidateReviewClaim;
  evidenceInputSnapshotId: string | null;
  associationCount: number;
}

const MAX_CLAIMS = 256;
const MAX_EVIDENCE_PER_CLAIM = 64;
const MAX_TOTAL_EVIDENCE = 2_048;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const SOURCE_KEY_PATTERN = /^[!-~]+$/;
const INVALID = Symbol('invalid-reference-field');

function invalidRow(): never {
  throw new Error('OPERATOR_CANDIDATE_DOSSIER_ROW_INVALID');
}

function requireUuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) invalidRow();
  return value;
}

function requireHash(value: unknown): string {
  if (typeof value !== 'string' || !HASH_PATTERN.test(value)) invalidRow();
  return value;
}

function requireInteger(value: unknown): number {
  if (!Number.isInteger(value)) invalidRow();
  return value as number;
}

function requireBoundedText(value: unknown, minimum: number, maximum: number): string {
  if (typeof value !== 'string') invalidRow();
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes < minimum || bytes > maximum) invalidRow();
  return value;
}

function optionalBoundedText(
  value: unknown,
  maximum: number,
): string | null | typeof INVALID {
  if (value === undefined) return null;
  if (typeof value !== 'string') return INVALID;
  const bytes = Buffer.byteLength(value, 'utf8');
  return bytes >= 1 && bytes <= maximum ? value : INVALID;
}

function requireIsoTimestamp(value: unknown): string {
  const parsed = value instanceof Date
    ? value
    : typeof value === 'string'
      ? new Date(value)
      : null;
  if (parsed === null || Number.isNaN(parsed.getTime())) invalidRow();
  const iso = parsed.toISOString();
  if (typeof value === 'string' && value !== iso) invalidRow();
  return iso;
}

function optionalIsoTimestamp(value: unknown): string | null {
  return value === null ? null : requireIsoTimestamp(value);
}

function optionalPublishedAt(
  value: unknown,
): string | null | typeof INVALID {
  if (value === undefined) return null;
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 64) {
    return INVALID;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(parsed.getTime())
      && parsed.toISOString().slice(0, 10) === value
      ? value
      : INVALID;
  }
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value
    ? value
    : INVALID;
}

function requireIdArray(value: unknown): string[] {
  if (!Array.isArray(value)) invalidRow();
  const ids = value.map((entry) => requireBoundedText(entry, 1, 128));
  if (new Set(ids).size !== ids.length) invalidRow();
  return ids;
}

function requireSelection(value: unknown): CandidateSelectionPayloadV1 {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    invalidRow();
  }
  const object = value as Record<string, unknown>;
  const keys = Object.keys(object).sort();
  if (
    keys.length !== 3
    || keys[0] !== 'augmentExternalIds'
    || keys[1] !== 'itemExternalIds'
    || keys[2] !== 'schemaVersion'
    || object.schemaVersion !== 1
  ) {
    invalidRow();
  }
  return {
    schemaVersion: 1,
    augmentExternalIds: requireIdArray(object.augmentExternalIds),
    itemExternalIds: requireIdArray(object.itemExternalIds),
  };
}

function expectedBand(score: number): OperatorCandidateConfidence['band'] {
  if (score <= 39) return 'low';
  if (score <= 69) return 'medium';
  if (score <= 89) return 'high';
  if (score === 90) return 'very_high';
  return invalidRow();
}

function mapConfidence(row: DossierHeaderRow): OperatorCandidateConfidence | null {
  const values = [
    row.candidate_confidence_score_id,
    row.scoring_version,
    row.score,
    row.band,
    row.provenance_quality_score,
    row.evidence_diversity_score,
    row.patch_alignment_score,
    row.freshness_score,
    row.evaluated_at,
    row.confidence_created_at,
  ];
  if (values.every((value) => value === null)) return null;
  if (values.some((value) => value === null)) invalidRow();
  if (row.scoring_version !== 'candidate-confidence-v1') invalidRow();

  const provenanceQualityScore = requireInteger(row.provenance_quality_score);
  const evidenceDiversityScore = requireInteger(row.evidence_diversity_score);
  const patchAlignmentScore = requireInteger(row.patch_alignment_score);
  const freshnessScore = requireInteger(row.freshness_score);
  if (![0, 20, 30].includes(provenanceQualityScore)) invalidRow();
  if (![0, 10, 25].includes(evidenceDiversityScore)) invalidRow();
  if (![0, 10, 20].includes(patchAlignmentScore)) invalidRow();
  if (![0, 5, 15].includes(freshnessScore)) invalidRow();
  const score = requireInteger(row.score);
  if (
    score !== provenanceQualityScore
      + evidenceDiversityScore
      + patchAlignmentScore
      + freshnessScore
    || row.band !== expectedBand(score)
  ) {
    invalidRow();
  }
  return {
    scoreId: requireUuid(row.candidate_confidence_score_id),
    scoringVersion: 'candidate-confidence-v1',
    score,
    band: row.band as OperatorCandidateConfidence['band'],
    components: {
      provenanceQualityScore: provenanceQualityScore as 0 | 20 | 30,
      evidenceDiversityScore: evidenceDiversityScore as 0 | 10 | 25,
      patchAlignmentScore: patchAlignmentScore as 0 | 10 | 20,
      freshnessScore: freshnessScore as 0 | 5 | 15,
    },
    evaluatedAt: requireIsoTimestamp(row.evaluated_at),
    createdAt: requireIsoTimestamp(row.confidence_created_at),
  };
}

function mapSource(row: {
  display_name: unknown;
  source_id: unknown;
  source_key: unknown;
  source_policy_revision_id: unknown;
  source_status: unknown;
  storage_permission: unknown;
}): OperatorDossierSource {
  const sourceKey = requireBoundedText(row.source_key, 1, 128);
  if (!SOURCE_KEY_PATTERN.test(sourceKey)) invalidRow();
  if (!['active', 'suspended', 'retired'].includes(row.source_status as string)) {
    invalidRow();
  }
  if (!['blob_allowed', 'reference_only', 'aggregate_only'].includes(
    row.storage_permission as string,
  )) {
    invalidRow();
  }
  return {
    sourceId: requireUuid(row.source_id),
    sourceKey,
    displayName: requireBoundedText(row.display_name, 1, 256),
    status: row.source_status as OperatorDossierSource['status'],
    sourcePolicyRevisionId: requireUuid(row.source_policy_revision_id),
    storagePermission:
      row.storage_permission as OperatorDossierSource['storagePermission'],
  };
}

function mapReference(
  externalReference: unknown,
  storagePermission: OperatorDossierSource['storagePermission'],
  origin?: OperatorCandidateReviewProvenance['origin'],
): OperatorDossierReference | null {
  if (
    storagePermission === 'aggregate_only'
    || origin === 'ai_generated'
    || externalReference === null
    || typeof externalReference !== 'object'
    || Array.isArray(externalReference)
  ) {
    return null;
  }
  const value = externalReference as Record<string, unknown>;
  const url = optionalBoundedText(value.url, 2_048);
  if (url === null || url === INVALID) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (
    parsed.protocol !== 'https:' || parsed.username || parsed.password
    || Buffer.byteLength(parsed.href, 'utf8') > 2_048
  ) {
    return null;
  }
  const platform = optionalBoundedText(value.platform, 128);
  const author = optionalBoundedText(value.author, 256);
  const publishedAt = optionalPublishedAt(value.publishedAt);
  const sourceContentId = optionalBoundedText(value.sourceContentId, 256);
  if ([platform, author, publishedAt, sourceContentId].includes(INVALID)) {
    return null;
  }
  return {
    url: parsed.href,
    platform: platform as string | null,
    author: author as string | null,
    publishedAt: publishedAt as string | null,
    sourceContentId: sourceContentId as string | null,
  };
}

function requireSame(actual: unknown, expected: string): void {
  if (requireUuid(actual) !== expected) invalidRow();
}

function requireUnique(values: string[]): void {
  if (new Set(values).size !== values.length) invalidRow();
}

function mapClaim(row: ClaimRow, context: HeaderContext): MappedClaim {
  requireSame(row.candidate_id, context.candidateId);
  requireSame(row.candidate_revision_id, context.candidateRevisionId);
  requireSame(row.patch_id, context.patchId);
  requireSame(row.catalog_revision_id, context.catalogRevisionId);
  const claimId = requireUuid(row.claim_id);
  const statementHash = requireHash(row.statement_hash);
  const claimTypeValues = [
    'meta_trend',
    'build_effectiveness',
    'compatibility',
    'patch_change',
    'playstyle_hypothesis',
    'translation_assertion',
    'ocr_extraction',
    'community_report',
  ];
  if (!claimTypeValues.includes(row.claim_type as string)) invalidRow();
  if (!['required', 'supporting', 'informational'].includes(row.importance as string)) {
    invalidRow();
  }
  const claim: OperatorCandidateReviewClaim = {
    claimId,
    claimKey: requireBoundedText(row.claim_key, 1, 128),
    claimType: row.claim_type as OperatorCandidateReviewClaim['claimType'],
    importance: row.importance as OperatorCandidateReviewClaim['importance'],
    statement: requireBoundedText(row.statement, 1, 4_096),
    statementHash,
    decision: null,
  };
  const decisionFields = [
    row.claim_evidence_decision_id,
    row.evidence_input_snapshot_id,
    row.evidence_policy_revision_id,
    row.decision_candidate_id,
    row.decision_candidate_revision_id,
    row.decision_patch_id,
    row.decision_catalog_revision_id,
    row.decision,
    row.reason,
    row.evaluated_at,
    row.candidate_claim_set_seal_id,
    row.claim_set_hash,
    row.claim_statement_hash,
    row.association_count,
  ];
  if (row.claim_evidence_decision_id === null) {
    if (decisionFields.some((value) => value !== null)) invalidRow();
    return { claim, evidenceInputSnapshotId: null, associationCount: 0 };
  }
  if (decisionFields.some((value) => value === null)) invalidRow();
  requireSame(row.decision_candidate_id, context.candidateId);
  requireSame(row.decision_candidate_revision_id, context.candidateRevisionId);
  requireSame(row.decision_patch_id, context.patchId);
  requireSame(row.decision_catalog_revision_id, context.catalogRevisionId);
  requireSame(row.candidate_claim_set_seal_id, context.claimSetSealId);
  if (requireHash(row.claim_set_hash) !== context.claimSetHash) invalidRow();
  if (requireHash(row.claim_statement_hash) !== statementHash) invalidRow();
  if (!['supported', 'insufficient', 'contradicted'].includes(row.decision as string)) {
    invalidRow();
  }
  const associationCount = requireInteger(row.association_count);
  if (associationCount < 0 || associationCount > MAX_EVIDENCE_PER_CLAIM) {
    invalidRow();
  }
  claim.decision = {
    decisionId: requireUuid(row.claim_evidence_decision_id),
    evidencePolicyRevisionId: requireUuid(row.evidence_policy_revision_id),
    outcome: row.decision as NonNullable<OperatorCandidateReviewClaim['decision']>['outcome'],
    reason: requireBoundedText(row.reason, 1, 1_024),
    evaluatedAt: requireIsoTimestamp(row.evaluated_at),
    evidence: [],
  };
  return {
    claim,
    evidenceInputSnapshotId: requireUuid(row.evidence_input_snapshot_id),
    associationCount,
  };
}

function mapEvidence(
  row: EvidenceRow,
  context: HeaderContext,
  parent: MappedClaim,
  expectedOrdinal: number,
): OperatorCandidateReviewEvidence {
  if (parent.claim.decision === null || parent.evidenceInputSnapshotId === null) {
    return invalidRow();
  }
  requireSame(row.claim_id, parent.claim.claimId);
  requireSame(row.claim_evidence_decision_id, parent.claim.decision.decisionId);
  requireSame(row.evidence_input_snapshot_id, parent.evidenceInputSnapshotId);
  requireSame(row.association_candidate_id, context.candidateId);
  requireSame(row.association_candidate_revision_id, context.candidateRevisionId);
  requireSame(row.decision_patch_id, context.patchId);
  requireSame(row.association_catalog_revision_id, context.catalogRevisionId);
  const evidencePatchId = requireUuid(row.evidence_patch_id);
  requireSame(row.association_evidence_patch_id, evidencePatchId);
  if (requireInteger(row.ordinal) !== expectedOrdinal) invalidRow();
  if (!['supports', 'contradicts', 'context_only'].includes(row.stance as string)) {
    invalidRow();
  }
  if (typeof row.cross_patch_revalidated !== 'boolean') invalidRow();
  const revalidationReason = row.revalidation_reason === null
    ? null
    : requireBoundedText(row.revalidation_reason, 1, 1_024);
  const isCrossPatch = evidencePatchId !== context.patchId;
  if (
    (isCrossPatch
      && (!row.cross_patch_revalidated || revalidationReason === null))
    || (!isCrossPatch
      && (row.cross_patch_revalidated || revalidationReason !== null))
  ) {
    invalidRow();
  }
  const source = mapSource(row);
  return {
    evidenceAssociationId: requireUuid(row.evidence_association_id),
    evidenceId: requireUuid(row.evidence_id),
    stance: row.stance as OperatorCandidateReviewEvidence['stance'],
    crossPatchRevalidated: row.cross_patch_revalidated,
    revalidationReason,
    evidencePatchId,
    evidencePatchKey: requireBoundedText(row.evidence_patch_key, 1, 128),
    source,
    reference: mapReference(row.external_reference, source.storagePermission),
    observedAt: optionalIsoTimestamp(row.observed_at),
    collectedAt: requireIsoTimestamp(row.collected_at),
    evidenceCreatedAt: requireIsoTimestamp(row.evidence_created_at),
  };
}

function mapProvenance(
  row: ProvenanceRow,
  context: HeaderContext,
): OperatorCandidateReviewProvenance {
  requireSame(row.provenance_patch_id, context.patchId);
  requireSame(row.provenance_catalog_revision_id, context.catalogRevisionId);
  const origins = [
    'collector_detected',
    'community_submitted',
    'editorial',
    'ai_generated',
  ];
  if (!origins.includes(row.origin as string)) invalidRow();
  const origin = row.origin as OperatorCandidateReviewProvenance['origin'];
  const source = mapSource(row);
  return {
    candidateProvenanceId: requireUuid(row.candidate_provenance_id),
    origin,
    source,
    reference: mapReference(
      row.external_reference,
      source.storagePermission,
      origin,
    ),
    observedAt: optionalIsoTimestamp(row.observed_at),
    collectedAt: requireIsoTimestamp(row.collected_at),
  };
}

export async function readOperatorCandidateReviewDossier(
  pool: Pool,
  candidateRevisionId: string,
  options: OperatorCandidateReviewDossierOptions = {},
): Promise<OperatorCandidateReviewDossier | null> {
  if (!UUID_PATTERN.test(candidateRevisionId)) {
    throw new Error('OPERATOR_CANDIDATE_DOSSIER_ID_INVALID');
  }
  const now = options.now ?? new Date();
  if (!Number.isFinite(now.getTime())) {
    throw new Error('OPERATOR_CANDIDATE_DOSSIER_NOW_INVALID');
  }
  const client = await pool.connect();
  try {
    await client.query(
      'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
    );
    const policyResult = await client.query<ActiveReviewPolicyRow>(
      `select policy.review_policy_revision_id,
              review_policy.minimum_confirmed_reviews
         from active_eligibility_policy_revision active
         join eligibility_policy_revisions policy
           on policy.eligibility_policy_revision_id =
              active.eligibility_policy_revision_id
         join review_policy_revisions review_policy
           on review_policy.review_policy_revision_id =
              policy.review_policy_revision_id
        where active.scope = 'candidate_revision'`,
    );
    if (policyResult.rows.length !== 1) {
      throw new Error('OPERATOR_ACTIVE_REVIEW_POLICY_UNAVAILABLE');
    }
    const policy = policyResult.rows[0]!;
    const reviewPolicyRevisionId = requireUuid(
      policy.review_policy_revision_id,
    );
    const minimumConfirmedReviews = requireInteger(
      policy.minimum_confirmed_reviews,
    );
    if (minimumConfirmedReviews < 1 || minimumConfirmedReviews > 16) {
      invalidRow();
    }

    const headerResult = await client.query<DossierHeaderRow>(
      `with latest_active_revisions as (
         select revision.candidate_id,
                revision.candidate_revision_id,
                revision.revision,
                revision.patch_id,
                revision.catalog_revision_id,
                revision.canonical_payload,
                revision.created_at,
                row_number() over (
                  partition by revision.candidate_id
                  order by revision.revision desc,
                           revision.candidate_revision_id::text
                             collate "C" desc
                ) as candidate_rank
           from candidate_revisions revision
           join candidates candidate
             on candidate.candidate_id = revision.candidate_id
           join active_catalog_revisions active_catalog
             on active_catalog.patch_id = revision.patch_id
            and active_catalog.game_mode_external_id =
                candidate.game_mode_external_id
            and active_catalog.catalog_revision_id =
                revision.catalog_revision_id
       )
       select revision.candidate_id,
              revision.candidate_revision_id,
              revision.revision,
              revision.patch_id,
              patch.patch_key,
              revision.catalog_revision_id,
              revision.canonical_payload,
              revision.created_at,
              subject.canonical_external_id as subject_external_id,
              seal.candidate_claim_set_seal_id,
              seal.claim_set_hash,
              seal.claim_count,
              current_review.review_quorum_evaluation_id,
              review.counted_review_count,
              review.required_confirmed_count,
              confidence.candidate_confidence_score_id,
              confidence.scoring_version,
              confidence.provenance_quality_score,
              confidence.evidence_diversity_score,
              confidence.patch_alignment_score,
              confidence.freshness_score,
              confidence.score,
              confidence.band,
              confidence.evaluated_at,
              confidence.created_at as confidence_created_at
         from latest_active_revisions revision
         join candidate_claim_set_seals seal
           on seal.candidate_revision_id = revision.candidate_revision_id
         join candidates candidate
           on candidate.candidate_id = revision.candidate_id
         join game_entities subject
           on subject.game_entity_id = candidate.subject_game_entity_id
         join patches patch on patch.patch_id = revision.patch_id
         left join current_review_quorum_evaluations current_review
           on current_review.candidate_revision_id =
              revision.candidate_revision_id
          and current_review.review_policy_revision_id = $1
         left join review_quorum_evaluations review
           on review.review_quorum_evaluation_id =
              current_review.review_quorum_evaluation_id
         left join current_candidate_confidence_scores current_confidence
           on current_confidence.candidate_revision_id =
              revision.candidate_revision_id
         left join candidate_confidence_scores confidence
           on confidence.candidate_confidence_score_id =
              current_confidence.candidate_confidence_score_id
          and confidence.candidate_id = revision.candidate_id
          and confidence.candidate_revision_id =
              revision.candidate_revision_id
          and confidence.patch_id = revision.patch_id
          and confidence.catalog_revision_id = revision.catalog_revision_id
        where revision.candidate_rank = 1
          and revision.candidate_revision_id = $2
          and coalesce(review.quorum_satisfied, false) = false`,
      [reviewPolicyRevisionId, candidateRevisionId],
    );
    if (headerResult.rows.length === 0) {
      await client.query('COMMIT');
      return null;
    }
    if (headerResult.rows.length !== 1) invalidRow();
    const header = headerResult.rows[0]!;
    const context: HeaderContext = {
      candidateId: requireUuid(header.candidate_id),
      candidateRevisionId: requireUuid(header.candidate_revision_id),
      patchId: requireUuid(header.patch_id),
      catalogRevisionId: requireUuid(header.catalog_revision_id),
      claimSetSealId: requireUuid(header.candidate_claim_set_seal_id),
      claimSetHash: requireHash(header.claim_set_hash),
    };
    if (context.candidateRevisionId !== candidateRevisionId) invalidRow();
    const claimCount = requireInteger(header.claim_count);
    if (claimCount < 1 || claimCount > MAX_CLAIMS) invalidRow();
    const hasReview = header.review_quorum_evaluation_id !== null;
    let confirmedCount = 0;
    let requiredCount = minimumConfirmedReviews;
    if (hasReview) {
      requireUuid(header.review_quorum_evaluation_id);
      confirmedCount = requireInteger(header.counted_review_count);
      requiredCount = requireInteger(header.required_confirmed_count);
      if (
        confirmedCount < 0
        || requiredCount !== minimumConfirmedReviews
        || confirmedCount >= requiredCount
      ) {
        invalidRow();
      }
    } else if (
      header.counted_review_count !== null
      || header.required_confirmed_count !== null
    ) {
      invalidRow();
    }

    const claimResult = await client.query<ClaimRow>(
      `select claim.claim_id,
              claim.candidate_id,
              claim.candidate_revision_id,
              claim.patch_id,
              claim.catalog_revision_id,
              claim.claim_key,
              claim.claim_type,
              claim.importance,
              claim.statement,
              claim.statement_hash,
              current.claim_evidence_decision_id,
              decision.evidence_input_snapshot_id,
              decision.evidence_policy_revision_id,
              decision.candidate_id as decision_candidate_id,
              decision.candidate_revision_id as
                decision_candidate_revision_id,
              decision.patch_id as decision_patch_id,
              decision.catalog_revision_id as
                decision_catalog_revision_id,
              decision.decision,
              decision.reason,
              decision.evaluated_at,
              snapshot.candidate_claim_set_seal_id,
              snapshot.claim_set_hash,
              snapshot.claim_statement_hash,
              snapshot.association_count
         from candidate_claims claim
         left join current_claim_evidence_decisions current
           on current.claim_id = claim.claim_id
          and current.candidate_id = claim.candidate_id
          and current.candidate_revision_id = claim.candidate_revision_id
          and current.patch_id = claim.patch_id
          and current.catalog_revision_id = claim.catalog_revision_id
         left join claim_evidence_decisions decision
           on decision.claim_evidence_decision_id =
              current.claim_evidence_decision_id
          and decision.claim_id = claim.claim_id
          and decision.candidate_id = claim.candidate_id
          and decision.candidate_revision_id = claim.candidate_revision_id
          and decision.patch_id = claim.patch_id
          and decision.catalog_revision_id = claim.catalog_revision_id
          and decision.evidence_policy_revision_id =
              current.evidence_policy_revision_id
         left join evidence_input_snapshots snapshot
           on snapshot.evidence_input_snapshot_id =
              decision.evidence_input_snapshot_id
          and snapshot.claim_id = claim.claim_id
          and snapshot.candidate_id = claim.candidate_id
          and snapshot.candidate_revision_id = claim.candidate_revision_id
          and snapshot.patch_id = claim.patch_id
          and snapshot.catalog_revision_id = claim.catalog_revision_id
          and snapshot.evidence_policy_revision_id =
              decision.evidence_policy_revision_id
        where claim.candidate_revision_id = $1
        order by claim.claim_key collate "C"
        limit $2`,
      [candidateRevisionId, MAX_CLAIMS + 1],
    );
    if (claimResult.rows.length !== claimCount) invalidRow();
    const mappedClaims = claimResult.rows.map((row) => mapClaim(row, context));
    if (mappedClaims.reduce((sum, claim) => sum + claim.associationCount, 0) > MAX_TOTAL_EVIDENCE) {
      invalidRow();
    }
    requireUnique(mappedClaims.map(({ claim }) => claim.claimId));
    requireUnique(mappedClaims.map(({ claim }) => claim.claimKey));
    const snapshots = mappedClaims
      .map(({ evidenceInputSnapshotId }) => evidenceInputSnapshotId)
      .filter((value): value is string => value !== null);
    requireUnique(snapshots);
    requireUnique(mappedClaims.flatMap(({ claim }) =>
      claim.decision === null ? [] : [claim.decision.decisionId]));
    const evidenceRows = snapshots.length === 0
      ? []
      : (await client.query<EvidenceRow>(
        `select decision.claim_id,
                decision.claim_evidence_decision_id,
                member.evidence_input_snapshot_id,
                member.ordinal,
                association.evidence_association_id,
                association.evidence_id,
                association.candidate_id as association_candidate_id,
                association.candidate_revision_id as
                  association_candidate_revision_id,
                association.decision_patch_id,
                association.catalog_revision_id as
                  association_catalog_revision_id,
                association.evidence_patch_id as
                  association_evidence_patch_id,
                association.stance,
                association.cross_patch_revalidated,
                association.revalidation_reason,
                evidence.evidence_patch_id,
                patch.patch_key as evidence_patch_key,
                evidence.created_at as evidence_created_at,
                source.source_id,
                source.source_key,
                source.display_name,
                source.status as source_status,
                policy.source_policy_revision_id,
                policy.storage_permission,
                raw.external_reference,
                raw.observed_at,
                raw.collected_at
           from evidence_input_snapshot_associations member
           join evidence_input_snapshots snapshot
             on snapshot.evidence_input_snapshot_id =
                member.evidence_input_snapshot_id
           join claim_evidence_decisions decision
             on decision.evidence_input_snapshot_id =
                snapshot.evidence_input_snapshot_id
            and decision.claim_id = snapshot.claim_id
            and decision.candidate_id = snapshot.candidate_id
            and decision.candidate_revision_id =
                snapshot.candidate_revision_id
            and decision.patch_id = snapshot.patch_id
            and decision.catalog_revision_id = snapshot.catalog_revision_id
            and decision.evidence_policy_revision_id =
                snapshot.evidence_policy_revision_id
           join evidence_associations association
             on association.evidence_association_id =
                member.evidence_association_id
            and association.claim_id = decision.claim_id
            and association.candidate_id = decision.candidate_id
            and association.candidate_revision_id =
                decision.candidate_revision_id
            and association.decision_patch_id = decision.patch_id
            and association.catalog_revision_id =
                decision.catalog_revision_id
           join evidence_records evidence
             on evidence.evidence_id = association.evidence_id
            and evidence.evidence_patch_id = association.evidence_patch_id
           join normalized_observations normalized
             on normalized.normalized_observation_id =
                evidence.normalized_observation_id
            and normalized.raw_observation_id = evidence.raw_observation_id
            and normalized.patch_id = evidence.evidence_patch_id
           join raw_observations raw
             on raw.raw_observation_id = evidence.raw_observation_id
            and raw.source_id = evidence.source_id
            and raw.source_policy_revision_id =
                evidence.source_policy_revision_id
           join sources source on source.source_id = evidence.source_id
           join source_policy_revisions policy
             on policy.source_policy_revision_id =
                evidence.source_policy_revision_id
            and policy.source_id = evidence.source_id
           join patches patch on patch.patch_id = evidence.evidence_patch_id
          where member.evidence_input_snapshot_id = any($1::uuid[])
          order by decision.claim_id::text collate "C", member.ordinal
          limit $2`,
        [snapshots, MAX_TOTAL_EVIDENCE + 1],
      )).rows;
    if (evidenceRows.length > MAX_TOTAL_EVIDENCE) invalidRow();
    const bySnapshot = new Map<string, EvidenceRow[]>();
    const evidenceAssociationIds: string[] = [];
    const snapshotEvidenceIds: string[] = [];
    for (const row of evidenceRows) {
      const snapshotId = requireUuid(row.evidence_input_snapshot_id);
      evidenceAssociationIds.push(requireUuid(row.evidence_association_id));
      snapshotEvidenceIds.push(`${snapshotId}:${requireUuid(row.evidence_id)}`);
      const rows = bySnapshot.get(snapshotId) ?? [];
      rows.push(row);
      bySnapshot.set(snapshotId, rows);
    }
    requireUnique(evidenceAssociationIds);
    requireUnique(snapshotEvidenceIds);
    for (const mapped of mappedClaims) {
      if (mapped.evidenceInputSnapshotId === null) continue;
      const rows = bySnapshot.get(mapped.evidenceInputSnapshotId) ?? [];
      if (rows.length !== mapped.associationCount) invalidRow();
      mapped.claim.decision!.evidence = rows.map((row, index) =>
        mapEvidence(row, context, mapped, index + 1));
      bySnapshot.delete(mapped.evidenceInputSnapshotId);
    }
    if (bySnapshot.size !== 0) invalidRow();

    const provenanceResult = await client.query<ProvenanceRow>(
      `select provenance.candidate_provenance_id,
              provenance.origin,
              normalized.patch_id as provenance_patch_id,
              normalized.catalog_revision_id as
                provenance_catalog_revision_id,
              source.source_id,
              source.source_key,
              source.display_name,
              source.status as source_status,
              policy.source_policy_revision_id,
              policy.storage_permission,
              raw.external_reference,
              raw.observed_at,
              raw.collected_at
         from candidate_provenance provenance
         join normalized_observations normalized
           on normalized.normalized_observation_id =
              provenance.normalized_observation_id
         join raw_observations raw
           on raw.raw_observation_id = normalized.raw_observation_id
         join sources source on source.source_id = raw.source_id
         join source_policy_revisions policy
           on policy.source_policy_revision_id =
              raw.source_policy_revision_id
          and policy.source_id = raw.source_id
        where provenance.candidate_revision_id = $1
        order by provenance.candidate_provenance_id::text collate "C"`,
      [candidateRevisionId],
    );
    const selection = requireSelection(header.canonical_payload);
    const provenance = provenanceResult.rows.map((row) =>
      mapProvenance(row, context));
    requireUnique(provenance.map(({ candidateProvenanceId }) =>
      candidateProvenanceId));
    const revision = requireInteger(header.revision);
    if (revision < 1) invalidRow();
    const dossier: OperatorCandidateReviewDossier = {
      schemaVersion: 1,
      generatedAt: now.toISOString(),
      activeReviewPolicyRevisionId: reviewPolicyRevisionId,
      candidate: {
        candidateId: context.candidateId,
        candidateRevisionId: context.candidateRevisionId,
        revision,
        patchId: context.patchId,
        patchKey: requireBoundedText(header.patch_key, 1, 128),
        catalogRevisionId: context.catalogRevisionId,
        subjectExternalId: requireBoundedText(
          header.subject_external_id,
          1,
          128,
        ),
        selection: {
          augmentExternalIds: [...selection.augmentExternalIds],
          itemExternalIds: [...selection.itemExternalIds],
        },
        createdAt: requireIsoTimestamp(header.created_at),
      },
      review: {
        state: hasReview ? 'in_progress' : 'unreviewed',
        confirmedCount,
        requiredCount,
      },
      confidence: mapConfidence(header),
      claimSet: {
        claimSetSealId: context.claimSetSealId,
        claimSetHash: context.claimSetHash,
        claimCount,
      },
      provenance,
      claims: mappedClaims.map(({ claim }) => claim),
    };
    await client.query('COMMIT');
    return dossier;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Preserve the original read failure.
    }
    throw error;
  } finally {
    client.release();
  }
}
