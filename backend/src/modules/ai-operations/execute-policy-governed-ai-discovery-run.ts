import type { Pool } from 'pg';

import type { RecordAiDiscoveryRunResult } from '../ai-discovery/types.js';
import {
  processAiProviderExecution,
  type ProcessAiProviderExecutionDependencies,
} from '../ai-provider-execution/process-ai-provider-execution.js';
import {
  executeAiDiscoveryProviderRun,
  type ExecuteAiDiscoveryProviderRunCommand,
  type ExecuteAiDiscoveryProviderRunDependencies,
} from '../ai-provider/execute-ai-discovery-provider-run.js';
import { normalizeAiProviderExecutionInput } from '../ai-provider/normalize-provider-execution-input.js';
import { AiProviderError, type AiDiscoveryProvider } from '../ai-provider/openai-responses-provider.js';
import { reserveAiOperationsRunBudget } from './reserve-ai-operations-run-budget.js';
import type {
  ExecutePolicyGovernedAiDiscoveryRunCommand,
  ExecutePolicyGovernedAiDiscoveryRunResult,
  ReserveAiOperationsRunBudgetCommand,
  ReserveAiOperationsRunBudgetResult,
} from './types.js';

export type { ExecutePolicyGovernedAiDiscoveryRunCommand, ExecutePolicyGovernedAiDiscoveryRunResult } from './types.js';

type ReserveBudget=(pool:Pool,command:ReserveAiOperationsRunBudgetCommand)=>Promise<ReserveAiOperationsRunBudgetResult>;
type ExecuteRun=(pool:Pool,command:ExecuteAiDiscoveryProviderRunCommand,dependencies?:ExecuteAiDiscoveryProviderRunDependencies)=>Promise<RecordAiDiscoveryRunResult>;

export interface ExecutePolicyGovernedAiDiscoveryRunDependencies {
  reserveBudget?:ReserveBudget;
  executeRun?:ExecuteRun;
  now?:()=>string;
  sleep?:(milliseconds:number)=>Promise<void>;
  minimumIntervalFloorSeconds?:number;
  processExecution?:typeof processAiProviderExecution;
}

function cappedProvider(provider:AiDiscoveryProvider,max:number):AiDiscoveryProvider {
  return {providerKey:provider.providerKey,async execute(request,options){
    const result=await provider.execute(request,options);
    if (result.proposals.length>max) throw new AiProviderError('AI_OPERATIONS_PROPOSAL_CAP_EXCEEDED',false,'PROVIDER_RESPONSE_INVALID',result.providerRequestId);
    return result;
  }};
}

async function legacyInjectedPath(
  pool:Pool,
  command:ExecutePolicyGovernedAiDiscoveryRunCommand,
  dependencies:ExecutePolicyGovernedAiDiscoveryRunDependencies,
):Promise<ExecutePolicyGovernedAiDiscoveryRunResult> {
  const normalized=normalizeAiProviderExecutionInput(command.input);
  const reserveBudget=dependencies.reserveBudget??reserveAiOperationsRunBudget;
  const reservation=await reserveBudget(pool,{actorId:command.actorId,correlationId:command.correlationId,idempotencyKey:command.idempotencyKey,aiDiscoveryRunId:command.aiDiscoveryRunId,runKey:normalized.runKey,gameModeExternalId:normalized.gameModeExternalId});
  const executeRun=dependencies.executeRun??executeAiDiscoveryProviderRun;
  const providerDependencies:ExecuteAiDiscoveryProviderRunDependencies={};
  if (dependencies.now) providerDependencies.now=dependencies.now;
  if (dependencies.sleep) providerDependencies.sleep=dependencies.sleep;
  const run=await executeRun(pool,{actorId:command.actorId,correlationId:command.correlationId,idempotencyKey:command.idempotencyKey,aiDiscoveryRunId:command.aiDiscoveryRunId,provider:cappedProvider(command.provider,reservation.maxProposalsPerRun),modelKey:command.modelKey,modelRevision:command.modelRevision,input:normalized,startedAt:command.startedAt},providerDependencies);
  return {...run,aiOperationsRunBudgetReservationId:reservation.aiOperationsRunBudgetReservationId,aiOperationsPolicyRevisionId:reservation.aiOperationsPolicyRevisionId,budgetReplayed:reservation.replayed};
}

export async function executePolicyGovernedAiDiscoveryRun(
  pool:Pool,
  command:ExecutePolicyGovernedAiDiscoveryRunCommand,
  dependencies:ExecutePolicyGovernedAiDiscoveryRunDependencies={},
):Promise<ExecutePolicyGovernedAiDiscoveryRunResult> {
  if (dependencies.reserveBudget || dependencies.executeRun) return legacyInjectedPath(pool,command,dependencies);
  const process=dependencies.processExecution??processAiProviderExecution;
  const processDependencies:ProcessAiProviderExecutionDependencies={};
  if (dependencies.now) processDependencies.now=dependencies.now;
  if (dependencies.sleep) processDependencies.sleep=dependencies.sleep;
  const result=await process(pool,{...command,minimumIntervalFloorSeconds:dependencies.minimumIntervalFloorSeconds??0},processDependencies);
  if (result.kind==='UNCERTAIN') throw new Error('AI_PROVIDER_EXECUTION_UNCERTAIN');
  return {...result.run,aiOperationsRunBudgetReservationId:result.reservation.aiOperationsRunBudgetReservationId,aiOperationsPolicyRevisionId:result.reservation.aiOperationsPolicyRevisionId,budgetReplayed:result.reservation.replayed};
}
