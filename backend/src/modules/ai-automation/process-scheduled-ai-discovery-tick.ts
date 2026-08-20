import { randomUUID } from 'node:crypto';

import type { Pool } from 'pg';

import type { AiDiscoveryProvider } from '../ai-provider/openai-responses-provider.js';
import {
  executePolicyGovernedAiDiscoveryRun,
  type ExecutePolicyGovernedAiDiscoveryRunDependencies,
  type ExecutePolicyGovernedAiDiscoveryRunResult,
} from '../ai-operations/execute-policy-governed-ai-discovery-run.js';
import { buildScheduledAiDiscoveryInput } from './build-scheduled-ai-discovery-input.js';
import type { BuiltScheduledAiDiscoveryInput } from './types.js';

const SCHEDULER_KEY='ai-discovery-hourly-v1';
const SCHEDULED_INTERVAL_SECONDS=3_600;
export type ScheduledAiDiscoveryTickOutcome='DUPLICATE_NOOP'|'NO_NEW_INPUT'|'CADENCE_NOT_ELAPSED'|'POLICY_DISABLED'|'DAILY_BUDGET_EXHAUSTED'|'POLICY_MIN_INTERVAL'|'COMPLETED'|'PROVIDER_FAILED'|'AMBIGUOUS_FAILURE';
export interface ProcessScheduledAiDiscoveryTickCommand {actorId:string;correlationId:string;provider:AiDiscoveryProvider;modelKey:string;modelRevision:string;startedAt:string;}
export interface ProcessScheduledAiDiscoveryTickResult {outcome:ScheduledAiDiscoveryTickOutcome;scheduledAiDiscoveryTickId:string|null;aiDiscoveryRunId:string|null;}
type BuildInput=(pool:Pool)=>Promise<BuiltScheduledAiDiscoveryInput|null>;
type ExecuteRun=(pool:Pool,command:Parameters<typeof executePolicyGovernedAiDiscoveryRun>[1],dependencies?:ExecutePolicyGovernedAiDiscoveryRunDependencies)=>Promise<ExecutePolicyGovernedAiDiscoveryRunResult>;
export interface ProcessScheduledAiDiscoveryTickDependencies {buildInput?:BuildInput;executeRun?:ExecuteRun;newId?:()=>string;}
interface TickClaimRow {scheduled_ai_discovery_tick_id:string;}
interface ReservationRow {ai_operations_run_budget_reservation_id:string;ai_operations_policy_revision_id:string;}
function knownBudgetOutcome(error:unknown):Exclude<ScheduledAiDiscoveryTickOutcome,'DUPLICATE_NOOP'|'NO_NEW_INPUT'|'COMPLETED'|'PROVIDER_FAILED'|'AMBIGUOUS_FAILURE'>|null {
  const message=error instanceof Error?error.message:'';
  if(message==='AI_OPERATIONS_DISABLED')return'POLICY_DISABLED';
  if(message==='AI_OPERATIONS_DAILY_BUDGET_EXHAUSTED')return'DAILY_BUDGET_EXHAUSTED';
  if(message==='AI_OPERATIONS_MIN_INTERVAL_NOT_ELAPSED')return'POLICY_MIN_INTERVAL';
  if(message==='AI_OPERATIONS_SCHEDULED_CADENCE_NOT_ELAPSED')return'CADENCE_NOT_ELAPSED';
  return null;
}
async function claimTick(pool:Pool,id:string):Promise<string|null>{const result=await pool.query<TickClaimRow>(`insert into scheduled_ai_discovery_ticks (scheduled_ai_discovery_tick_id,scheduler_key,utc_hour,status) values ($1,$2,date_trunc('hour',clock_timestamp()),'PROCESSING') on conflict (scheduler_key,utc_hour) do nothing returning scheduled_ai_discovery_tick_id`,[id,SCHEDULER_KEY]);return result.rows[0]?.scheduled_ai_discovery_tick_id??null;}
async function enrichTick(pool:Pool,tickId:string,input:BuiltScheduledAiDiscoveryInput):Promise<void>{await pool.query(`update scheduled_ai_discovery_ticks set scheduled_content_hash=$2,ai_discovery_run_id=$3 where scheduled_ai_discovery_tick_id=$1 and status='PROCESSING'`,[tickId,input.scheduledContentHash,input.aiDiscoveryRunId]);}
async function contentWasBudgetConsumed(pool:Pool,tickId:string,hash:string):Promise<boolean>{const result=await pool.query(`select 1 from scheduled_ai_discovery_ticks tick join ai_operations_run_budget_reservations reservation on reservation.ai_discovery_run_id=tick.ai_discovery_run_id where tick.scheduled_content_hash=$1 and tick.scheduled_ai_discovery_tick_id<>$2 limit 1`,[hash,tickId]);return result.rowCount!==0;}
async function reservationForRun(pool:Pool,runId:string):Promise<ReservationRow|null>{const r=await pool.query<ReservationRow>(`select ai_operations_run_budget_reservation_id,ai_operations_policy_revision_id from ai_operations_run_budget_reservations where ai_discovery_run_id=$1`,[runId]);return r.rows[0]??null;}
async function finalizeTick(pool:Pool,tickId:string,outcome:Exclude<ScheduledAiDiscoveryTickOutcome,'DUPLICATE_NOOP'>,links:{policyRevisionId?:string;budgetReservationId?:string}={}):Promise<void>{await pool.query(`update scheduled_ai_discovery_ticks set status=$2,ai_operations_policy_revision_id=coalesce($3,ai_operations_policy_revision_id),ai_operations_run_budget_reservation_id=coalesce($4,ai_operations_run_budget_reservation_id),completed_at=clock_timestamp() where scheduled_ai_discovery_tick_id=$1 and status='PROCESSING'`,[tickId,outcome,links.policyRevisionId??null,links.budgetReservationId??null]);}

