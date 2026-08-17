import type { Pool, PoolClient } from 'pg';

import { withTransaction } from '../../database/transaction.js';
import { hashCanonicalJson } from '../../shared/hash.js';
import { normalizeAiDiscoveryRunCommand } from './normalize-ai-discovery-input.js';
import type {
  AiDiscoveryRunStatus,
  NormalizedAiDiscoveryRunCommand,
  RecordAiDiscoveryRunCommand,
  RecordAiDiscoveryRunResult,
} from './types.js';

const IDEMPOTENCY_SCOPE = 'ai.discovery.run.record';

export interface AiDiscoveryRunReplayIdentity {
  actorId: string;
  aiDiscoveryRunId: string;
  correlationId: string;
  idempotencyKey: string;
  runKey: string;
  providerKey: string;
  modelKey: string;
  modelRevision: string;
  promptTemplateKey: string;
  promptTemplateVersion: number;
  inputHash: string;
  startedAt: string;
}

interface IdempotencyRow {
  payload_hash: string;
  state: string;
  result: RecordAiDiscoveryRunResult | null;
}

interface RunRow {
  ai_discovery_run_id: string;
  run_key: string;
  provider_key: string;
  model_key: string;
  model_revision: string;
  prompt_template_key: string;
  prompt_template_version: number;
  input_hash: string;
  output_hash: string;
  status: AiDiscoveryRunStatus;
  started_at: Date | string;
  completed_at: Date | string;
  failure_code: string | null;
}

interface ProposalRow {
  ai_candidate_proposal_id: string;
  ordinal: number;
  patch_key: string;
  game_mode_external_id: 'aram_mayhem';
  subject_external_id: string;
  augment_external_ids: string[];
  item_external_ids: string[];
  rationale: string | null;
}

function canonicalCommandHash(command: NormalizedAiDiscoveryRunCommand): string {
  return hashCanonicalJson({
    schemaVersion: 1,
    actorId: command.actorId,
    aiDiscoveryRunId: command.aiDiscoveryRunId,
    correlationId: command.correlationId,
    runKey: command.runKey,
    providerKey: command.providerKey,
    modelKey: command.modelKey,
    modelRevision: command.modelRevision,
    promptTemplateKey: command.promptTemplateKey,
    promptTemplateVersion: command.promptTemplateVersion,
    inputHash: command.inputHash,
    outputHash: command.outputHash,
    status: command.status,
    startedAt: command.startedAt,
    completedAt: command.completedAt,
    failureCode: command.failureCode,
    proposals: [...command.proposals]
      .sort((left, right) => left.ordinal - right.ordinal)
      .map((proposal) => ({
        aiCandidateProposalId: proposal.aiCandidateProposalId,
        ordinal: proposal.ordinal,
        proposalHash: proposal.proposalHash,
        patchKey: proposal.patchKey,
        gameModeExternalId: proposal.gameModeExternalId,
        subjectExternalId: proposal.subjectExternalId,
        augmentExternalIds: proposal.augmentExternalIds,
        itemExternalIds: proposal.itemExternalIds,
        rationale: proposal.rationale,
      })),
  });
}

function isoTimestamp(value: Date | string): string {
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error('AI_DISCOVERY_RUN_CONFLICT');
  }
  return parsed.toISOString();
}

async function assertNoExistingRun(
  client: PoolClient,
  identity: AiDiscoveryRunReplayIdentity,
): Promise<void> {
  const existing = await client.query(
    `select 1
       from ai_discovery_runs
      where ai_discovery_run_id = $1
         or run_key = $2
      limit 1`,
    [identity.aiDiscoveryRunId, identity.runKey],
  );
  if (existing.rowCount !== 0) {
    throw new Error('AI_DISCOVERY_RUN_CONFLICT');
  }
}

