import { randomUUID } from 'node:crypto';

import type { Pool, PoolClient } from 'pg';

import { withTransaction } from '../../database/transaction.js';
import { hashCanonicalJson } from '../../shared/hash.js';
import { computeCandidateConfidence } from './compute-candidate-confidence.js';
import {
  CANDIDATE_CONFIDENCE_SCORING_VERSION,
  type CandidateConfidenceBand,
  type CandidateConfidenceComponents,
  type CandidateProvenanceQuality,
  type EvaluateCandidateConfidenceCommand,
  type EvaluateCandidateConfidenceResult,
} from './types.js';

interface CandidateRevisionIdentityRow {
  candidate_id: string;
  candidate_revision_id: string;
  catalog_revision_id: string;
  patch_id: string;
}

interface ProvenanceFactsRow {
  has_editorial: boolean;
  has_trusted_non_ai: boolean;
}

interface EvidenceFactsRow {
  all_cross_patch_revalidated: boolean;
  has_cross_patch_support: boolean;
  has_exact_patch_support: boolean;
  newest_supporting_evidence_at: Date | null;
  supporting_source_count: number;
}

interface InputSnapshotRow {
  candidate_confidence_input_snapshot_id: string;
}

interface PersistedScoreRow {
  band: CandidateConfidenceBand;
  candidate_confidence_input_snapshot_id: string;
  candidate_confidence_score_id: string;
  created_at: Date;
  evidence_diversity_score: 0 | 10 | 25;
  freshness_score: 0 | 5 | 15;
  patch_alignment_score: 0 | 10 | 20;
  provenance_quality_score: CandidateProvenanceQuality;
  score: number;
  score_sequence: string;
}

function requireCommandText(
  value: string,
  errorCode: string,
  maxLength: number,
): void {
  const length = Buffer.byteLength(value.trim(), 'utf8');
  if (length < 1 || length > maxLength) {
    throw new Error(errorCode);
  }
}

function validateCommand(command: EvaluateCandidateConfidenceCommand): void {
  requireCommandText(command.actorId, 'CONFIDENCE_ACTOR_ID_INVALID', 256);
  requireCommandText(
    command.candidateRevisionId,
    'CONFIDENCE_CANDIDATE_REVISION_ID_INVALID',
    256,
  );
  requireCommandText(
    command.correlationId,
    'CONFIDENCE_CORRELATION_ID_INVALID',
    256,
  );
  requireCommandText(command.reason, 'CONFIDENCE_REASON_INVALID', 1024);
  if (
    !(command.evaluatedAt instanceof Date)
    || !Number.isFinite(command.evaluatedAt.getTime())
  ) {
    throw new Error('CONFIDENCE_EVALUATED_AT_INVALID');
  }
}

async function loadCandidateRevisionIdentity(
  client: PoolClient,
  candidateRevisionId: string,
): Promise<CandidateRevisionIdentityRow> {
  const result = await client.query<CandidateRevisionIdentityRow>(
    `select candidate_id,
            candidate_revision_id,
            patch_id,
            catalog_revision_id
       from candidate_revisions
      where candidate_revision_id = $1
      for share`,
    [candidateRevisionId],
  );
  const identity = result.rows[0];
  if (!identity) {
    throw new Error('CONFIDENCE_CANDIDATE_REVISION_NOT_FOUND');
  }
  return identity;
}

async function loadProvenanceQuality(
  client: PoolClient,
  candidateRevisionId: string,
): Promise<CandidateProvenanceQuality> {
  const result = await client.query<ProvenanceFactsRow>(
    `select coalesce(bool_or(origin = 'editorial'), false) as has_editorial,
            coalesce(
              bool_or(origin in ('collector_detected', 'community_submitted')),
              false
            ) as has_trusted_non_ai
       from candidate_provenance
      where candidate_revision_id = $1`,
    [candidateRevisionId],
  );
  const facts = result.rows[0];
  if (facts?.has_editorial) {
    return 30;
  }
  if (facts?.has_trusted_non_ai) {
    return 20;
  }
  return 0;
}