export async function processScheduledAiDiscoveryTick(pool:Pool,command:ProcessScheduledAiDiscoveryTickCommand,dependencies:ProcessScheduledAiDiscoveryTickDependencies={}):Promise<ProcessScheduledAiDiscoveryTickResult>{
  const tickId=await claimTick(pool,(dependencies.newId??randomUUID)());
  if(!tickId)return{outcome:'DUPLICATE_NOOP',scheduledAiDiscoveryTickId:null,aiDiscoveryRunId:null};
  const buildInput=dependencies.buildInput??buildScheduledAiDiscoveryInput;
  let built:BuiltScheduledAiDiscoveryInput|null=null;
  try{
    built=await buildInput(pool);
    if(!built){await finalizeTick(pool,tickId,'NO_NEW_INPUT');return{outcome:'NO_NEW_INPUT',scheduledAiDiscoveryTickId:tickId,aiDiscoveryRunId:null};}
    await enrichTick(pool,tickId,built);
    if(await contentWasBudgetConsumed(pool,tickId,built.scheduledContentHash)){await finalizeTick(pool,tickId,'NO_NEW_INPUT');return{outcome:'NO_NEW_INPUT',scheduledAiDiscoveryTickId:tickId,aiDiscoveryRunId:built.aiDiscoveryRunId};}
    const executeRun=dependencies.executeRun??executePolicyGovernedAiDiscoveryRun;
    const result=await executeRun(pool,{actorId:command.actorId,correlationId:command.correlationId,idempotencyKey:built.idempotencyKey,aiDiscoveryRunId:built.aiDiscoveryRunId,provider:command.provider,modelKey:command.modelKey,modelRevision:command.modelRevision,input:built.input,startedAt:command.startedAt},{minimumIntervalFloorSeconds:SCHEDULED_INTERVAL_SECONDS});
    const outcome=result.status==='completed'?'COMPLETED':'PROVIDER_FAILED';
    await finalizeTick(pool,tickId,outcome,{policyRevisionId:result.aiOperationsPolicyRevisionId,budgetReservationId:result.aiOperationsRunBudgetReservationId});
    return{outcome,scheduledAiDiscoveryTickId:tickId,aiDiscoveryRunId:built.aiDiscoveryRunId};
  }catch(error){
    const budgetOutcome=knownBudgetOutcome(error);
    if(budgetOutcome){await finalizeTick(pool,tickId,budgetOutcome);return{outcome:budgetOutcome,scheduledAiDiscoveryTickId:tickId,aiDiscoveryRunId:built?.aiDiscoveryRunId??null};}
    const reservation=built?await reservationForRun(pool,built.aiDiscoveryRunId):null;
    await finalizeTick(pool,tickId,'AMBIGUOUS_FAILURE',reservation?{policyRevisionId:reservation.ai_operations_policy_revision_id,budgetReservationId:reservation.ai_operations_run_budget_reservation_id}:{});
    return{outcome:'AMBIGUOUS_FAILURE',scheduledAiDiscoveryTickId:tickId,aiDiscoveryRunId:built?.aiDiscoveryRunId??null};
  }
}