async function loadCompletedRun(
  client: PoolClient,
  identity: AiDiscoveryRunReplayIdentity,
): Promise<{ run: RunRow; proposals: ProposalRow[] }> {
  const runs = await client.query<RunRow>(
    `select ai_discovery_run_id, run_key, provider_key, model_key,
            model_revision, prompt_template_key, prompt_template_version,
            input_hash, output_hash, status, started_at, completed_at,
            failure_code
       from ai_discovery_runs
      where ai_discovery_run_id = $1
         or run_key = $2
      for update`,
    [identity.aiDiscoveryRunId, identity.runKey],
  );
  if (runs.rowCount !== 1) {
    throw new Error('AI_DISCOVERY_RUN_CONFLICT');
  }

  const run = runs.rows[0]!;
  if (
    run.ai_discovery_run_id !== identity.aiDiscoveryRunId
    || run.run_key !== identity.runKey
  ) {
    throw new Error('AI_DISCOVERY_RUN_CONFLICT');
  }

  const proposals = await client.query<ProposalRow>(
    `select ai_candidate_proposal_id, ordinal, patch_key,
            game_mode_external_id, subject_external_id,
            augment_external_ids, item_external_ids, rationale
       from ai_candidate_proposals
      where ai_discovery_run_id = $1
      order by ordinal asc`,
    [run.ai_discovery_run_id],
  );

  return { run, proposals: proposals.rows };
}

function reconstructCommand(
  identity: AiDiscoveryRunReplayIdentity,
  run: RunRow,
  proposals: ProposalRow[],
): RecordAiDiscoveryRunCommand {
  return {
    actorId: identity.actorId,
    aiDiscoveryRunId: identity.aiDiscoveryRunId,
    correlationId: identity.correlationId,
    idempotencyKey: identity.idempotencyKey,
    runKey: identity.runKey,
    providerKey: identity.providerKey,
    modelKey: identity.modelKey,
    modelRevision: identity.modelRevision,
    promptTemplateKey: identity.promptTemplateKey,
    promptTemplateVersion: identity.promptTemplateVersion,
    inputHash: identity.inputHash,
    outputHash: run.output_hash,
    status: run.status,
    startedAt: identity.startedAt,
    completedAt: isoTimestamp(run.completed_at),
    failureCode: run.failure_code,
    proposals: proposals.map((proposal) => ({
      aiCandidateProposalId: proposal.ai_candidate_proposal_id,
      ordinal: proposal.ordinal,
      patchKey: proposal.patch_key,
      gameModeExternalId: proposal.game_mode_external_id,
      subjectExternalId: proposal.subject_external_id,
      augmentExternalIds: proposal.augment_external_ids,
      itemExternalIds: proposal.item_external_ids,
      rationale: proposal.rationale,
    })),
  };
}

export async function readAiDiscoveryRunReplay(
  pool: Pool,
  identity: AiDiscoveryRunReplayIdentity,
): Promise<RecordAiDiscoveryRunResult | null> {
  return withTransaction(pool, async (client) => {
    const idempotency = await client.query<IdempotencyRow>(
      `select payload_hash, state, result
         from idempotency_records
        where scope = $1
          and idempotency_key = $2
        for update`,
      [IDEMPOTENCY_SCOPE, identity.idempotencyKey],
    );

    if (idempotency.rowCount === 0) {
      await assertNoExistingRun(client, identity);
      return null;
    }

    const record = idempotency.rows[0]!;
    if (record.state !== 'completed' || record.result === null) {
      throw new Error('IDEMPOTENCY_OPERATION_IN_PROGRESS');
    }

    const { run, proposals } = await loadCompletedRun(client, identity);
    const reconstructed = normalizeAiDiscoveryRunCommand(
      reconstructCommand(identity, run, proposals),
    );
    if (canonicalCommandHash(reconstructed) !== record.payload_hash) {
      throw new Error('IDEMPOTENCY_PAYLOAD_CONFLICT');
    }

    return { ...record.result, replayed: true };
  });
}
