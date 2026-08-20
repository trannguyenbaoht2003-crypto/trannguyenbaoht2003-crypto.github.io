import type { Pool } from 'pg';

import { withTransaction } from '../../database/transaction.js';

export interface MarkAiProviderAttemptInFlightCommand {
  executionId: string;
  attemptId: string;
  leaseToken: string;
}

export async function markAiProviderAttemptInFlight(
  pool: Pool,
  command: MarkAiProviderAttemptInFlightCommand,
): Promise<void> {
  await withTransaction(pool,async(client)=>{
    const locked=await client.query<{current_attempt_ordinal:number}>(
      `select current_attempt_ordinal
         from ai_provider_executions
        where ai_provider_execution_id=$1
          and status='PREPARED'
          and lease_token=$2
          and lease_expires_at > clock_timestamp()
        for update`,
      [command.executionId,command.leaseToken],
    );
    if (locked.rowCount!==1) throw new Error('AI_PROVIDER_EXECUTION_LEASE_NOT_HELD');
    const attempt=await client.query(
      `update ai_provider_execution_attempts
          set status='IN_FLIGHT',dispatch_started_at=clock_timestamp()
        where ai_provider_execution_attempt_id=$1
          and ai_provider_execution_id=$2
          and ordinal=$3
          and status='PREPARED'
        returning ai_provider_execution_attempt_id`,
      [command.attemptId,command.executionId,locked.rows[0]!.current_attempt_ordinal],
    );
    if (attempt.rowCount!==1) throw new Error('AI_PROVIDER_EXECUTION_ATTEMPT_NOT_CURRENT');
    await client.query(
      `update ai_provider_executions
          set status='IN_FLIGHT',updated_at=clock_timestamp()
        where ai_provider_execution_id=$1`,[command.executionId],
    );
  });
}
