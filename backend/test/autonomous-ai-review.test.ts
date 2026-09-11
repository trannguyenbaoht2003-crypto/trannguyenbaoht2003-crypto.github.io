import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { processAutonomousReviewTick, ensureAutonomousReviewPolicy } from '../src/modules/ai-review/run-autonomous-review.js';
import { hashCanonicalJson } from '../src/shared/hash.js';
import type { AiReviewProvider, AiReviewRequest } from '../src/modules/ai-review/ai-review-provider.js';
import { resetDatabase, tableCount } from './helpers/database.js';
import { seedActiveCatalog } from './helpers/catalog.js';
import { CANDIDATE_IDS, validNormalizationSnapshot } from './helpers/candidate.js';
import { registerNormalizedObservation } from '../src/modules/candidate/register-normalized-observation.js';
async function seed(pool: Awaited<ReturnType<typeof resetDatabase>>) {
    await seedActiveCatalog(pool);
    for (const [i, url] of ['https://www.bilibili.com/video/123', 'https://www.zhihu.com/question/123'].entries()) {
        const source = randomUUID(), policy = randomUUID(), raw = randomUUID();
        await pool.query(`insert into sources (source_id,source_key,display_name,status) values ($1,$2,'test','active')`, [source, `autonomous-${i}`]);
        await pool.query(`insert into source_policy_revisions (source_policy_revision_id,source_id,revision,storage_permission,collector_enabled,reason,created_by) values ($1,$2,1,'reference_only',true,'test','test')`, [policy, source]);
        await pool.query(`insert into raw_observations (raw_observation_id,source_id,source_policy_revision_id,adapter_version,external_reference,content_hash,collected_at) values ($1,$2,$3,'test',$4::jsonb,$5,clock_timestamp())`, [raw, source, policy, JSON.stringify({ url }), `autonomous-${i}`]);
        await registerNormalizedObservation(pool, { actorId: 'test', candidateId: CANDIDATE_IDS.candidateId, candidateRevisionId: CANDIDATE_IDS.candidateRevisionId, correlationId: `autonomous-${i}`, normalizedObservationId: randomUUID(), provenanceId: randomUUID(), rawObservationId: raw, snapshot: validNormalizationSnapshot('community_submitted') });
    }
    await ensureAutonomousReviewPolicy(pool, { model: 'gpt-test' });
}
function result(request: AiReviewRequest, outcome: 'confirmed' | 'changes_requested' | 'declined' = 'confirmed') {
    const decision = { outcome, reason: 'Supplied reports checked.', claims: request.requiredClaims.map(({ claimId }) => ({ claimId, decision: outcome === 'confirmed' ? 'supported' as const : 'insufficient' as const, observationIds: request.evidence.map(e => e.normalizedObservationId) })) };
    const validated = validateAiReviewDecision(decision, request);
    return { decision: validated, responseHash: hashCanonicalJson(validated), providerResponseId: 'response-test' };
}
const time = '2026-09-10T10:00:00.000Z';
test('autonomous success publishes once with no human receipt across duplicate and concurrent ticks', async (t) => {
    const pool = await resetDatabase();
    t.after(() => pool.end());
    await seed(pool);
    let calls = 0;
    const provider: AiReviewProvider = { async execute(request) { calls++; return result(request); } };
    await Promise.all([processAutonomousReviewTick(pool, { provider, model: 'gpt-test', now: time }), processAutonomousReviewTick(pool, { provider, model: 'gpt-test', now: time })]);
    await processAutonomousReviewTick(pool, { provider, model: 'gpt-test', now: '2026-09-10T11:00:00.000Z' });
    assert.equal(calls, 1);
    assert.equal(await tableCount(pool, 'publication_versions'), 1);
    assert.equal(await tableCount(pool, 'human_reviews'), 0);
    assert.equal(await tableCount(pool, 'ai_reviews'), 1);
});
for (const outcome of ['changes_requested', 'declined', 'malformed', 'contradicted'] as const)
    test(`autonomous ${outcome} output cannot publish`, async (t) => {
        const pool = await resetDatabase();
        t.after(() => pool.end());
        await seed(pool);
        const provider: AiReviewProvider = { async execute(request) { const response = result(request, outcome === 'changes_requested' || outcome === 'declined' ? outcome : 'confirmed'); if (outcome === 'malformed')
                response.responseHash = 'bad'; if (outcome === 'contradicted') {
                response.decision.claims[0]!.decision = 'contradicted';
                response.responseHash = hashCanonicalJson(response.decision);
            } return response; } };
        await processAutonomousReviewTick(pool, { provider, model: 'gpt-test', now: time });
        assert.equal(await tableCount(pool, 'publication_versions'), 0);
        const run = (await pool.query('select state from autonomous_ai_review_runs')).rows[0];
        assert.equal(run.state, outcome === 'declined' ? 'declined' : outcome === 'changes_requested' ? 'held' : 'failed');
    });
