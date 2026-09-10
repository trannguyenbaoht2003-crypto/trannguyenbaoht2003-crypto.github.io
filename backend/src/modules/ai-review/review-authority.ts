import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { withTransaction } from '../../database/transaction.js';
import { beginIdempotentCommand, completeIdempotentCommand } from '../../shared/idempotent-command.js';
import { hashCanonicalTupleV1, normalizePolicyKey, requireBoundedText, requireUuid } from '../trust/normalize-trust-input.js';
import { lockCandidateRevisionAuthority } from '../trust/load-trust-authority.js';
import { loadReviewPointerSeed, lockCurrentAuthorityPointers, lockClaims, loadClaimSeal, loadProvenance, reviewInputHashes, resolveReviewSnapshot } from '../trust/complete-human-review.js';

export interface RegisterAiReviewPolicyCommand {
  actorId: string;
  reviewPolicyRevisionId: string;
  policyKey: string;
  revision: number;
  model: string;
  promptVersion: number;
  reason: string;
  correlationId: string;
  idempotencyKey: string;
}
export interface RegisterAiReviewPolicyResult {
  reviewPolicyRevisionId: string;
  replayed: boolean;
}
export interface CompleteAiReviewCommand {
  actorId: string;
  candidateId: string;
  candidateRevisionId: string;
  reviewPolicyRevisionId: string;
  expectedInputHash: string;
  aiReviewId: string;
  reviewInputSnapshotId: string;
  reviewQuorumEvaluationId: string;
  model: string;
  promptVersion: number;
  requestHash: string;
  responseHash: string;
  providerResponseId: string;
  outcome: 'confirmed' | 'changes_requested' | 'declined';
  reason: string;
  completedAt: string;
  correlationId: string;
  idempotencyKey: string;
}
export interface CompleteAiReviewResult {
  aiReviewId: string;
  quorumEvaluationId: string;
  inputHash: string;
  quorumSatisfied: boolean;
  replayed: boolean;
}

function exactKeys(value: unknown, keys: readonly string[]): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) {
    throw new Error('TRUST_OBJECT_KEYS_INVALID:aiReview');
  }
}
function hash(value: string, field: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`AI_REVIEW_HASH_INVALID:${field}`);
  }
  return value;
}
function metadata<T extends { actorId: string; model: string; promptVersion: number; reason: string; correlationId: string; idempotencyKey: string }>(input: T): T {
  if (input.promptVersion !== 1) throw new Error('AI_REVIEW_PROMPT_VERSION_INVALID');
  return { ...input,
    actorId: requireBoundedText(input.actorId, 'actorId', 256),
    model: requireBoundedText(input.model, 'model', 256),
    reason: requireBoundedText(input.reason, 'reason', 1024),
    correlationId: requireBoundedText(input.correlationId, 'correlationId', 256),
    idempotencyKey: requireBoundedText(input.idempotencyKey, 'idempotencyKey', 256),
  };
}
// Include every accepted field, including caller-generated IDs and timestamps.
function payloadHash(kind: string, command: object): string {
  return hashCanonicalTupleV1(['TrustTupleV1', kind,
    ...Object.entries(command).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .flatMap(([key, value]) => [key, String(value)])]);
}

