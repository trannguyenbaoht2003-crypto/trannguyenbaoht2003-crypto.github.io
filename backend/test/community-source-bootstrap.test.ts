import assert from 'node:assert/strict';
import test from 'node:test';

import {
  bootstrapCommunitySource,
} from '../src/modules/community/bootstrap-community-source.js';
import { activateSourcePolicy } from '../src/modules/source-policy/activate-source-policy.js';
import { resetDatabase, tableCount } from './helpers/database.js';

test('community source bootstrap is idempotent and leaves one governed active policy', async () => {
  const pool = await resetDatabase();

  const first = await bootstrapCommunitySource(pool);
  const second = await bootstrapCommunitySource(pool);

  assert.deepEqual(second, first);
  assert.equal(await tableCount(pool, 'sources'), 1);
  assert.equal(await tableCount(pool, 'source_policy_revisions'), 1);
  assert.equal(await tableCount(pool, 'active_source_policies'), 1);
  assert.equal(await tableCount(pool, 'audit_events'), 1);
  assert.equal(await tableCount(pool, 'outbox_events'), 1);

  const policy = await pool.query<{
    collector_enabled: boolean;
    source_key: string;
    storage_permission: string;
  }>(`
    select s.source_key, spr.storage_permission, spr.collector_enabled
      from active_source_policies asp
      join sources s on s.source_id = asp.source_id
      join source_policy_revisions spr
        on spr.source_policy_revision_id = asp.source_policy_revision_id
     where s.source_key = 'community-collector-v1'
  `);
  assert.deepEqual(policy.rows[0], {
    source_key: 'community-collector-v1',
    storage_permission: 'blob_allowed',
    collector_enabled: true,
  });
  await pool.end();
});

test('community bootstrap fails closed instead of overwriting an operator policy revision', async () => {
  const pool = await resetDatabase();
  const baseline = await bootstrapCommunitySource(pool);

  await activateSourcePolicy(pool, {
    actorId: 'operator-1',
    collectorEnabled: false,
    correlationId: 'operator-policy-change',
    reason: 'operator suspended collector pending review',
    revision: 2,
    revisionId: '6b000000-0000-4000-8000-000000000099',
    sourceId: baseline.sourceId,
    storagePermission: 'prohibited',
  });

  await assert.rejects(
    bootstrapCommunitySource(pool),
    /COMMUNITY_SOURCE_POLICY_CONFLICT/,
  );

  const active = await pool.query<{ revision: number }>(`
    select spr.revision
      from active_source_policies asp
      join source_policy_revisions spr
        on spr.source_policy_revision_id = asp.source_policy_revision_id
     where asp.source_id = $1
  `, [baseline.sourceId]);
  assert.equal(active.rows[0]?.revision, 2);
  await pool.end();
});