test('autonomous policy bootstrap is concurrent and idempotent, models have distinct identity', async (t) => {
    const pool = await resetDatabase();
    t.after(() => pool.end());
    const [a, b] = await Promise.all([ensureAutonomousReviewPolicy(pool, { model: 'gpt-test' }), ensureAutonomousReviewPolicy(pool, { model: 'gpt-test' })]);
    assert.deepEqual(a, b);
    const c = await ensureAutonomousReviewPolicy(pool, { model: 'gpt-other' });
    assert.notDeepEqual(a, c);
    assert.equal(await tableCount(pool, 'ai_review_policy_configs'), 2);
});
import { prepareCandidateReview } from '../src/modules/ai-review/prepare-candidate-review.js';
import { autonomousClock, reserveRun, type AutonomousRun } from '../src/modules/ai-review/autonomous-review-journal.js';
import { AiReviewProviderError, hashAiReviewRequest, validateAiReviewDecision } from '../src/modules/ai-review/ai-review-provider.js';
import { readAutonomousReviewStatus } from '../src/modules/ai-review/read-autonomous-review-status.js';
async function reserve(pool: Awaited<ReturnType<typeof resetDatabase>>, now = time) {
    const prepared = await prepareCandidateReview(pool, CANDIDATE_IDS.candidateId, CANDIDATE_IDS.candidateRevisionId);
    assert.ok(prepared);
    const run = await reserveRun(pool, prepared, 'gpt-test', autonomousClock(now));
    assert.ok(run);
    return run;
}
async function respond(pool: Awaited<ReturnType<typeof resetDatabase>>, run: AutonomousRun) {
    await pool.query(`update autonomous_ai_review_runs set state='in_flight',in_flight_at=$2 where run_id=$1`, [run.run_id, time]);
    const response = result(run.request);
    await pool.query(`update autonomous_ai_review_runs set state='responded',response=$2::jsonb,provider_response_id=$3,response_hash=$4 where run_id=$1`, [run.run_id, JSON.stringify(response.decision), response.providerResponseId, response.responseHash]);
}
const neverProvider: AiReviewProvider = { async execute() { assert.fail('recovery must not reissue a paid request'); } };
test('reserved recovery calls once in original hour; expired unused reservation holds without call', async (t) => {
    const pool = await resetDatabase();
    t.after(() => pool.end());
    await seed(pool);
    await reserve(pool);
    let calls = 0;
    await processAutonomousReviewTick(pool, { model: 'gpt-test', now: '2026-09-10T10:10:00.000Z', provider: { async execute(request) { calls++; return result(request); } } });
    assert.equal(calls, 1);
    assert.equal(await tableCount(pool, 'publication_versions'), 1);
});
test('expired unused reservation holds and unchanged request is not reserved again', async (t) => {
    const pool = await resetDatabase();
    t.after(() => pool.end());
    await seed(pool);
    await reserve(pool);
    await processAutonomousReviewTick(pool, { provider: neverProvider, model: 'gpt-test', now: '2026-09-10T11:00:00.000Z' });
    assert.deepEqual((await pool.query('select state,failure_code from autonomous_ai_review_runs')).rows, [{ state: 'held', failure_code: 'AI_AUTONOMOUS_RESERVATION_EXPIRED' }]);
});
test('in-flight recovery ages from atomic ownership plus maximum provider timeout grace', async (t) => {
    const pool = await resetDatabase();
    t.after(() => pool.end());
    await seed(pool);
    const run = await reserve(pool);
    await pool.query(`update autonomous_ai_review_runs set state='in_flight',in_flight_at='2026-09-10T10:59:50.000Z' where run_id=$1`, [run.run_id]);
    await processAutonomousReviewTick(pool, { provider: neverProvider, model: 'gpt-test', now: '2026-09-10T11:00:30.000Z' });
    assert.equal((await pool.query('select state from autonomous_ai_review_runs')).rows[0].state, 'in_flight');
    await processAutonomousReviewTick(pool, { provider: neverProvider, model: 'gpt-test', now: '2026-09-10T11:01:00.000Z' });
    assert.equal((await pool.query('select state from autonomous_ai_review_runs')).rows[0].state, 'uncertain');
    assert.equal(await tableCount(pool, 'publication_versions'), 0);
});
test('saved response recovery publishes once without a model call across instances', async (t) => {
    const pool = await resetDatabase();
    t.after(() => pool.end());
    await seed(pool);
    const run = await reserve(pool);
    await respond(pool, run);
    await Promise.all([processAutonomousReviewTick(pool, { provider: neverProvider, model: 'gpt-test', now: time }), processAutonomousReviewTick(pool, { provider: neverProvider, model: 'gpt-test', now: time })]);
    assert.equal(await tableCount(pool, 'publication_versions'), 1);
    assert.equal(await tableCount(pool, 'human_reviews'), 0);
});
test('crash after publication leaves responded run and replays durable publication receipt', async (t) => {
    const pool = await resetDatabase();
    t.after(() => pool.end());
    await seed(pool);
    const run = await reserve(pool);
    await respond(pool, run);
    await pool.query(`create function test_interrupt_published() returns trigger language plpgsql as $$begin if new.state='published' then raise exception 'test publication interruption'; end if;return new;end;$$;create trigger test_interrupt before update on autonomous_ai_review_runs for each row execute function test_interrupt_published()`);
    await assert.rejects(processAutonomousReviewTick(pool, { provider: neverProvider, model: 'gpt-test', now: time }), /test publication interruption/);
    assert.equal(await tableCount(pool, 'publication_versions'), 1);
    assert.equal((await pool.query('select state from autonomous_ai_review_runs')).rows[0].state, 'responded');
    await pool.query('drop trigger test_interrupt on autonomous_ai_review_runs');
    await ensureAutonomousReviewPolicy(pool, { model: 'gpt-other' });
    await processAutonomousReviewTick(pool, { provider: neverProvider, model: 'gpt-test', now: time });
    assert.equal(await tableCount(pool, 'publication_versions'), 1);
    assert.equal((await pool.query('select state from autonomous_ai_review_runs')).rows[0].state, 'published');
});
test('changed policy during provider work persists response but holds without publication', async (t) => {
    const pool = await resetDatabase();
    t.after(() => pool.end());
    await seed(pool);
    await processAutonomousReviewTick(pool, { model: 'gpt-test', now: time, provider: { async execute(request) { await ensureAutonomousReviewPolicy(pool, { model: 'gpt-other' }); return result(request); } } });
    assert.equal(await tableCount(pool, 'publication_versions'), 0);
    assert.equal(await tableCount(pool, 'ai_reviews'), 0);
    const run = (await pool.query('select state,response from autonomous_ai_review_runs')).rows[0];
    assert.equal(run.state, 'held');
    assert.ok(run.response);
});
test('publication identity chosen at reservation is never replaced after concurrent creation', async (t) => {
    const pool = await resetDatabase();
    t.after(() => pool.end());
    await seed(pool);
    await processAutonomousReviewTick(pool, { model: 'gpt-test', now: time, provider: { async execute(request) { await pool.query(`insert into publications(publication_id,candidate_id,created_by) values($1,$2,'operator')`, [randomUUID(), CANDIDATE_IDS.candidateId]); return result(request); } } });
    assert.equal(await tableCount(pool, 'publication_versions'), 0);
    assert.equal((await pool.query('select state from autonomous_ai_review_runs')).rows[0].state, 'held');
});
for (const code of ['AI_REVIEW_PROVIDER_AUTH', 'AI_REVIEW_PROVIDER_RATE_LIMIT', 'AI_REVIEW_PROVIDER_UNCERTAIN'] as const)
    test(`provider ${code} is sanitized and never retried`, async (t) => {
        const pool = await resetDatabase();
        t.after(() => pool.end());
        await seed(pool);
        let calls = 0;
        const provider: AiReviewProvider = { async execute() { calls++; throw new AiReviewProviderError(code); } };
        await processAutonomousReviewTick(pool, { provider, model: 'gpt-test', now: time });
        await processAutonomousReviewTick(pool, { provider, model: 'gpt-test', now: '2026-09-10T11:00:00.000Z' });
        assert.equal(calls, 1);
        assert.equal(await tableCount(pool, 'publication_versions'), 0);
        assert.deepEqual((await pool.query('select state,failure_code from autonomous_ai_review_runs')).rows, [{ state: code === 'AI_REVIEW_PROVIDER_UNCERTAIN' ? 'uncertain' : 'failed', failure_code: code }]);
    });