async function loadEvidenceFacts(
  client: PoolClient,
  candidateRevisionId: string,
  patchId: string,
): Promise<{
  hasExactPatchSupport: boolean;
  hasRevalidatedCrossPatchSupport: boolean;
  newestSupportingEvidenceAt: Date | null;
  supportingSourceCount: number;
}> {
  const result = await client.query<EvidenceFactsRow>(
    `select count(distinct er.source_id)::integer as supporting_source_count,
            coalesce(
              bool_or(er.evidence_patch_id = $2),
              false
            ) as has_exact_patch_support,
            coalesce(
              bool_or(er.evidence_patch_id <> $2),
              false
            ) as has_cross_patch_support,
            coalesce(
              bool_and(ea.cross_patch_revalidated)
                filter (where er.evidence_patch_id <> $2),
              false
            ) as all_cross_patch_revalidated,
            max(coalesce(ro.observed_at, ro.collected_at))
              as newest_supporting_evidence_at
       from candidate_claims claim
       join current_claim_evidence_decisions current_decision
         on current_decision.claim_id = claim.claim_id
        and current_decision.candidate_revision_id =
            claim.candidate_revision_id
       join claim_evidence_decisions decision
         on decision.claim_evidence_decision_id =
            current_decision.claim_evidence_decision_id
        and decision.decision = 'supported'
       join evidence_input_snapshot_associations snapshot_member
         on snapshot_member.evidence_input_snapshot_id =
            decision.evidence_input_snapshot_id
       join evidence_associations ea
         on ea.evidence_association_id =
            snapshot_member.evidence_association_id
        and ea.claim_id = claim.claim_id
        and ea.candidate_revision_id = claim.candidate_revision_id
        and ea.stance = 'supports'
       join evidence_records er
         on er.evidence_id = ea.evidence_id
       join raw_observations ro
         on ro.raw_observation_id = er.raw_observation_id
      where claim.candidate_revision_id = $1`,
    [candidateRevisionId, patchId],
  );
  const facts = result.rows[0];
  const supportingSourceCount = facts?.supporting_source_count ?? 0;
  const hasCrossPatchSupport = facts?.has_cross_patch_support ?? false;
  const allCrossPatchRevalidated =
    facts?.all_cross_patch_revalidated ?? false;

  return {
    hasExactPatchSupport: facts?.has_exact_patch_support ?? false,
    hasRevalidatedCrossPatchSupport:
      hasCrossPatchSupport && allCrossPatchRevalidated,
    newestSupportingEvidenceAt:
      facts?.newest_supporting_evidence_at ?? null,
    supportingSourceCount,
  };
}

async function resolveInputSnapshot(
  client: PoolClient,
  identity: CandidateRevisionIdentityRow,
  command: EvaluateCandidateConfidenceCommand,
  facts: {
    hasExactPatchSupport: boolean;
    hasRevalidatedCrossPatchSupport: boolean;
    newestSupportingEvidenceAt: Date | null;
    provenanceQuality: CandidateProvenanceQuality;
    supportingSourceCount: number;
  },
  inputHash: string,
): Promise<string> {
  const inputSnapshotId = randomUUID();
  const inserted = await client.query<InputSnapshotRow>(
    `insert into candidate_confidence_input_snapshots
      (candidate_confidence_input_snapshot_id, candidate_id,
       candidate_revision_id, patch_id, catalog_revision_id,
       scoring_version, provenance_quality, supporting_source_count,
       has_exact_patch_support, has_revalidated_cross_patch_support,
       newest_supporting_evidence_at, evaluated_at, input_hash, created_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
             $11, $12, $13, $14)
     on conflict (candidate_revision_id, scoring_version, input_hash)
     do nothing
     returning candidate_confidence_input_snapshot_id`,
    [
      inputSnapshotId,
      identity.candidate_id,
      identity.candidate_revision_id,
      identity.patch_id,
      identity.catalog_revision_id,
      CANDIDATE_CONFIDENCE_SCORING_VERSION,
      facts.provenanceQuality,
      facts.supportingSourceCount,
      facts.hasExactPatchSupport,
      facts.hasRevalidatedCrossPatchSupport,
      facts.newestSupportingEvidenceAt,
      command.evaluatedAt,
      inputHash,
      command.actorId,
    ],
  );
  if (inserted.rows[0]) {
    return inserted.rows[0].candidate_confidence_input_snapshot_id;
  }

  const existing = await client.query<InputSnapshotRow>(
    `select candidate_confidence_input_snapshot_id
       from candidate_confidence_input_snapshots
      where candidate_revision_id = $1
        and scoring_version = $2
        and input_hash = $3`,
    [
      identity.candidate_revision_id,
      CANDIDATE_CONFIDENCE_SCORING_VERSION,
      inputHash,
    ],
  );
  const snapshot = existing.rows[0];
  if (!snapshot) {
    throw new Error('CONFIDENCE_INPUT_SNAPSHOT_CONFLICT_NOT_VISIBLE');
  }
  return snapshot.candidate_confidence_input_snapshot_id;
}

