import assert from 'node:assert/strict';
import test from 'node:test';

import {
  evaluateCandidateEligibility,
} from '../src/modules/eligibility/evaluate-candidate-eligibility.js';
import type {
  EvaluateCandidateEligibilityCommand,
} from '../src/modules/eligibility/evaluate-candidate-eligibility.js';
import {
  readCandidateEligibilityStatus,
} from '../src/modules/eligibility/read-candidate-eligibility-status.js';
import {
  recordCandidateModerationDecision,
} from '../src/modules/moderation/record-candidate-moderation-decision.js';
import {
  recordClaimEvidenceDecision,
} from '../src/modules/trust/record-claim-evidence-decision.js';
import {
  registerNormalizedObservation,
} from '../src/modules/candidate/register-normalized-observation.js';
import {
  CANDIDATE_IDS,
  registrationCommand,
  seedRawObservation,
  validNormalizationSnapshot,
} from './helpers/candidate.js';
import { resetDatabase, tableCount } from './helpers/database.js';
import {
  GATE_IDS,
  moderationDecisionCommand,
  seedActivatedGateContext,
  seedModerationContext,
  seedSatisfiedReviewQuorum,
} from './helpers/gate.js';
import {
  TRUST_IDS,
  evidenceDecisionCommand,
} from './helpers/trust.js';

function evaluationCommand(
  overrides: Partial<EvaluateCandidateEligibilityCommand> = {},
): EvaluateCandidateEligibilityCommand {
  return {
    actorId: 'eligibility-evaluator',
    candidateId: CANDIDATE_IDS.candidateId,
    candidateRevisionId: CANDIDATE_IDS.candidateRevisionId,
    correlationId: 'eligibility-evaluation-v1',
    evaluatedAt: '2026-07-28T12:00:00.000Z',
    evaluationId: GATE_IDS.eligibilityEvaluationId,
    idempotencyKey: 'eligibility-evaluation-v1',
    inputSnapshotId: GATE_IDS.eligibilityInputSnapshotId,
    ...overrides,
  };
}

async function seedEligibleInputs(
  pool: Awaited<ReturnType<typeof resetDatabase>>,
): Promise<void> {
  await seedActivatedGateContext(pool);
  await recordCandidateModerationDecision(
    pool,
    moderationDecisionCommand(),
  );
  await seedSatisfiedReviewQuorum(pool);
}

test('Eligibility read fails closed before an active policy exists', async () => {
  const pool = await resetDatabase();
  await seedModerationContext(pool);

  const status = await readCandidateEligibilityStatus(
    pool,
    CANDIDATE_IDS.candidateId,
    CANDIDATE_IDS.candidateRevisionId,
  );

  assert.deepEqual(status, {
    activeEligibilityPolicyRevisionId: null,
    candidateRevisionId: CANDIDATE_IDS.candidateRevisionId,
    currentEvaluationId: null,
    outcome: 'needs_review',
    reasons: ['moderation_missing'],
    stale: true,
  });
  await pool.end();
});

test('Eligibility persists eligible only for fresh clear supported quorum inputs', async () => {
  const pool = await resetDatabase();
  await seedEligibleInputs(pool);

  const result = await evaluateCandidateEligibility(
    pool,
    evaluationCommand(),
  );

  assert.equal(result.outcome, 'eligible');
  assert.deepEqual(result.reasons, ['all_requirements_satisfied']);
  assert.equal(result.replayed, false);
  assert.match(result.inputHash, /^[a-f0-9]{64}$/);
  assert.equal(await tableCount(pool, 'eligibility_input_snapshots'), 1);
  assert.equal(
    await tableCount(pool, 'eligibility_input_snapshot_required_claims'),
    1,
  );
  assert.equal(
    await tableCount(pool, 'candidate_eligibility_evaluations'),
    1,
  );
  assert.equal(
    await tableCount(pool, 'current_candidate_eligibility_evaluations'),
    1,
  );

  const status = await readCandidateEligibilityStatus(
    pool,
    CANDIDATE_IDS.candidateId,
    CANDIDATE_IDS.candidateRevisionId,
  );
  assert.deepEqual(status, {
    activeEligibilityPolicyRevisionId: GATE_IDS.eligibilityPolicyId,
    candidateRevisionId: CANDIDATE_IDS.candidateRevisionId,
    currentEvaluationId: GATE_IDS.eligibilityEvaluationId,
    outcome: 'eligible',
    reasons: ['all_requirements_satisfied'],
    stale: false,
  });
  await pool.end();
});

test('Eligibility blocked Moderation takes precedence over missing Review', async () => {
  const pool = await resetDatabase();
  await seedActivatedGateContext(pool);
  await recordCandidateModerationDecision(
    pool,
    moderationDecisionCommand({ outcome: 'blocked' }),
  );

  const result = await evaluateCandidateEligibility(
    pool,
    evaluationCommand(),
  );

  assert.equal(result.outcome, 'ineligible');
  assert.deepEqual(result.reasons, ['moderation_blocked']);
  await pool.end();
});

