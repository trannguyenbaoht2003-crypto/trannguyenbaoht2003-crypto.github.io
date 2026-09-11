import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { withTransaction } from '../../database/transaction.js';
import { deterministicPreparationUuid, type PreparedCandidateReview } from './prepare-candidate-review.js';
import type { AiReviewDecision, AiReviewRequest } from './ai-review-provider.js';
export interface AutonomousRun {
    run_id: string;
    utc_tick: Date;
    started_at: Date;
    candidate_id: string;
    candidate_revision_id: string;
    eligibility_policy_revision_id: string;
    evidence_policy_revision_id: string;
    moderation_policy_revision_id: string;
    review_policy_revision_id: string;
    model: string;
    prompt_version: 1;
    input_hash: string;
    request_hash: string;
    request: AiReviewRequest;
    publication_id: string;
    expected_publication_version_id: string | null;
    expected_moderation_decision_id: string | null;
    chosen_moderation_decision_id: string;
    state: 'reserved' | 'in_flight' | 'responded' | 'uncertain' | 'failed' | 'held' | 'declined' | 'published';
    response: AiReviewDecision | null;
    provider_response_id: string | null;
    response_hash: string | null;
}
export function autonomousClock(now = new Date().toISOString()) {
    if (typeof now !== 'string' || !Number.isFinite(Date.parse(now)) || new Date(now).toISOString() !== now)
        throw new Error('AI_AUTONOMOUS_TIMESTAMP_INVALID');
    return { now, tick: `${now.slice(0, 13)}:00:00.000Z`, day: now.slice(0, 10) };
}
export function runUuid(run: AutonomousRun, kind: string) { return deterministicPreparationUuid(`autonomous-run-${kind}`, run.run_id); }
export async function terminalRun(pool: Pool, run: AutonomousRun, state: 'held' | 'declined' | 'published' | 'failed' | 'uncertain', failureCode: string | null = null, publicationVersionId: string | null = null) {
    await pool.query(`update autonomous_ai_review_runs set state=$2,failure_code=$3,publication_version_id=$4 where run_id=$1 and state=$5`, [run.run_id, state, failureCode, publicationVersionId, run.state]);
}
export async function reserveRun(pool: Pool, prepared: PreparedCandidateReview, model: string, clock: ReturnType<typeof autonomousClock>): Promise<AutonomousRun | null> {
    return withTransaction(pool, async (client) => {
        await client.query("select pg_advisory_xact_lock(hashtextextended('autonomous-ai-review-budget-v1',0))");
        const budget = await client.query(`select 1 where not exists(select 1 from autonomous_ai_review_runs where utc_tick=$1)
      and (select count(*) from autonomous_ai_review_runs where budget_day=$2::date)<4
      and not exists(select 1 from autonomous_ai_review_runs where request_hash=$3 and model=$4 and prompt_version=1)`, [clock.tick, clock.day, prepared.requestHash, model]);
        if (!budget.rowCount)
            return null;
        const head = (await client.query<{
            publication_id: string;
            publication_version_id: string | null;
        }>(`select publication.publication_id,active.publication_version_id from publications publication left join active_publication_versions active using(publication_id) where publication.candidate_id=$1`, [prepared.candidateId])).rows[0];
        const moderation = (await client.query<{
            moderation_decision_id: string;
        }>(`select moderation_decision_id from current_candidate_moderation_decisions where candidate_revision_id=$1 and moderation_policy_revision_id=$2`, [prepared.candidateRevisionId, prepared.moderationPolicyRevisionId])).rows[0];
        const runId = randomUUID();
        const result = await client.query<AutonomousRun>(`insert into autonomous_ai_review_runs
      (run_id,utc_tick,budget_day,started_at,candidate_id,candidate_revision_id,eligibility_policy_revision_id,evidence_policy_revision_id,moderation_policy_revision_id,review_policy_revision_id,model,input_hash,request_hash,request,publication_id,expected_publication_version_id,expected_moderation_decision_id,chosen_moderation_decision_id)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15,$16,$17,$18) returning *`, [runId, clock.tick, clock.day, clock.now, prepared.candidateId, prepared.candidateRevisionId, prepared.eligibilityPolicyRevisionId, prepared.evidencePolicyRevisionId, prepared.moderationPolicyRevisionId, prepared.reviewPolicyRevisionId, model, prepared.inputHash, prepared.requestHash, JSON.stringify(prepared.request), head?.publication_id ?? deterministicPreparationUuid('autonomous-publication', prepared.candidateId), head?.publication_version_id ?? null, moderation?.moderation_decision_id ?? null, deterministicPreparationUuid('autonomous-run-moderation', runId)]);
        return result.rows[0]!;
    });
}
// Structural currentness only. Preparation is the source/claim authority.
export const ACTIVE_CANDIDATES_SQL = `select revision.candidate_id,revision.candidate_revision_id,
  (select max(created_at) from candidate_provenance where candidate_revision_id=revision.candidate_revision_id) as fresh_at
  from candidate_revisions revision join candidates candidate using(candidate_id)
  join active_catalog_revisions catalog on catalog.patch_id=revision.patch_id
    and catalog.catalog_revision_id=revision.catalog_revision_id and catalog.game_mode_external_id=candidate.game_mode_external_id
  where candidate.game_mode_external_id='aram_mayhem'
    and (select lifecycle_state from patch_lifecycle_events where patch_id=revision.patch_id
      order by occurred_at desc,created_at desc,patch_lifecycle_event_id desc limit 1)='active'
    and not exists(select 1 from candidate_revisions newer join active_catalog_revisions newer_catalog
      on newer_catalog.patch_id=newer.patch_id and newer_catalog.catalog_revision_id=newer.catalog_revision_id
      and newer_catalog.game_mode_external_id=candidate.game_mode_external_id
      where newer.candidate_id=revision.candidate_id and newer.revision>revision.revision)`;
export async function scanCandidates(pool: Pool) {
    return withTransaction(pool, async (client) => {
        const scan = (await client.query<{
            scan_offset: string;
        }>('select scan_offset from autonomous_ai_review_scan_state where singleton=true for update')).rows[0]!;
        const eligible = `${ACTIVE_CANDIDATES_SQL} and (select count(*) from candidate_provenance where candidate_revision_id=revision.candidate_revision_id and origin<>'ai_generated')>=2
      and not exists(select 1 from candidate_claims claim join claim_evidence_decisions decision using(claim_id) where claim.candidate_revision_id=revision.candidate_revision_id and claim.importance='required' and decision.decision='contradicted')`;
        const count = Number((await client.query<{
            count: string;
        }>(`select count(*) from (${eligible}) eligible`)).rows[0]!.count);
        if (!count)
            return [];
        const offset = Number(BigInt(scan.scan_offset) % BigInt(count));
        const rows = (await client.query<{
            candidate_id: string;
            candidate_revision_id: string;
        }>(`${eligible} order by fresh_at desc nulls last,revision.candidate_revision_id limit 32 offset $1`, [offset])).rows;
        await client.query('update autonomous_ai_review_scan_state set scan_offset=$1 where singleton=true', [(offset + rows.length) % count]);
        return rows;
    });
}
