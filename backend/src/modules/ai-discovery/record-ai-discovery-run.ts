import { randomUUID } from 'node:crypto';

import type { Pool, PoolClient } from 'pg';

import { withTransaction } from '../../database/transaction.js';
import { hashCanonicalJson } from '../../shared/hash.js';
import {
  beginIdempotentCommand,
  completeIdempotentCommand,
} from '../../shared/idempotent-command.js';
import { normalizeAiDiscoveryRunCommand } from './normalize-ai-discovery-input.js';
import type {
  NormalizedAiDiscoveryRunCommand,
  RecordAiDiscoveryRunCommand,
  RecordAiDiscoveryRunResult,
} from './types.js';

const IDEMPOTENCY_SCOPE = 'ai.discovery.run.record';

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

async function assertRunKeyAvailable(
  client: PoolClient,
  command: NormalizedAiDiscoveryRunCommand,
): Promise<void> {
  const existing = await client.query<{
    ai_discovery_run_id: string;
  }>(
    `select ai_discovery_run_id
       from ai_discovery_runs
      where run_key = $1
      for update`,
    [command.runKey],
  );
  if (existing.rowCount !== 0) {
    throw new Error('AI_DISCOVERY_RUN_CONFLICT');
  }
}

function freshResult(command: NormalizedAiDiscoveryRunCommand): RecordAiDiscoveryRunResult {
  return {
    aiDiscoveryRunId: command.aiDiscoveryRunId,
    runKey: command.runKey,
    status: command.status,
    proposalIds: [...command.proposals]
      .sort((left, right) => left.ordinal - right.ordinal)
      .map((proposal) => proposal.aiCandidateProposalId),
    proposalCount: command.proposals.length,
    replayed: false,
  };
}

export async function recordAiDiscoveryRun(
  pool: Pool,
  input: RecordAiDiscoveryRunCommand,
): Promise<RecordAiDiscoveryRunResult> {
  const command = normalizeAiDiscoveryRunCommand(input);
  const commandHash = canonicalCommandHash(command);

  return withTransaction(pool, async (client) => {
    await client.query(
      `select pg_advisory_xact_lock(hashtextextended($1::text, 0))`,
      [`ai-discovery-run:${command.runKey}`],
    );

    const replay = await beginIdempotentCommand<RecordAiDiscoveryRunResult>(
      client,
      IDEMPOTENCY_SCOPE,
      command.idempotencyKey,
      commandHash,
    );
    if (replay) {
      return { ...replay, replayed: true };
    }

    await assertRunKeyAvailable(client, command);

    await client.query(
      `insert into ai_discovery_runs
         (ai_discovery_run_id, run_key, provider_key, model_key,
          model_revision, prompt_template_key, prompt_template_version,
          input_hash, output_hash, status, started_at, completed_at,
          failure_code)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        command.aiDiscoveryRunId,
        command.runKey,
        command.providerKey,
        command.modelKey,
        command.modelRevision,
        command.promptTemplateKey,
        command.promptTemplateVersion,
        command.inputHash,
        command.outputHash,
        command.status,
        command.startedAt,
        command.completedAt,
        command.failureCode,
      ],
    );

    for (const proposal of [...command.proposals].sort((left, right) => left.ordinal - right.ordinal)) {
      await client.query(
        `insert into ai_candidate_proposals
           (ai_candidate_proposal_id, ai_discovery_run_id, ordinal,
            proposal_hash, patch_key, game_mode_external_id,
            subject_external_id, augment_external_ids,
            item_external_ids, rationale)
         values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10)`,
        [
          proposal.aiCandidateProposalId,
          command.aiDiscoveryRunId,
          proposal.ordinal,
          proposal.proposalHash,
          proposal.patchKey,
          proposal.gameModeExternalId,
          proposal.subjectExternalId,
          JSON.stringify(proposal.augmentExternalIds),
          JSON.stringify(proposal.itemExternalIds),
          proposal.rationale,
        ],
      );
    }

    const eventPayload = {
      schemaVersion: 1,
      aiDiscoveryRunId: command.aiDiscoveryRunId,
      runKey: command.runKey,
      inputHash: command.inputHash,
      outputHash: command.outputHash,
      status: command.status,
      proposalCount: command.proposals.length,
    } as const;

    await client.query(
      `insert into audit_events
         (audit_event_id, actor_id, action, reason, correlation_id, payload)
       values ($1,$2,'ai.discovery.run.recorded',
               'AI discovery run recorded as advisory proposal authority',
               $3,$4::jsonb)`,
      [
        randomUUID(),
        command.actorId,
        command.correlationId,
        JSON.stringify(eventPayload),
      ],
    );

    await client.query(
      `insert into outbox_events
         (outbox_event_id, aggregate_type, aggregate_id, event_type,
          payload, occurred_at)
       values ($1,'ai_discovery_run',$2,'AiDiscoveryRunRecorded',$3::jsonb,$4)`,
      [
        randomUUID(),
        command.aiDiscoveryRunId,
        JSON.stringify(eventPayload),
        command.completedAt,
      ],
    );

    const result = freshResult(command);
    await completeIdempotentCommand(
      client,
      IDEMPOTENCY_SCOPE,
      command.idempotencyKey,
      result,
    );
    return result;
  });
}
