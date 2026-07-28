import assert from 'node:assert/strict';
import test from 'node:test';

import {
  recordClaimEvidenceDecision,
} from '../src/modules/trust/record-claim-evidence-decision.js';
import { resetDatabase, tableCount } from './helpers/database.js';
import {
  TRUST_IDS,
  evidenceDecisionCommand,
  seedSecondTrustCandidate,
  seedTrustClaimSet,
} from './helpers/trust.js';

async function evidenceCounts(
  pool: Awaited<ReturnType<typeof resetDatabase>>,
) {
  const audit = await pool.query<{ count: string }>(
    `select count(*)
       from audit_events
      where action = 'evidence.claim_decision_recorded'`,
  );
  const outbox = await pool.query<{ count: string }>(
    `select count(*)
       from outbox_events
      where event_type = 'ClaimEvidenceDecisionRecorded'`,
  );
  const idempotency = await pool.query<{ count: string }>(
    `select count(*)
       from idempotency_records
      where scope = 'claim_evidence_decision'`,
  );
  return {
    associations: await tableCount(pool, 'evidence_associations'),
    audit: Number(audit.rows[0]?.count ?? 0),
    current: await tableCount(pool, 'current_claim_evidence_decisions'),
    decisions: await tableCount(pool, 'claim_evidence_decisions'),
    evidence: await tableCount(pool, 'evidence_records'),
    idempotency: Number(idempotency.rows[0]?.count ?? 0),
    outbox: Number(outbox.rows[0]?.count ?? 0),
    snapshotMembers: await tableCount(
      pool,
      'evidence_input_snapshot_associations',
    ),
    snapshots: await tableCount(pool, 'evidence_input_snapshots'),
  };
}

