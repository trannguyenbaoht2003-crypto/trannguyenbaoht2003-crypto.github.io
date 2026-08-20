import { createHash, randomUUID } from 'node:crypto';

import type { Pool } from 'pg';

import { hashCanonicalJson } from '../../shared/hash.js';
import type {
  RecordAiDiscoveryRunCommand,
  RecordAiDiscoveryRunResult,
} from '../ai-discovery/types.js';
import type { ReserveAiOperationsRunBudgetResult } from '../ai-operations/types.js';
import {
  AI_DISCOVERY_PROMPT_TEMPLATE_KEY,
  AI_DISCOVERY_PROMPT_TEMPLATE_VERSION,
  buildAiProviderRequest,
} from '../ai-provider/build-provider-request.js';
import {
  hashNormalizedAiProviderExecutionInput,
  normalizeAiProviderExecutionInput,
} from '../ai-provider/normalize-provider-execution-input.js';
import type {
  AiDiscoveryProvider,
  AiProviderProposal,
} from '../ai-provider/openai-responses-provider.js';
import { claimAiProviderExecution } from './claim-ai-provider-execution.js';
import { executeAiProviderAttempt } from './execute-ai-provider-attempt.js';
import { finalizeAiProviderExecution } from './finalize-ai-provider-execution.js';
import { markAiProviderAttemptInFlight } from './mark-ai-provider-attempt-in-flight.js';
import { prepareAiProviderExecution } from './prepare-ai-provider-execution.js';
import type {
  AiProviderAttemptDisposition,
  AiProviderAttemptOrdinal,
} from './types.js';

const RETRY_DELAYS_MS = [500, 1_500] as const;
const PRINTABLE = /^[!-~]+$/u;

export interface ProcessAiProviderExecutionCommand {
  actorId: string;
  correlationId: string;
  idempotencyKey: string;
  aiDiscoveryRunId: string;
  provider: AiDiscoveryProvider;
  modelKey: string;
  modelRevision: string;
  input: unknown;
  startedAt: string;
  minimumIntervalFloorSeconds: number;
}

export type ProcessAiProviderExecutionResult =
  | {
      kind: 'RESOLVED';
      run: RecordAiDiscoveryRunResult;
      reservation: ReserveAiOperationsRunBudgetResult;
    }
  | {
      kind: 'UNCERTAIN';
      executionId: string;
      reservation: ReserveAiOperationsRunBudgetResult;
    };

export interface ProcessAiProviderExecutionDependencies {
  now?: () => string;
  sleep?: (milliseconds: number) => Promise<void>;
}

interface AttemptRow {
  ai_provider_execution_attempt_id: string;
  ordinal: AiProviderAttemptOrdinal;
  client_request_id: string;
}

function compareAscii(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function ids(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 128) {
    throw new Error('PROVIDER_RESPONSE_INVALID');
  }
  const result = value.map((entry) => {
    if (
      typeof entry !== 'string'
      || entry.length === 0
      || entry.length > 128
      || entry !== entry.trim()
      || !PRINTABLE.test(entry)
    ) {
      throw new Error('PROVIDER_RESPONSE_INVALID');
    }
    return entry;
  }).sort(compareAscii);
  if (new Set(result).size !== result.length) {
    throw new Error('PROVIDER_RESPONSE_INVALID');
  }
  return result;
}

function canonicalProposals(
  value: AiProviderProposal[],
  normalized: ReturnType<typeof normalizeAiProviderExecutionInput>,
  cap: number,
): AiProviderProposal[] {
  if (!Array.isArray(value) || value.length > 64 || value.length > cap) {
    throw new Error('PROVIDER_RESPONSE_INVALID');
  }
  const subjects = new Map(normalized.subjects.map((subject) => [subject.subjectExternalId, subject] as const));
  const seen = new Set<string>();
  return value.map((proposal) => {
    if (
      !proposal
      || typeof proposal.subjectExternalId !== 'string'
      || !PRINTABLE.test(proposal.subjectExternalId)
      || (
        proposal.rationale !== null
        && (typeof proposal.rationale !== 'string' || proposal.rationale.length > 2_000)
      )
    ) {
      throw new Error('PROVIDER_RESPONSE_INVALID');
    }
    const augmentExternalIds = ids(proposal.augmentExternalIds);
    const itemExternalIds = ids(proposal.itemExternalIds);
    const subject = subjects.get(proposal.subjectExternalId);
    if (
      !subject
      || augmentExternalIds.some((id) => !subject.allowedAugmentExternalIds.includes(id))
      || itemExternalIds.some((id) => !subject.allowedItemExternalIds.includes(id))
    ) {
      throw new Error('PROVIDER_RESPONSE_INVALID');
    }
    const key = hashCanonicalJson({
      subjectExternalId: proposal.subjectExternalId,
      augmentExternalIds,
      itemExternalIds,
    });
    if (seen.has(key)) throw new Error('PROVIDER_RESPONSE_INVALID');
    seen.add(key);
    return {
      subjectExternalId: proposal.subjectExternalId,
      augmentExternalIds,
      itemExternalIds,
      rationale: proposal.rationale,
    };
  }).sort((left, right) => compareAscii(JSON.stringify(left), JSON.stringify(right)));
}