async function recordEvent(client: PoolClient, command: { actorId: string; reason: string; correlationId: string; reviewPolicyRevisionId: string }, action: string, eventType: string, aggregateType: string, aggregateId: string, payload: object): Promise<void> {
  await client.query(`insert into audit_events
    (audit_event_id,actor_id,action,reason,correlation_id,policy_version,payload)
    values ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
  [randomUUID(),command.actorId,action,command.reason,command.correlationId,command.reviewPolicyRevisionId,JSON.stringify(payload)]);
  await client.query(`insert into outbox_events
    (outbox_event_id,aggregate_type,aggregate_id,event_type,payload,correlation_id)
    values ($1,$2,$3,$4,$5::jsonb,$6)`,
  [randomUUID(),aggregateType,aggregateId,eventType,JSON.stringify(payload),command.correlationId]);
}

export async function registerAiReviewPolicy(pool: Pool, input: RegisterAiReviewPolicyCommand): Promise<RegisterAiReviewPolicyResult> {
  exactKeys(input, ['actorId','reviewPolicyRevisionId','policyKey','revision','model','promptVersion','reason','correlationId','idempotencyKey']);
  if (!Number.isSafeInteger(input.revision) || input.revision < 1 || input.revision > 2147483647) throw new Error('TRUST_POLICY_INVALID');
  const command = { ...metadata(input),
    reviewPolicyRevisionId: requireUuid(input.reviewPolicyRevisionId, 'reviewPolicyRevisionId'),
    policyKey: normalizePolicyKey(input.policyKey),
  };
  return withTransaction(pool, async (client) => {
    const replay = await beginIdempotentCommand<RegisterAiReviewPolicyResult>(client, 'ai_review_policy_registration', command.idempotencyKey, payloadHash('RegisterAiReviewPolicyV1', command));
    if (replay) return { ...replay, replayed: true };
    await client.query(`insert into review_policy_revisions
      (review_policy_revision_id,policy_key,revision,minimum_confirmed_reviews,require_distinct_reviewers,
       required_permission,applies_to_ai_provenance,reason,created_by,review_authority)
      values ($1,$2,$3,1,true,'ai_reviewer',true,$4,$5,'ai')`,
    [command.reviewPolicyRevisionId,command.policyKey,command.revision,command.reason,command.actorId]);
    await client.query(`insert into ai_review_policy_configs (review_policy_revision_id,model,prompt_version) values ($1,$2,$3)`,
    [command.reviewPolicyRevisionId,command.model,command.promptVersion]);
    const result = { reviewPolicyRevisionId: command.reviewPolicyRevisionId, replayed: false };
    await recordEvent(client, command, 'review.ai_policy_registered', 'AiReviewPolicyRegistered', 'trust_policy_revision', command.reviewPolicyRevisionId,
      { ...result, model: command.model, promptVersion: command.promptVersion });
    await completeIdempotentCommand(client, 'ai_review_policy_registration', command.idempotencyKey, result);
    return result;
  });
}

async function loadLockedContext(client: PoolClient, candidateId: string, candidateRevisionId: string) {
  const seed = await loadReviewPointerSeed(client, candidateId, candidateRevisionId);
  await lockCurrentAuthorityPointers(client, seed);
  const authority = await lockCandidateRevisionAuthority(client, candidateId, candidateRevisionId);
  const policy = await client.query<{
    eligibility_policy_revision_id: string;
    evidence_policy_revision_id: string;
    moderation_policy_revision_id: string;
    review_policy_revision_id: string;
    model: string;
    prompt_version: number;
  }>(`
    select eligibility.eligibility_policy_revision_id,
           eligibility.evidence_policy_revision_id,
           eligibility.moderation_policy_revision_id,
           review.review_policy_revision_id, config.model, config.prompt_version
      from active_eligibility_policy_revision active
      join eligibility_policy_revisions eligibility using (eligibility_policy_revision_id)
      join review_policy_revisions review using (review_policy_revision_id)
      join ai_review_policy_configs config using (review_policy_revision_id)
     where active.scope = 'candidate_revision' and review.review_authority = 'ai'
       and not exists (
         select 1 from candidate_revisions newer
         join active_catalog_revisions catalog on catalog.patch_id = newer.patch_id
           and catalog.game_mode_external_id = $3 and catalog.catalog_revision_id = newer.catalog_revision_id
         where newer.candidate_id = $1 and (newer.revision >
           (select revision from candidate_revisions where candidate_revision_id = $2)
           or (newer.revision = (select revision from candidate_revisions where candidate_revision_id = $2)
             and newer.candidate_revision_id::text collate "C" > $2::text collate "C")))`,
  [candidateId,candidateRevisionId,seed.gameModeExternalId]);
  const activePolicy = policy.rows[0];
  if (!activePolicy) throw new Error('REVIEW_INPUT_STALE');
  const claims = await lockClaims(client, candidateRevisionId);
  const seal = await loadClaimSeal(client, candidateRevisionId);
  const provenance = await loadProvenance(client, candidateRevisionId);
  const hashes = reviewInputHashes(candidateId,candidateRevisionId,authority.patchId,authority.catalogRevisionId,
    authority.normalizedSignature,seal.claim_set_hash,activePolicy.review_policy_revision_id,claims,provenance);
  return { authority, activePolicy, claims, seal, provenance, hashes };
}

export async function loadAiReviewContext(pool: Pool, candidateId: string, candidateRevisionId: string): Promise<{
  eligibilityPolicyRevisionId: string;
  evidencePolicyRevisionId: string;
  moderationPolicyRevisionId: string;
  reviewPolicyRevisionId: string;
  inputHash: string;
}> {
  requireUuid(candidateId, 'candidateId');
  requireUuid(candidateRevisionId, 'candidateRevisionId');
  return withTransaction(pool, async (client) => {
    const context = await loadLockedContext(client, candidateId, candidateRevisionId);
    return {
      eligibilityPolicyRevisionId: context.activePolicy.eligibility_policy_revision_id,
      evidencePolicyRevisionId: context.activePolicy.evidence_policy_revision_id,
      moderationPolicyRevisionId: context.activePolicy.moderation_policy_revision_id,
      reviewPolicyRevisionId: context.activePolicy.review_policy_revision_id,
      inputHash: context.hashes.inputHash,
    };
  });
}

export async function completeAiReview(pool: Pool, input: CompleteAiReviewCommand): Promise<CompleteAiReviewResult> {
  exactKeys(input, ['actorId','candidateId','candidateRevisionId','reviewPolicyRevisionId','expectedInputHash','aiReviewId',
    'reviewInputSnapshotId','reviewQuorumEvaluationId','model','promptVersion','requestHash','responseHash',
    'providerResponseId','outcome','reason','completedAt','correlationId','idempotencyKey']);
  if (input.actorId !== 'system:ai-reviewer') throw new Error('REVIEW_AUTHORITY_REQUIRED');
  if (!['confirmed','changes_requested','declined'].includes(input.outcome)) throw new Error('AI_REVIEW_OUTCOME_INVALID');
  if (typeof input.completedAt !== 'string' || !Number.isFinite(Date.parse(input.completedAt))
    || new Date(input.completedAt).toISOString() !== input.completedAt) throw new Error('AI_REVIEW_TIMESTAMP_INVALID');
  const command = { ...metadata(input),
    candidateId: requireUuid(input.candidateId, 'candidateId'),
    candidateRevisionId: requireUuid(input.candidateRevisionId, 'candidateRevisionId'),
    reviewPolicyRevisionId: requireUuid(input.reviewPolicyRevisionId, 'reviewPolicyRevisionId'),
    aiReviewId: requireUuid(input.aiReviewId, 'aiReviewId'),
    reviewInputSnapshotId: requireUuid(input.reviewInputSnapshotId, 'reviewInputSnapshotId'),
    reviewQuorumEvaluationId: requireUuid(input.reviewQuorumEvaluationId, 'reviewQuorumEvaluationId'),
    expectedInputHash: hash(input.expectedInputHash, 'expectedInputHash'),
    requestHash: hash(input.requestHash, 'requestHash'),
    responseHash: hash(input.responseHash, 'responseHash'),
    providerResponseId: requireBoundedText(input.providerResponseId, 'providerResponseId', 256),
  };
  return withTransaction(pool, async (client) => {
    // A stored receipt wins over later policy/catalog/evidence/provenance changes.
    const replay = await beginIdempotentCommand<CompleteAiReviewResult>(client, 'ai_review_completion', command.idempotencyKey, payloadHash('CompleteAiReviewV1', command));
    if (replay) return { ...replay, replayed: true };
    const context = await loadLockedContext(client, command.candidateId, command.candidateRevisionId);
    if (context.activePolicy.review_policy_revision_id !== command.reviewPolicyRevisionId
      || context.hashes.inputHash !== command.expectedInputHash) throw new Error('REVIEW_INPUT_STALE');
    if (context.activePolicy.model !== command.model || context.activePolicy.prompt_version !== command.promptVersion) {
      throw new Error('AI_REVIEW_POLICY_METADATA_MISMATCH');
    }
    const snapshot = await resolveReviewSnapshot(client, command, context.authority, context.seal, context.claims, context.provenance);
    if (command.outcome === 'confirmed') {
      const evidence = await client.query<{ supported: boolean }>('select ai_review_required_evidence_supported($1) as supported', [snapshot.review_input_snapshot_id]);
      if (evidence.rows[0]?.supported !== true) throw new Error('AI_REVIEW_EVIDENCE_UNSUPPORTED');
    }
    await client.query(`insert into ai_reviews
      (ai_review_id,candidate_id,candidate_revision_id,review_input_snapshot_id,input_hash,review_policy_revision_id,
       reviewer_actor_id,model,prompt_version,request_hash,response_hash,provider_response_id,outcome,reason,correlation_id,completed_at)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
    [command.aiReviewId,command.candidateId,command.candidateRevisionId,snapshot.review_input_snapshot_id,snapshot.input_hash,
      command.reviewPolicyRevisionId,command.actorId,command.model,command.promptVersion,command.requestHash,command.responseHash,
      command.providerResponseId,command.outcome,command.reason,command.correlationId,command.completedAt]);
    const confirmed = await client.query<{ ai_review_id: string }>(`select ai_review_id from ai_reviews
      where candidate_revision_id=$1 and review_policy_revision_id=$2 and input_hash=$3 and outcome='confirmed'
      order by completed_at, ai_review_id::text collate "C"`, [command.candidateRevisionId,command.reviewPolicyRevisionId,snapshot.input_hash]);
    const quorumSatisfied = confirmed.rows.length >= 1;
    await client.query(`insert into review_quorum_evaluations
      (review_quorum_evaluation_id,candidate_id,candidate_revision_id,review_input_snapshot_id,input_hash,
       review_policy_revision_id,required_confirmed_count,counted_review_count,quorum_satisfied,evaluated_at)
      values ($1,$2,$3,$4,$5,$6,1,$7,$8,$9)`,
    [command.reviewQuorumEvaluationId,command.candidateId,command.candidateRevisionId,snapshot.review_input_snapshot_id,
      snapshot.input_hash,command.reviewPolicyRevisionId,confirmed.rows.length,quorumSatisfied,command.completedAt]);
    for (const [index, review] of confirmed.rows.entries()) {
      await client.query(`insert into review_quorum_evaluation_ai_reviews
        (review_quorum_evaluation_id,ai_review_id,candidate_id,candidate_revision_id,review_policy_revision_id,input_hash,ordinal)
        values ($1,$2,$3,$4,$5,$6,$7)`,
      [command.reviewQuorumEvaluationId,review.ai_review_id,command.candidateId,command.candidateRevisionId,command.reviewPolicyRevisionId,snapshot.input_hash,index + 1]);
    }
    await client.query(`insert into current_review_quorum_evaluations
      (candidate_revision_id,review_policy_revision_id,candidate_id,input_hash,review_quorum_evaluation_id)
      values ($1,$2,$3,$4,$5)
      on conflict (candidate_revision_id,review_policy_revision_id) do update
      set input_hash=excluded.input_hash, review_quorum_evaluation_id=excluded.review_quorum_evaluation_id, updated_at=clock_timestamp()`,
    [command.candidateRevisionId,command.reviewPolicyRevisionId,command.candidateId,snapshot.input_hash,command.reviewQuorumEvaluationId]);
    const result = { aiReviewId: command.aiReviewId, quorumEvaluationId: command.reviewQuorumEvaluationId,
      inputHash: snapshot.input_hash, quorumSatisfied, replayed: false };
    await recordEvent(client, command, 'review.ai_review_completed', 'AiReviewCompleted', 'candidate_revision', command.candidateRevisionId,
      { ...result, candidateId: command.candidateId, candidateRevisionId: command.candidateRevisionId,
        reviewPolicyRevisionId: command.reviewPolicyRevisionId, outcome: command.outcome });
    await completeIdempotentCommand(client, 'ai_review_completion', command.idempotencyKey, result);
    return result;
  });
}
