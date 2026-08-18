import type { Pool } from 'pg';

import type { AiOperationsSnapshot } from './types.js';

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
  };
}
