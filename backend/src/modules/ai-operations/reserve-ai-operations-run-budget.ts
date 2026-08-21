import { randomUUID } from 'node:crypto';

import type { Pool, PoolClient } from 'pg';

import { withTransaction } from '../../database/transaction.js';
import { beginIdempotentCommand, completeIdempotentCommand } from '../../shared/idempotent-command.js';
import { hashCanonicalTupleV1, requireBoundedText } from '../trust/normalize-trust-input.js';
import type {
  ReserveAiOperationsRunBudgetCommand,
  ReserveAiOperationsRunBudgetOptions,
  ReserveAiOperationsRunBudgetResult,
} from './types.js';

export type {
  ReserveAiOperationsRunBudgetCommand,
  ReserveAiOperationsRunBudgetOptions,
  ReserveAiOperationsRunBudgetResult,
} from './types.js';

const COMMAND_KEYS = ['actorId','correlationId','idempotencyKey','aiDiscoveryRunId','runKey','gameModeExternalId'] as const;
const PRINTABLE_IDENTIFIER = /^[!-~]+$/u;
const AI_DISCOVERY_RUN_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[45][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const RESERVATION_REASON = 'policy-governed AI provider run budget reservation';

interface ActivePolicyRow {
  ai_operations_policy_revision_id: string;
  enabled: boolean;
  max_runs_per_utc_day: number;
  min_interval_seconds: number;
  max_proposals_per_run: number;
  game_mode_external_id: 'aram_mayhem';
}
interface BudgetStateRow { budget_date: string; used_runs: number; seconds_since_last: string | null; }

function compareCanonical(left:string,right:string):number { return left < right ? -1 : left > right ? 1 : 0; }
function failInput():never { throw new Error('AI_OPERATIONS_BUDGET_INPUT_INVALID'); }
function trimmedText(value:string,field:string,maxBytes:number):string {
  const result = requireBoundedText(value, field, maxBytes);
  if (result !== result.trim()) return failInput();
  return result;
}
function requireAiDiscoveryRunUuid(value:string):string {
  if (typeof value !== 'string' || !AI_DISCOVERY_RUN_UUID.test(value)) return failInput();
  return value;
}
function normalizeCommand(input:ReserveAiOperationsRunBudgetCommand):ReserveAiOperationsRunBudgetCommand {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return failInput();
  const actual = Object.keys(input).sort(compareCanonical);
  const expected = [...COMMAND_KEYS].sort(compareCanonical);
  if (actual.length !== expected.length || actual.some((key,index)=>key!==expected[index])) return failInput();
  if (input.gameModeExternalId !== 'aram_mayhem') return failInput();
  try {
    const runKey = trimmedText(input.runKey,'runKey',128);
    if (!PRINTABLE_IDENTIFIER.test(runKey)) return failInput();
    return {
      actorId: trimmedText(input.actorId,'actorId',256),
      correlationId: trimmedText(input.correlationId,'correlationId',256),
      idempotencyKey: trimmedText(input.idempotencyKey,'idempotencyKey',256),
      aiDiscoveryRunId: requireAiDiscoveryRunUuid(input.aiDiscoveryRunId),
      runKey,
      gameModeExternalId:'aram_mayhem',
    };
  } catch { return failInput(); }
}
function normalizeFloor(options:ReserveAiOperationsRunBudgetOptions):number {
  const floor = options?.minimumIntervalFloorSeconds;
  if (!Number.isSafeInteger(floor) || floor < 0 || floor > 86_400) return failInput();
  return floor;
}
function dateText(value:unknown):string {
  if (typeof value === 'string') return value;
  if (value instanceof Date) return value.toISOString().slice(0,10);
  throw new Error('AI_OPERATIONS_BUDGET_DATE_INVALID');
}
function payloadHash(command:ReserveAiOperationsRunBudgetCommand, floor:number):string {
  return floor === 0
    ? hashCanonicalTupleV1(['ReserveAiOperationsRunBudgetCommandV1',command.aiDiscoveryRunId,command.runKey,command.gameModeExternalId,command.actorId])
    : hashCanonicalTupleV1(['ReserveAiOperationsRunBudgetWithFloorCommandV1',command.aiDiscoveryRunId,command.runKey,command.gameModeExternalId,command.actorId,String(floor)]);
}

export async function reserveAiOperationsRunBudgetInTransaction(
  client: PoolClient,
  input: ReserveAiOperationsRunBudgetCommand,
  options: ReserveAiOperationsRunBudgetOptions,
): Promise<ReserveAiOperationsRunBudgetResult> {
  const command = normalizeCommand(input);
  const minimumIntervalFloorSeconds = normalizeFloor(options);
  const hash = payloadHash(command, minimumIntervalFloorSeconds);

  const replay = await beginIdempotentCommand<ReserveAiOperationsRunBudgetResult>(
    client,'ai.operations.run.reserve',command.idempotencyKey,hash,
  );
  if (replay) return { ...replay, replayed:true };

  await client.query(`select pg_advisory_xact_lock(hashtextextended('ai_operations_provider_budget:v1', 0))`);
  const active = await client.query<ActivePolicyRow>(
    `select policy.ai_operations_policy_revision_id, policy.enabled,
            policy.max_runs_per_utc_day, policy.min_interval_seconds,
            policy.max_proposals_per_run, policy.game_mode_external_id
       from active_ai_operations_policy_revision active
       join ai_operations_policy_revisions policy
         on policy.ai_operations_policy_revision_id = active.ai_operations_policy_revision_id
      where active.scope = 'ai_discovery_provider'
      for share of active, policy`,
  );
  const policy = active.rows[0];
  if (!policy || policy.enabled !== true) throw new Error('AI_OPERATIONS_DISABLED');
  if (policy.game_mode_external_id !== command.gameModeExternalId) throw new Error('AI_OPERATIONS_GAME_MODE_NOT_ALLOWED');

  const existingRun = await client.query(
    `select ai_operations_run_budget_reservation_id from ai_operations_run_budget_reservations
      where ai_discovery_run_id = $1 for share`, [command.aiDiscoveryRunId],
  );
  if (existingRun.rowCount !== 0) throw new Error('AI_OPERATIONS_RUN_ALREADY_RESERVED');

  const state = await client.query<BudgetStateRow>(
    `select (timezone('UTC', clock_timestamp()))::date::text as budget_date,
            count(today.ai_operations_run_budget_reservation_id)::int as used_runs,
            extract(epoch from (clock_timestamp() - max(all_runs.reserved_at)))::text as seconds_since_last
       from ai_operations_run_budget_reservations all_runs
       left join ai_operations_run_budget_reservations today
         on today.ai_operations_run_budget_reservation_id = all_runs.ai_operations_run_budget_reservation_id
        and today.budget_date = (timezone('UTC', clock_timestamp()))::date`,
  );
  const budget = state.rows[0];
  if (!budget) throw new Error('AI_OPERATIONS_BUDGET_STATE_UNAVAILABLE');
  if (budget.used_runs >= policy.max_runs_per_utc_day) throw new Error('AI_OPERATIONS_DAILY_BUDGET_EXHAUSTED');
  if (budget.seconds_since_last !== null) {
    const secondsSinceLast = Number(budget.seconds_since_last);
    if (secondsSinceLast < policy.min_interval_seconds) throw new Error('AI_OPERATIONS_MIN_INTERVAL_NOT_ELAPSED');
    const effectiveMinimum = Math.max(policy.min_interval_seconds, minimumIntervalFloorSeconds);
    if (secondsSinceLast < effectiveMinimum) throw new Error('AI_OPERATIONS_SCHEDULED_CADENCE_NOT_ELAPSED');
  }

  const reservationId = randomUUID();
  const inserted = await client.query<{budget_date:string|Date}>(
    `insert into ai_operations_run_budget_reservations
      (ai_operations_run_budget_reservation_id, ai_discovery_run_id, run_key,
       ai_operations_policy_revision_id, budget_date, max_proposals_per_run, actor_id, correlation_id)
     values ($1,$2,$3,$4,(timezone('UTC', clock_timestamp()))::date,$5,$6,$7)
     returning budget_date`,
    [reservationId,command.aiDiscoveryRunId,command.runKey,policy.ai_operations_policy_revision_id,policy.max_proposals_per_run,command.actorId,command.correlationId],
  );
  const budgetDate = dateText(inserted.rows[0]?.budget_date);
  const eventPayload = {
    aiOperationsRunBudgetReservationId: reservationId,
    aiDiscoveryRunId: command.aiDiscoveryRunId,
    aiOperationsPolicyRevisionId: policy.ai_operations_policy_revision_id,
    runKey: command.runKey,
    budgetDate,
    maxProposalsPerRun: policy.max_proposals_per_run,
  } as const;
  await client.query(
    `insert into audit_events
      (audit_event_id, actor_id, action, reason, correlation_id, policy_version, payload)
     values ($1,$2,'ai.operations.run_budget_reserved',$3,$4,$5,$6::jsonb)`,
    [randomUUID(),command.actorId,RESERVATION_REASON,command.correlationId,policy.ai_operations_policy_revision_id,JSON.stringify(eventPayload)],
  );
  const result:ReserveAiOperationsRunBudgetResult = {
    aiOperationsRunBudgetReservationId:reservationId,
    aiDiscoveryRunId:command.aiDiscoveryRunId,
    aiOperationsPolicyRevisionId:policy.ai_operations_policy_revision_id,
    budgetDate,
    maxProposalsPerRun:policy.max_proposals_per_run,
    replayed:false,
  };
  await completeIdempotentCommand(client,'ai.operations.run.reserve',command.idempotencyKey,result);
  return result;
}

function mapUnique(error:unknown):never {
  if (error !== null && typeof error === 'object' && 'code' in error && (error as {code?:string}).code === '23505') {
    throw new Error('AI_OPERATIONS_RUN_ALREADY_RESERVED');
  }
  throw error;
}

export async function reserveAiOperationsRunBudgetWithFloor(
  pool:Pool,input:ReserveAiOperationsRunBudgetCommand,options:ReserveAiOperationsRunBudgetOptions,
):Promise<ReserveAiOperationsRunBudgetResult> {
  try {
    return await withTransaction(pool, (client)=>reserveAiOperationsRunBudgetInTransaction(client,input,options));
  } catch (error) { return mapUnique(error); }
}

export async function reserveAiOperationsRunBudget(
  pool:Pool,input:ReserveAiOperationsRunBudgetCommand,
):Promise<ReserveAiOperationsRunBudgetResult> {
  return reserveAiOperationsRunBudgetWithFloor(pool,input,{minimumIntervalFloorSeconds:0});
}
