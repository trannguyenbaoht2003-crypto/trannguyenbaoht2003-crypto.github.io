import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { CANDIDATE_IDS } from './helpers/candidate.js';
import { CATALOG_IDS } from './helpers/catalog.js';
import { resetDatabase, tableCount } from './helpers/database.js';
import { seedTrustCandidate } from './helpers/trust.js';

const VERSION = 'candidate-confidence-v1';

async function insertValidConfidenceFixture(
  pool: Awaited<ReturnType<typeof resetDatabase>>,
) {
  const inputSnapshotId = randomUUID();
  const scoreId = randomUUID();
  const inputHash = 'a'.repeat(64);
  const evaluatedAt = new Date('2026-08-25T00:00:00.000Z');

  await pool.query(
    `insert into candidate_confidence_input_snapshots
      (candidate_confidence_input_snapshot_id, candidate_id,
       candidate_revision_id, patch_id, catalog_revision_id,
       scoring_version, provenance_quality, supporting_source_count,
       has_exact_patch_support, has_revalidated_cross_patch_support,
       newest_supporting_evidence_at, evaluated_at, input_hash, created_by)
     values ($1, $2, $3, $4, $5, $6, 20, 1, true, false,
             null, $7, $8, 'confidence-migration-test')`,
    [
      inputSnapshotId,
      CANDIDATE_IDS.candidateId,
      CANDIDATE_IDS.candidateRevisionId,
      CATALOG_IDS.patchId,
      CATALOG_IDS.catalogRevisionId,
      VERSION,
      evaluatedAt,
      inputHash,
    ],
  );

  await pool.query(
    `insert into candidate_confidence_scores
      (candidate_confidence_score_id, candidate_confidence_input_snapshot_id,
       candidate_id, candidate_revision_id, patch_id, catalog_revision_id,
       scoring_version, input_hash, evaluated_at,
       provenance_quality_score, evidence_diversity_score,
       patch_alignment_score, freshness_score, score, band,
       reason, actor_id, correlation_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9,
             20, 10, 20, 15, 65, 'medium',
             'migration fixture', 'confidence-migration-test',
             'confidence-migration-test')`,
    [
      scoreId,
      inputSnapshotId,
      CANDIDATE_IDS.candidateId,
      CANDIDATE_IDS.candidateRevisionId,
      CATALOG_IDS.patchId,
      CATALOG_IDS.catalogRevisionId,
      VERSION,
      inputHash,
      evaluatedAt,
    ],
  );

  return { inputSnapshotId, scoreId };
}

test('migration 0018 creates confidence history and current pointer tables', async () => {
  const pool = await resetDatabase();

  assert.equal(await tableCount(pool, 'candidate_confidence_input_snapshots'), 0);
  assert.equal(await tableCount(pool, 'candidate_confidence_scores'), 0);
  assert.equal(await tableCount(pool, 'current_candidate_confidence_scores'), 0);

  const migration = await pool.query<{ count: string }>(
    `select count(*)
       from schema_migrations
      where version = '0018_candidate_confidence_scoring.sql'`,
  );
  assert.equal(Number(migration.rows[0]?.count ?? 0), 1);
  await pool.end();
});

test('confidence snapshots and scores are append-only', async () => {
  const pool = await resetDatabase();
  await seedTrustCandidate(pool);
  const fixture = await insertValidConfidenceFixture(pool);

  await assert.rejects(
    pool.query(
      `update candidate_confidence_input_snapshots
          set created_by = 'mutated'
        where candidate_confidence_input_snapshot_id = $1`,
      [fixture.inputSnapshotId],
    ),
    /candidate_confidence_input_snapshots is immutable/,
  );
  await assert.rejects(
    pool.query(
      `delete from candidate_confidence_scores
        where candidate_confidence_score_id = $1`,
      [fixture.scoreId],
    ),
    /candidate_confidence_scores is immutable/,
  );
  await pool.end();
});