test('journal rejects request mutation, invalid transitions, response replacement and deletion', async (t) => {
    const pool = await resetDatabase();
    t.after(() => pool.end());
    await seed(pool);
    const run = await reserve(pool);
    await assert.rejects(pool.query(`update autonomous_ai_review_runs set request='{}'::jsonb where run_id=$1`, [run.run_id]), /immutable/);
    await assert.rejects(pool.query(`update autonomous_ai_review_runs set state='responded' where run_id=$1`, [run.run_id]), /invalid transition/);
    await respond(pool, run);
    await assert.rejects(pool.query(`update autonomous_ai_review_runs set state='held',response_hash=$2 where run_id=$1`, [run.run_id, 'a'.repeat(64)]), /response immutable/);
    await assert.rejects(pool.query('delete from autonomous_ai_review_runs where run_id=$1', [run.run_id]), /immutable/);
    assert.equal(await tableCount(pool, 'publication_versions'), 0);
});
test('UTC budget reserves at most four including failures and resets on next day', async (t) => {
    const pool = await resetDatabase();
    t.after(() => pool.end());
    await seed(pool);
    const prepared = await prepareCandidateReview(pool, CANDIDATE_IDS.candidateId, CANDIDATE_IDS.candidateRevisionId);
    assert.ok(prepared);
    // Exercise the durable reservation boundary with distinct prepared identities, not an in-memory provider counter.
    for (let hour = 0; hour < 5; hour++) {
        const request = { ...prepared.request, requiredClaims: prepared.request.requiredClaims.map(claim => ({ ...claim, statement: `Budget fixture ${hour}` })) };
        const candidate = { ...prepared, request, requestHash: hashAiReviewRequest(request) };
        const run = await reserveRun(pool, candidate, 'gpt-test', autonomousClock(`2026-09-10T0${hour}:00:00.000Z`));
        assert.equal(Boolean(run), hour < 4);
    }
    assert.equal(await tableCount(pool, 'autonomous_ai_review_runs'), 4);
    assert.ok(await reserveRun(pool, prepared, 'gpt-test', autonomousClock('2026-09-11T00:00:00.000Z')));
    assert.equal(await tableCount(pool, 'autonomous_ai_review_runs'), 5);
});
test('private readiness reports missing catalog and empty input and returns no prompt or response', async (t) => {
    const pool = await resetDatabase();
    t.after(() => pool.end());
    assert.equal((await readAutonomousReviewStatus(pool, { enabled: false, now: time })).inputState, 'MISSING_ACTIVE_CATALOG');
    await seedActiveCatalog(pool);
    assert.equal((await readAutonomousReviewStatus(pool, { enabled: true, now: time })).inputState, 'EMPTY_CANDIDATE_INPUT');
    assert.equal(await tableCount(pool, 'ai_review_policy_configs'), 0);
});

