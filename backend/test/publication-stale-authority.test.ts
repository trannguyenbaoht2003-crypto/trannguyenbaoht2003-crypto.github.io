import assert from 'node:assert/strict';
import test from 'node:test';

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

test('PostgreSQL rechecks Moderation currentness when it is superseded before Publication COMMIT', async () => {
  const pool = await resetDatabase();
  await seedEligiblePublicationContext(pool);
  const publicationClient = await pool.connect();
  let transactionOpen = false;

  try {
    await publicationClient.query('begin');
    transactionOpen = true;
    await publicationClient.query(
      `set local lock_timeout = '3s';
       set local statement_timeout = '15s'`,
    );
    await insertDirectPublicationGraph(publicationClient);

    await recordCandidateModerationDecision(
      pool,
      moderationDecisionCommand({
        actorId: 'publication-concurrent-moderator',
        correlationId: 'publication-concurrent-block',
        decisionId: GATE_IDS.secondModerationDecisionId,
        evaluatedAt: '2026-07-30T03:00:00.000Z',
        idempotencyKey: 'publication-concurrent-block',
        inputSnapshotId: GATE_IDS.secondModerationInputSnapshotId,
        outcome: 'blocked',
        reason: 'Moderation superseded before Publication commit.',
      }),
    );

    const commit = publicationClient.query('commit').finally(() => {
      transactionOpen = false;
    });
    await assert.rejects(commit, /publication input stale/);
  } finally {
    if (transactionOpen) {
      await publicationClient.query('rollback');
    }
    publicationClient.release();
    await assertPublicationGraphAbsent(pool);
    await pool.end();
  }
});
