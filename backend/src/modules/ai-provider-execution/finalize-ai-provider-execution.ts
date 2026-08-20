import { randomUUID } from 'node:crypto';

import type { Pool } from 'pg';

import { withTransaction } from '../../database/transaction.js';
import { recordAiDiscoveryRunInTransaction } from '../ai-discovery/record-ai-discovery-run.js';
import type {
  RecordAiDiscoveryRunCommand,
  RecordAiDiscoveryRunResult,
} from '../ai-discovery/types.js';
import { deterministicAiProviderClientRequestId } from './client-request-id.js';
import type {
  AiProviderAttemptDisposition,
  AiProviderAttemptOrdinal,
} from './types.js';

export interface FinalizeAiProviderExecutionCommand {
  executionId: string;
  attemptId: string;
  ordinal: AiProviderAttemptOrdinal;
  disposition: AiProviderAttemptDisposition;
  completedRun?: RecordAiDiscoveryRunCommand | undefined;
  failedRun?: RecordAiDiscoveryRunCommand | undefined;
}

export type FinalizeAiProviderExecutionResult =
  | { kind: 'COMPLETED'; run: RecordAiDiscoveryRunResult }
  | { kind: 'FAILED'; run: RecordAiDiscoveryRunResult }
  | {
      kind: 'RETRY_PREPARED';
      attemptId: string;
      ordinal: AiProviderAttemptOrdinal;
      clientRequestId: string;
    }
  | { kind: 'UNCERTAIN' };

interface LockedExecutionRow {
  ai_discovery_run_id: string;
  run_key: string;
  provider_key: string;
  model_key: string;
  model_revision: string;
  prompt_template_key: string;
  prompt_template_version: number;
  input_hash: string;
  status: string;
  current_attempt_ordinal: number;
  current_attempt_id: string;
  lease_valid: boolean;
}

function assertRunIdentity(
  execution: LockedExecutionRow,
  run: RecordAiDiscoveryRunCommand,
): void {
  if (
    run.aiDiscoveryRunId !== execution.ai_discovery_run_id
    || run.runKey !== execution.run_key
    || run.providerKey !== execution.provider_key
    || run.modelKey !== execution.model_key
    || run.modelRevision !== execution.model_revision
    || run.promptTemplateKey !== execution.prompt_template_key
    || run.promptTemplateVersion !== execution.prompt_template_version
    || run.inputHash !== execution.input_hash
  ) {
    throw new Error('AI_PROVIDER_EXECUTION_IDENTITY_CONFLICT');
  }
}

