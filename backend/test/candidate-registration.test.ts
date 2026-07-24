import assert from 'node:assert/strict';
import test from 'node:test';

import type { Pool } from 'pg';

import {
  registerNormalizedObservation,
} from '../src/modules/candidate/register-normalized-observation.js';
import {
  CANDIDATE_IDS,
  registrationCommand,
  seedRawObservation,
  validNormalizationSnapshot,
} from './helpers/candidate.js';
import { seedActiveCatalog } from './helpers/catalog.js';
import { resetDatabase, tableCount } from './helpers/database.js';

const SECOND_IDS = {
  candidateId: '62000000-0000-4000-8000-000000000011',
  candidateRevisionId: '62000000-0000-4000-8000-000000000012',
  normalizedObservationId: '62000000-0000-4000-8000-000000000013',
  rawObservationId: '62000000-0000-4000-8000-000000000015',
} as const;

async function registryCounts(pool: Pool) {
  const candidateAudit = await pool.query<{ count: string }>(
    `select count(*)
       from audit_events
      where action like 'candidate.%'`,
  );
  const candidateOutbox = await pool.query<{ count: string }>(
    `select count(*)
       from outbox_events
      where aggregate_type = 'candidate'`,
  );
  return {
    audit: Number(candidateAudit.rows[0]?.count ?? 0),
    candidates: await tableCount(pool, 'candidates'),
    normalized: await tableCount(pool, 'normalized_observations'),
    outbox: Number(candidateOutbox.rows[0]?.count ?? 0),
    provenance: await tableCount(pool, 'candidate_provenance'),
    revisions: await tableCount(pool, 'candidate_revisions'),
  };
}

test('valid active-catalog snapshot creates one complete registry graph', async () => {
  const pool = await resetDatabase();
  await seedActiveCatalog(pool);
  await seedRawObservation(pool);

  const result = await registerNormalizedObservation(
    pool,
    registrationCommand(),
  );

  assert.deepEqual(result, {
    candidateCreated: true,
    candidateId: CANDIDATE_IDS.candidateId,
    candidateRevisionCreated: true,
    candidateRevisionId: CANDIDATE_IDS.candidateRevisionId,
    normalizedObservationId: CANDIDATE_IDS.normalizedObservationId,
    provenanceAdded: true,
  });
  assert.deepEqual(await registryCounts(pool), {
    audit: 1,
    candidates: 1,
    normalized: 1,
    outbox: 1,
    provenance: 1,
    revisions: 1,
  });
  await pool.end();
});

test('wrong patch or invalid catalog selection creates no registry rows', async () => {
  const pool = await resetDatabase();
  await seedActiveCatalog(pool);
  await seedRawObservation(pool);

  await assert.rejects(
    registerNormalizedObservation(pool, registrationCommand({
      snapshot: {
        ...validNormalizationSnapshot(),
        patchKey: '26.16',
      },
    })),
    /NORMALIZATION_ACTIVE_CATALOG_NOT_FOUND/,
  );
  assert.deepEqual(await registryCounts(pool), {
    audit: 0,
    candidates: 0,
    normalized: 0,
    outbox: 0,
    provenance: 0,
    revisions: 0,
  });

  await assert.rejects(
    registerNormalizedObservation(pool, registrationCommand({
      snapshot: {
        ...validNormalizationSnapshot(),
        itemExternalIds: ['missing-item'],
      },
    })),
    /CATALOG_ENTITY_MISSING/,
  );
  assert.deepEqual(await registryCounts(pool), {
    audit: 0,
    candidates: 0,
    normalized: 0,
    outbox: 0,
    provenance: 0,
    revisions: 0,
  });
  await pool.end();
});

test('same raw observation replays but changed semantic payload conflicts', async () => {
  const pool = await resetDatabase();
  await seedActiveCatalog(pool);
  await seedRawObservation(pool);
  const first = await registerNormalizedObservation(
    pool,
    registrationCommand(),
  );
  const replay = await registerNormalizedObservation(
    pool,
    registrationCommand(),
  );

  assert.equal(replay.candidateId, first.candidateId);
  assert.equal(replay.candidateRevisionId, first.candidateRevisionId);
  assert.equal(replay.candidateCreated, false);
  assert.equal(replay.candidateRevisionCreated, false);
  assert.equal(replay.provenanceAdded, false);
  assert.deepEqual(await registryCounts(pool), {
    audit: 1,
    candidates: 1,
    normalized: 1,
    outbox: 1,
    provenance: 1,
    revisions: 1,
  });

  await assert.rejects(
    registerNormalizedObservation(pool, registrationCommand({
      snapshot: {
        ...validNormalizationSnapshot(),
        itemExternalIds: ['3006'],
      },
    })),
    /NORMALIZATION_REPLAY_CONFLICT/,
  );
  assert.deepEqual(await registryCounts(pool), {
    audit: 1,
    candidates: 1,
    normalized: 1,
    outbox: 1,
    provenance: 1,
    revisions: 1,
  });
  await pool.end();
});

test('late provenance conflict rolls back every earlier registration write', async () => {
  const pool = await resetDatabase();
  await seedActiveCatalog(pool);
  await seedRawObservation(pool);
  await registerNormalizedObservation(pool, registrationCommand());
  const before = await registryCounts(pool);
  await seedRawObservation(pool, SECOND_IDS.rawObservationId);

  await assert.rejects(
    registerNormalizedObservation(pool, registrationCommand({
      candidateId: SECOND_IDS.candidateId,
      candidateRevisionId: SECOND_IDS.candidateRevisionId,
      normalizedObservationId: SECOND_IDS.normalizedObservationId,
      rawObservationId: SECOND_IDS.rawObservationId,
      provenanceId: CANDIDATE_IDS.provenanceId,
    })),
    /candidate_provenance_pkey/,
  );

  assert.deepEqual(await registryCounts(pool), before);
  await pool.end();
});
