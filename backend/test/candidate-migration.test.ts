import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import type { Pool } from 'pg';

import { importCatalogRevision } from '../src/modules/catalog/import-catalog-revision.js';
import {
  CATALOG_IDS,
  seedCatalogPrerequisites,
  validCatalogSnapshot,
} from './helpers/catalog.js';
import { resetDatabase, tableCount } from './helpers/database.js';

const IDS = {
  candidateId: '61000000-0000-4000-8000-000000000001',
  candidateRevisionId: '61000000-0000-4000-8000-000000000002',
  normalizedObservationId: '61000000-0000-4000-8000-000000000003',
  provenanceId: '61000000-0000-4000-8000-000000000004',
  rawObservationId: '61000000-0000-4000-8000-000000000005',
  secondCatalogRevisionId: '61000000-0000-4000-8000-000000000006',
  secondNormalizedObservationId: '61000000-0000-4000-8000-000000000007',
  secondRawObservationId: '61000000-0000-4000-8000-000000000008',
  mismatchedCandidateId: '61000000-0000-4000-8000-000000000009',
  mismatchedCandidateRevisionId: '61000000-0000-4000-8000-000000000010',
  mismatchedProvenanceId: '61000000-0000-4000-8000-000000000011',
  wrongPatchId: '61000000-0000-4000-8000-000000000012',
  subjectMismatchNormalizedObservationId:
    '61000000-0000-4000-8000-000000000013',
  subjectMismatchRawObservationId:
    '61000000-0000-4000-8000-000000000014',
  subjectMismatchProvenanceId:
    '61000000-0000-4000-8000-000000000015',
} as const;

const SIGNATURE = 'b'.repeat(64);
const FINGERPRINT = 'c'.repeat(64);
const PAYLOAD = {
  schemaVersion: 1,
  augmentExternalIds: ['1194'],
  itemExternalIds: ['3006', '6672'],
};

async function importCatalog(
  pool: Pool,
  catalogRevisionId: string = CATALOG_IDS.catalogRevisionId,
  revision = 1,
): Promise<void> {
  const snapshot = validCatalogSnapshot();
  snapshot.entities.push({
    entityType: 'champion',
    externalId: 'jinx',
    displayName: 'Jinx',
    active: true,
    attributes: {},
  });
  if (revision > 1) {
    snapshot.source.sourceDigest = 'd'.repeat(64);
    const samira = snapshot.entities.find((entity) => (
      entity.entityType === 'champion' && entity.externalId === 'samira'
    ));
    assert.ok(samira);
    samira.attributes = { ...samira.attributes, revision };
  }
  await importCatalogRevision(pool, {
    actorId: 'candidate-migration',
    catalogRevisionId,
    correlationId: `candidate-migration-${revision}`,
    idempotencyKey: `candidate-migration-${revision}`,
    patchId: CATALOG_IDS.patchId,
    revision,
    sourceId: CATALOG_IDS.sourceId,
    sourcePolicyRevisionId: CATALOG_IDS.sourcePolicyRevisionId,
    snapshot,
  });
}

async function insertRawObservation(
  pool: Pool,
  rawObservationId: string,
): Promise<void> {
  await pool.query(
    `insert into raw_observations
      (raw_observation_id, source_id, source_policy_revision_id,
       adapter_version, content_hash, collected_at)
     values ($1, $2, $3, 'candidate-migration-v1', $4, clock_timestamp())`,
    [
      rawObservationId,
      CATALOG_IDS.sourceId,
      CATALOG_IDS.sourcePolicyRevisionId,
      `content-${rawObservationId}`,
    ],
  );
}

async function subjectRevisionId(
  pool: Pool,
  catalogRevisionId: string,
  subjectExternalId = 'samira',
): Promise<string> {
  const result = await pool.query<{ game_entity_revision_id: string }>(
    `select ger.game_entity_revision_id
       from game_entity_revisions ger
       join game_entities ge on ge.game_entity_id = ger.game_entity_id
      where ger.catalog_revision_id = $1
        and ge.entity_type = 'champion'
        and ge.canonical_external_id = $2`,
    [catalogRevisionId, subjectExternalId],
  );
  const value = result.rows[0]?.game_entity_revision_id;
  assert.ok(value);
  return value;
}