test('Eligibility required contradiction takes precedence over missing Moderation', async () => {
  const pool = await resetDatabase();
  await seedActivatedGateContext(pool);
  const contradictoryRawObservationId =
    '76000000-0000-4000-8000-000000000030';
  const contradictoryNormalizedObservationId =
    '76000000-0000-4000-8000-000000000031';
  await seedRawObservation(pool, contradictoryRawObservationId);
  await registerNormalizedObservation(pool, registrationCommand({
    candidateId: CANDIDATE_IDS.candidateId,
    candidateRevisionId: CANDIDATE_IDS.candidateRevisionId,
    normalizedObservationId:
      contradictoryNormalizedObservationId,
    provenanceId: '76000000-0000-4000-8000-000000000032',
    rawObservationId: contradictoryRawObservationId,
    snapshot: validNormalizationSnapshot('editorial'),
  }));
  await recordClaimEvidenceDecision(pool, evidenceDecisionCommand({
    associations: [{
      associationId: TRUST_IDS.alternateAssociationId,
      crossPatchRevalidated: false,
      evidenceId: TRUST_IDS.alternateEvidenceId,
      normalizedObservationId:
        contradictoryNormalizedObservationId,
      revalidationReason: null,
      stance: 'contradicts',
    }],
    correlationId: 'eligibility-required-contradiction',
    decision: 'contradicted',
    decisionId: TRUST_IDS.secondEvidenceDecisionId,
    evidenceInputSnapshotId: TRUST_IDS.secondEvidenceInputSnapshotId,
    idempotencyKey: 'eligibility-required-contradiction',
    reason: 'The required Claim is contradicted.',
  }));

  const result = await evaluateCandidateEligibility(
    pool,
    evaluationCommand(),
  );

  assert.equal(result.outcome, 'ineligible');
  assert.deepEqual(result.reasons, ['required_claim_contradicted']);
  await pool.end();
});

test('Eligibility replay is side-effect free and payload changes conflict', async () => {
  const pool = await resetDatabase();
  await seedEligibleInputs(pool);
  const command = evaluationCommand();
  const first = await evaluateCandidateEligibility(pool, command);
  const replay = await evaluateCandidateEligibility(pool, command);

  assert.deepEqual(replay, { ...first, replayed: true });
  assert.equal(
    await tableCount(pool, 'candidate_eligibility_evaluations'),
    1,
  );
  await assert.rejects(
    evaluateCandidateEligibility(
      pool,
      evaluationCommand({ evaluatedAt: '2026-07-28T12:01:00.000Z' }),
    ),
    /IDEMPOTENCY_PAYLOAD_CONFLICT/,
  );
  await pool.end();
});

test('Eligibility read immediately fails closed after required Evidence changes', async () => {
  const pool = await resetDatabase();
  await seedEligibleInputs(pool);
  await evaluateCandidateEligibility(pool, evaluationCommand());
  await recordClaimEvidenceDecision(pool, evidenceDecisionCommand({
    associations: [],
    correlationId: 'eligibility-stale-evidence',
    decision: 'insufficient',
    decisionId: TRUST_IDS.secondEvidenceDecisionId,
    evidenceInputSnapshotId: TRUST_IDS.secondEvidenceInputSnapshotId,
    idempotencyKey: 'eligibility-stale-evidence',
    reason: 'New Evidence is insufficient.',
  }));

  const status = await readCandidateEligibilityStatus(
    pool,
    CANDIDATE_IDS.candidateId,
    CANDIDATE_IDS.candidateRevisionId,
  );

  assert.equal(status.outcome, 'needs_review');
  assert.equal(status.stale, true);
  assert.equal(
    status.currentEvaluationId,
    GATE_IDS.eligibilityEvaluationId,
  );
  assert.ok(status.reasons.includes('required_claim_insufficient'));
  assert.ok(status.reasons.includes('review_quorum_stale'));
  await pool.end();
});

test('Eligibility read immediately fails closed after provenance changes', async () => {
  const pool = await resetDatabase();
  await seedEligibleInputs(pool);
  await evaluateCandidateEligibility(pool, evaluationCommand());
  const rawObservationId =
    '76000000-0000-4000-8000-000000000020';
  await seedRawObservation(pool, rawObservationId);
  await registerNormalizedObservation(pool, registrationCommand({
    candidateId: CANDIDATE_IDS.candidateId,
    candidateRevisionId: CANDIDATE_IDS.candidateRevisionId,
    normalizedObservationId:
      '76000000-0000-4000-8000-000000000021',
    provenanceId: '76000000-0000-4000-8000-000000000022',
    rawObservationId,
    snapshot: validNormalizationSnapshot('editorial'),
  }));

  const status = await readCandidateEligibilityStatus(
    pool,
    CANDIDATE_IDS.candidateId,
    CANDIDATE_IDS.candidateRevisionId,
  );

  assert.equal(status.outcome, 'needs_review');
  assert.equal(status.stale, true);
  assert.ok(status.reasons.includes('moderation_stale'));
  assert.ok(status.reasons.includes('review_quorum_stale'));
  await pool.end();
});

test('late audit failure rolls back Eligibility graph and idempotency', async () => {
  const pool = await resetDatabase();
  await seedEligibleInputs(pool);
  await pool.query(`
    create function reject_eligibility_audit()
    returns trigger
    language plpgsql
    as $$
    begin
      if new.action = 'gate.candidate_eligibility_evaluated' then
        raise exception 'injected Eligibility audit failure';
      end if;
      return new;
    end;
    $$;
    create trigger reject_eligibility_audit
    before insert on audit_events
    for each row execute function reject_eligibility_audit();
  `);

  await assert.rejects(
    evaluateCandidateEligibility(pool, evaluationCommand()),
    /injected Eligibility audit failure/,
  );
  assert.equal(await tableCount(pool, 'eligibility_input_snapshots'), 0);
  assert.equal(
    await tableCount(pool, 'candidate_eligibility_evaluations'),
    0,
  );
  const idempotency = await pool.query<{ count: string }>(
    `select count(*)
       from idempotency_records
      where scope = 'candidate_eligibility_evaluation'`,
  );
  assert.equal(idempotency.rows[0]?.count, '0');
  await pool.end();
});
