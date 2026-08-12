import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import {
  registerNormalizedObservation,
} from '../src/modules/candidate/register-normalized-observation.js';
import {
  recordCandidateModerationDecision,
} from '../src/modules/moderation/record-candidate-moderation-decision.js';
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
  seedModerationContext,
} from './helpers/gate.js';

async function appendCurrentCandidateProvenance(
  pool: Awaited<ReturnType<typeof resetDatabase>>,
): Promise<void> {
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
}

test('Moderation command appends an immutable clear decision and current pointer', async () => {
  const pool = await resetDatabase();
  await seedModerationContext(pool);

  const result = await recordCandidateModerationDecision(
    pool,
    moderationDecisionCommand(),
  );

  assert.equal(result.candidateRevisionId, CANDIDATE_IDS.candidateRevisionId);
  assert.equal(result.decisionId, GATE_IDS.moderationDecisionId);
  assert.equal(result.outcome, 'clear');
  assert.equal(result.replayed, false);
  assert.match(result.inputHash, /^[a-f0-9]{64}$/);
  assert.equal(await tableCount(pool, 'moderation_input_snapshots'), 1);
  assert.equal(
    await tableCount(pool, 'moderation_input_snapshot_provenance'),
    1,
  );
  assert.equal(await tableCount(pool, 'moderation_decisions'), 1);
  assert.equal(
    await tableCount(pool, 'current_candidate_moderation_decisions'),
    1,
  );
  const current = await pool.query<{
    moderation_decision_id: string;
  }>(
    `select moderation_decision_id
       from current_candidate_moderation_decisions
      where candidate_revision_id = $1
        and moderation_policy_revision_id = $2`,
    [
      CANDIDATE_IDS.candidateRevisionId,
      GATE_IDS.moderationPolicyId,
    ],
  );
  assert.equal(
    current.rows[0]?.moderation_decision_id,
    GATE_IDS.moderationDecisionId,
  );
  await pool.end();
});

test('Moderation command preserves needs_review as an explicit outcome', async () => {
  const pool = await resetDatabase();
  await seedModerationContext(pool);

  const result = await recordCandidateModerationDecision(
    pool,
    moderationDecisionCommand({
      outcome: 'needs_review',
      reason: 'Candidate requires another Moderation pass.',
    }),
  );

  assert.equal(result.outcome, 'needs_review');
  const stored = await pool.query<{ outcome: string }>(
    `select outcome
       from moderation_decisions
      where moderation_decision_id = $1`,
    [GATE_IDS.moderationDecisionId],
  );
  assert.equal(stored.rows[0]?.outcome, 'needs_review');
  await pool.end();
});

test('Moderation command preserves blocked as an explicit outcome', async () => {
  const pool = await resetDatabase();
  await seedModerationContext(pool);

  const result = await recordCandidateModerationDecision(
    pool,
    moderationDecisionCommand({
      outcome: 'blocked',
      reason: 'Candidate violates the pinned Moderation policy.',
    }),
  );

  assert.equal(result.outcome, 'blocked');
  const stored = await pool.query<{ outcome: string }>(
    `select outcome
       from moderation_decisions
      where moderation_decision_id = $1`,
    [GATE_IDS.moderationDecisionId],
  );
  assert.equal(stored.rows[0]?.outcome, 'blocked');
  await pool.end();
});

test('Moderation replay returns the recorded result without duplicate effects', async () => {
  const pool = await resetDatabase();
  await seedModerationContext(pool);
  const first = await recordCandidateModerationDecision(
    pool,
    moderationDecisionCommand(),
  );
  const replay = await recordCandidateModerationDecision(
    pool,
    moderationDecisionCommand(),
  );

  assert.deepEqual(replay, { ...first, replayed: true });
  assert.equal(await tableCount(pool, 'moderation_input_snapshots'), 1);
  assert.equal(await tableCount(pool, 'moderation_decisions'), 1);
  const outbox = await pool.query<{ count: string }>(
    `select count(*)
       from outbox_events
      where event_type = 'ModerationDecisionRecorded'`,
  );
  assert.equal(outbox.rows[0]?.count, '1');
  await pool.end();
});

test('Moderation idempotency rejects a changed decision payload', async () => {
  const pool = await resetDatabase();
  await seedModerationContext(pool);
  await recordCandidateModerationDecision(
    pool,
    moderationDecisionCommand(),
  );

  await assert.rejects(
    recordCandidateModerationDecision(
      pool,
      moderationDecisionCommand({ outcome: 'blocked' }),
    ),
    /IDEMPOTENCY_PAYLOAD_CONFLICT/,
  );
  assert.equal(await tableCount(pool, 'moderation_decisions'), 1);
  await pool.end();
});