async function seedRegistryGraph(pool: Pool): Promise<void> {
  await seedCatalogPrerequisites(pool);
  await importCatalog(pool);
  await insertRawObservation(pool, IDS.rawObservationId);
  const subjectRevision = await subjectRevisionId(
    pool,
    CATALOG_IDS.catalogRevisionId,
  );
  const subject = await pool.query<{ game_entity_id: string }>(
    `select game_entity_id
       from game_entity_revisions
      where game_entity_revision_id = $1`,
    [subjectRevision],
  );
  const subjectId = subject.rows[0]?.game_entity_id;
  assert.ok(subjectId);

  await pool.query(
    `insert into normalized_observations
      (normalized_observation_id, raw_observation_id, patch_id,
       catalog_revision_id, game_mode_external_id,
       subject_game_entity_revision_id, normalizer_version,
       normalized_signature, canonical_payload)
     values ($1, $2, $3, $4, 'aram_mayhem', $5,
             'candidate-selection-v1', $6, $7::jsonb)`,
    [
      IDS.normalizedObservationId,
      IDS.rawObservationId,
      CATALOG_IDS.patchId,
      CATALOG_IDS.catalogRevisionId,
      subjectRevision,
      SIGNATURE,
      JSON.stringify(PAYLOAD),
    ],
  );
  await pool.query(
    `insert into candidates
      (candidate_id, fingerprint, patch_id, game_mode_external_id,
       subject_game_entity_id)
     values ($1, $2, $3, 'aram_mayhem', $4)`,
    [IDS.candidateId, FINGERPRINT, CATALOG_IDS.patchId, subjectId],
  );
  await pool.query(
    `insert into candidate_revisions
      (candidate_revision_id, candidate_id, revision, patch_id,
       catalog_revision_id, normalized_signature, canonical_payload)
     values ($1, $2, 1, $3, $4, $5, $6::jsonb)`,
    [
      IDS.candidateRevisionId,
      IDS.candidateId,
      CATALOG_IDS.patchId,
      CATALOG_IDS.catalogRevisionId,
      SIGNATURE,
      JSON.stringify(PAYLOAD),
    ],
  );
  await pool.query(
    `insert into candidate_provenance
      (candidate_provenance_id, candidate_revision_id,
       normalized_observation_id, origin)
     values ($1, $2, $3, 'collector_detected')`,
    [
      IDS.provenanceId,
      IDS.candidateRevisionId,
      IDS.normalizedObservationId,
    ],
  );
}

test('candidate registry history rejects update and delete', async () => {
  const pool = await resetDatabase();
  await seedRegistryGraph(pool);

  for (const table of [
    'normalized_observations',
    'candidates',
    'candidate_revisions',
    'candidate_provenance',
  ]) {
    await assert.rejects(
      pool.query(`update ${table} set created_at = clock_timestamp()`),
      /immutable/,
    );
    await assert.rejects(
      pool.query(`delete from ${table}`),
      /immutable/,
    );
  }
  await pool.end();
});

test('normalized subject revision must belong to the pinned catalog', async () => {
  const pool = await resetDatabase();
  await seedRegistryGraph(pool);
  await importCatalog(pool, IDS.secondCatalogRevisionId, 2);
  await insertRawObservation(pool, IDS.secondRawObservationId);
  const firstSubjectRevision = await subjectRevisionId(
    pool,
    CATALOG_IDS.catalogRevisionId,
  );

  await assert.rejects(
    pool.query(
      `insert into normalized_observations
        (normalized_observation_id, raw_observation_id, patch_id,
         catalog_revision_id, game_mode_external_id,
         subject_game_entity_revision_id, normalizer_version,
         normalized_signature, canonical_payload)
       values ($1, $2, $3, $4, 'aram_mayhem', $5,
               'candidate-selection-v1', $6, $7::jsonb)`,
      [
        IDS.secondNormalizedObservationId,
        IDS.secondRawObservationId,
        CATALOG_IDS.patchId,
        IDS.secondCatalogRevisionId,
        firstSubjectRevision,
        SIGNATURE,
        JSON.stringify(PAYLOAD),
      ],
    ),
    /foreign key/,
  );
  await pool.end();
});