async function loadScoreBySnapshot(
  client: PoolClient,
  inputSnapshotId: string,
): Promise<PersistedScoreRow> {
  const result = await client.query<PersistedScoreRow>(
    `select candidate_confidence_score_id,
            candidate_confidence_input_snapshot_id,
            score_sequence::text as score_sequence,
            provenance_quality_score,
            evidence_diversity_score,
            patch_alignment_score,
            freshness_score,
            score,
            band,
            created_at
       from candidate_confidence_scores
      where candidate_confidence_input_snapshot_id = $1`,
    [inputSnapshotId],
  );
  const score = result.rows[0];
  if (!score) {
    throw new Error('CONFIDENCE_SCORE_CONFLICT_NOT_VISIBLE');
  }
  return score;
}

async function persistScore(
  client: PoolClient,
  identity: CandidateRevisionIdentityRow,
  command: EvaluateCandidateConfidenceCommand,
  inputSnapshotId: string,
  inputHash: string,
  confidence: {
    band: CandidateConfidenceBand;
    components: CandidateConfidenceComponents;
    score: number;
  },
): Promise<{ created: boolean; row: PersistedScoreRow }> {
  const scoreId = randomUUID();
  const inserted = await client.query<PersistedScoreRow>(
    `insert into candidate_confidence_scores
      (candidate_confidence_score_id, candidate_confidence_input_snapshot_id,
       candidate_id, candidate_revision_id, patch_id, catalog_revision_id,
       scoring_version, input_hash, evaluated_at,
       provenance_quality_score, evidence_diversity_score,
       patch_alignment_score, freshness_score, score, band,
       reason, actor_id, correlation_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9,
             $10, $11, $12, $13, $14, $15, $16, $17, $18)
     on conflict (candidate_confidence_input_snapshot_id) do nothing
     returning candidate_confidence_score_id,
               candidate_confidence_input_snapshot_id,
               score_sequence::text as score_sequence,
               provenance_quality_score,
               evidence_diversity_score,
               patch_alignment_score,
               freshness_score,
               score,
               band,
               created_at`,
    [
      scoreId,
      inputSnapshotId,
      identity.candidate_id,
      identity.candidate_revision_id,
      identity.patch_id,
      identity.catalog_revision_id,
      CANDIDATE_CONFIDENCE_SCORING_VERSION,
      inputHash,
      command.evaluatedAt,
      confidence.components.provenanceQualityScore,
      confidence.components.evidenceDiversityScore,
      confidence.components.patchAlignmentScore,
      confidence.components.freshnessScore,
      confidence.score,
      confidence.band,
      command.reason,
      command.actorId,
      command.correlationId,
    ],
  );
  const row = inserted.rows[0];
  if (row) {
    return { created: true, row };
  }
  return {
    created: false,
    row: await loadScoreBySnapshot(client, inputSnapshotId),
  };
}

async function recordAuditEvent(
  client: PoolClient,
  identity: CandidateRevisionIdentityRow,
  command: EvaluateCandidateConfidenceCommand,
  inputSnapshotId: string,
  inputHash: string,
  score: PersistedScoreRow,
): Promise<void> {
  await client.query(
    `insert into audit_events
      (audit_event_id, actor_id, action, reason, correlation_id,
       policy_version, payload)
     values ($1, $2, 'candidate_confidence.created', $3, $4, $5, $6::jsonb)`,
    [
      randomUUID(),
      command.actorId,
      command.reason,
      command.correlationId,
      CANDIDATE_CONFIDENCE_SCORING_VERSION,
      JSON.stringify({
        band: score.band,
        candidateId: identity.candidate_id,
        candidateRevisionId: identity.candidate_revision_id,
        components: {
          evidenceDiversityScore: score.evidence_diversity_score,
          freshnessScore: score.freshness_score,
          patchAlignmentScore: score.patch_alignment_score,
          provenanceQualityScore: score.provenance_quality_score,
        },
        inputHash,
        inputSnapshotId,
        score: score.score,
        scoreId: score.candidate_confidence_score_id,
        scoringVersion: CANDIDATE_CONFIDENCE_SCORING_VERSION,
      }),
    ],
  );
}