function proposalId(runId: string, ordinal: number): string {
  const bytes = Buffer.from(
    createHash('sha256')
      .update('ai-provider-proposal-v1\0')
      .update(runId)
      .update('\0')
      .update(String(ordinal))
      .digest()
      .subarray(0, 16),
  );
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function currentAttempt(pool: Pool, executionId: string): Promise<AttemptRow> {
  const result = await pool.query<AttemptRow>(
    `select a.ai_provider_execution_attempt_id,a.ordinal,a.client_request_id
       from ai_provider_executions e
       join ai_provider_execution_attempts a
         on a.ai_provider_execution_id=e.ai_provider_execution_id
        and a.ordinal=e.current_attempt_ordinal
      where e.ai_provider_execution_id=$1`,
    [executionId],
  );
  if (result.rowCount !== 1) {
    throw new Error('AI_PROVIDER_EXECUTION_ATTEMPT_NOT_FOUND');
  }
  return result.rows[0]!;
}

function failureRun(
  base: Omit<RecordAiDiscoveryRunCommand, 'outputHash' | 'status' | 'completedAt' | 'failureCode' | 'proposals'>,
  failureCode: string,
  completedAt: string,
): RecordAiDiscoveryRunCommand {
  return {
    ...base,
    outputHash: hashCanonicalJson({ schemaVersion: 1, failureCode }),
    status: 'failed',
    completedAt,
    failureCode,
    proposals: [],
  };
}

function isLeaseNotHeld(error: unknown): boolean {
  return error instanceof Error && error.message === 'AI_PROVIDER_EXECUTION_LEASE_NOT_HELD';
}

export async function processAiProviderExecution(
  pool: Pool,
  command: ProcessAiProviderExecutionCommand,
  dependencies: ProcessAiProviderExecutionDependencies = {},
): Promise<ProcessAiProviderExecutionResult> {
  const normalized = normalizeAiProviderExecutionInput(command.input);
  const inputHash = hashNormalizedAiProviderExecutionInput(normalized);
  const prepared = await prepareAiProviderExecution(pool, {
    actorId: command.actorId,
    correlationId: command.correlationId,
    idempotencyKey: command.idempotencyKey,
    aiDiscoveryRunId: command.aiDiscoveryRunId,
    runKey: normalized.runKey,
    providerKey: command.provider.providerKey,
    modelKey: command.modelKey,
    modelRevision: command.modelRevision,
    promptTemplateKey: AI_DISCOVERY_PROMPT_TEMPLATE_KEY,
    promptTemplateVersion: AI_DISCOVERY_PROMPT_TEMPLATE_VERSION,
    inputHash,
    startedAt: command.startedAt,
    gameModeExternalId: normalized.gameModeExternalId,
  }, { minimumIntervalFloorSeconds: command.minimumIntervalFloorSeconds });

  if (prepared.kind === 'REPLAYED') {
    const reservation = await pool.query<{
      ai_operations_run_budget_reservation_id: string;
      ai_operations_policy_revision_id: string;
      budget_date: string | Date;
      max_proposals_per_run: number;
    }>(
      `select ai_operations_run_budget_reservation_id,ai_operations_policy_revision_id,
              budget_date,max_proposals_per_run
         from ai_operations_run_budget_reservations
        where ai_discovery_run_id=$1`,
      [command.aiDiscoveryRunId],
    );
    const row = reservation.rows[0];
    if (!row) throw new Error('AI_PROVIDER_EXECUTION_REPLAY_RESERVATION_MISSING');
    return {
      kind: 'RESOLVED',
      run: prepared.run,
      reservation: {
        aiOperationsRunBudgetReservationId: row.ai_operations_run_budget_reservation_id,
        aiDiscoveryRunId: command.aiDiscoveryRunId,
        aiOperationsPolicyRevisionId: row.ai_operations_policy_revision_id,
        budgetDate: (row.budget_date instanceof Date
          ? row.budget_date.toISOString()
          : String(row.budget_date)).slice(0, 10),
        maxProposalsPerRun: row.max_proposals_per_run,
        replayed: true,
      },
    };
  }

  const executionId = prepared.executionId;
  const reservation = prepared.reservation;
  if (prepared.kind === 'EXISTING') {
    if (prepared.status === 'UNCERTAIN' || prepared.status === 'IN_FLIGHT') {
      return { kind: 'UNCERTAIN', executionId, reservation };
    }
    if (prepared.status === 'COMPLETED' || prepared.status === 'FAILED') {
      const replay = await prepareAiProviderExecution(pool, {
        actorId: command.actorId,
        correlationId: command.correlationId,
        idempotencyKey: command.idempotencyKey,
        aiDiscoveryRunId: command.aiDiscoveryRunId,
        runKey: normalized.runKey,
        providerKey: command.provider.providerKey,
        modelKey: command.modelKey,
        modelRevision: command.modelRevision,
        promptTemplateKey: AI_DISCOVERY_PROMPT_TEMPLATE_KEY,
        promptTemplateVersion: AI_DISCOVERY_PROMPT_TEMPLATE_VERSION,
        inputHash,
        startedAt: command.startedAt,
        gameModeExternalId: normalized.gameModeExternalId,
      }, { minimumIntervalFloorSeconds: command.minimumIntervalFloorSeconds });
      if (replay.kind !== 'REPLAYED') {
        throw new Error('AI_PROVIDER_EXECUTION_TERMINAL_RUN_MISSING');
      }
      return { kind: 'RESOLVED', run: replay.run, reservation };
    }
  }

  const request = buildAiProviderRequest(normalized);
  const now = dependencies.now ?? (() => new Date().toISOString());
  const sleep = dependencies.sleep ?? ((milliseconds) => new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  }));
  const base = {
    actorId: command.actorId,
    aiDiscoveryRunId: command.aiDiscoveryRunId,
    correlationId: command.correlationId,
    idempotencyKey: command.idempotencyKey,
    runKey: normalized.runKey,
    providerKey: command.provider.providerKey,
    modelKey: command.modelKey,
    modelRevision: command.modelRevision,
    promptTemplateKey: AI_DISCOVERY_PROMPT_TEMPLATE_KEY,
    promptTemplateVersion: AI_DISCOVERY_PROMPT_TEMPLATE_VERSION,
    inputHash,
    startedAt: command.startedAt,
  };

  let heldLeaseToken: string | null = null;

  for (;;) {
    const attempt = await currentAttempt(pool, executionId);
    let markedInFlight = false;

    if (heldLeaseToken !== null) {
      try {
        await markAiProviderAttemptInFlight(pool, {
          executionId,
          attemptId: attempt.ai_provider_execution_attempt_id,
          leaseToken: heldLeaseToken,
        });
        markedInFlight = true;
      } catch (error) {
        if (!isLeaseNotHeld(error)) throw error;
        heldLeaseToken = null;
      }
    }

    if (!markedInFlight) {
      const leaseToken = randomUUID();
      if (!await claimAiProviderExecution(pool, {
        executionId,
        leaseToken,
        leaseSeconds: 120,
      })) {
        return { kind: 'UNCERTAIN', executionId, reservation };
      }
      heldLeaseToken = leaseToken;
      try {
        await markAiProviderAttemptInFlight(pool, {
          executionId,
          attemptId: attempt.ai_provider_execution_attempt_id,
          leaseToken,
        });
      } catch (error) {
        if (isLeaseNotHeld(error)) {
          return { kind: 'UNCERTAIN', executionId, reservation };
        }
        throw error;
      }
    }

    let disposition: AiProviderAttemptDisposition = await executeAiProviderAttempt({
      provider: command.provider,
      request,
      clientRequestId: attempt.client_request_id,
    });
    let completedRun: RecordAiDiscoveryRunCommand | undefined;
    let failedRun: RecordAiDiscoveryRunCommand | undefined;
    const completedAt = now();

    if (disposition.kind === 'COMPLETED') {
      try {
        const proposals = canonicalProposals(
          disposition.result.proposals,
          normalized,
          reservation.maxProposalsPerRun,
        );
        const outputHash = hashCanonicalJson({ schemaVersion: 1, proposals });
        completedRun = {
          ...base,
          outputHash,
          status: 'completed',
          completedAt,
          failureCode: null,
          proposals: proposals.map((proposal, index) => ({
            aiCandidateProposalId: proposalId(command.aiDiscoveryRunId, index),
            ordinal: index,
            patchKey: normalized.patchKey,
            gameModeExternalId: normalized.gameModeExternalId,
            subjectExternalId: proposal.subjectExternalId,
            augmentExternalIds: proposal.augmentExternalIds,
            itemExternalIds: proposal.itemExternalIds,
            rationale: proposal.rationale,
          })),
        };
      } catch {
        disposition = {
          kind: 'SAFE_TERMINAL',
          failureCode: 'PROVIDER_RESPONSE_INVALID',
          providerRequestId: disposition.result.providerRequestId,
        };
      }
    }

    if (disposition.kind === 'SAFE_TERMINAL' || disposition.kind === 'SAFE_RETRYABLE') {
      failedRun = failureRun(base, disposition.failureCode, completedAt);
    }

    const finalized = await finalizeAiProviderExecution(pool, {
      executionId,
      attemptId: attempt.ai_provider_execution_attempt_id,
      ordinal: attempt.ordinal,
      disposition,
      completedRun,
      failedRun,
    });

    if (finalized.kind === 'COMPLETED' || finalized.kind === 'FAILED') {
      return { kind: 'RESOLVED', run: finalized.run, reservation };
    }
    if (finalized.kind === 'UNCERTAIN') {
      return { kind: 'UNCERTAIN', executionId, reservation };
    }

    const delay = RETRY_DELAYS_MS[attempt.ordinal - 1];
    if (delay !== undefined) await sleep(delay);
  }
}