test('normalized observation patch must own the pinned catalog', async () => {
  const pool = await resetDatabase();
  await seedRegistryGraph(pool);
  await insertRawObservation(pool, IDS.secondRawObservationId);
  await pool.query(
    `insert into patches (patch_id, patch_key, display_label)
     values ($1, '99.99', 'Wrong patch')`,
    [IDS.wrongPatchId],
  );
  const subjectRevision = await subjectRevisionId(
    pool,
    CATALOG_IDS.catalogRevisionId,
  );

  await assert.rejects(
    pool.query(
      `insert into normalized_observations
        (normalized_observation_id, raw_observation_id, patch_id,
         catalog_revision_id, game_mode_external_id,
         subject_game_entity_revision_id, normalizer_version,
         normalized_signature, canonical_payload)
       values ($1, $2, $3, $4, 'aram_mayhem', $5,
               'candidate-selection-v1', $6, $7::jsonb)`,
      [
        IDS.secondNormalizedObservationId,
        IDS.secondRawObservationId,
        IDS.wrongPatchId,
        CATALOG_IDS.catalogRevisionId,
        subjectRevision,
        SIGNATURE,
        JSON.stringify(PAYLOAD),
      ],
    ),
    /foreign key/,
  );
  await pool.end();
});

test('candidate revision patch must own both candidate and catalog', async () => {
  const pool = await resetDatabase();
  await seedRegistryGraph(pool);
  await pool.query(
    `insert into patches (patch_id, patch_key, display_label)
     values ($1, '99.99', 'Wrong patch')`,
    [IDS.wrongPatchId],
  );
  const subject = await pool.query<{ game_entity_id: string }>(
    `select subject_game_entity_id as game_entity_id
       from candidates
      where candidate_id = $1`,
    [IDS.candidateId],
  );
  const subjectId = subject.rows[0]?.game_entity_id;
  assert.ok(subjectId);
  await pool.query(
    `insert into candidates
      (candidate_id, fingerprint, patch_id, game_mode_external_id,
       subject_game_entity_id)
     values ($1, $2, $3, 'aram_mayhem', $4)`,
    [
      IDS.mismatchedCandidateId,
      'd'.repeat(64),
      IDS.wrongPatchId,
      subjectId,
    ],
  );

  await assert.rejects(
    pool.query(
      `insert into candidate_revisions
        (candidate_revision_id, candidate_id, revision, patch_id,
         catalog_revision_id, normalized_signature, canonical_payload)
       values ($1, $2, 1, $3, $4, $5, $6::jsonb)`,
      [
        IDS.mismatchedCandidateRevisionId,
        IDS.mismatchedCandidateId,
        IDS.wrongPatchId,
        CATALOG_IDS.catalogRevisionId,
        SIGNATURE,
        JSON.stringify(PAYLOAD),
      ],
    ),
    /foreign key/,
  );
  await pool.end();
});

test('provenance must link matching catalog signature and payload', async () => {
  const pool = await resetDatabase();
  await seedRegistryGraph(pool);
  await insertRawObservation(pool, IDS.secondRawObservationId);
  const subjectRevision = await subjectRevisionId(
    pool,
    CATALOG_IDS.catalogRevisionId,
  );
  const mismatchedPayload = {
    ...PAYLOAD,
    itemExternalIds: ['3006'],
  };
  await pool.query(
    `insert into normalized_observations
      (normalized_observation_id, raw_observation_id, patch_id,
       catalog_revision_id, game_mode_external_id,
       subject_game_entity_revision_id, normalizer_version,
       normalized_signature, canonical_payload)
     values ($1, $2, $3, $4, 'aram_mayhem', $5,
             'candidate-selection-v1', $6, $7::jsonb)`,
    [
      IDS.secondNormalizedObservationId,
      IDS.secondRawObservationId,
      CATALOG_IDS.patchId,
      CATALOG_IDS.catalogRevisionId,
      subjectRevision,
      'e'.repeat(64),
      JSON.stringify(mismatchedPayload),
    ],
  );

  await assert.rejects(
    pool.query(
      `insert into candidate_provenance
        (candidate_provenance_id, candidate_revision_id,
         normalized_observation_id, origin)
       values ($1, $2, $3, 'collector_detected')`,
      [
        IDS.mismatchedProvenanceId,
        IDS.candidateRevisionId,
        IDS.secondNormalizedObservationId,
      ],
    ),
    /candidate provenance graph mismatch/,
  );
  await pool.end();
});