test('persisted response hash mismatch fails closed during recovery',async t=>{
 const pool=await resetDatabase();t.after(()=>pool.end());await seed(pool);const run=await reserve(pool);
 await pool.query(`update autonomous_ai_review_runs set state='in_flight',in_flight_at=$2 where run_id=$1`,[run.run_id,time]);
 const response=result(run.request);
 await pool.query(`update autonomous_ai_review_runs set state='responded',response=$2::jsonb,provider_response_id=$3,response_hash=$4 where run_id=$1`,[run.run_id,JSON.stringify(response.decision),response.providerResponseId,'a'.repeat(64)]);
 await processAutonomousReviewTick(pool,{provider:neverProvider,model:'gpt-test',now:time});
 assert.equal(await tableCount(pool,'publication_versions'),0);assert.equal(await tableCount(pool,'ai_reviews'),0);
 assert.equal((await pool.query('select state from autonomous_ai_review_runs')).rows[0].state,'held');
});


import { recordCandidateModerationDecision } from '../src/modules/moderation/record-candidate-moderation-decision.js';
import { evaluateCandidateEligibility } from '../src/modules/eligibility/evaluate-candidate-eligibility.js';

async function recordOperatorModeration(pool: Awaited<ReturnType<typeof resetDatabase>>, policyId: string) {
    const decisionId = randomUUID();
    await recordCandidateModerationDecision(pool, {
        actorId: 'operator', candidateId: CANDIDATE_IDS.candidateId,
        candidateRevisionId: CANDIDATE_IDS.candidateRevisionId,
        correlationId: decisionId, idempotencyKey: decisionId, decisionId,
        inputSnapshotId: randomUUID(), moderationPolicyRevisionId: policyId,
        outcome: 'blocked', reason: 'Later operator decision.', evaluatedAt: '2026-09-10T10:01:00.000Z',
    });
    return decisionId;
}

