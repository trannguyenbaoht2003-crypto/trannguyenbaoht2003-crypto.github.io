import { randomUUID } from 'node:crypto';

import type { Pool } from 'pg';

import { withTransaction } from '../../database/transaction.js';

export interface RegisterPatchEventCommand {
  actorId: string;
  correlationId: string;
  displayLabel: string;
  eventId: string;
  lifecycleState: 'announced' | 'active' | 'superseded' | 'withdrawn';
  occurredAt: Date;
  patchId: string;
  patchKey: string;
  reason: string;
}

export async function registerPatchEvent(
  pool: Pool,
  command: RegisterPatchEventCommand,
): Promise<{ eventId: string }> {
  return withTransaction(pool, async (client) => {
    await client.query(
      `insert into patches (patch_id, patch_key, display_label)
       values ($1, $2, $3)
       on conflict (patch_id) do nothing`,
      [command.patchId, command.patchKey, command.displayLabel],
    );
    await client.query(
      `insert into patch_lifecycle_events
        (patch_lifecycle_event_id, patch_id, lifecycle_state, reason,
         actor_id, correlation_id, occurred_at)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [
        command.eventId,
        command.patchId,
        command.lifecycleState,
        command.reason,
        command.actorId,
        command.correlationId,
        command.occurredAt,
      ],
    );
    await client.query(
      `insert into audit_events
        (audit_event_id, actor_id, action, reason, correlation_id, payload)
       values ($1, $2, 'patch.lifecycle_recorded', $3, $4, $5::jsonb)`,
      [
        randomUUID(),
        command.actorId,
        command.reason,
        command.correlationId,
        JSON.stringify({ eventId: command.eventId, patchId: command.patchId }),
      ],
    );
    await client.query(
      `insert into outbox_events
        (outbox_event_id, aggregate_type, aggregate_id, event_type, payload, correlation_id)
       values ($1, 'patch', $2, 'PatchLifecycleRecorded', $3::jsonb, $4)`,
      [
        randomUUID(),
        command.patchId,
        JSON.stringify({
          lifecycleState: command.lifecycleState,
          patchId: command.patchId,
        }),
        command.correlationId,
      ],
    );
    return { eventId: command.eventId };
  });
}
