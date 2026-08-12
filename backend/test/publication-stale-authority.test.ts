import assert from 'node:assert/strict';
import test from 'node:test';

import { Pool } from 'pg';

import {
  registerNormalizedObservation,
} from '../src/modules/candidate/register-normalized-observation.js';
import {
  recordCandidateModerationDecision,
} from '../src/modules/moderation/record-candidate-moderation-decision.js';
import { resetDatabase, tableCount } from './helpers/database.js';
import {
  registrationCommand,
  seedRawObservation,
} from './helpers/candidate.js';
import {
  GATE_IDS,
  moderationDecisionCommand,
} from './helpers/gate.js';
import {
  insertDirectPublicationGraph,
  seedEligiblePublicationContext,
} from './helpers/publication.js';

const STALE_IDS = {
  rawObservationId: '7b100000-0000-4000-8000-000000000001',
  normalizedObservationId: '7b100000-0000-4000-8000-000000000002',
  unusedCandidateId: '7b100000-0000-4000-8000-000000000003',
  unusedCandidateRevisionId: '7b100000-0000-4000-8000-000000000004',
  provenanceId: '7b100000-0000-4000-8000-000000000005',
} as const;

function databaseUrl(): string {
  const value = process.env.TEST_DATABASE_URL;
  if (!value) {
    throw new Error('TEST_DATABASE_URL is required');
  }
  return value;
}

function boundedPool(): Pool {
  return new Pool({
    application_name: 'hai-dau-publication-authority-race',
    connectionString: databaseUrl(),
    max: 1,
    options: '-c lock_timeout=1000 -c statement_timeout=5000',
  });
}

async function assertPublicationGraphAbsent(
  pool: Awaited<ReturnType<typeof resetDatabase>>,
): Promise<void> {
  assert.equal(await tableCount(pool, 'publications'), 0);
  assert.equal(await tableCount(pool, 'publication_versions'), 0);
  assert.equal(await tableCount(pool, 'publication_activation_history'), 0);
  assert.equal(await tableCount(pool, 'active_publication_versions'), 0);
}

test('PostgreSQL rejects Publication after provenance makes the pinned Eligibility input stale', async () => {
  const pool = await resetDatabase();
  await seedEligiblePublicationContext(pool);
  await seedRawObservation(pool, STALE_IDS.rawObservationId);
  const registration = await registerNormalizedObservation(
    pool,
    registrationCommand({
      actorId: 'publication-stale-provenance',
      candidateId: STALE_IDS.unusedCandidateId,
      candidateRevisionId: STALE_IDS.unusedCandidateRevisionId,
      correlationId: 'publication-stale-provenance',
      normalizedObservationId: STALE_IDS.normalizedObservationId,
      provenanceId: STALE_IDS.provenanceId,
      rawObservationId: STALE_IDS.rawObservationId,
    }),
  );
  assert.equal(registration.provenanceAdded, true);
  assert.equal(registration.candidateCreated, false);
  assert.equal(registration.candidateRevisionCreated, false);

  const client = await pool.connect();
  let transactionOpen = false;
  try {
    await client.query('begin');
    transactionOpen = true;
    await insertDirectPublicationGraph(client);
    const commit = client.query('commit').finally(() => {
      transactionOpen = false;
    });
    await assert.rejects(commit, /publication input stale/);
  } finally {
    if (transactionOpen) {
      await client.query('rollback');
    }
    client.release();
    await assertPublicationGraphAbsent(pool);
    await pool.end();
  }
});

test('Publication transaction serializes a concurrent Moderation supersede without deadlock', async () => {
  const pool = await resetDatabase();
  await seedEligiblePublicationContext(pool);
  const publicationClient = await pool.connect();
  const moderationPool = boundedPool();
  let transactionOpen = false;
  const command = moderationDecisionCommand({
    actorId: 'publication-concurrent-moderator',
    correlationId: 'publication-concurrent-block',
    decisionId: GATE_IDS.secondModerationDecisionId,
    evaluatedAt: '2026-07-30T03:00:00.000Z',
    idempotencyKey: 'publication-concurrent-block',
    inputSnapshotId: GATE_IDS.secondModerationInputSnapshotId,
    outcome: 'blocked',
    reason: 'Moderation supersede serialized behind Publication authority.',
  });

  try {
    await publicationClient.query('begin');
    transactionOpen = true;
    await publicationClient.query(
      `set local lock_timeout = '3s';
       set local statement_timeout = '15s'`,
    );
    await insertDirectPublicationGraph(publicationClient);

    await assert.rejects(
      recordCandidateModerationDecision(moderationPool, command),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        const databaseError = error as Error & { code?: string };
        assert.notEqual(databaseError.code, '40P01');
        assert.doesNotMatch(databaseError.message, /deadlock detected/i);
        assert.ok(
          databaseError.code === '55P03'
          || databaseError.code === '57014',
        );
        return true;
      },
    );

    await publicationClient.query('rollback');
    transactionOpen = false;
    await recordCandidateModerationDecision(pool, command);
    const current = await pool.query<{ moderation_decision_id: string }>(
      `select moderation_decision_id
         from current_candidate_moderation_decisions
        where candidate_revision_id =
              '62000000-0000-4000-8000-000000000002'
          and moderation_policy_revision_id = $1`,
      [GATE_IDS.moderationPolicyId],
    );
    assert.equal(
      current.rows[0]?.moderation_decision_id,
      GATE_IDS.secondModerationDecisionId,
    );
  } finally {
    if (transactionOpen) {
      await publicationClient.query('rollback');
    }
    publicationClient.release();
    await moderationPool.end();
    await assertPublicationGraphAbsent(pool);
    await pool.end();
  }
});
