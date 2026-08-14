import { randomUUID } from 'node:crypto';

import type { Pool } from 'pg';

import { withTransaction } from '../../database/transaction.js';

const SOURCE_ID = '6b000000-0000-4000-8000-000000000001';
const SOURCE_POLICY_REVISION_ID = '6b000000-0000-4000-8000-000000000002';
const SOURCE_KEY = 'community-collector-v1';
const DISPLAY_NAME = 'Community Collector v1';

interface SourceRow {
  source_id: string;
  status: string;
}

interface PolicyRow {
  collector_enabled: boolean;
  revision: number;
  source_policy_revision_id: string;
  storage_permission: string;
}

export interface CommunitySourceAuthority {
  sourceId: string;
  sourcePolicyRevisionId: string;
}

export async function bootstrapCommunitySource(
  pool: Pool,
): Promise<CommunitySourceAuthority> {
  return withTransaction(pool, async (client) => {
    await client.query(
      `insert into sources (source_id, source_key, display_name, status)
       values ($1, $2, $3, 'active')
       on conflict (source_key) do nothing`,
      [SOURCE_ID, SOURCE_KEY, DISPLAY_NAME],
    );

    const sourceResult = await client.query<SourceRow>(
      `select source_id, status
         from sources
        where source_key = $1
        for update`,
      [SOURCE_KEY],
    );
    const source = sourceResult.rows[0];
    if (!source || source.status !== 'active') {
      throw new Error('COMMUNITY_SOURCE_NOT_ACTIVE');
    }

    await client.query(
      `insert into source_policy_revisions
        (source_policy_revision_id, source_id, revision, storage_permission,
         collector_enabled, reason, created_by)
       values ($1, $2, 1, 'blob_allowed', true,
               'Sprint 6B governed community discovery intake',
               'community-bootstrap')
       on conflict (source_id, revision) do nothing`,
      [SOURCE_POLICY_REVISION_ID, source.source_id],
    );

    const revisionResult = await client.query<PolicyRow>(
      `select source_policy_revision_id, revision, storage_permission,
              collector_enabled
         from source_policy_revisions
        where source_id = $1 and revision = 1`,
      [source.source_id],
    );
    const revision = revisionResult.rows[0];
    if (
      !revision
      || revision.source_policy_revision_id !== SOURCE_POLICY_REVISION_ID
      || revision.revision !== 1
      || revision.storage_permission !== 'blob_allowed'
      || revision.collector_enabled !== true
    ) {
      throw new Error('COMMUNITY_SOURCE_POLICY_CONFLICT');
    }

    const activated = await client.query(
      `insert into active_source_policies (source_id, source_policy_revision_id)
       values ($1, $2)
       on conflict (source_id) do nothing
       returning source_id`,
      [source.source_id, SOURCE_POLICY_REVISION_ID],
    );

    const activeResult = await client.query<PolicyRow>(
      `select spr.source_policy_revision_id, spr.revision,
              spr.storage_permission, spr.collector_enabled
         from active_source_policies asp
         join source_policy_revisions spr
           on spr.source_policy_revision_id = asp.source_policy_revision_id
        where asp.source_id = $1
        for update of asp`,
      [source.source_id],
    );
    const active = activeResult.rows[0];
    if (
      !active
      || active.source_policy_revision_id !== SOURCE_POLICY_REVISION_ID
      || active.revision !== 1
      || active.storage_permission !== 'blob_allowed'
      || active.collector_enabled !== true
    ) {
      throw new Error('COMMUNITY_SOURCE_POLICY_CONFLICT');
    }

    if ((activated.rowCount ?? 0) > 0) {
      const correlationId = `community-source-bootstrap:${SOURCE_POLICY_REVISION_ID}`;
      await client.query(
        `insert into audit_events
          (audit_event_id, actor_id, action, reason, correlation_id,
           policy_version, payload)
         values ($1, 'community-bootstrap', 'source_policy.activated',
                 'Sprint 6B governed community discovery intake',
                 $2, '1', $3::jsonb)`,
        [
          randomUUID(),
          correlationId,
          JSON.stringify({
            sourceId: source.source_id,
            sourceKey: SOURCE_KEY,
            sourcePolicyRevisionId: SOURCE_POLICY_REVISION_ID,
          }),
        ],
      );
      await client.query(
        `insert into outbox_events
          (outbox_event_id, aggregate_type, aggregate_id, event_type,
           payload, correlation_id)
         values ($1, 'source_policy', $2, 'SourcePolicyActivated',
                 $3::jsonb, $4)`,
        [
          randomUUID(),
          source.source_id,
          JSON.stringify({
            sourceId: source.source_id,
            sourcePolicyRevisionId: SOURCE_POLICY_REVISION_ID,
          }),
          correlationId,
        ],
      );
    }

    return {
      sourceId: source.source_id,
      sourcePolicyRevisionId: SOURCE_POLICY_REVISION_ID,
    };
  });
}