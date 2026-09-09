import { createHash } from 'node:crypto';

import type { Pool } from 'pg';

import {
  AiReviewProviderError,
  hashAiReviewRequest,
  normalizePublicSourceUrl,
  type AiReviewRequest,
} from './ai-review-provider.js';
import { loadAiReviewContext } from './review-authority.js';
import { defineCandidateClaimSet } from '../trust/define-candidate-claim-set.js';
import { recordClaimEvidenceDecision } from '../trust/record-claim-evidence-decision.js';

const OWNED_CLAIM_KEY = 'ai-community-report-v1';
const ACTOR_ID = 'system:ai-reviewer';
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

interface CandidateRow {
  candidate_id: string;
  candidate_revision_id: string;
  patch_key: string;
  champion_external_id: string;
  canonical_payload: unknown;
  normalized_signature: string;
  eligibility_policy_revision_id: string;
  evidence_policy_revision_id: string;
  moderation_policy_revision_id: string;
  review_policy_revision_id: string;
}

interface ClaimRow {
  claim_id: string;
  claim_key: string;
  claim_type: string;
  importance: string;
  statement: string;
  decision: string | null;
  evidence_policy_revision_id: string | null;
  has_contradicted_decision: boolean;
}

interface SourceRow {
  normalized_observation_id: string;
  source_id: string;
  source_policy_revision_id: string;
  origin: string;
  observation_created_at: Date | string;
  source_status: string;
  storage_permission: string;
  collector_enabled: boolean;
  url: string | null;
  author: string | null;
  patch_id_matches: boolean;
  catalog_revision_matches: boolean;
  game_mode_matches: boolean;
  subject_matches: boolean;
  signature_matches: boolean;
  payload_matches: boolean;
}

interface CurrentAssociationRow {
  claim_id: string;
  normalized_observation_id: string;
  stance: string;
}

interface CandidateSelection {
  augmentExternalIds: string[];
  itemExternalIds: string[];
}

type PreparedSource = AiReviewRequest['evidence'][number] & {
  createdAt: string;
  sourceId: string;
  sourcePolicyRevisionId: string;
};

interface PreparationState {
  candidate: CandidateRow;
  claims: ClaimRow[];
  hasClaimSeal: boolean;
  associations: CurrentAssociationRow[];
  selection: CandidateSelection;
  sources: PreparedSource[];
}

