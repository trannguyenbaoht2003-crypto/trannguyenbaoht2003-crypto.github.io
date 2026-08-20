import { randomUUID } from 'node:crypto';

import type { Pool } from 'pg';

import { withTransaction } from '../../database/transaction.js';
import {
  readAiDiscoveryRunReplay,
  type AiDiscoveryRunReplayIdentity,
} from '../ai-discovery/read-ai-discovery-run-replay.js';
import type { RecordAiDiscoveryRunResult } from '../ai-discovery/types.js';
import {
  reserveAiOperationsRunBudgetInTransaction,
  type ReserveAiOperationsRunBudgetOptions,
  type ReserveAiOperationsRunBudgetResult,
} from '../ai-operations/reserve-ai-operations-run-budget.js';
import { deterministicAiProviderClientRequestId } from './client-request-id.js';
import type { AiProviderExecutionStatus } from './types.js';

export interface PrepareAiProviderExecutionCommand extends AiDiscoveryRunReplayIdentity {
  gameModeExternalId: 'aram_mayhem';
}

export type PrepareAiProviderExecutionResult =
  | { kind: 'REPLAYED'; run: RecordAiDiscoveryRunResult }
  | {
      kind: 'PREPARED';
      executionId: string;
      attemptId: string;
      ordinal: 1;
      clientRequestId: string;
      reservation: ReserveAiOperationsRunBudgetResult;
    }
  | {
      kind: 'EXISTING';
      executionId: string;
      status: AiProviderExecutionStatus;
      currentAttemptOrdinal: 1 | 2 | 3;
      reservation: ReserveAiOperationsRunBudgetResult;
    };

interface ExistingRow {
  ai_provider_execution_id: string;
  status: AiProviderExecutionStatus;
  current_attempt_ordinal: 1 | 2 | 3;
  ai_operations_run_budget_reservation_id: string;
  ai_operations_policy_revision_id: string;
  budget_date: string | Date;
  max_proposals_per_run: number;
}

function budgetResult(command:PrepareAiProviderExecutionCommand,row:ExistingRow):ReserveAiOperationsRunBudgetResult {
  const date=row.budget_date instanceof Date ? row.budget_date.toISOString().slice(0,10) : String(row.budget_date).slice(0,10);
  return {
    aiOperationsRunBudgetReservationId:row.ai_operations_run_budget_reservation_id,
    aiDiscoveryRunId:command.aiDiscoveryRunId,
    aiOperationsPolicyRevisionId:row.ai_operations_policy_revision_id,
    budgetDate:date,
    maxProposalsPerRun:row.max_proposals_per_run,
    replayed:true,
  };
}

async function loadExisting(pool:Pool,command:PrepareAiProviderExecutionCommand):Promise<PrepareAiProviderExecutionResult|null> {
  const result=await pool.query<ExistingRow>(
    `select e.ai_provider_execution_id,e.status,e.current_attempt_ordinal,
            r.ai_operations_run_budget_reservation_id,r.ai_operations_policy_revision_id,
            r.budget_date,r.max_proposals_per_run
       from ai_provider_executions e
       join ai_operations_run_budget_reservations r
         on r.ai_operations_run_budget_reservation_id=e.ai_operations_run_budget_reservation_id
      where e.ai_discovery_run_id=$1`,[command.aiDiscoveryRunId],
  );
  const row=result.rows[0];
  if (!row) return null;
  return {kind:'EXISTING',executionId:row.ai_provider_execution_id,status:row.status,currentAttemptOrdinal:row.current_attempt_ordinal,reservation:budgetResult(command,row)};
}

export async function prepareAiProviderExecution(
  pool:Pool,
  command:PrepareAiProviderExecutionCommand,
  options:ReserveAiOperationsRunBudgetOptions,
):Promise<PrepareAiProviderExecutionResult> {
  const replay=await readAiDiscoveryRunReplay(pool,command);
  if (replay) return {kind:'REPLAYED',run:replay};

  const existing=await loadExisting(pool,command);
  if (existing) return existing;

  const historical=await pool.query(
    `select 1 from ai_operations_run_budget_reservations where ai_discovery_run_id=$1 limit 1`,
    [command.aiDiscoveryRunId],
  );
  if (historical.rowCount!==0) throw new Error('AI_PROVIDER_EXECUTION_HISTORICAL_AUTHORIZATION_CONSUMED');

  const executionId=randomUUID();
  const attemptId=randomUUID();
  const clientRequestId=deterministicAiProviderClientRequestId(executionId,1);
  try {
    return await withTransaction(pool,async(client)=>{
      const reservation=await reserveAiOperationsRunBudgetInTransaction(client,{
        actorId:command.actorId,
        correlationId:command.correlationId,
        idempotencyKey:command.idempotencyKey,
        aiDiscoveryRunId:command.aiDiscoveryRunId,
        runKey:command.runKey,
        gameModeExternalId:command.gameModeExternalId,
      },options);
      await client.query(
        `insert into ai_provider_executions
          (ai_provider_execution_id,ai_discovery_run_id,ai_operations_run_budget_reservation_id,
           run_key,idempotency_key,provider_key,model_key,model_revision,prompt_template_key,
           prompt_template_version,input_hash,status,current_attempt_ordinal)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'PREPARED',1)`,
        [executionId,command.aiDiscoveryRunId,reservation.aiOperationsRunBudgetReservationId,command.runKey,
         command.idempotencyKey,command.providerKey,command.modelKey,command.modelRevision,
         command.promptTemplateKey,command.promptTemplateVersion,command.inputHash],
      );
      await client.query(
        `insert into ai_provider_execution_attempts
          (ai_provider_execution_attempt_id,ai_provider_execution_id,ordinal,client_request_id,status)
         values ($1,$2,1,$3,'PREPARED')`,[attemptId,executionId,clientRequestId],
      );
      return {kind:'PREPARED',executionId,attemptId,ordinal:1 as const,clientRequestId,reservation};
    });
  } catch (error) {
    const raced=await loadExisting(pool,command);
    if (raced) return raced;
    throw error;
  }
}