async function advanceCurrentPointer(
  client: PoolClient,
  identity: CandidateRevisionIdentityRow,
  command: EvaluateCandidateConfidenceCommand,
  inputHash: string,
  score: PersistedScoreRow,
): Promise<void> {
  await client.query(
    `insert into current_candidate_confidence_scores
      (candidate_revision_id, candidate_id, patch_id, catalog_revision_id,
       candidate_confidence_score_id, scoring_version, input_hash,
       evaluated_at, score_sequence)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     on conflict (candidate_revision_id) do update
     set candidate_id = excluded.candidate_id,
         patch_id = excluded.patch_id,
         catalog_revision_id = excluded.catalog_revision_id,
         candidate_confidence_score_id =
           excluded.candidate_confidence_score_id,
         scoring_version = excluded.scoring_version,
         input_hash = excluded.input_hash,
         evaluated_at = excluded.evaluated_at,
         score_sequence = excluded.score_sequence,
         updated_at = clock_timestamp()
     where excluded.evaluated_at
             > current_candidate_confidence_scores.evaluated_at
        or (
          excluded.evaluated_at
            = current_candidate_confidence_scores.evaluated_at
          and excluded.score_sequence
            > current_candidate_confidence_scores.score_sequence
        )`,
    [
      identity.candidate_revision_id,
      identity.candidate_id,
      identity.patch_id,
      identity.catalog_revision_id,
      score.candidate_confidence_score_id,
      CANDIDATE_CONFIDENCE_SCORING_VERSION,
      inputHash,
      command.evaluatedAt,
      score.score_sequence,
    ],
  );
}

export async function evaluateCandidateConfidence(
  pool: Pool,
  command: EvaluateCandidateConfidenceCommand,
): Promise<EvaluateCandidateConfidenceResult> {
  validateCommand(command);

  return withTransaction(pool, async (client) => {
    const identity = await loadCandidateRevisionIdentity(
      client,
      command.candidateRevisionId,
    );
    const [provenanceQuality, evidenceFacts] = await Promise.all([
      loadProvenanceQuality(client, identity.candidate_revision_id),
      loadEvidenceFacts(
        client,
        identity.candidate_revision_id,
        identity.patch_id,
      ),
    ]);
    const facts = {
      ...evidenceFacts,
      provenanceQuality,
    };
    const confidence = computeCandidateConfidence({
      evaluatedAt: command.evaluatedAt,
      hasExactPatchSupport: facts.hasExactPatchSupport,
      hasRevalidatedCrossPatchSupport:
        facts.hasRevalidatedCrossPatchSupport,
      newestSupportingEvidenceAt: facts.newestSupportingEvidenceAt,
      provenanceQuality: facts.provenanceQuality,
      supportingSourceCount: facts.supportingSourceCount,
    });
    const inputHash = hashCanonicalJson({
      candidateId: identity.candidate_id,
      candidateRevisionId: identity.candidate_revision_id,
      catalogRevisionId: identity.catalog_revision_id,
      evaluatedAt: command.evaluatedAt.toISOString(),
      hasExactPatchSupport: facts.hasExactPatchSupport,
      hasRevalidatedCrossPatchSupport:
        facts.hasRevalidatedCrossPatchSupport,
      newestSupportingEvidenceAt:
        facts.newestSupportingEvidenceAt?.toISOString() ?? null,
      patchId: identity.patch_id,
      provenanceQuality: facts.provenanceQuality,
      schemaVersion: 1,
      scoringVersion: CANDIDATE_CONFIDENCE_SCORING_VERSION,
      supportingSourceCount: facts.supportingSourceCount,
    });
    const inputSnapshotId = await resolveInputSnapshot(
      client,
      identity,
      command,
      facts,
      inputHash,
    );
    const persisted = await persistScore(
      client,
      identity,
      command,
      inputSnapshotId,
      inputHash,
      confidence,
    );
    if (persisted.created) {
      await recordAuditEvent(
        client,
        identity,
        command,
        inputSnapshotId,
        inputHash,
        persisted.row,
      );
    }
    await advanceCurrentPointer(
      client,
      identity,
      command,
      inputHash,
      persisted.row,
    );

    return {
      band: persisted.row.band,
      candidateId: identity.candidate_id,
      candidateRevisionId: identity.candidate_revision_id,
      components: {
        evidenceDiversityScore:
          persisted.row.evidence_diversity_score,
        freshnessScore: persisted.row.freshness_score,
        patchAlignmentScore: persisted.row.patch_alignment_score,
        provenanceQualityScore:
          persisted.row.provenance_quality_score,
      },
      inputHash,
      inputSnapshotId,
      replayed: !persisted.created,
      score: persisted.row.score,
      scoreId: persisted.row.candidate_confidence_score_id,
      scoringVersion: CANDIDATE_CONFIDENCE_SCORING_VERSION,
    };
  });
}