test('new Candidate provenance creates a new Moderation snapshot without changing history', async () => {
  const pool = await resetDatabase();
  await seedModerationContext(pool);
  const first = await recordCandidateModerationDecision(
    pool,
    moderationDecisionCommand(),
  );
  await appendCurrentCandidateProvenance(pool);

  const second = await recordCandidateModerationDecision(
    pool,
    moderationDecisionCommand({
      correlationId: 'moderation-decision-v2',
      decisionId: GATE_IDS.secondModerationDecisionId,
      idempotencyKey: 'moderation-decision-v2',
      inputSnapshotId: GATE_IDS.secondModerationInputSnapshotId,
      outcome: 'blocked',
      reason: 'New provenance requires a blocked decision.',
    }),
  );

  assert.notEqual(first.inputHash, second.inputHash);
  assert.equal(await tableCount(pool, 'moderation_input_snapshots'), 2);
  assert.equal(
    await tableCount(pool, 'moderation_input_snapshot_provenance'),
    3,
  );
  assert.equal(await tableCount(pool, 'moderation_decisions'), 2);
  const current = await pool.query<{
    moderation_decision_id: string;
  }>(
    `select moderation_decision_id
       from current_candidate_moderation_decisions`,
  );
  assert.equal(
    current.rows[0]?.moderation_decision_id,
    GATE_IDS.secondModerationDecisionId,
  );
  await pool.end();
});

test('equal-time Moderation pointer cannot roll back to an older sequence', async () => {
  const pool = await resetDatabase();
  await seedModerationContext(pool);
  await recordCandidateModerationDecision(
    pool,
    moderationDecisionCommand(),
  );
  await recordCandidateModerationDecision(
    pool,
    moderationDecisionCommand({
      correlationId: 'moderation-equal-time-v2',
      decisionId: GATE_IDS.secondModerationDecisionId,
      idempotencyKey: 'moderation-equal-time-v2',
      inputSnapshotId: GATE_IDS.secondModerationInputSnapshotId,
      outcome: 'blocked',
    }),
  );

  await assert.rejects(
    pool.query(
      `update current_candidate_moderation_decisions
          set moderation_decision_id = $2,
              updated_at = clock_timestamp()
        where moderation_decision_id = $1`,
      [
        GATE_IDS.secondModerationDecisionId,
        GATE_IDS.moderationDecisionId,
      ],
    ),
    /current moderation decision cannot move backward/,
  );
  await pool.end();
});

test('Moderation current pointer cannot cross CandidateRevision identity', async () => {
  const pool = await resetDatabase();
  await seedModerationContext(pool);
  await recordCandidateModerationDecision(
    pool,
    moderationDecisionCommand(),
  );

  await assert.rejects(
    pool.query(
      `insert into current_candidate_moderation_decisions
        (candidate_revision_id, moderation_policy_revision_id,
         candidate_id, moderation_decision_id)
       values ($1, $2, $3, $4)`,
      [
        randomUUID(),
        GATE_IDS.moderationPolicyId,
        CANDIDATE_IDS.candidateId,
        GATE_IDS.moderationDecisionId,
      ],
    ),
    /moderation|foreign key|violates/,
  );
  await pool.end();
});

test('late audit failure rolls back Moderation graph and idempotency', async () => {
  const pool = await resetDatabase();
  await seedModerationContext(pool);
  await pool.query(`
    create function reject_moderation_audit()
    returns trigger
    language plpgsql
    as $$
    begin
      if new.action = 'moderation.decision_recorded' then
        raise exception 'injected Moderation audit failure';
      end if;
      return new;
    end;
    $$;
    create trigger reject_moderation_audit
    before insert on audit_events
    for each row execute function reject_moderation_audit();
  `);

  await assert.rejects(
    recordCandidateModerationDecision(
      pool,
      moderationDecisionCommand(),
    ),
    /injected Moderation audit failure/,
  );
  assert.equal(await tableCount(pool, 'moderation_input_snapshots'), 0);
  assert.equal(await tableCount(pool, 'moderation_decisions'), 0);
  assert.equal(
    await tableCount(pool, 'current_candidate_moderation_decisions'),
    0,
  );
  const idempotency = await pool.query<{ count: string }>(
    `select count(*)
       from idempotency_records
      where scope = 'moderation_decision'`,
  );
  assert.equal(idempotency.rows[0]?.count, '0');
  await pool.end();
});