export async function finalizeAiProviderExecution(
  pool: Pool,
  command: FinalizeAiProviderExecutionCommand,
): Promise<FinalizeAiProviderExecutionResult> {
  return withTransaction(pool, async (client) => {
    const locked = await client.query<LockedExecutionRow>(
      `select e.ai_discovery_run_id,e.run_key,e.provider_key,e.model_key,e.model_revision,
              e.prompt_template_key,e.prompt_template_version,e.input_hash,e.status,
              e.current_attempt_ordinal,a.ai_provider_execution_attempt_id as current_attempt_id,
              (e.lease_token is not null and e.lease_expires_at > clock_timestamp()) as lease_valid
         from ai_provider_executions e
         join ai_provider_execution_attempts a
           on a.ai_provider_execution_id=e.ai_provider_execution_id
          and a.ordinal=e.current_attempt_ordinal
        where e.ai_provider_execution_id=$1
        for update of e,a`,
      [command.executionId],
    );
    const execution = locked.rows[0];
    if (
      !execution
      || execution.status !== 'IN_FLIGHT'
      || execution.current_attempt_ordinal !== command.ordinal
      || execution.current_attempt_id !== command.attemptId
      || execution.lease_valid !== true
    ) {
      throw new Error('AI_PROVIDER_EXECUTION_FINALIZATION_CONFLICT');
    }

    const providerRequestId = command.disposition.kind === 'COMPLETED'
      ? command.disposition.result.providerRequestId
      : command.disposition.providerRequestId;

    if (command.disposition.kind === 'COMPLETED') {
      if (!command.completedRun) {
        throw new Error('AI_PROVIDER_EXECUTION_FINALIZATION_INPUT_INVALID');
      }
      assertRunIdentity(execution, command.completedRun);
      const run = await recordAiDiscoveryRunInTransaction(client, command.completedRun);
      const attempt = await client.query(
        `update ai_provider_execution_attempts
            set status='COMPLETED',provider_request_id=$3,provider_response_id=$4,
                output_hash=$5,completed_at=clock_timestamp()
          where ai_provider_execution_attempt_id=$1
            and ai_provider_execution_id=$2
            and status='IN_FLIGHT'`,
        [
          command.attemptId,
          command.executionId,
          command.disposition.result.providerRequestId,
          command.disposition.result.providerResponseId ?? null,
          command.completedRun.outputHash,
        ],
      );
      if (attempt.rowCount !== 1) {
        throw new Error('AI_PROVIDER_EXECUTION_FINALIZATION_CONFLICT');
      }
      await client.query(
        `update ai_provider_executions
            set status='COMPLETED',lease_token=null,leased_at=null,lease_expires_at=null,
                terminal_at=clock_timestamp(),updated_at=clock_timestamp()
          where ai_provider_execution_id=$1`,
        [command.executionId],
      );
      return { kind: 'COMPLETED', run };
    }

    if (command.disposition.kind === 'SAFE_TERMINAL') {
      if (!command.failedRun) {
        throw new Error('AI_PROVIDER_EXECUTION_FINALIZATION_INPUT_INVALID');
      }
      assertRunIdentity(execution, command.failedRun);
      const run = await recordAiDiscoveryRunInTransaction(client, command.failedRun);
      const attempt = await client.query(
        `update ai_provider_execution_attempts
            set status='FAILED',failure_code=$3,provider_request_id=$4,
                completed_at=clock_timestamp()
          where ai_provider_execution_attempt_id=$1
            and ai_provider_execution_id=$2
            and status='IN_FLIGHT'`,
        [command.attemptId, command.executionId, command.disposition.failureCode, providerRequestId],
      );
      if (attempt.rowCount !== 1) {
        throw new Error('AI_PROVIDER_EXECUTION_FINALIZATION_CONFLICT');
      }
      await client.query(
        `update ai_provider_executions
            set status='FAILED',lease_token=null,leased_at=null,lease_expires_at=null,
                terminal_at=clock_timestamp(),updated_at=clock_timestamp()
          where ai_provider_execution_id=$1`,
        [command.executionId],
      );
      return { kind: 'FAILED', run };
    }

    if (command.disposition.kind === 'SAFE_RETRYABLE') {
      const attempt = await client.query(
        `update ai_provider_execution_attempts
            set status='FAILED',failure_code=$3,provider_request_id=$4,
                completed_at=clock_timestamp()
          where ai_provider_execution_attempt_id=$1
            and ai_provider_execution_id=$2
            and status='IN_FLIGHT'`,
        [command.attemptId, command.executionId, command.disposition.failureCode, providerRequestId],
      );
      if (attempt.rowCount !== 1) {
        throw new Error('AI_PROVIDER_EXECUTION_FINALIZATION_CONFLICT');
      }
      if (command.ordinal === 3) {
        if (!command.failedRun) {
          throw new Error('AI_PROVIDER_EXECUTION_FINALIZATION_INPUT_INVALID');
        }
        assertRunIdentity(execution, command.failedRun);
        const run = await recordAiDiscoveryRunInTransaction(client, command.failedRun);
        await client.query(
          `update ai_provider_executions
              set status='FAILED',lease_token=null,leased_at=null,lease_expires_at=null,
                  terminal_at=clock_timestamp(),updated_at=clock_timestamp()
            where ai_provider_execution_id=$1`,
          [command.executionId],
        );
        return { kind: 'FAILED', run };
      }

      const nextOrdinal = (command.ordinal + 1) as AiProviderAttemptOrdinal;
      const nextAttemptId = randomUUID();
      const clientRequestId = deterministicAiProviderClientRequestId(command.executionId, nextOrdinal);
      await client.query(
        `insert into ai_provider_execution_attempts
          (ai_provider_execution_attempt_id,ai_provider_execution_id,ordinal,client_request_id,status)
         values($1,$2,$3,$4,'PREPARED')`,
        [nextAttemptId, command.executionId, nextOrdinal, clientRequestId],
      );
      await client.query(
        `update ai_provider_executions
            set status='PREPARED',current_attempt_ordinal=$2,
                lease_token=case when lease_expires_at>clock_timestamp() then lease_token else null end,
                leased_at=case when lease_expires_at>clock_timestamp() then leased_at else null end,
                lease_expires_at=case when lease_expires_at>clock_timestamp() then lease_expires_at else null end,
                updated_at=clock_timestamp()
          where ai_provider_execution_id=$1`,
        [command.executionId, nextOrdinal],
      );
      return {
        kind: 'RETRY_PREPARED',
        attemptId: nextAttemptId,
        ordinal: nextOrdinal,
        clientRequestId,
      };
    }

    const attempt = await client.query(
      `update ai_provider_execution_attempts
          set status='UNCERTAIN',failure_code=$3,provider_request_id=$4,
              completed_at=clock_timestamp()
        where ai_provider_execution_attempt_id=$1
          and ai_provider_execution_id=$2
          and status='IN_FLIGHT'`,
      [command.attemptId, command.executionId, command.disposition.failureCode, providerRequestId],
    );
    if (attempt.rowCount !== 1) {
      throw new Error('AI_PROVIDER_EXECUTION_FINALIZATION_CONFLICT');
    }
    await client.query(
      `update ai_provider_executions
          set status='UNCERTAIN',lease_token=null,leased_at=null,lease_expires_at=null,
              updated_at=clock_timestamp()
        where ai_provider_execution_id=$1`,
      [command.executionId],
    );
    return { kind: 'UNCERTAIN' };
  });
}
