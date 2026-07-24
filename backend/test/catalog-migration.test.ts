import assert from 'node:assert/strict';
import test from 'node:test';

import type { Pool } from 'pg';

import { resetDatabase } from './helpers/database.js';

async function seedMinimalSealedCatalog(pool: Pool): Promise<void> {
  await pool.query(`
    insert into sources
      (source_id, source_key, display_name)
    values
      ('30000000-0000-4000-8000-000000000001',
       'catalog-source',
       'Catalog source');

    insert into source_policy_revisions
      (source_policy_revision_id, source_id, revision, storage_permission,
       collector_enabled, reason, created_by)
    values
      ('30000000-0000-4000-8000-000000000002',
       '30000000-0000-4000-8000-000000000001',
       1, 'reference_only', true, 'test', 'test');

    insert into patches (patch_id, patch_key, display_label)
    values
      ('30000000-0000-4000-8000-000000000003', '26.15', '26.15');

    insert into catalog_revisions
      (catalog_revision_id, patch_id, revision, status,
       source_policy_revision_id)
    values
      ('30000000-0000-4000-8000-000000000004',
       '30000000-0000-4000-8000-000000000003',
       1, 'draft',
       '30000000-0000-4000-8000-000000000002');

    insert into game_entities
      (game_entity_id, entity_type, canonical_external_id)
    values
      ('30000000-0000-4000-8000-000000000005', 'champion', 'samira');

    insert into game_entity_revisions
      (game_entity_revision_id, game_entity_id, catalog_revision_id,
       display_name, active)
    values
      ('30000000-0000-4000-8000-000000000006',
       '30000000-0000-4000-8000-000000000005',
       '30000000-0000-4000-8000-000000000004',
       'Samira', true);

    insert into compatibility_rules
      (compatibility_rule_id, catalog_revision_id, rule_key,
       constraint_type, definition)
    values
      ('30000000-0000-4000-8000-000000000008',
       '30000000-0000-4000-8000-000000000004',
       'test-rule', 'limit',
       '{"modeExternalId":"aram_mayhem","entityType":"augment","maxSelections":3}'::jsonb);

    insert into catalog_revision_seals
      (catalog_revision_id, schema_version, adapter_version, source_digest,
       game_mode_external_id, content_hash, entity_count, rule_count,
       sealed_by)
    values
      ('30000000-0000-4000-8000-000000000004',
       1, 'test', repeat('a', 64), 'aram_mayhem', repeat('b', 64),
       1, 1, 'test');

    insert into catalog_validation_results
      (catalog_validation_result_id, catalog_revision_id,
       sealed_content_hash, validator_ruleset_version, result,
       reason_codes, validated_by)
    values
      ('30000000-0000-4000-8000-000000000007',
       '30000000-0000-4000-8000-000000000004',
       repeat('b', 64), 'catalog-rules-v1', 'passed',
       array[]::text[], 'test');

    insert into catalog_lifecycle_events
      (catalog_lifecycle_event_id, catalog_revision_id, lifecycle_state,
       reason, actor_id, correlation_id)
    values
      ('30000000-0000-4000-8000-000000000009',
       '30000000-0000-4000-8000-000000000004',
       'imported', 'test', 'test', 'catalog-test');
  `);
}

test('sealed catalog rejects later entity revision and rule inserts', async () => {
  const pool = await resetDatabase();
  await seedMinimalSealedCatalog(pool);

  await assert.rejects(
    pool.query(`
      insert into game_entities
        (game_entity_id, entity_type, canonical_external_id)
      values
        ('30000000-0000-4000-8000-000000000010', 'champion', 'jinx');
      insert into game_entity_revisions
        (game_entity_revision_id, game_entity_id, catalog_revision_id,
         display_name, active)
      values
        ('30000000-0000-4000-8000-000000000011',
         '30000000-0000-4000-8000-000000000010',
         '30000000-0000-4000-8000-000000000004',
         'Jinx', true);
    `),
    /sealed/,
  );

  await assert.rejects(
    pool.query(`
      insert into compatibility_rules
        (compatibility_rule_id, catalog_revision_id, rule_key,
         constraint_type, definition)
      values
        ('30000000-0000-4000-8000-000000000012',
         '30000000-0000-4000-8000-000000000004',
         'late-rule', 'limit',
         '{"modeExternalId":"aram_mayhem","entityType":"item","maxSelections":6}'::jsonb)
    `),
    /sealed/,
  );
  await pool.end();
});

test('catalog seal, validation, lifecycle, and entity identity are immutable', async () => {
  const pool = await resetDatabase();
  await seedMinimalSealedCatalog(pool);

  await assert.rejects(
    pool.query(`update catalog_revision_seals set sealed_by = 'changed'`),
    /immutable/,
  );
  await assert.rejects(
    pool.query('delete from catalog_validation_results'),
    /immutable/,
  );
  await assert.rejects(
    pool.query(`update catalog_lifecycle_events set reason = 'changed'`),
    /immutable/,
  );
  await assert.rejects(
    pool.query(`update game_entities set canonical_external_id = 'changed'`),
    /immutable/,
  );
  await pool.end();
});
