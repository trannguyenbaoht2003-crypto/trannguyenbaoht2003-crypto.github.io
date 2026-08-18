import type { AiDiscoveryProvider } from '../ai-provider/openai-responses-provider.js';
import type { NormalizedAiProviderExecutionInput } from '../ai-provider/types.js';

export interface RegisterAiOperationsPolicyRevisionCommand {
  actorId: string;
  correlationId: string;
  idempotencyKey: string;
  aiOperationsPolicyRevisionId: string;
  revision: number;
  enabled: boolean;
  maxRunsPerUtcDay: number;
  minIntervalSeconds: number;
  maxProposalsPerRun: number;
  reason: string;
}

export interface RegisterAiOperationsPolicyRevisionResult {
  aiOperationsPolicyRevisionId: string;
  revision: number;
  replayed: boolean;
}

export interface ActivateAiOperationsPolicyRevisionCommand {
  actorId: string;
  correlationId: string;
  idempotencyKey: string;
  aiOperationsPolicyRevisionId: string;
  expectedCurrentAiOperationsPolicyRevisionId: string | null;
  reason: string;
}

export interface ActivateAiOperationsPolicyRevisionResult {
  currentAiOperationsPolicyRevisionId: string;
  previousAiOperationsPolicyRevisionId: string | null;
  replayed: boolean;
}

export interface ReserveAiOperationsRunBudgetCommand {
  actorId: string;
  correlationId: string;
  idempotencyKey: string;
  aiDiscoveryRunId: string;
  runKey: string;
  gameModeExternalId: 'aram_mayhem';
}

export interface ReserveAiOperationsRunBudgetResult {
  aiOperationsRunBudgetReservationId: string;
  aiDiscoveryRunId: string;
  aiOperationsPolicyRevisionId: string;
  budgetDate: string;
  maxProposalsPerRun: number;
  replayed: boolean;
}

export interface AiOperationsActivePolicySnapshot {
  aiOperationsPolicyRevisionId: string;
  revision: number;
  enabled: boolean;
  maxRunsPerUtcDay: number;
  minIntervalSeconds: number;
  maxProposalsPerRun: number;
  gameModeExternalId: 'aram_mayhem';
}

export interface AiOperationsBudgetSnapshot {
  utcDate: string;
  usedRuns: number;
  remainingRuns: number;
  lastReservedAt: string | null;
}

export interface AiOperationsProposalSnapshot {
  pending: number;
  materialized: number;
}

export interface AiOperationsSnapshot {
  activePolicy: AiOperationsActivePolicySnapshot;
  budget: AiOperationsBudgetSnapshot;
  proposals: AiOperationsProposalSnapshot;
}

export interface ExecutePolicyGovernedAiDiscoveryRunCommand {
  actorId: string;
  correlationId: string;
  idempotencyKey: string;
  aiDiscoveryRunId: string;
  provider: AiDiscoveryProvider;
  modelKey: string;
  modelRevision: string;
  input: unknown;
  startedAt: string;
}

export interface ExecutePolicyGovernedAiDiscoveryRunResult {
  aiDiscoveryRunId: string;
  runKey: string;
  status: 'completed' | 'failed';
  proposalIds: string[];
  proposalCount: number;
  replayed: boolean;
  aiOperationsRunBudgetReservationId: string;
  aiOperationsPolicyRevisionId: string;
  budgetReplayed: boolean;
}

export interface NormalizedPolicyGovernedAiDiscoveryRunCommand extends Omit<
  ExecutePolicyGovernedAiDiscoveryRunCommand,
  'input'
> {
  input: NormalizedAiProviderExecutionInput;
}