export interface PreparedCandidateReview {
  candidateId: string;
  candidateRevisionId: string;
  eligibilityPolicyRevisionId: string;
  evidencePolicyRevisionId: string;
  moderationPolicyRevisionId: string;
  reviewPolicyRevisionId: string;
  inputHash: string;
  request: AiReviewRequest;
  requestHash: string;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function deterministicPreparationUuid(kind: string, literal: string): string {
  const encoded = ['AiReviewPreparationUuidV1', kind, literal]
    .map((value) => `${Buffer.byteLength(value, 'utf8')}:${value}`)
    .join('|');
  const bytes = createHash('sha256').update(encoded, 'utf8').digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function selectionFromPayload(value: unknown): CandidateSelection | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const payload = value as Record<string, unknown>;
  const keys = Object.keys(payload).sort(compareText);
  if (keys.join(',') !== 'augmentExternalIds,itemExternalIds,schemaVersion' || payload.schemaVersion !== 1) return null;
  if (!Array.isArray(payload.augmentExternalIds) || !Array.isArray(payload.itemExternalIds)
    || payload.augmentExternalIds.length < 1 || payload.augmentExternalIds.length > 64
    || payload.itemExternalIds.length < 2 || payload.itemExternalIds.length > 64
    || payload.augmentExternalIds.some((id) => typeof id !== 'string')
    || payload.itemExternalIds.some((id) => typeof id !== 'string')) return null;
  return {
    augmentExternalIds: [...payload.augmentExternalIds] as string[],
    itemExternalIds: [...payload.itemExternalIds] as string[],
  };
}

function isoTimestamp(value: Date | string): string | null {
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function normalizeSources(rows: SourceRow[], selection: CandidateSelection): PreparedSource[] | null {
  const sources: PreparedSource[] = [];
  for (const row of rows) {
    if (row.origin === 'ai_generated') continue;
    if (!UUID_V4.test(row.normalized_observation_id)
      || row.source_status !== 'active' || !row.collector_enabled
      || !['blob_allowed', 'reference_only'].includes(row.storage_permission)
      || !row.patch_id_matches || !row.catalog_revision_matches || !row.game_mode_matches
      || !row.subject_matches || !row.signature_matches || !row.payload_matches
      || typeof row.url !== 'string' || (row.author !== null && typeof row.author !== 'string')
      || (row.author !== null && (row.author.length === 0 || Buffer.byteLength(row.author, 'utf8') > 256))) return null;
    let normalized: ReturnType<typeof normalizePublicSourceUrl>;
    try {
      normalized = normalizePublicSourceUrl(row.url);
    } catch {
      return null;
    }
    const createdAt = isoTimestamp(row.observation_created_at);
    if (!createdAt) return null;
    sources.push({
      normalizedObservationId: row.normalized_observation_id,
      url: normalized.url,
      sourceHost: normalized.sourceHost,
      author: row.author,
      augmentExternalIds: [...selection.augmentExternalIds],
      itemExternalIds: [...selection.itemExternalIds],
      createdAt,
      sourceId: row.source_id,
      sourcePolicyRevisionId: row.source_policy_revision_id,
    });
  }
  sources.sort((left, right) => compareText(left.normalizedObservationId, right.normalizedObservationId));
  if (sources.length < 2 || sources.length > 16
    || new Set(sources.map(({ normalizedObservationId }) => normalizedObservationId)).size !== sources.length
    || new Set(sources.map(({ sourceHost }) => sourceHost)).size < 2) return null;
  return sources;
}

async function loadPreparationState(pool: Pool, candidateId: string, candidateRevisionId: string): Promise<PreparationState | null> {
  const candidateResult = await pool.query<CandidateRow>(`
    select candidate.candidate_id, revision.candidate_revision_id, patch.patch_key,
           subject.canonical_external_id as champion_external_id, revision.canonical_payload,
           revision.normalized_signature, eligibility.eligibility_policy_revision_id,
           eligibility.evidence_policy_revision_id, eligibility.moderation_policy_revision_id,
           eligibility.review_policy_revision_id
      from candidate_revisions revision
      join candidates candidate using (candidate_id)
      join patches patch on patch.patch_id = revision.patch_id
      join game_entities subject on subject.game_entity_id = candidate.subject_game_entity_id
      join active_catalog_revisions active_catalog
        on active_catalog.patch_id = revision.patch_id
       and active_catalog.game_mode_external_id = candidate.game_mode_external_id
       and active_catalog.catalog_revision_id = revision.catalog_revision_id
      join active_eligibility_policy_revision active_policy on active_policy.scope = 'candidate_revision'
      join eligibility_policy_revisions eligibility using (eligibility_policy_revision_id)
      join review_policy_revisions review_policy using (review_policy_revision_id)
     where candidate.candidate_id = $1 and revision.candidate_revision_id = $2
       and candidate.game_mode_external_id = 'aram_mayhem'
       and subject.entity_type = 'champion'
       and review_policy.review_authority = 'ai'
       and (select lifecycle_state from patch_lifecycle_events
             where patch_id = revision.patch_id
             order by occurred_at desc, created_at desc, patch_lifecycle_event_id desc limit 1) = 'active'
       and not exists (
         select 1 from candidate_revisions newer
         join active_catalog_revisions newer_catalog
           on newer_catalog.patch_id = newer.patch_id
          and newer_catalog.game_mode_external_id = candidate.game_mode_external_id
          and newer_catalog.catalog_revision_id = newer.catalog_revision_id
        where newer.candidate_id = candidate.candidate_id
          and (newer.revision > revision.revision
            or (newer.revision = revision.revision
              and newer.candidate_revision_id::text collate "C" > revision.candidate_revision_id::text collate "C")))`,
  [candidateId, candidateRevisionId]);
  const candidate = candidateResult.rows[0];
  if (!candidate || candidateResult.rowCount !== 1) return null;
  const selection = selectionFromPayload(candidate.canonical_payload);
  if (!selection) return null;

  const [sealResult, claimResult, sourceResult, associationResult] = await Promise.all([
    pool.query(`select candidate_claim_set_seal_id from candidate_claim_set_seals where candidate_revision_id = $1`, [candidateRevisionId]),
    pool.query<ClaimRow>(`
      select claim.claim_id, claim.claim_key, claim.claim_type, claim.importance, claim.statement,
             decision.decision, decision.evidence_policy_revision_id,
             exists (select 1 from claim_evidence_decisions historical
                      where historical.claim_id = claim.claim_id
                        and historical.decision = 'contradicted') as has_contradicted_decision
        from candidate_claims claim
        left join current_claim_evidence_decisions current using (claim_id)
        left join claim_evidence_decisions decision using (claim_evidence_decision_id)
       where claim.candidate_id = $1 and claim.candidate_revision_id = $2
       order by claim.claim_key collate "C"`, [candidateId, candidateRevisionId]),
    pool.query<SourceRow>(`
      select observation.normalized_observation_id, raw.source_id, raw.source_policy_revision_id,
             provenance.origin,
             observation.created_at as observation_created_at, source.status as source_status,
             source_policy.storage_permission, source_policy.collector_enabled,
             raw.external_reference ->> 'url' as url,
             raw.external_reference ->> 'author' as author,
             observation.patch_id = revision.patch_id as patch_id_matches,
             observation.catalog_revision_id = revision.catalog_revision_id as catalog_revision_matches,
             observation.game_mode_external_id = candidate.game_mode_external_id as game_mode_matches,
             observed_subject.game_entity_id = candidate.subject_game_entity_id as subject_matches,
             observation.normalized_signature = revision.normalized_signature as signature_matches,
             observation.canonical_payload = revision.canonical_payload as payload_matches
        from candidate_provenance provenance
        join candidate_revisions revision using (candidate_revision_id)
        join candidates candidate using (candidate_id)
        join normalized_observations observation using (normalized_observation_id)
        join game_entity_revisions observed_subject
          on observed_subject.game_entity_revision_id = observation.subject_game_entity_revision_id
        join raw_observations raw using (raw_observation_id)
        join sources source on source.source_id = raw.source_id
        join source_policy_revisions source_policy
          on source_policy.source_policy_revision_id = raw.source_policy_revision_id
         and source_policy.source_id = raw.source_id
       where provenance.candidate_revision_id = $1
       order by observation.normalized_observation_id::text collate "C"`, [candidateRevisionId]),
    pool.query<CurrentAssociationRow>(`
      select claim.claim_id, evidence.normalized_observation_id, association.stance
        from candidate_claims claim
        join current_claim_evidence_decisions current using (claim_id)
        join claim_evidence_decisions decision using (claim_evidence_decision_id)
        join evidence_input_snapshot_associations member
          on member.evidence_input_snapshot_id = decision.evidence_input_snapshot_id
        join evidence_associations association using (evidence_association_id)
        join evidence_records evidence using (evidence_id)
       where claim.candidate_id = $1 and claim.candidate_revision_id = $2
       order by claim.claim_id::text collate "C", evidence.normalized_observation_id::text collate "C"`,
    [candidateId, candidateRevisionId]),
  ]);
  const hasClaimSeal = sealResult.rowCount === 1;
  if (sealResult.rowCount !== 0 && !hasClaimSeal) return null;
  if ((!hasClaimSeal && claimResult.rowCount !== 0) || (hasClaimSeal && claimResult.rowCount === 0)) return null;
  const sources = normalizeSources(sourceResult.rows, selection);
  if (!sources) return null;
  return { candidate, claims: claimResult.rows, hasClaimSeal, associations: associationResult.rows, selection, sources };
}

function ownedClaimStatement(state: PreparationState): string {
  const { candidate, selection } = state;
  return `The exact selection for ${candidate.champion_external_id} on patch ${candidate.patch_key} (augments: ${selection.augmentExternalIds.join(', ')}; items: ${selection.itemExternalIds.join(', ')}) was reported by the supplied public sources.`;
}

function ownedClaim(state: PreparationState): ClaimRow | null {
  const expectedId = deterministicPreparationUuid('claim', state.candidate.candidate_revision_id);
  const expectedStatement = ownedClaimStatement(state);
  return state.claims.find((claim) => claim.claim_key === OWNED_CLAIM_KEY
    && claim.claim_id === expectedId && claim.claim_type === 'community_report'
    && claim.importance === 'required' && claim.statement === expectedStatement) ?? null;
}

function requiredClaimsAreSupported(state: PreparationState, owned: ClaimRow | null): boolean {
  const required = state.claims.filter(({ importance }) => importance === 'required');
  if (required.length < 1 || required.length > 16) return false;
  return required.every((claim) => UUID_V4.test(claim.claim_id)
    && Buffer.byteLength(claim.statement, 'utf8') >= 1
    && Buffer.byteLength(claim.statement, 'utf8') <= 4_096
    && (claim === owned || (
    claim.decision === 'supported'
    && claim.evidence_policy_revision_id === state.candidate.evidence_policy_revision_id
    )));
}

function sameSourceSet(left: PreparedSource[], right: PreparedSource[]): boolean {
  return left.length === right.length
    && left.every((source, index) => source.normalizedObservationId === right[index]?.normalizedObservationId
      && source.url === right[index]?.url && source.sourceHost === right[index]?.sourceHost
      && source.author === right[index]?.author && source.createdAt === right[index]?.createdAt
      && source.sourceId === right[index]?.sourceId
      && source.sourcePolicyRevisionId === right[index]?.sourcePolicyRevisionId);
}

async function prepareOwnedEvidence(pool: Pool, state: PreparationState, claim: ClaimRow): Promise<boolean> {
  if (claim.has_contradicted_decision) return false;
  const currentAssociations = state.associations.filter(({ claim_id }) => claim_id === claim.claim_id);
  if (currentAssociations.some(({ stance }) => stance !== 'supports')) return false;
  const suppliedIds = state.sources.map(({ normalizedObservationId }) => normalizedObservationId);
  const currentIds = currentAssociations.map(({ normalized_observation_id }) => normalized_observation_id).sort(compareText);
  if (claim.decision === 'supported'
    && claim.evidence_policy_revision_id === state.candidate.evidence_policy_revision_id
    && suppliedIds.length === currentIds.length
    && suppliedIds.every((id, index) => id === currentIds[index])) return true;

  const evidenceIdentity = [
    state.candidate.candidate_revision_id,
    state.candidate.evidence_policy_revision_id,
    ...state.sources.flatMap(({ normalizedObservationId, sourceId, sourcePolicyRevisionId }) => (
      [normalizedObservationId, sourceId, sourcePolicyRevisionId]
    )),
  ].join(':');
  const evaluatedAt = state.sources.map(({ createdAt }) => createdAt).sort(compareText).at(-1)!;
  const decisionId = deterministicPreparationUuid('evidence-decision', evidenceIdentity);
  await recordClaimEvidenceDecision(pool, {
    actorId: ACTOR_ID,
    associations: state.sources.map(({ normalizedObservationId }) => ({
      associationId: deterministicPreparationUuid('association', `${claim.claim_id}:${normalizedObservationId}`),
      crossPatchRevalidated: false,
      evidenceId: deterministicPreparationUuid('evidence', normalizedObservationId),
      normalizedObservationId,
      revalidationReason: null,
      stance: 'supports' as const,
    })),
    candidateId: state.candidate.candidate_id,
    candidateRevisionId: state.candidate.candidate_revision_id,
    claimId: claim.claim_id,
    correlationId: `ai-review-preparation:${decisionId}`,
    decision: 'supported',
    decisionId,
    evaluatedAt,
    evidenceInputSnapshotId: deterministicPreparationUuid('evidence-input-snapshot', evidenceIdentity),
    evidencePolicyRevisionId: state.candidate.evidence_policy_revision_id,
    idempotencyKey: `ai-review-preparation:${decisionId}`,
    reason: 'Supplied normalized public reports support the factual community-report claim.',
  });
  return true;
}

export async function prepareCandidateReview(
  pool: Pool,
  candidateId: string,
  candidateRevisionId: string,
): Promise<PreparedCandidateReview | null> {
  if (!UUID_V4.test(candidateId) || !UUID_V4.test(candidateRevisionId)) return null;
  const initial = await loadPreparationState(pool, candidateId, candidateRevisionId);
  if (!initial) return null;

  let owned = ownedClaim(initial);
  if (!initial.hasClaimSeal) {
    const claimId = deterministicPreparationUuid('claim', candidateRevisionId);
    await defineCandidateClaimSet(pool, {
      actorId: ACTOR_ID,
      candidateId,
      candidateRevisionId,
      claims: [{
        claimId,
        claimKey: OWNED_CLAIM_KEY,
        claimType: 'community_report',
        importance: 'required',
        statement: ownedClaimStatement(initial),
      }],
      correlationId: `ai-review-preparation:${claimId}`,
      idempotencyKey: `ai-review-preparation:${claimId}`,
    });
    owned = {
      claim_id: claimId,
      claim_key: OWNED_CLAIM_KEY,
      claim_type: 'community_report',
      importance: 'required',
      statement: ownedClaimStatement(initial),
      decision: null,
      evidence_policy_revision_id: null,
      has_contradicted_decision: false,
    };
  }
  if (!requiredClaimsAreSupported(initial.hasClaimSeal ? initial : { ...initial, claims: [owned!] }, owned)) return null;
  if (owned && !await prepareOwnedEvidence(pool, initial, owned)) return null;

  const finalState = await loadPreparationState(pool, candidateId, candidateRevisionId);
  if (!finalState || !sameSourceSet(initial.sources, finalState.sources)) return null;
  const finalOwned = ownedClaim(finalState);
  if (!requiredClaimsAreSupported(finalState, finalOwned)
    || (finalOwned !== null && (finalOwned.decision !== 'supported'
      || finalOwned.evidence_policy_revision_id !== finalState.candidate.evidence_policy_revision_id))) return null;
  const reviewContext = await loadAiReviewContext(pool, candidateId, candidateRevisionId).catch(() => null);
  if (!reviewContext || reviewContext.reviewPolicyRevisionId !== finalState.candidate.review_policy_revision_id) return null;

  const request: AiReviewRequest = {
    schemaVersion: 1,
    candidateRevisionId,
    inputHash: reviewContext.inputHash,
    patchKey: finalState.candidate.patch_key,
    championExternalId: finalState.candidate.champion_external_id,
    selection: {
      augmentExternalIds: [...finalState.selection.augmentExternalIds],
      itemExternalIds: [...finalState.selection.itemExternalIds],
    },
    requiredClaims: finalState.claims
      .filter(({ importance }) => importance === 'required')
      .map(({ claim_id, statement }) => ({ claimId: claim_id, statement })),
    evidence: finalState.sources.map(({
      createdAt: _createdAt,
      sourceId: _sourceId,
      sourcePolicyRevisionId: _sourcePolicyRevisionId,
      ...source
    }) => source),
  };
  let requestHash: string;
  try {
    requestHash = hashAiReviewRequest(request);
  } catch (error) {
    if (error instanceof AiReviewProviderError) return null;
    throw error;
  }
  return {
    candidateId,
    candidateRevisionId,
    eligibilityPolicyRevisionId: finalState.candidate.eligibility_policy_revision_id,
    evidencePolicyRevisionId: finalState.candidate.evidence_policy_revision_id,
    moderationPolicyRevisionId: finalState.candidate.moderation_policy_revision_id,
    reviewPolicyRevisionId: finalState.candidate.review_policy_revision_id,
    inputHash: reviewContext.inputHash,
    request,
    requestHash,
  };
}
