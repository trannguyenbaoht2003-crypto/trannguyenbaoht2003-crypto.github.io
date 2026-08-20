import type { Pool } from 'pg';

import { withTransaction } from '../../database/transaction.js';

export interface RecoverStaleAiProviderExecutionsOptions { limit?: number; }
export interface RecoverStaleAiProviderExecutionsResult { preparedRecovered:number; inFlightMarkedUncertain:number; }

export async function recoverStaleAiProviderExecutions(
  pool:Pool,
  options:RecoverStaleAiProviderExecutionsOptions={},
):Promise<RecoverStaleAiProviderExecutionsResult> {
  const limit=options.limit??100;
  if (!Number.isSafeInteger(limit) || limit<1 || limit>1000) throw new Error('AI_PROVIDER_RECOVERY_LIMIT_INVALID');
  return withTransaction(pool,async(client)=>{
    const stale=await client.query<{ai_provider_execution_id:string;status:'PREPARED'|'IN_FLIGHT';current_attempt_ordinal:number}>(
      `select ai_provider_execution_id,status,current_attempt_ordinal
         from ai_provider_executions
        where status in ('PREPARED','IN_FLIGHT')
          and lease_expires_at is not null
          and lease_expires_at <= clock_timestamp()
        order by lease_expires_at asc,ai_provider_execution_id asc
        for update skip locked
        limit $1`,[limit],
    );
    let preparedRecovered=0;
    let inFlightMarkedUncertain=0;
    for (const row of stale.rows) {
      if (row.status==='PREPARED') {
        await client.query(
          `update ai_provider_executions
              set lease_token=null,leased_at=null,lease_expires_at=null,updated_at=clock_timestamp()
            where ai_provider_execution_id=$1 and status='PREPARED'`,[row.ai_provider_execution_id],
        );
        preparedRecovered+=1;
        continue;
      }
      await client.query(
        `update ai_provider_execution_attempts
            set status='UNCERTAIN',failure_code='PROVIDER_EXECUTION_LEASE_EXPIRED',completed_at=clock_timestamp()
          where ai_provider_execution_id=$1 and ordinal=$2 and status='IN_FLIGHT'`,
        [row.ai_provider_execution_id,row.current_attempt_ordinal],
      );
      await client.query(
        `update ai_provider_executions
            set status='UNCERTAIN',lease_token=null,leased_at=null,lease_expires_at=null,updated_at=clock_timestamp()
          where ai_provider_execution_id=$1 and status='IN_FLIGHT'`,[row.ai_provider_execution_id],
      );
      inFlightMarkedUncertain+=1;
    }
    return {preparedRecovered,inFlightMarkedUncertain};
  });
}