test('provenance subject must match the candidate subject', async () => {
  const pool = await resetDatabase();
  await seedRegistryGraph(pool);
  await insertRawObservation(pool, IDS.subjectMismatchRawObservationId);
  const jinxRevision = await subjectRevisionId(
    pool,
    CATALOG_IDS.catalogRevisionId,
    'jinx',
  );
  await pool.query(
    `insert into normalized_observations
      (normalized_observation_id, raw_observation_id, patch_id,
       catalog_revision_id, game_mode_external_id,
       subject_game_entity_revision_id, normalizer_version,
       normalized_signature, canonical_payload)
     values ($1, $2, $3, $4, 'aram_mayhem', $5,
             'candidate-selection-v1', $6, $7::jsonb)`,
    [
      IDS.subjectMismatchNormalizedObservationId,
      IDS.subjectMismatchRawObservationId,
      CATALOG_IDS.patchId,
      CATALOG_IDS.catalogRevisionId,
      jinxRevision,
      SIGNATURE,
      JSON.stringify(PAYLOAD),
    ],
  );

  await assert.rejects(
    pool.query(
      `insert into candidate_provenance
        (candidate_provenance_id, candidate_revision_id,
         normalized_observation_id, origin)
       values ($1, $2, $3, 'collector_detected')`,
      [
        IDS.subjectMismatchProvenanceId,
        IDS.candidateRevisionId,
        IDS.subjectMismatchNormalizedObservationId,
      ],
    ),
    /candidate provenance graph mismatch/,
  );
  assert.equal(await tableCount(pool, 'candidate_provenance'), 1);
  await pool.end();
});

test('candidate payload storage rejects noncanonical V1 shapes and bounds', async () => {
  const pool = await resetDatabase();
  await seedRegistryGraph(pool);
  const subjectRevision = await subjectRevisionId(
    pool,
    CATALOG_IDS.catalogRevisionId,
  );
  const invalidPayloads = [
    {
      ...PAYLOAD,
      retainedSourceText: 'must not enter immutable history',
    },
    {
      ...PAYLOAD,
      itemExternalIds: [3006],
    },
    {
      ...PAYLOAD,
      itemExternalIds: Array.from(
        { length: 65 },
        (_value, index) => `item-${index}`,
      ),
    },
  ];

  for (const payload of invalidPayloads) {
    const rawObservationId = randomUUID();
    await insertRawObservation(pool, rawObservationId);
    await assert.rejects(
      pool.query(
        `insert into normalized_observations
          (normalized_observation_id, raw_observation_id, patch_id,
           catalog_revision_id, game_mode_external_id,
           subject_game_entity_revision_id, normalizer_version,
           normalized_signature, canonical_payload)
         values ($1, $2, $3, $4, 'aram_mayhem', $5,
                 'candidate-selection-v1', $6, $7::jsonb)`,
        [
          randomUUID(),
          rawObservationId,
          CATALOG_IDS.patchId,
          CATALOG_IDS.catalogRevisionId,
          subjectRevision,
          'a'.repeat(64),
          JSON.stringify(payload),
        ],
      ),
      /check constraint|candidate selection payload/,
    );
  }

  await assert.rejects(
    pool.query(
      `insert into candidate_revisions
        (candidate_revision_id, candidate_id, revision, patch_id,
         catalog_revision_id, normalized_signature, canonical_payload)
       values ($1, $2, 2, $3, $4, $5, $6::jsonb)`,
      [
        randomUUID(),
        IDS.candidateId,
        CATALOG_IDS.patchId,
        CATALOG_IDS.catalogRevisionId,
        'f'.repeat(64),
        JSON.stringify({
          ...PAYLOAD,
          retainedSourceText: 'must not enter immutable history',
        }),
      ],
    ),
    /check constraint|candidate selection payload/,
  );
  await pool.end();
});