test('database rejects inconsistent confidence score totals and bands', async () => {
  const pool = await resetDatabase();
  await seedTrustCandidate(pool);
  const inputSnapshotId = randomUUID();
  const inputHash = 'b'.repeat(64);
  const evaluatedAt = new Date('2026-08-25T00:00:00.000Z');

  await pool.query(
    `insert into candidate_confidence_input_snapshots
      (candidate_confidence_input_snapshot_id, candidate_id,
       candidate_revision_id, patch_id, catalog_revision_id,
       scoring_version, provenance_quality, supporting_source_count,
       has_exact_patch_support, has_revalidated_cross_patch_support,
       newest_supporting_evidence_at, evaluated_at, input_hash, created_by)
     values ($1, $2, $3, $4, $5, $6, 20, 1, true, false,
             null, $7, $8, 'confidence-migration-test')`,
    [
      inputSnapshotId,
      CANDIDATE_IDS.candidateId,
      CANDIDATE_IDS.candidateRevisionId,
      CATALOG_IDS.patchId,
      CATALOG_IDS.catalogRevisionId,
      VERSION,
      evaluatedAt,
      inputHash,
    ],
  );

  await assert.rejects(
    pool.query(
      `insert into candidate_confidence_scores
        (candidate_confidence_score_id,
         candidate_confidence_input_snapshot_id, candidate_id,
         candidate_revision_id, patch_id, catalog_revision_id,
         scoring_version, input_hash, evaluated_at,
         provenance_quality_score, evidence_diversity_score,
         patch_alignment_score, freshness_score, score, band,
         reason, actor_id, correlation_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9,
               20, 10, 20, 15, 64, 'medium',
               'invalid sum', 'test', 'test')`,
      [
        randomUUID(),
        inputSnapshotId,
        CANDIDATE_IDS.candidateId,
        CANDIDATE_IDS.candidateRevisionId,
        CATALOG_IDS.patchId,
        CATALOG_IDS.catalogRevisionId,
        VERSION,
        inputHash,
        evaluatedAt,
      ],
    ),
    /candidate_confidence_scores_component_sum_check/,
  );

  await assert.rejects(
    pool.query(
      `insert into candidate_confidence_scores
        (candidate_confidence_score_id,
         candidate_confidence_input_snapshot_id, candidate_id,
         candidate_revision_id, patch_id, catalog_revision_id,
         scoring_version, input_hash, evaluated_at,
         provenance_quality_score, evidence_diversity_score,
         patch_alignment_score, freshness_score, score, band,
         reason, actor_id, correlation_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9,
               20, 10, 20, 15, 65, 'high',
               'invalid band', 'test', 'test')`,
      [
        randomUUID(),
        inputSnapshotId,
        CANDIDATE_IDS.candidateId,
        CANDIDATE_IDS.candidateRevisionId,
        CATALOG_IDS.patchId,
        CATALOG_IDS.catalogRevisionId,
        VERSION,
        inputHash,
        evaluatedAt,
      ],
    ),
    /candidate_confidence_scores_band_check/,
  );
  await pool.end();
});

test('database rejects a confidence snapshot for a mismatched candidate graph', async () => {
  const pool = await resetDatabase();
  await seedTrustCandidate(pool);

  await assert.rejects(
    pool.query(
      `insert into candidate_confidence_input_snapshots
        (candidate_confidence_input_snapshot_id, candidate_id,
         candidate_revision_id, patch_id, catalog_revision_id,
         scoring_version, provenance_quality, supporting_source_count,
         has_exact_patch_support, has_revalidated_cross_patch_support,
         newest_supporting_evidence_at, evaluated_at, input_hash, created_by)
       values ($1, $2, $3, $4, $5, $6, 20, 0, false, false,
               null, $7, $8, 'confidence-migration-test')`,
      [
        randomUUID(),
        randomUUID(),
        CANDIDATE_IDS.candidateRevisionId,
        CATALOG_IDS.patchId,
        CATALOG_IDS.catalogRevisionId,
        VERSION,
        new Date('2026-08-25T00:00:00.000Z'),
        'c'.repeat(64),
      ],
    ),
    /foreign key constraint/,
  );
  await pool.end();
});