test('a later existing moderation timestamp holds an unused reservation without a paid call', async t => {
    const pool = await resetDatabase(); t.after(() => pool.end()); await seed(pool);
    const policy = await ensureAutonomousReviewPolicy(pool, { model: 'gpt-test' });
    assert.ok(await prepareCandidateReview(pool, CANDIDATE_IDS.candidateId, CANDIDATE_IDS.candidateRevisionId));
    const decisionId = await recordOperatorModeration(pool, policy.moderationPolicyRevisionId);
    await reserve(pool);
    await processAutonomousReviewTick(pool, { provider: neverProvider, model: 'gpt-test', now: time });
    assert.equal((await pool.query('select state from autonomous_ai_review_runs')).rows[0].state, 'held');
    assert.equal((await pool.query('select moderation_decision_id from current_candidate_moderation_decisions')).rows[0].moderation_decision_id, decisionId);
    assert.equal(await tableCount(pool, 'ai_reviews'), 0);
    assert.equal(await tableCount(pool, 'publication_versions'), 0);
});

function afterOwnershipClaim(pool: Awaited<ReturnType<typeof resetDatabase>>, action: () => Promise<void>) {
    let invoked = false;
    return new Proxy(pool, {
        get(target, property) {
            if (property === 'query') {
                return async (...args: unknown[]) => {
                    const reply = await Reflect.apply(target.query, target, args);
                    if (!invoked && typeof args[0] === 'string'
                        && args[0].includes("set state='in_flight',in_flight_at=$2")) {
                        invoked = true;
                        await action();
                    }
                    return reply;
                };
            }
            const value = Reflect.get(target, property) as unknown;
            return typeof value === 'function' ? value.bind(target) : value;
        },
    });
}

