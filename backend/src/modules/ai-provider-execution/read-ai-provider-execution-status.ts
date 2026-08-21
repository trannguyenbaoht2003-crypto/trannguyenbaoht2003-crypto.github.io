import type { Pool } from 'pg';

export interface ReadAiProviderExecutionStatusOptions {
  executionId?:string;
  runId?:string;
  limit?:number;
}

export interface AiProviderExecutionStatusReadModel {
  executionId:string;
  aiDiscoveryRunId:string;
  status:string;
  currentAttemptOrdinal:number;
  leaseExpiresAt:string|null;
  terminalAt:string|null;
  attempts:Array<{
    attemptId:string;ordinal:number;clientRequestId:string;status:string;failureCode:string|null;
    providerRequestId:string|null;providerResponseId:string|null;preparedAt:string;dispatchStartedAt:string|null;completedAt:string|null;
    reconciliationDecision:string|null;
  }>;
}

function iso(value:Date|string|null):string|null {
  if (value===null) return null;
  return (value instanceof Date?value:new Date(value)).toISOString();
}

export async function readAiProviderExecutionStatus(
  pool:Pool,
  options:ReadAiProviderExecutionStatusOptions={},
):Promise<AiProviderExecutionStatusReadModel[]> {
  const limit=options.limit??20;
  if (!Number.isSafeInteger(limit)||limit<1||limit>100) throw new Error('AI_PROVIDER_STATUS_LIMIT_INVALID');
  const executions=await pool.query<{
    ai_provider_execution_id:string;ai_discovery_run_id:string;status:string;current_attempt_ordinal:number;
    lease_expires_at:Date|string|null;terminal_at:Date|string|null;
  }>(
    `select ai_provider_execution_id,ai_discovery_run_id,status,current_attempt_ordinal,lease_expires_at,terminal_at
       from ai_provider_executions
      where ($1::uuid is null or ai_provider_execution_id=$1)
        and ($2::uuid is null or ai_discovery_run_id=$2)
      order by created_at desc,ai_provider_execution_id desc
      limit $3`,[options.executionId??null,options.runId??null,limit],
  );
  const result:AiProviderExecutionStatusReadModel[]=[];
  for (const execution of executions.rows) {
    const attempts=await pool.query<{
      ai_provider_execution_attempt_id:string;ordinal:number;client_request_id:string;status:string;failure_code:string|null;
      provider_request_id:string|null;provider_response_id:string|null;prepared_at:Date|string;dispatch_started_at:Date|string|null;completed_at:Date|string|null;decision:string|null;
    }>(
      `select a.ai_provider_execution_attempt_id,a.ordinal,a.client_request_id,a.status,a.failure_code,
              a.provider_request_id,a.provider_response_id,a.prepared_at,a.dispatch_started_at,a.completed_at,r.decision
         from ai_provider_execution_attempts a
         left join ai_provider_execution_reconciliations r
           on r.ai_provider_execution_attempt_id=a.ai_provider_execution_attempt_id
        where a.ai_provider_execution_id=$1 order by a.ordinal asc`,[execution.ai_provider_execution_id],
    );
    result.push({
      executionId:execution.ai_provider_execution_id,aiDiscoveryRunId:execution.ai_discovery_run_id,
      status:execution.status,currentAttemptOrdinal:execution.current_attempt_ordinal,
      leaseExpiresAt:iso(execution.lease_expires_at),terminalAt:iso(execution.terminal_at),
      attempts:attempts.rows.map((a)=>({attemptId:a.ai_provider_execution_attempt_id,ordinal:a.ordinal,clientRequestId:a.client_request_id,status:a.status,failureCode:a.failure_code,providerRequestId:a.provider_request_id,providerResponseId:a.provider_response_id,preparedAt:iso(a.prepared_at)!,dispatchStartedAt:iso(a.dispatch_started_at),completedAt:iso(a.completed_at),reconciliationDecision:a.decision})),
    });
  }
  return result;
}
