import { randomUUID } from 'node:crypto';

import type { Pool } from 'pg';

import { withTransaction } from '../../database/transaction.js';
import { deterministicAiProviderClientRequestId } from './client-request-id.js';
import type { AiProviderReconciliationDecision } from './types.js';

export interface ReconcileAiProviderExecutionCommand {
  actorId:string;
  correlationId:string;
  attemptId:string;
  decision:AiProviderReconciliationDecision;
  reasonCode:string;
  evidenceReference:string;
}

export interface ReconcileAiProviderExecutionResult {
  reconciliationId:string;
  executionId:string;
  decision:AiProviderReconciliationDecision;
  reopened:boolean;
  nextAttemptId:string|null;
}

function bounded(value:string,max:number):string {
  if (typeof value!=='string' || value.length===0 || value!==value.trim() || Buffer.byteLength(value,'utf8')>max) throw new Error('AI_PROVIDER_RECONCILIATION_INPUT_INVALID');
  return value;
}

export async function reconcileAiProviderExecution(
  pool:Pool,
  command:ReconcileAiProviderExecutionCommand,
):Promise<ReconcileAiProviderExecutionResult> {
  const actorId=bounded(command.actorId,256);
  const correlationId=bounded(command.correlationId,256);
  const reasonCode=bounded(command.reasonCode,128);
  const evidenceReference=bounded(command.evidenceReference,512);
  if (!['CONFIRMED_NOT_RECEIVED','CONFIRMED_RECEIVED','ABANDONED'].includes(command.decision)) throw new Error('AI_PROVIDER_RECONCILIATION_INPUT_INVALID');
  return withTransaction(pool,async(client)=>{
    const target=await client.query<{
      ai_provider_execution_id:string;ordinal:1|2|3;status:string;current_attempt_ordinal:1|2|3;
    }>(
      `select a.ai_provider_execution_id,a.ordinal,a.status,e.current_attempt_ordinal
         from ai_provider_execution_attempts a
         join ai_provider_executions e on e.ai_provider_execution_id=a.ai_provider_execution_id
        where a.ai_provider_execution_attempt_id=$1
        for update of a,e`,[command.attemptId],
    );
    const row=target.rows[0];
    if (!row || row.status!=='UNCERTAIN' || row.ordinal!==row.current_attempt_ordinal) throw new Error('AI_PROVIDER_RECONCILIATION_TARGET_INVALID');
    const reconciliationId=randomUUID();
    await client.query(
      `insert into ai_provider_execution_reconciliations
        (ai_provider_execution_reconciliation_id,ai_provider_execution_id,ai_provider_execution_attempt_id,
         decision,actor_id,reason_code,evidence_reference)
       values ($1,$2,$3,$4,$5,$6,$7)`,
      [reconciliationId,row.ai_provider_execution_id,command.attemptId,command.decision,actorId,reasonCode,evidenceReference],
    );
    let nextAttemptId:string|null=null;
    let reopened=false;
    if (command.decision==='CONFIRMED_NOT_RECEIVED' && row.ordinal<3) {
      const nextOrdinal=(row.ordinal+1) as 2|3;
      nextAttemptId=randomUUID();
      const clientRequestId=deterministicAiProviderClientRequestId(row.ai_provider_execution_id,nextOrdinal);
      await client.query(
        `insert into ai_provider_execution_attempts
          (ai_provider_execution_attempt_id,ai_provider_execution_id,ordinal,client_request_id,status)
         values ($1,$2,$3,$4,'PREPARED')`,
        [nextAttemptId,row.ai_provider_execution_id,nextOrdinal,clientRequestId],
      );
      await client.query(
        `update ai_provider_executions
            set status='PREPARED',current_attempt_ordinal=$2,terminal_at=null,
                lease_token=null,leased_at=null,lease_expires_at=null,updated_at=clock_timestamp()
          where ai_provider_execution_id=$1`,[row.ai_provider_execution_id,nextOrdinal],
      );
      reopened=true;
    } else {
      await client.query(
        `update ai_provider_executions
            set terminal_at=coalesce(terminal_at,clock_timestamp()),
                lease_token=null,leased_at=null,lease_expires_at=null,updated_at=clock_timestamp()
          where ai_provider_execution_id=$1 and status='UNCERTAIN'`,[row.ai_provider_execution_id],
      );
    }
    await client.query(
      `insert into audit_events
        (audit_event_id,actor_id,action,reason,correlation_id,payload)
       values ($1,$2,'ai.provider_execution.reconciled',$3,$4,$5::jsonb)`,
      [randomUUID(),actorId,'AI provider execution uncertainty reconciled',correlationId,JSON.stringify({
        aiProviderExecutionReconciliationId:reconciliationId,
        aiProviderExecutionId:row.ai_provider_execution_id,
        aiProviderExecutionAttemptId:command.attemptId,
        decision:command.decision,reasonCode,evidenceReference,reopened,nextAttemptId,
      })],
    );
    return {reconciliationId,executionId:row.ai_provider_execution_id,decision:command.decision,reopened,nextAttemptId};
  });
}
