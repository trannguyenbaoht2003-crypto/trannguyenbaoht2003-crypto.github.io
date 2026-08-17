import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { resetDatabase } from './helpers/database.js';

test('AI discovery migration reserves a safe non-collector source', async () => {
  const pool = await resetDatabase();
  const result = await pool.query<{
    source_key: string;
    display_name: string;
    status: string;
    storage_permission: string;
    collector_enabled: boolean;
  }>(
    `select source.source_key,
            source.display_name,
            source.status,
            policy.storage_permission,
            policy.collector_enabled
       from sources source
       join active_source_policies active
         on active.source_id = source.source_id
       join source_policy_revisions policy
         on policy.source_policy_revision_id = active.source_policy_revision_id
      where source.source_key = 'ai-discovery'`,
  );

  assert.deepEqual(result.rows[0], {
    source_key: 'ai-discovery',
    display_name: 'AI Discovery',
    status: 'active',
    storage_permission: 'aggregate_only',
    collector_enabled: false,
  });
  await pool.end();
});

test('AI discovery migration creates immutable authority tables', async () => {
  const pool = await resetDatabase();
  const runId = randomUUID();
  const proposalId = randomUUID();

  await pool.query(
    `insert into ai_discovery_runs
      (ai_discovery_run_id, run_key, provider_key, model_key,
       model_revision, prompt_template_key, prompt_template_version,
       input_hash, output_hash, status, started_at, completed_at)
     values ($1, 'run-test', 'fixture-provider', 'fixture-model', 'r1',
             'aram-discovery', 1, $2, $3, 'completed',
             '2026-08-17T05:00:00Z', '2026-08-17T05:00:01Z')`,
    [runId, 'a'.repeat(64), 'b'.repeat(64)],
  );
  await pool.query(
    `insert into ai_candidate_proposals
      (ai_candidate_proposal_id, ai_discovery_run_id, ordinal,
       proposal_hash, patch_key, game_mode_external_id,
       subject_external_id, augment_external_ids, item_external_ids, rationale)
     values ($1, $2, 0, $3, '26.17', 'aram_mayhem', 'samira',
             '["1194"]'::jsonb, '["3006"]'::jsonb, 'plain text')`,
    [proposalId, runId, 'c'.repeat(64)],
  );

  await assert.rejects(
    pool.query(`update ai_discovery_runs set model_key='changed' where ai_discovery_run_id=$1`, [runId]),
    /immutable/,
  );
  await assert.rejects(
    pool.query(`delete from ai_candidate_proposals where ai_candidate_proposal_id=$1`, [proposalId]),
    /immutable/,
  );
  await pool.end();
});
