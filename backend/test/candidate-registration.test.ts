import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import type { Pool } from 'pg';

import { activateCatalogRevision } from '../src/modules/catalog/activate-catalog-revision.js';
import { importCatalogRevision } from '../src/modules/catalog/import-catalog-revision.js';
import { validateCatalogRevision } from '../src/modules/catalog/validate-catalog-revision.js';
import {
  registerNormalizedObservation,
  registerNormalizedObservationInTransaction,
} from '../src/modules/candidate/register-normalized-observation.js';
import { registerPatchEvent } from '../src/modules/patch/register-patch-event.js';
import {
  CANDIDATE_IDS,
  registrationCommand,
  seedRawObservation,
  validNormalizationSnapshot,
} from './helpers/candidate.js';
import {
  CATALOG_IDS,
  seedActiveCatalog,
  validCatalogSnapshot,
} from './helpers/catalog.js';
import { resetDatabase, tableCount } from './helpers/database.js';

const SECOND_IDS = {
  candidateId: '62000000-0000-4000-8000-000000000011',
  candidateRevisionId: '62000000-0000-4000-8000-000000000012',
  normalizedObservationId: '62000000-0000-4000-8000-000000000013',
  rawObservationId: '62000000-0000-4000-8000-000000000015',
} as const;

const THIRD_IDS = {
  candidateId: '62000000-0000-4000-8000-000000000021',
  candidateRevisionId: '62000000-0000-4000-8000-000000000022',
  normalizedObservationId: '62000000-0000-4000-8000-000000000023',
  provenanceId: '62000000-0000-4000-8000-000000000024',
  rawObservationId: '62000000-0000-4000-8000-000000000025',
} as const;

const SECOND_CATALOG_IDS = {
  catalogRevisionId: '62000000-0000-4000-8000-000000000031',
  validationResultId: '62000000-0000-4000-8000-000000000032',
} as const;

async function waitForSettlementOrPatchLock(
  pool: Pool,
  settled: () => boolean,
): Promise<'lock_wait' | 'settled'> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (settled()) {
      return 'settled';
    }
    const waiting = await pool.query<{ waiting: boolean }>(
      `select exists (
         select 1
           from pg_stat_activity
          where pid <> pg_backend_pid()
            and wait_event_type = 'Lock'
            and query ilike '%patches%'
       ) as waiting`,
    );
    if (waiting.rows[0]?.waiting) {
      return 'lock_wait';
    }
    await delay(10);
  }
  throw new Error('timed out waiting for patch lock state');
}

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