test('authority changing after ownership claim holds the run before any provider call', async t => {
    const pool = await resetDatabase(); t.after(() => pool.end()); await seed(pool);
    const run = await reserve(pool);
    let decisionId: string | undefined;
    const interleavedPool = afterOwnershipClaim(pool, async () => {
        decisionId = await recordOperatorModeration(pool, run.moderation_policy_revision_id);
    });
    await processAutonomousReviewTick(interleavedPool, { provider: neverProvider, model: 'gpt-test', now: time });
    assert.ok(decisionId);
    assert.deepEqual((await pool.query('select state,failure_code from autonomous_ai_review_runs')).rows,
        [{ state: 'held', failure_code: 'AI_AUTONOMOUS_INPUT_STALE' }]);
    assert.equal((await pool.query('select moderation_decision_id from current_candidate_moderation_decisions')).rows[0].moderation_decision_id, decisionId);
    assert.equal(await tableCount(pool, 'ai_reviews'), 0);
    assert.equal(await tableCount(pool, 'publication_versions'), 0);
});

test('crossing the UTC hour after ownership claim holds without a delayed paid call', async t => {
    const pool = await resetDatabase(); t.after(() => pool.end()); await seed(pool);
    await reserve(pool, '2026-09-10T10:59:59.000Z');
    t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-09-10T10:59:59.000Z') });
    const interleavedPool = afterOwnershipClaim(pool, async () => {
        t.mock.timers.setTime(Date.parse('2026-09-10T11:00:00.000Z'));
    });
    let calls = 0;
    await processAutonomousReviewTick(interleavedPool, {
        model: 'gpt-test',
        provider: { async execute(request) { calls++; return result(request); } },
    });
    assert.equal(calls, 0);
    assert.deepEqual((await pool.query('select state,failure_code from autonomous_ai_review_runs')).rows,
        [{ state: 'held', failure_code: 'AI_AUTONOMOUS_RESERVATION_EXPIRED' }]);
    assert.equal(await tableCount(pool, 'publication_versions'), 0);
});

test('response recovery holds after a later eligibility evaluation without overwriting its pointer', async t => {
    const pool = await resetDatabase(); t.after(() => pool.end()); await seed(pool);
    const run = await reserve(pool); await respond(pool, run);
    const evaluationId = randomUUID();
    await evaluateCandidateEligibility(pool, {
        actorId: 'operator', candidateId: run.candidate_id, candidateRevisionId: run.candidate_revision_id,
        correlationId: evaluationId, idempotencyKey: evaluationId, evaluationId, inputSnapshotId: randomUUID(),
        evaluatedAt: '2026-09-10T10:01:00.000Z',
    });
    await processAutonomousReviewTick(pool, { provider: neverProvider, model: 'gpt-test', now: time });
    assert.equal((await pool.query('select state from autonomous_ai_review_runs')).rows[0].state, 'held');
    assert.equal((await pool.query('select candidate_eligibility_evaluation_id from current_candidate_eligibility_evaluations')).rows[0].candidate_eligibility_evaluation_id, evaluationId);
    assert.equal(await tableCount(pool, 'publication_versions'), 0);
});

test('moderation pointer CAS rejects an autonomous decision after operator authority changes', async t => {
    const pool = await resetDatabase(); t.after(() => pool.end()); await seed(pool);
    const run = await reserve(pool); await respond(pool, run);
    const decisionId = await recordOperatorModeration(pool, run.moderation_policy_revision_id);
    await assert.rejects(recordCandidateModerationDecision(pool, {
        actorId: 'system:ai-reviewer', candidateId: run.candidate_id, candidateRevisionId: run.candidate_revision_id,
        correlationId: run.run_id, idempotencyKey: run.run_id, decisionId: run.chosen_moderation_decision_id,
        inputSnapshotId: randomUUID(), moderationPolicyRevisionId: run.moderation_policy_revision_id,
        outcome: 'clear', reason: 'Stale autonomous command.', evaluatedAt: run.started_at.toISOString(),
    }), /AI_AUTONOMOUS_AUTHORITY_CHANGED/);
    assert.equal((await pool.query('select moderation_decision_id from current_candidate_moderation_decisions')).rows[0].moderation_decision_id, decisionId);
    assert.equal(await tableCount(pool, 'moderation_decisions'), 1);
    assert.equal(await tableCount(pool, 'publication_versions'), 0);
});
