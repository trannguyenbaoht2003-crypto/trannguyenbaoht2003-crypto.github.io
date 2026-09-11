import type { Pool } from 'pg';
import { hashCanonicalJson } from '../../shared/hash.js';
import { completeAiReview, loadAiReviewContext } from './review-authority.js';
import { prepareCandidateReview } from './prepare-candidate-review.js';
import { AiReviewProviderError, createAiReviewProvider, hashAiReviewRequest, validateAiReviewDecision, type AiReviewProvider } from './ai-review-provider.js';
import { recordCandidateModerationDecision } from '../moderation/record-candidate-moderation-decision.js';
import { evaluateCandidateEligibility } from '../eligibility/evaluate-candidate-eligibility.js';
import { publishCandidateRevision } from '../publication/publish-candidate-revision.js';
import { autonomousClock, reserveRun, runUuid, scanCandidates, terminalRun, type AutonomousRun } from './autonomous-review-journal.js';
export { ensureAutonomousReviewPolicy } from './autonomous-review-policy.js';
const ACTOR = 'system:ai-reviewer';
const STALE_CODES = new Set(['current moderation decision cannot move backward', 'current eligibility evaluation cannot move backward', 'AI_AUTONOMOUS_AUTHORITY_CHANGED', 'REVIEW_INPUT_STALE', 'AI_REVIEW_POLICY_METADATA_MISMATCH', 'AI_REVIEW_EVIDENCE_UNSUPPORTED', 'MODERATION_INPUT_STALE', 'CLAIM_SET_NOT_SEALED', 'CANDIDATE_REVISION_NOT_CURRENT', 'CANDIDATE_NOT_ELIGIBLE', 'ACTIVE_ELIGIBILITY_POLICY_MISMATCH', 'STALE_ELIGIBILITY_EVALUATION', 'STALE_MODERATION_DECISION', 'MODERATION_NOT_CLEAR', 'PUBLICATION_CANDIDATE_CONFLICT', 'PUBLICATION_ACTIVE_POINTER_CONFLICT', 'ELIGIBILITY_POLICY_NOT_ACTIVE']);
function metadata(run: AutonomousRun, kind: string) { return { actorId: ACTOR, candidateId: run.candidate_id, candidateRevisionId: run.candidate_revision_id, correlationId: `autonomous:${run.run_id}`, idempotencyKey: `autonomous:${run.run_id}:${kind}` }; }
async function contextCurrent(pool: Pool, run: AutonomousRun): Promise<boolean> {
    try {
        const context = await loadAiReviewContext(pool, run.candidate_id, run.candidate_revision_id);
        if (context.inputHash !== run.input_hash || context.reviewPolicyRevisionId !== run.review_policy_revision_id || context.eligibilityPolicyRevisionId !== run.eligibility_policy_revision_id || context.evidencePolicyRevisionId !== run.evidence_policy_revision_id || context.moderationPolicyRevisionId !== run.moderation_policy_revision_id)
            return false;
        const moderation = (await pool.query<{moderation_decision_id: string; evaluated_at: Date}>(`select current.moderation_decision_id,decision.evaluated_at from current_candidate_moderation_decisions current join moderation_decisions decision using(moderation_decision_id) where current.candidate_revision_id=$1 and current.moderation_policy_revision_id=$2`, [run.candidate_revision_id, run.moderation_policy_revision_id])).rows[0];
        if (moderation?.moderation_decision_id === runUuid(run, 'moderation')) return true;
        return (moderation?.moderation_decision_id ?? null) === run.expected_moderation_decision_id
          && (!moderation || moderation.evaluated_at <= run.started_at);
    }
    catch (error) {
        if (error instanceof Error && (STALE_CODES.has(error.message) || /NOT_FOUND|NOT_ACTIVE|STALE/.test(error.message)))
            return false;
        throw error;
    }
}
function publicationCommand(run: AutonomousRun) { return { publicationId: run.publication_id, publicationVersionId: runUuid(run, 'publication-version'), activationId: runUuid(run, 'activation'), candidateRevisionId: run.candidate_revision_id, expectedActiveEligibilityPolicyRevisionId: run.eligibility_policy_revision_id, expectedEligibilityEvaluationId: runUuid(run, 'eligibility'), expectedModerationDecisionId: runUuid(run, 'moderation'), expectedActivePublicationVersionId: run.expected_publication_version_id, authorization: { actorId: ACTOR, permissions: ['publisher'] as const }, auditId: runUuid(run, 'publication-audit'), outboxEventId: runUuid(run, 'publication-outbox'), correlationId: `autonomous:${run.run_id}`, idempotencyKey: `autonomous:${run.run_id}:publish`, occurredAt: run.started_at.toISOString() }; }
async function finalizeResponse(pool: Pool, run: AutonomousRun): Promise<void> {
    // Serialize coordinators without keeping a database transaction open across domain commands.
    const lock = await pool.connect();
    try {
        const owned = (await lock.query<{
            locked: boolean;
        }>('select pg_try_advisory_lock(hashtextextended($1,0)) as locked', [`autonomous-finalize:${run.run_id}`])).rows[0]!.locked;
        if (!owned)
            return;
        try {
            const current = (await pool.query<AutonomousRun>('select * from autonomous_ai_review_runs where run_id=$1', [run.run_id])).rows[0]!;
            if (current.state !== 'responded')
                return;
            const command = publicationCommand(run);
            // Receipt replay must precede currentness checks: a crash after publication is already success.
            const published = await pool.query<{
                result: unknown;
            }>(`select result from idempotency_records where scope='publication_publish' and idempotency_key=$1 and state='completed'`, [command.idempotencyKey]);
            if (published.rowCount) {
                const receipt = published.rows[0]?.result;
                const receiptIsBound = receipt !== null
                  && typeof receipt === 'object'
                  && !Array.isArray(receipt)
                  && (receipt as Record<string, unknown>).publicationId === run.publication_id
                  && (receipt as Record<string, unknown>).candidateRevisionId === run.candidate_revision_id
                  && (receipt as Record<string, unknown>).publicationVersionId === command.publicationVersionId;
                if (!receiptIsBound) {
                    await terminalRun(pool, run, 'held', 'AI_AUTONOMOUS_PUBLICATION_RECEIPT_INVALID');
                    return;
                }
                const receiptPublicationVersionId = (receipt as Record<string, unknown>).publicationVersionId as string;
                const version = await pool.query(
                  `select 1 from publication_versions
                    where publication_version_id=$1
                      and publication_id=$2
                      and candidate_revision_id=$3`,
                  [receiptPublicationVersionId, run.publication_id, run.candidate_revision_id],
                );
                if (!version.rowCount) {
                    await terminalRun(pool, run, 'held', 'AI_AUTONOMOUS_PUBLICATION_RECEIPT_INVALID');
                    return;
                }
                // The domain command has already committed all publication effects. Do not
                // re-enter its current-authority checks after a later policy change.
                await terminalRun(pool, run, 'published', null, receiptPublicationVersionId);
                return;
            }
            if (!await contextCurrent(pool, run)) {
                await terminalRun(pool, run, 'held', 'AI_AUTONOMOUS_INPUT_STALE');
                return;
            }
            const decision = validateAiReviewDecision(run.response, run.request);
            if (hashCanonicalJson(decision) !== run.response_hash || hashAiReviewRequest(run.request) !== run.request_hash) {
                await terminalRun(pool, run, 'held', 'AI_REVIEW_PROVIDER_OUTPUT_INVALID');
                return;
            }
            await completeAiReview(pool, { ...metadata(run, 'review'), reviewPolicyRevisionId: run.review_policy_revision_id, expectedInputHash: run.input_hash, aiReviewId: runUuid(run, 'review'), reviewInputSnapshotId: runUuid(run, 'review-input'), reviewQuorumEvaluationId: runUuid(run, 'review-quorum'), model: run.model, promptVersion: 1, requestHash: run.request_hash, responseHash: run.response_hash!, providerResponseId: run.provider_response_id!, outcome: decision.outcome, reason: decision.reason, completedAt: run.started_at.toISOString() });
            if (!await contextCurrent(pool, run)) {
                await terminalRun(pool, run, 'held', 'AI_AUTONOMOUS_INPUT_STALE');
                return;
            }
            await recordCandidateModerationDecision(pool, { ...metadata(run, 'moderation'), decisionId: runUuid(run, 'moderation'), inputSnapshotId: runUuid(run, 'moderation-input'), moderationPolicyRevisionId: run.moderation_policy_revision_id, outcome: decision.outcome === 'confirmed' ? 'clear' : decision.outcome === 'declined' ? 'blocked' : 'needs_review', reason: decision.reason, evaluatedAt: run.started_at.toISOString() });
            if (!await contextCurrent(pool, run)) {
                await terminalRun(pool, run, 'held', 'AI_AUTONOMOUS_INPUT_STALE');
                return;
            }
            const newerEvaluation = await pool.query(`select 1 from current_candidate_eligibility_evaluations current join candidate_eligibility_evaluations evaluation using(candidate_eligibility_evaluation_id) where current.candidate_revision_id=$1 and current.eligibility_policy_revision_id=$2 and evaluation.evaluated_at>$3 and evaluation.candidate_eligibility_evaluation_id<>$4`, [run.candidate_revision_id,run.eligibility_policy_revision_id,run.started_at,runUuid(run,'eligibility')]);
            if (newerEvaluation.rowCount) {
                await terminalRun(pool,run,'held','AI_AUTONOMOUS_INPUT_STALE');
                return;
            }
            const eligibility = await evaluateCandidateEligibility(pool, { ...metadata(run, 'eligibility'), evaluationId: runUuid(run, 'eligibility'), inputSnapshotId: runUuid(run, 'eligibility-input'), evaluatedAt: run.started_at.toISOString() });
            if (decision.outcome === 'declined') {
                await terminalRun(pool, run, 'declined');
                return;
            }
            if (decision.outcome !== 'confirmed' || eligibility.outcome !== 'eligible' || eligibility.eligibilityPolicyRevisionId !== run.eligibility_policy_revision_id) {
                await terminalRun(pool, run, 'held', 'AI_AUTONOMOUS_NOT_ELIGIBLE');
                return;
            }
            const result = await publishCandidateRevision(pool, command);
            await terminalRun(pool, run, 'published', null, result.publicationVersionId);
        }
        catch (error) {
            if (error instanceof AiReviewProviderError) {
                await terminalRun(pool,run,'held','AI_REVIEW_PROVIDER_OUTPUT_INVALID');
                return;
            }
            if (error instanceof Error && STALE_CODES.has(error.message)) {
                await terminalRun(pool, run, 'held', 'AI_AUTONOMOUS_INPUT_STALE');
                return;
            }
            // Persistence failures retain the validated response and all replayable receipts.
            throw error;
        }
        finally {
            await lock.query('select pg_advisory_unlock(hashtextextended($1,0))', [`autonomous-finalize:${run.run_id}`]);
        }
    }
    finally {
        lock.release();
    }
}
async function executeReserved(pool: Pool, run: AutonomousRun, provider: AiReviewProvider, now?: string) {
    const clock = autonomousClock(now);
    if (run.utc_tick.toISOString() !== clock.tick) {
        await terminalRun(pool, run, 'held', 'AI_AUTONOMOUS_RESERVATION_EXPIRED');
        return;
    }
    if (hashAiReviewRequest(run.request) !== run.request_hash || !await contextCurrent(pool, run)) {
        await terminalRun(pool, run, 'held', 'AI_AUTONOMOUS_INPUT_STALE');
        return;
    }
    const claimClock = autonomousClock(now);
    if (run.utc_tick.toISOString() !== claimClock.tick) {
        await terminalRun(pool,run,'held','AI_AUTONOMOUS_RESERVATION_EXPIRED');
        return;
    }
    const owned = await pool.query<AutonomousRun>(`update autonomous_ai_review_runs set state='in_flight',in_flight_at=$2 where run_id=$1 and state='reserved' returning *`, [run.run_id, claimClock.now]);
    if (!owned.rowCount)
        return;
    const inFlight = owned.rows[0]!;
    if (!await contextCurrent(pool, run)) {
        // The provider has not been called yet; stale authority is held for
        // operator/current-policy recovery, never classified as a provider failure.
        await terminalRun(pool, inFlight, 'held', 'AI_AUTONOMOUS_INPUT_STALE');
        return;
    }
    let response;
    try {
        response = await provider.execute(run.request, { clientRequestId: run.run_id });
        const decision = validateAiReviewDecision(response.decision, run.request);
        if (typeof response.providerResponseId !== 'string' || !/^[!-~]{1,256}$/.test(response.providerResponseId) || response.responseHash !== hashCanonicalJson(decision))
            throw new AiReviewProviderError('AI_REVIEW_PROVIDER_OUTPUT_INVALID');
        response = { ...response, decision };
    }
    catch (error) {
        const code = error instanceof AiReviewProviderError ? error.code : 'AI_REVIEW_PROVIDER_UNCERTAIN';
        await terminalRun(pool, inFlight, code === 'AI_REVIEW_PROVIDER_UNCERTAIN' ? 'uncertain' : 'failed', code);
        return;
    }
    // Never catch this write as a provider error: a lost acknowledgement remains in flight/uncertain.
    const saved = await pool.query<AutonomousRun>(`update autonomous_ai_review_runs set state='responded',response=$2::jsonb,provider_response_id=$3,response_hash=$4 where run_id=$1 and state='in_flight' returning *`, [run.run_id, JSON.stringify(response.decision), response.providerResponseId, response.responseHash]);
    if (saved.rows[0])
        await finalizeResponse(pool, saved.rows[0]);
}
export async function processAutonomousReviewTick(pool: Pool, options: {
    provider: AiReviewProvider;
    model: string;
    now?: string;
}) {
    const clock = autonomousClock(options.now);
    createAiReviewProvider({ apiKey: 'validation-only', model: options.model });
    // 60s provider maximum plus 5s grace, measured from ownership, never reservation creation.
    await pool.query(`update autonomous_ai_review_runs set state='uncertain',failure_code='AI_AUTONOMOUS_IN_FLIGHT_EXPIRED' where state='in_flight' and in_flight_at<$1::timestamptz-interval '65 seconds'`, [clock.now]);
    await pool.query(`update autonomous_ai_review_runs set state='held',failure_code='AI_AUTONOMOUS_RESERVATION_EXPIRED' where state='reserved' and utc_tick<$1`, [clock.tick]);
    const recovery = (await pool.query<AutonomousRun>(`select * from autonomous_ai_review_runs where model=$1 and state in ('responded','reserved') order by started_at limit 16`, [options.model])).rows;
    for (const run of recovery) {
        if (run.state === 'responded')
            await finalizeResponse(pool, run);
        else
            await executeReserved(pool, run, options.provider, options.now);
    }
    const budget = (await pool.query<{
        available: boolean;
    }>(`select not exists(select 1 from autonomous_ai_review_runs where utc_tick=$1) and (select count(*) from autonomous_ai_review_runs where budget_day=$2::date)<4 as available`, [clock.tick, clock.day])).rows[0]!.available;
    if (!budget)
        return { outcome: 'BUDGET_OR_TICK_RESERVED' };
    const policy = await pool.query(`select 1 from active_eligibility_policy_revision active join eligibility_policy_revisions eligibility using(eligibility_policy_revision_id) join ai_review_policy_configs config using(review_policy_revision_id) where active.scope='candidate_revision' and config.model=$1 and config.prompt_version=1`, [options.model]);
    if (!policy.rowCount)
        return { outcome: 'AI_POLICY_NOT_ACTIVE' };
    for (const candidate of await scanCandidates(pool)) {
        const prepared = await prepareCandidateReview(pool, candidate.candidate_id, candidate.candidate_revision_id);
        if (!prepared)
            continue;
        const duplicate = await pool.query('select 1 from autonomous_ai_review_runs where request_hash=$1 and model=$2 and prompt_version=1', [prepared.requestHash, options.model]);
        if (duplicate.rowCount)
            continue;
        const run = await reserveRun(pool, prepared, options.model, autonomousClock(options.now));
        if (!run)
            return { outcome: 'BUDGET_OR_TICK_RESERVED' };
        await executeReserved(pool, run, options.provider, options.now);
        return { outcome: 'PROCESSED', runId: run.run_id };
    }
    return { outcome: 'NO_PREPARABLE_INPUT' };
}
