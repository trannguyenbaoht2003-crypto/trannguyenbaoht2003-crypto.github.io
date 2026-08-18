import type { Pool } from 'pg';

import {
  executeAiDiscoveryProviderRun,
  type ExecuteAiDiscoveryProviderRunCommand,
  type ExecuteAiDiscoveryProviderRunDependencies,
} from '../ai-provider/execute-ai-discovery-provider-run.js';
import {
  normalizeAiProviderExecutionInput,
} from '../ai-provider/normalize-provider-execution-input.js';
import {
  AiProviderError,
  type AiDiscoveryProvider,
} from '../ai-provider/openai-responses-provider.js';
import type { RecordAiDiscoveryRunResult } from '../ai-discovery/types.js';
import {
  reserveAiOperationsRunBudget,
} from './reserve-ai-operations-run-budget.js';
import type {
  ExecutePolicyGovernedAiDiscoveryRunCommand,
  ExecutePolicyGovernedAiDiscoveryRunResult,
  ReserveAiOperationsRunBudgetCommand,
  ReserveAiOperationsRunBudgetResult,
} from './types.js';

export type {
  ExecutePolicyGovernedAiDiscoveryRunCommand,
  ExecutePolicyGovernedAiDiscoveryRunResult,
} from './types.js';

type ReserveBudget = (
  pool: Pool,
  command: ReserveAiOperationsRunBudgetCommand,
) => Promise<ReserveAiOperationsRunBudgetResult>;

type ExecuteRun = (
  pool: Pool,
  command: ExecuteAiDiscoveryProviderRunCommand,
  dependencies?: ExecuteAiDiscoveryProviderRunDependencies,
) => Promise<RecordAiDiscoveryRunResult>;

export interface ExecutePolicyGovernedAiDiscoveryRunDependencies {
  reserveBudget?: ReserveBudget;
  executeRun?: ExecuteRun;
  now?: () => string;
  sleep?: (milliseconds: number) => Promise<void>;
}

function cappedProvider(
  provider: AiDiscoveryProvider,
  maxProposalsPerRun: number,
): AiDiscoveryProvider {
  return {
    providerKey: provider.providerKey,
    async execute(request) {
      const result = await provider.execute(request);
      if (result.proposals.length > maxProposalsPerRun) {
        throw new AiProviderError(
          'AI_OPERATIONS_PROPOSAL_CAP_EXCEEDED',
          false,
          'PROVIDER_RESPONSE_INVALID',
        );
      }
      return result;
    },
  };
}

export async function executePolicyGovernedAiDiscoveryRun(
  pool: Pool,
  command: ExecutePolicyGovernedAiDiscoveryRunCommand,
  dependencies: ExecutePolicyGovernedAiDiscoveryRunDependencies = {},
): Promise<ExecutePolicyGovernedAiDiscoveryRunResult> {
  const normalizedInput = normalizeAiProviderExecutionInput(command.input);
  const reserveBudget = dependencies.reserveBudget ?? reserveAiOperationsRunBudget;
  const reservation = await reserveBudget(pool, {
    actorId: command.actorId,
    correlationId: command.correlationId,
    idempotencyKey: command.idempotencyKey,
    aiDiscoveryRunId: command.aiDiscoveryRunId,
    runKey: normalizedInput.runKey,
    gameModeExternalId: normalizedInput.gameModeExternalId,
  });

  const executeRun = dependencies.executeRun ?? executeAiDiscoveryProviderRun;
  const providerDependencies: ExecuteAiDiscoveryProviderRunDependencies = {};
  if (dependencies.now !== undefined) providerDependencies.now = dependencies.now;
  if (dependencies.sleep !== undefined) providerDependencies.sleep = dependencies.sleep;

  const run = await executeRun(
    pool,
    {
      actorId: command.actorId,
      correlationId: command.correlationId,
      idempotencyKey: command.idempotencyKey,
      aiDiscoveryRunId: command.aiDiscoveryRunId,
      provider: cappedProvider(command.provider, reservation.maxProposalsPerRun),
      modelKey: command.modelKey,
      modelRevision: command.modelRevision,
      input: normalizedInput,
      startedAt: command.startedAt,
    },
    providerDependencies,
  );

  return {
    ...run,
    aiOperationsRunBudgetReservationId: reservation.aiOperationsRunBudgetReservationId,
    aiOperationsPolicyRevisionId: reservation.aiOperationsPolicyRevisionId,
    budgetReplayed: reservation.replayed,
  };
}