test('supported decision writes one complete Claim-level graph', async () => {
  const pool = await resetDatabase();
  await seedTrustClaimSet(pool);

  const result = await recordClaimEvidenceDecision(
    pool,
    evidenceDecisionCommand(),
  );

  assert.equal(result.decision, 'supported');
  assert.equal(result.claimId, TRUST_IDS.requiredClaimId);
  assert.equal(result.replayed, false);
  assert.match(result.inputHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(await evidenceCounts(pool), {
    associations: 1,
    audit: 1,
    current: 1,
    decisions: 1,
    evidence: 1,
    idempotency: 1,
    outbox: 1,
    snapshotMembers: 1,
    snapshots: 1,
  });
  await pool.end();
});

test('two Claims keep independent current Evidence decisions', async () => {
  const pool = await resetDatabase();
  await seedTrustClaimSet(pool);
  await recordClaimEvidenceDecision(pool, evidenceDecisionCommand());
  await recordClaimEvidenceDecision(pool, evidenceDecisionCommand({
    associations: [],
    claimId: TRUST_IDS.supportingClaimId,
    correlationId: 'evidence-decision-2',
    decision: 'insufficient',
    decisionId: TRUST_IDS.secondEvidenceDecisionId,
    evidenceInputSnapshotId: TRUST_IDS.secondEvidenceInputSnapshotId,
    idempotencyKey: 'evidence-decision-2',
    reason: 'No authoritative Evidence is associated yet.',
  }));

  const current = await pool.query<{
    claim_key: string;
    decision: string;
  }>(
    `select claim.claim_key,
            decision.decision
       from current_claim_evidence_decisions current
       join candidate_claims claim on claim.claim_id = current.claim_id
       join claim_evidence_decisions decision
         on decision.claim_evidence_decision_id =
            current.claim_evidence_decision_id
      order by claim.claim_key collate "C"`,
  );
  assert.deepEqual(
    current.rows.map((row) => [row.claim_key, row.decision]),
    [
      ['build-core', 'supported'],
      ['context-note', 'insufficient'],
    ],
  );
  await pool.end();
});

test('decision outcome enforces its minimum Evidence stance', async () => {
  const pool = await resetDatabase();
  await seedTrustClaimSet(pool);

  await assert.rejects(
    recordClaimEvidenceDecision(pool, evidenceDecisionCommand({
      associations: [],
    })),
    /EVIDENCE_DECISION_INPUT_INVALID/,
  );
  await assert.rejects(
    recordClaimEvidenceDecision(pool, evidenceDecisionCommand({
      decision: 'contradicted',
    })),
    /EVIDENCE_DECISION_INPUT_INVALID/,
  );
  assert.deepEqual(await evidenceCounts(pool), {
    associations: 0,
    audit: 0,
    current: 0,
    decisions: 0,
    evidence: 0,
    idempotency: 0,
    outbox: 0,
    snapshotMembers: 0,
    snapshots: 0,
  });
  await pool.end();
});

test('empty insufficient decision persists explicit history without Evidence', async () => {
  const pool = await resetDatabase();
  await seedTrustClaimSet(pool);

  const result = await recordClaimEvidenceDecision(
    pool,
    evidenceDecisionCommand({
      associations: [],
      decision: 'insufficient',
      reason: 'No qualifying Evidence is available.',
    }),
  );

  assert.equal(result.decision, 'insufficient');
  assert.deepEqual(await evidenceCounts(pool), {
    associations: 0,
    audit: 1,
    current: 1,
    decisions: 1,
    evidence: 0,
    idempotency: 1,
    outbox: 1,
    snapshotMembers: 0,
    snapshots: 1,
  });
  await pool.end();
});

test('lost acknowledgement replay creates no duplicate Evidence effects', async () => {
  const pool = await resetDatabase();
  await seedTrustClaimSet(pool);
  const command = evidenceDecisionCommand();
  const first = await recordClaimEvidenceDecision(pool, command);
  const before = await evidenceCounts(pool);

  const replay = await recordClaimEvidenceDecision(pool, command);

  assert.equal(replay.replayed, true);
  assert.equal(replay.decisionId, first.decisionId);
  assert.equal(replay.inputHash, first.inputHash);
  assert.deepEqual(await evidenceCounts(pool), before);
  await pool.end();
});

test('re-evaluation appends history and superseded input cannot roll back', async () => {
  const pool = await resetDatabase();
  await seedTrustClaimSet(pool);
  await recordClaimEvidenceDecision(pool, evidenceDecisionCommand());
  await recordClaimEvidenceDecision(pool, evidenceDecisionCommand({
    associations: [],
    correlationId: 'evidence-reevaluation',
    decision: 'insufficient',
    decisionId: TRUST_IDS.reevaluationDecisionId,
    evaluatedAt: '2026-07-28T03:00:00.000Z',
    evidenceInputSnapshotId: TRUST_IDS.reevaluationInputSnapshotId,
    idempotencyKey: 'evidence-reevaluation',
    reason: 'Current evaluation no longer has qualifying Evidence input.',
  }));

  await assert.rejects(
    recordClaimEvidenceDecision(pool, evidenceDecisionCommand({
      correlationId: 'evidence-old-input-replay',
      decisionId: '73000000-0000-4000-8000-000000000020',
      evaluatedAt: '2026-07-28T04:00:00.000Z',
      evidenceInputSnapshotId:
        '73000000-0000-4000-8000-000000000021',
      idempotencyKey: 'evidence-old-input-replay',
    })),
    /EVIDENCE_DECISION_INPUT_SUPERSEDED/,
  );
  const current = await pool.query<{ decision: string }>(
    `select decision.decision
       from current_claim_evidence_decisions current
       join claim_evidence_decisions decision
         on decision.claim_evidence_decision_id =
            current.claim_evidence_decision_id
      where current.claim_id = $1`,
    [TRUST_IDS.requiredClaimId],
  );
  assert.equal(current.rows[0]?.decision, 'insufficient');
  assert.equal(await tableCount(pool, 'claim_evidence_decisions'), 2);
  await pool.end();
});

test('one NormalizedObservation converges to one Evidence record', async () => {
  const pool = await resetDatabase();
  await seedTrustClaimSet(pool);
  await recordClaimEvidenceDecision(pool, evidenceDecisionCommand());
  await recordClaimEvidenceDecision(pool, evidenceDecisionCommand({
    associations: [
      {
        associationId: TRUST_IDS.secondEvidenceAssociationId,
        crossPatchRevalidated: false,
        evidenceId: TRUST_IDS.evidenceId,
        normalizedObservationId:
          evidenceDecisionCommand().associations[0]!.normalizedObservationId,
        revalidationReason: null,
        stance: 'supports',
      },
    ],
    claimId: TRUST_IDS.supportingClaimId,
    correlationId: 'evidence-convergence',
    decisionId: TRUST_IDS.secondEvidenceDecisionId,
    evidenceInputSnapshotId: TRUST_IDS.secondEvidenceInputSnapshotId,
    idempotencyKey: 'evidence-convergence',
  }));

  assert.equal(await tableCount(pool, 'evidence_records'), 1);
  assert.equal(await tableCount(pool, 'evidence_associations'), 2);
  assert.equal(await tableCount(pool, 'claim_evidence_decisions'), 2);
  await pool.end();
});

test('late Decision identity conflict rolls back new Evidence graph', async () => {
  const pool = await resetDatabase();
  await seedTrustClaimSet(pool);
  await recordClaimEvidenceDecision(pool, evidenceDecisionCommand());
  await seedSecondTrustCandidate(pool);
  const before = await evidenceCounts(pool);

  await assert.rejects(
    recordClaimEvidenceDecision(pool, evidenceDecisionCommand({
      associations: [
        {
          associationId: TRUST_IDS.alternateAssociationId,
          crossPatchRevalidated: false,
          evidenceId: TRUST_IDS.alternateEvidenceId,
          normalizedObservationId:
            TRUST_IDS.secondNormalizedObservationId,
          revalidationReason: null,
          stance: 'supports',
        },
      ],
      claimId: TRUST_IDS.supportingClaimId,
      correlationId: 'evidence-late-conflict',
      decisionId: TRUST_IDS.evidenceDecisionId,
      evidenceInputSnapshotId:
        '73000000-0000-4000-8000-000000000022',
      idempotencyKey: 'evidence-late-conflict',
    })),
    /claim_evidence_decisions_pkey/,
  );
  assert.deepEqual(await evidenceCounts(pool), before);
  await pool.end();
});
