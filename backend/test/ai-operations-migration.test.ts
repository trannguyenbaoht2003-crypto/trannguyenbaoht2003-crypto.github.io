import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { resetDatabase } from './helpers/database.js';

test('AI operations migration starts fail-closed with disabled revision 1', async () => {
  const pool = await resetDatabase();
  const result = await pool.query<{
    revision: number;
    enabled: boolean;
    max_runs_per_utc_day: number;
    min_interval_seconds: number;
    max_proposals_per_run: number;
    game_mode_external_id: string;
    reason: string;
    created_by: string;
  }>(
    `select policy.revision,
            policy.enabled,
            policy.max_runs_per_utc_day,
            policy.min_interval_seconds,
            policy.max_proposals_per_run,
            policy.game_mode_external_id,
            policy.reason,
            policy.created_by
       from active_ai_operations_policy_revision active
       join ai_operations_policy_revisions policy
         on policy.ai_operations_policy_revision_id = active.ai_operations_policy_revision_id
      where active.scope = 'ai_discovery_provider'`,
  );

  assert.deepEqual(result.rows[0], {
    revision: 1,
    enabled: false,
    max_runs_per_utc_day: 0,
    min_interval_seconds: 3600,
    max_proposals_per_run: 16,
    game_mode_external_id: 'aram_mayhem',
    reason: 'disabled by default; explicit activation required',
    created_by: 'system:migration:0015',
  });
  await pool.end();
});

test('AI operations policy revisions and budget reservations are append-only', async () => {
  const pool = await resetDatabase();
  const active = await pool.query<{ ai_operations_policy_revision_id: string }>(
    `select ai_operations_policy_revision_id
       from active_ai_operations_policy_revision
      where scope = 'ai_discovery_provider'`,
  );
  const policyRevisionId = active.rows[0]!.ai_operations_policy_revision_id;
  const reservationId = randomUUID();

  await pool.query(
    `insert into ai_operations_run_budget_reservations
      (ai_operations_run_budget_reservation_id, ai_discovery_run_id,
       run_key, ai_operations_policy_revision_id, budget_date,
       max_proposals_per_run, actor_id, correlation_id)
     values ($1,$2,'run-migration-test',$3,
             (timezone('UTC', clock_timestamp()))::date,
             16,'test:actor','test:correlation')`,
    [reservationId, randomUUID(), policyRevisionId],
  );

  await assert.rejects(
    pool.query(
      `update ai_operations_policy_revisions
          set reason = 'changed'
        where ai_operations_policy_revision_id = $1`,
      [policyRevisionId],
    ),
    /immutable/i,
  );
  await assert.rejects(
    pool.query(
      `delete from ai_operations_run_budget_reservations
        where ai_operations_run_budget_reservation_id = $1`,
      [reservationId],
    ),
    /immutable/i,
  );
  await pool.end();
});
