import type { Pool } from 'pg';

import type {
  AiOperationsAutomationOutcome,
  AiOperationsSnapshot,
} from './types.js';

const RECENT_AUTOMATION_WINDOW = 100;

interface PolicyRow {
  ai_operations_policy_revision_id: string;
  revision: number;
  enabled: boolean;
  max_runs_per_utc_day: number;
  min_interval_seconds: number;
  max_proposals_per_run: number;
  game_mode_external_id: 'aram_mayhem';
}

interface BudgetRow {
  utc_date: string | Date;
  used_runs: number;
  last_reserved_at: string | Date | null;
}

interface ProposalRow {
  pending: number;
  materialized: number;
}

interface AutomationLastRow {
  completed_at: string | Date;
  status: AiOperationsAutomationOutcome;
  scheduled_content_hash: string | null;
  ai_discovery_run_id: string | null;
  reserved_at: string | Date | null;
}

interface AutomationCounterRow {
  ticks: number;
  no_new_input: number;
  policy_cadence_blocked: number;
  completed: number;
  provider_failed_or_ambiguous: number;
  incomplete_processing: number;
}

interface ProviderExecutionAggregateRow {
  prepared: number;
  in_flight: number;
  completed: number;
  failed: number;
  uncertain: number;
  stale_prepared: number;
  stale_in_flight: number;
  attempts_today: number;
  safe_retries_today: number;
  uncertain_executions: number;
  unreconciled_uncertain: number;
  last_execution_at: string | Date | null;
}

function dateText(value: string | Date): string {
  return typeof value === 'string' ? value : value.toISOString().slice(0, 10);
}

function timestampText(value: string | Date | null): string | null {
  if (value === null) return null;
  return typeof value === 'string' ? new Date(value).toISOString() : value.toISOString();
}