async function activateSecondCatalogRevision(pool: Pool): Promise<void> {
  const snapshot = validCatalogSnapshot();
  snapshot.source.sourceDigest = 'e'.repeat(64);
  const subject = snapshot.entities.find((entity) => (
    entity.entityType === 'champion'
    && entity.externalId === 'samira'
  ));
  assert.ok(subject);
  subject.attributes = { ...subject.attributes, catalogRevision: 2 };

  await importCatalogRevision(pool, {
    actorId: 'candidate-catalog',
    catalogRevisionId: SECOND_CATALOG_IDS.catalogRevisionId,
    correlationId: 'candidate-catalog-import-2',
    idempotencyKey: 'candidate-catalog-import-2',
    patchId: CATALOG_IDS.patchId,
    revision: 2,
    sourceId: CATALOG_IDS.sourceId,
    sourcePolicyRevisionId: CATALOG_IDS.sourcePolicyRevisionId,
    snapshot,
  });
  const validation = await validateCatalogRevision(pool, {
    actorId: 'candidate-validator',
    catalogRevisionId: SECOND_CATALOG_IDS.catalogRevisionId,
    catalogValidationResultId: SECOND_CATALOG_IDS.validationResultId,
    correlationId: 'candidate-catalog-validation-2',
    reason: 'candidate catalog revision test',
    validatorRulesetVersion: 'catalog-rules-v1',
  });
  assert.equal(validation.result, 'passed');
  await activateCatalogRevision(pool, {
    actorId: 'candidate-operator',
    catalogRevisionId: SECOND_CATALOG_IDS.catalogRevisionId,
    correlationId: 'candidate-catalog-activation-2',
    expectedCurrentCatalogRevisionId: CATALOG_IDS.catalogRevisionId,
    patchId: CATALOG_IDS.patchId,
    reason: 'candidate catalog revision test',
  });
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

test('S21 same signature from collector and AI has one candidate and two provenance rows', async () => {
  const pool = await resetDatabase();
  await seedActiveCatalog(pool);
  await seedRawObservation(pool);
  await seedRawObservation(pool, SECOND_IDS.rawObservationId);

  const collector = await registerNormalizedObservation(
    pool,
    registrationCommand(),
  );
  const ai = await registerNormalizedObservation(
    pool,
    registrationCommand({
      candidateId: SECOND_IDS.candidateId,
      candidateRevisionId: SECOND_IDS.candidateRevisionId,
      normalizedObservationId: SECOND_IDS.normalizedObservationId,
      provenanceId: THIRD_IDS.provenanceId,
      rawObservationId: SECOND_IDS.rawObservationId,
      snapshot: validNormalizationSnapshot('ai_generated'),
    }),
  );

  assert.equal(collector.candidateId, ai.candidateId);
  assert.equal(
    collector.candidateRevisionId,
    ai.candidateRevisionId,
  );
  assert.deepEqual(await registryCounts(pool), {
    audit: 2,
    candidates: 1,
    normalized: 2,
    outbox: 2,
    provenance: 2,
    revisions: 1,
  });
  const provenance = await pool.query<{ origin: string }>(
    `select origin from candidate_provenance order by origin`,
  );
  assert.deepEqual(
    provenance.rows.map((row) => row.origin),
    ['ai_generated', 'collector_detected'],
  );
  await pool.end();
});

test('concurrent identical source observations converge without a unique failure', async () => {
  const pool = await resetDatabase();
  await seedActiveCatalog(pool);
  await seedRawObservation(pool);
  await seedRawObservation(pool, SECOND_IDS.rawObservationId);

  const [first, second] = await Promise.all([
    registerNormalizedObservation(pool, registrationCommand()),
    registerNormalizedObservation(pool, registrationCommand({
      candidateId: SECOND_IDS.candidateId,
      candidateRevisionId: SECOND_IDS.candidateRevisionId,
      normalizedObservationId: SECOND_IDS.normalizedObservationId,
      provenanceId: THIRD_IDS.provenanceId,
      rawObservationId: SECOND_IDS.rawObservationId,
    })),
  ]);

  assert.equal(first.candidateId, second.candidateId);
  assert.equal(first.candidateRevisionId, second.candidateRevisionId);
  assert.equal(await tableCount(pool, 'candidates'), 1);
  assert.equal(await tableCount(pool, 'candidate_revisions'), 1);
  assert.equal(await tableCount(pool, 'candidate_provenance'), 2);
  await pool.end();
});

test('concurrent replay of one raw observation returns one registry effect', async () => {
  const pool = await resetDatabase();
  await seedActiveCatalog(pool);
  await seedRawObservation(pool);

  const [first, second] = await Promise.all([
    registerNormalizedObservation(pool, registrationCommand()),
    registerNormalizedObservation(pool, registrationCommand({
      candidateId: SECOND_IDS.candidateId,
      candidateRevisionId: SECOND_IDS.candidateRevisionId,
      normalizedObservationId: SECOND_IDS.normalizedObservationId,
      provenanceId: THIRD_IDS.provenanceId,
    })),
  ]);

  assert.equal(first.candidateId, second.candidateId);
  assert.equal(first.candidateRevisionId, second.candidateRevisionId);
  assert.equal(
    first.normalizedObservationId,
    second.normalizedObservationId,
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

test('same fingerprint under a new active catalog creates an immutable second revision', async () => {
  const pool = await resetDatabase();
  await seedActiveCatalog(pool);
  await seedRawObservation(pool);
  const first = await registerNormalizedObservation(
    pool,
    registrationCommand(),
  );
  await activateSecondCatalogRevision(pool);
  await seedRawObservation(pool, THIRD_IDS.rawObservationId);

  const second = await registerNormalizedObservation(
    pool,
    registrationCommand({
      candidateId: THIRD_IDS.candidateId,
      candidateRevisionId: THIRD_IDS.candidateRevisionId,
      normalizedObservationId: THIRD_IDS.normalizedObservationId,
      provenanceId: THIRD_IDS.provenanceId,
      rawObservationId: THIRD_IDS.rawObservationId,
    }),
  );

  assert.equal(first.candidateId, second.candidateId);
  assert.notEqual(
    first.candidateRevisionId,
    second.candidateRevisionId,
  );
  const revisions = await pool.query<{
    catalog_revision_id: string;
    revision: number;
  }>(
    `select revision, catalog_revision_id
       from candidate_revisions
      order by revision`,
  );
  assert.deepEqual(revisions.rows, [
    {
      catalog_revision_id: CATALOG_IDS.catalogRevisionId,
      revision: 1,
    },
    {
      catalog_revision_id: SECOND_CATALOG_IDS.catalogRevisionId,
      revision: 2,
    },
  ]);
  assert.equal(await tableCount(pool, 'candidates'), 1);
  assert.equal(await tableCount(pool, 'candidate_provenance'), 2);
  await pool.end();
});

test('registration holds the patch lifecycle lock until commit', async () => {
  const pool = await resetDatabase();
  await seedActiveCatalog(pool);
  await seedRawObservation(pool);
  const registrationClient = await pool.connect();
  let transactionOpen = true;
  let writerSettled = false;
  let writer: Promise<unknown> | undefined;

  try {
    await registrationClient.query('begin');
    await registerNormalizedObservationInTransaction(
      registrationClient,
      registrationCommand(),
    );
    writer = registerPatchEvent(pool, {
      actorId: 'patch-race-writer',
      correlationId: 'patch-race-registration-first',
      displayLabel: '26.15',
      eventId: '62000000-0000-4000-8000-000000000041',
      lifecycleState: 'withdrawn',
      occurredAt: new Date('2026-07-25T00:00:00Z'),
      patchId: CATALOG_IDS.patchId,
      patchKey: '26.15',
      reason: 'registration-first lock test',
    }).finally(() => {
      writerSettled = true;
    });

    assert.equal(
      await waitForSettlementOrPatchLock(pool, () => writerSettled),
      'lock_wait',
    );
    await registrationClient.query('commit');
    transactionOpen = false;
    await writer;
    assert.equal(await tableCount(pool, 'candidates'), 1);
  } finally {
    if (transactionOpen) {
      await registrationClient.query('rollback');
    }
    await writer?.catch(() => undefined);
    registrationClient.release();
    await pool.end();
  }
});

test('withdrawal committed ahead of registration fails closed', async () => {
  const pool = await resetDatabase();
  await seedActiveCatalog(pool);
  await seedRawObservation(pool);
  const lifecycleClient = await pool.connect();
  let transactionOpen = true;
  let registrationSettled = false;

  try {
    await lifecycleClient.query('begin');
    await lifecycleClient.query(
      `select patch_id
         from patches
        where patch_id = $1
        for update`,
      [CATALOG_IDS.patchId],
    );
    await lifecycleClient.query(
      `insert into patch_lifecycle_events
        (patch_lifecycle_event_id, patch_id, lifecycle_state, reason,
         actor_id, correlation_id, occurred_at)
       values ($1, $2, 'withdrawn', 'withdrawal-first lock test',
               'patch-race-writer', 'patch-race-withdrawal-first', $3)`,
      [
        '62000000-0000-4000-8000-000000000042',
        CATALOG_IDS.patchId,
        new Date('2026-07-25T00:00:00Z'),
      ],
    );

    const registration = registerNormalizedObservation(
      pool,
      registrationCommand(),
    ).then(
      (value) => ({ status: 'fulfilled' as const, value }),
      (error: unknown) => ({ error, status: 'rejected' as const }),
    ).finally(() => {
      registrationSettled = true;
    });
    assert.equal(
      await waitForSettlementOrPatchLock(pool, () => registrationSettled),
      'lock_wait',
    );
    await lifecycleClient.query('commit');
    transactionOpen = false;

    const outcome = await registration;
    assert.equal(outcome.status, 'rejected');
    assert.match(
      String(outcome.status === 'rejected' ? outcome.error : ''),
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
  } finally {
    if (transactionOpen) {
      await lifecycleClient.query('rollback');
    }
    lifecycleClient.release();
    await pool.end();
  }
});
