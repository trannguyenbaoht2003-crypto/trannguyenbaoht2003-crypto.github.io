import { randomUUID } from 'node:crypto';

import type { Pool } from 'pg';

import { withTransaction } from '../../database/transaction.js';

export type StoragePermission =
  | 'blob_allowed'
  | 'reference_only'
  | 'aggregate_only'
  | 'prohibited';

export interface ActivateSourcePolicyCommand {
  actorId: string;
  collectorEnabled: boolean;
  correlationId: string;
  reason: string;
  revision: number;
  revisionId: string;
  sourceId: string;
  storagePermission: StoragePermission;
}

export async function activateSourcePolicy(
  pool: Pool,
  command: ActivateSourcePolicyCommand,
): Promise<{ revisionId: string }> {
  return withTransaction(pool, async (client) => {
    await client.query(
      `insert into source_policy_revisions
        (source_policy_revision_id, source_id, revision, storage_permission,
         collector_enabled, reason, created_by)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [
        command.revisionId,
        command.sourceId,
        command.revision,
        command.storagePermission,
        command.collectorEnabled,
        command.reason,
        command.actorId,
      ],
    );
    await client.query(
      `insert into active_source_policies
        (source_id, source_policy_revision_id)
       values ($1, $2)
       on conflict (source_id) do update
       set source_policy_revision_id = excluded.source_policy_revision_id,
           activated_at = clock_timestamp()`,
      [command.sourceId, command.revisionId],
    );
    await client.query(
      `insert into audit_events
        (audit_event_id, actor_id, action, reason, correlation_id, policy_version, payload)
       values ($1, $2, 'source_policy.activated', $3, $4, $5, $6::jsonb)`,
      [
        randomUUID(),
        command.actorId,
        command.reason,
        command.correlationId,
        String(command.revision),
        JSON.stringify({
          sourceId: command.sourceId,
          sourcePolicyRevisionId: command.revisionId,
        }),
      ],
    );
    await client.query(
      `insert into outbox_events
        (outbox_event_id, aggregate_type, aggregate_id, event_type, payload, correlation_id)
       values ($1, 'source_policy', $2, 'SourcePolicyActivated', $3::jsonb, $4)`,
      [
        randomUUID(),
        command.sourceId,
        JSON.stringify({
          sourceId: command.sourceId,
          sourcePolicyRevisionId: command.revisionId,
        }),
        command.correlationId,
      ],
    );
    return { revisionId: command.revisionId };
  });
}