export async function readAiOperationsSnapshot(
  pool: Pool,
): Promise<AiOperationsSnapshot> {
  const policyResult = await pool.query<PolicyRow>(
    `select policy.ai_operations_policy_revision_id,
            policy.revision,
            policy.enabled,
            policy.max_runs_per_utc_day,
            policy.min_interval_seconds,
            policy.max_proposals_per_run,
            policy.game_mode_external_id
       from active_ai_operations_policy_revision active
       join ai_operations_policy_revisions policy
         on policy.ai_operations_policy_revision_id = active.ai_operations_policy_revision_id
      where active.scope = 'ai_discovery_provider'`,
  );
  const policy = policyResult.rows[0];
  if (!policy) throw new Error('AI_OPERATIONS_POLICY_UNAVAILABLE');

  const budgetResult = await pool.query<BudgetRow>(
    `select (timezone('UTC', clock_timestamp()))::date as utc_date,
            count(*) filter (
              where budget_date = (timezone('UTC', clock_timestamp()))::date
            )::int as used_runs,
            max(reserved_at) as last_reserved_at
       from ai_operations_run_budget_reservations`,
  );
  const budget = budgetResult.rows[0];
  if (!budget) throw new Error('AI_OPERATIONS_BUDGET_STATE_UNAVAILABLE');

  const proposalsResult = await pool.query<ProposalRow>(
    `select count(*) filter (
              where materialization.ai_candidate_materialization_id is null
            )::int as pending,
            count(*) filter (
              where materialization.ai_candidate_materialization_id is not null
            )::int as materialized
       from ai_candidate_proposals proposal
       left join ai_candidate_materializations materialization
         on materialization.ai_candidate_proposal_id = proposal.ai_candidate_proposal_id`,
  );
  const proposals = proposalsResult.rows[0] ?? { pending: 0, materialized: 0 };

  const lastAutomationResult = await pool.query<AutomationLastRow>(
    `select tick.completed_at,
            tick.status,
            tick.scheduled_content_hash,
            tick.ai_discovery_run_id,
            reservation.reserved_at
       from scheduled_ai_discovery_ticks tick
       left join ai_operations_run_budget_reservations reservation
         on reservation.ai_operations_run_budget_reservation_id =
            tick.ai_operations_run_budget_reservation_id
      where tick.completed_at is not null
      order by tick.completed_at desc,
               tick.scheduled_ai_discovery_tick_id desc
      limit 1`,
  );
  const lastAutomation = lastAutomationResult.rows[0] ?? null;

  const automationCounters = await pool.query<AutomationCounterRow>(
    `with recent as (
       select status
         from scheduled_ai_discovery_ticks
        order by utc_hour desc, scheduled_ai_discovery_tick_id desc
        limit $1
     )
     select count(*)::int as ticks,
            count(*) filter (where status = 'NO_NEW_INPUT')::int as no_new_input,
            count(*) filter (
              where status in (
                'CADENCE_NOT_ELAPSED', 'POLICY_DISABLED',
                'DAILY_BUDGET_EXHAUSTED', 'POLICY_MIN_INTERVAL'
              )
            )::int as policy_cadence_blocked,
            count(*) filter (where status = 'COMPLETED')::int as completed,
            count(*) filter (
              where status in ('PROVIDER_FAILED', 'AMBIGUOUS_FAILURE')
            )::int as provider_failed_or_ambiguous,
            count(*) filter (where status = 'PROCESSING')::int as incomplete_processing
       from recent`,
    [RECENT_AUTOMATION_WINDOW],
  );
  const counters = automationCounters.rows[0] ?? {
    ticks: 0,
    no_new_input: 0,
    policy_cadence_blocked: 0,
    completed: 0,
    provider_failed_or_ambiguous: 0,
    incomplete_processing: 0,
  };

  const providerExecutionResult = await pool.query<ProviderExecutionAggregateRow>(
    `with execution_counts as (
       select count(*) filter (where status = 'PREPARED')::int as prepared,
              count(*) filter (where status = 'IN_FLIGHT')::int as in_flight,
              count(*) filter (where status = 'COMPLETED')::int as completed,
              count(*) filter (where status = 'FAILED')::int as failed,
              count(*) filter (where status = 'UNCERTAIN')::int as uncertain,
              count(*) filter (
                where status = 'PREPARED'
                  and lease_expires_at is not null
                  and lease_expires_at <= clock_timestamp()
              )::int as stale_prepared,
              count(*) filter (
                where status = 'IN_FLIGHT'
                  and lease_expires_at <= clock_timestamp()
              )::int as stale_in_flight,
              count(*) filter (where status = 'UNCERTAIN')::int as uncertain_executions,
              max(created_at) as last_execution_at
         from ai_provider_executions
     ), attempt_counts as (
       select count(*) filter (
                where (timezone('UTC', attempt.prepared_at))::date =
                      (timezone('UTC', clock_timestamp()))::date
              )::int as attempts_today,
              count(*) filter (
                where attempt.ordinal > 1
                  and (timezone('UTC', attempt.prepared_at))::date =
                      (timezone('UTC', clock_timestamp()))::date
                  and (
                    exists (
                      select 1
                        from ai_provider_execution_attempts prior
                       where prior.ai_provider_execution_id = attempt.ai_provider_execution_id
                         and prior.ordinal = attempt.ordinal - 1
                         and prior.status = 'FAILED'
                         and prior.failure_code = 'PROVIDER_RATE_LIMITED'
                    )
                    or exists (
                      select 1
                        from ai_provider_execution_attempts prior
                        join ai_provider_execution_reconciliations reconciliation
                          on reconciliation.ai_provider_execution_attempt_id =
                             prior.ai_provider_execution_attempt_id
                       where prior.ai_provider_execution_id = attempt.ai_provider_execution_id
                         and prior.ordinal = attempt.ordinal - 1
                         and prior.status = 'UNCERTAIN'
                         and reconciliation.decision = 'CONFIRMED_NOT_RECEIVED'
                    )
                  )
              )::int as safe_retries_today
         from ai_provider_execution_attempts attempt
     ), uncertain_counts as (
       select count(*)::int as unreconciled_uncertain
         from ai_provider_execution_attempts attempt
         left join ai_provider_execution_reconciliations reconciliation
           on reconciliation.ai_provider_execution_attempt_id =
              attempt.ai_provider_execution_attempt_id
        where attempt.status = 'UNCERTAIN'
          and reconciliation.ai_provider_execution_reconciliation_id is null
     )
     select execution_counts.prepared,
            execution_counts.in_flight,
            execution_counts.completed,
            execution_counts.failed,
            execution_counts.uncertain,
            execution_counts.stale_prepared,
            execution_counts.stale_in_flight,
            attempt_counts.attempts_today,
            attempt_counts.safe_retries_today,
            execution_counts.uncertain_executions,
            uncertain_counts.unreconciled_uncertain,
            execution_counts.last_execution_at
       from execution_counts
       cross join attempt_counts
       cross join uncertain_counts`,
  );
  const providerExecution = providerExecutionResult.rows[0] ?? {
    prepared: 0,
    in_flight: 0,
    completed: 0,
    failed: 0,
    uncertain: 0,
    stale_prepared: 0,
    stale_in_flight: 0,
    attempts_today: 0,
    safe_retries_today: 0,
    uncertain_executions: 0,
    unreconciled_uncertain: 0,
    last_execution_at: null,
  };

  const usedRuns = budget.used_runs;

  return {
    activePolicy: {
      aiOperationsPolicyRevisionId: policy.ai_operations_policy_revision_id,
      revision: policy.revision,
      enabled: policy.enabled,
      maxRunsPerUtcDay: policy.max_runs_per_utc_day,
      minIntervalSeconds: policy.min_interval_seconds,
      maxProposalsPerRun: policy.max_proposals_per_run,
      gameModeExternalId: policy.game_mode_external_id,
    },
    budget: {
      utcDate: dateText(budget.utc_date),
      usedRuns,
      remainingRuns: Math.max(0, policy.max_runs_per_utc_day - usedRuns),
      lastReservedAt: timestampText(budget.last_reserved_at),
    },
    proposals: {
      pending: proposals.pending,
      materialized: proposals.materialized,
    },
    automation: {
      lastCompletedAt: timestampText(lastAutomation?.completed_at ?? null),
      lastOutcome: lastAutomation?.status ?? null,
      lastScheduledContentHash: lastAutomation?.scheduled_content_hash ?? null,
      lastAiDiscoveryRunId: lastAutomation?.ai_discovery_run_id ?? null,
      lastBudgetReservedAt: timestampText(lastAutomation?.reserved_at ?? null),
      recentWindowSize: RECENT_AUTOMATION_WINDOW,
      recent: {
        ticks: counters.ticks,
        noNewInput: counters.no_new_input,
        policyCadenceBlocked: counters.policy_cadence_blocked,
        completed: counters.completed,
        providerFailedOrAmbiguous: counters.provider_failed_or_ambiguous,
        incompleteProcessing: counters.incomplete_processing,
      },
    },
    providerExecution: {
      prepared: providerExecution.prepared,
      inFlight: providerExecution.in_flight,
      completed: providerExecution.completed,
      failed: providerExecution.failed,
      uncertain: providerExecution.uncertain,
      stalePrepared: providerExecution.stale_prepared,
      staleInFlight: providerExecution.stale_in_flight,
      attemptsToday: providerExecution.attempts_today,
      safeRetriesToday: providerExecution.safe_retries_today,
      uncertainExecutions: providerExecution.uncertain_executions,
      unreconciledUncertain: providerExecution.unreconciled_uncertain,
      lastExecutionAt: timestampText(providerExecution.last_execution_at),
    },
  };
}
