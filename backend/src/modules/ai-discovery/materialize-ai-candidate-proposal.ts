import { randomUUID } from 'node:crypto';

import type { Pool, PoolClient } from 'pg';

import { withTransaction } from '../../database/transaction.js';
import { hashCanonicalJson } from '../../shared/hash.js';
import {
  beginIdempotentCommand,
  completeIdempotentCommand,
} from '../../shared/idempotent-command.js';
import {
  registerNormalizedObservationInTransaction,
} from '../candidate/register-normalized-observation.js';
import type { ObservationNormalizationSnapshotV1 } from '../candidate/types.js';
import { proposalNormalizationSnapshot } from './normalize-ai-discovery-input.js';
import type {
  AiCandidateProposalInput,
  MaterializeAiCandidateProposalCommand,
  MaterializeAiCandidateProposalResult,
} from './types.js';

const IDEMPOTENCY_SCOPE = 'ai.candidate.proposal.materialize';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

interface ProposalRow {
  ai_candidate_proposal_id: string;
  ai_discovery_run_id: string;
  ordinal: number;
  proposal_hash: string;
  patch_key: string;
  game_mode_external_id: 'aram_mayhem';
  subject_external_id: string;
  augment_external_ids: string[];
  item_external_ids: string[];
  rationale: string | null;
  run_status: 'completed' | 'failed';
  run_completed_at: Date | string;
}

interface SafeSourceRow {
  source_id: string;
  source_policy_revision_id: string;
  source_status: string;
  policy_revision: number;
  storage_permission: string;
  collector_enabled: boolean;
  reason: string;
  created_by: string;
}

interface CanonicalGraphRow {
  raw_observation_id: string;
  normalized_observation_id: string;
  candidate_provenance_id: string;
  candidate_id: string;
  candidate_revision_id: string;
}

function requireUuid(value: string, code: string): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) throw new Error(code);
  return value.toLowerCase();
}

function requireText(value: string, max: number, code: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max) {
    throw new Error(code);
  }
  return value;
}

function requireTimestamp(value: string): string {
  const parsed = new Date(value);
  if (typeof value !== 'string' || value.length === 0 || Number.isNaN(parsed.getTime())) {
    throw new Error('AI_DISCOVERY_MATERIALIZATION_TIMESTAMP_INVALID');
  }
  return parsed.toISOString();
}

function normalizeCommand(command: MaterializeAiCandidateProposalCommand) {
  return {
    actorId: requireText(command.actorId, 256, 'AI_DISCOVERY_MATERIALIZATION_ACTOR_INVALID'),
    aiCandidateMaterializationId: requireUuid(
      command.aiCandidateMaterializationId,
      'AI_DISCOVERY_MATERIALIZATION_ID_INVALID',
    ),
    aiCandidateProposalId: requireUuid(
      command.aiCandidateProposalId,
      'AI_DISCOVERY_PROPOSAL_ID_INVALID',
    ),
    correlationId: requireText(
      command.correlationId,
      256,
      'AI_DISCOVERY_MATERIALIZATION_CORRELATION_INVALID',
    ),
    idempotencyKey: requireText(
      command.idempotencyKey,
      256,
      'AI_DISCOVERY_MATERIALIZATION_IDEMPOTENCY_INVALID',
    ),
    reason: requireText(command.reason, 2_000, 'AI_DISCOVERY_MATERIALIZATION_REASON_INVALID'),
    materializedAt: requireTimestamp(command.materializedAt),
  };
}

function commandHash(command: ReturnType<typeof normalizeCommand>): string {
  return hashCanonicalJson({ schemaVersion: 1, ...command });
}

function proposalInput(row: ProposalRow): AiCandidateProposalInput {
  return {
    aiCandidateProposalId: row.ai_candidate_proposal_id,
    ordinal: row.ordinal,
    patchKey: row.patch_key,
    gameModeExternalId: row.game_mode_external_id,
    subjectExternalId: row.subject_external_id,
    augmentExternalIds: row.augment_external_ids,
    itemExternalIds: row.item_external_ids,
    rationale: row.rationale,
  };
}

async function loadProposal(client: PoolClient, proposalId: string): Promise<ProposalRow> {
  const result = await client.query<ProposalRow>(
    `select proposal.ai_candidate_proposal_id,
            proposal.ai_discovery_run_id,
            proposal.ordinal,
            proposal.proposal_hash,
            proposal.patch_key,
            proposal.game_mode_external_id,
            proposal.subject_external_id,
            proposal.augment_external_ids,
            proposal.item_external_ids,
            proposal.rationale,
            run.status as run_status,
            run.completed_at as run_completed_at
       from ai_candidate_proposals proposal
       join ai_discovery_runs run
         on run.ai_discovery_run_id = proposal.ai_discovery_run_id
      where proposal.ai_candidate_proposal_id = $1
      for update of proposal, run`,
    [proposalId],
  );
  const proposal = result.rows[0];
  if (!proposal) throw new Error('AI_DISCOVERY_PROPOSAL_NOT_FOUND');
  if (proposal.run_status !== 'completed') {
    throw new Error('AI_DISCOVERY_PROPOSAL_RUN_NOT_COMPLETED');
  }
  return proposal;
}

async function loadSafeSource(client: PoolClient): Promise<SafeSourceRow> {
  const result = await client.query<SafeSourceRow>(
    `select source.source_id,
            source.status as source_status,
            policy.source_policy_revision_id,
            policy.revision as policy_revision,
            policy.storage_permission,
            policy.collector_enabled,
            policy.reason,
            policy.created_by
       from sources source
       join active_source_policies active
         on active.source_id = source.source_id
       join source_policy_revisions policy
         on policy.source_policy_revision_id = active.source_policy_revision_id
        and policy.source_id = source.source_id
      where source.source_key = 'ai-discovery'
      for share of source, active, policy`,
  );
  const authority = result.rows[0];
  if (
    !authority
    || authority.source_status !== 'active'
    || authority.policy_revision !== 1
    || authority.storage_permission !== 'aggregate_only'
    || authority.collector_enabled !== false
    || authority.reason !== 'synthetic AI proposal materialization only'
    || authority.created_by !== 'system:migration:0014'
  ) {
    throw new Error('AI_DISCOVERY_RESERVED_POLICY_UNSAFE');
  }
  return authority;
}

async function loadCanonicalGraph(
  client: PoolClient,
  authority: SafeSourceRow,
  proposalHash: string,
  snapshot: ObservationNormalizationSnapshotV1,
): Promise<CanonicalGraphRow | null> {
  const result = await client.query<CanonicalGraphRow>(
    `select raw.raw_observation_id,
            normalized.normalized_observation_id,
            provenance.candidate_provenance_id,
            revision.candidate_id,
            provenance.candidate_revision_id
       from raw_observations raw
       join normalized_observations normalized
         on normalized.raw_observation_id = raw.raw_observation_id
       join candidate_provenance provenance
         on provenance.normalized_observation_id = normalized.normalized_observation_id
        and provenance.origin = 'ai_generated'
       join candidate_revisions revision
         on revision.candidate_revision_id = provenance.candidate_revision_id
      where raw.source_id = $1
        and raw.source_policy_revision_id = $2
        and raw.adapter_version = 'ai-discovery-proposal-v1'
        and raw.content_hash = $3
        and raw.raw_blob is null
        and raw.aggregate_metadata -> 'normalizationSnapshot' = $4::jsonb
      order by raw.created_at, raw.raw_observation_id
      limit 1
      for share of raw, normalized, provenance, revision`,
    [
      authority.source_id,
      authority.source_policy_revision_id,
      proposalHash,
      JSON.stringify(snapshot),
    ],
  );
  return result.rows[0] ?? null;
}

async function createCanonicalGraph(
  client: PoolClient,
  authority: SafeSourceRow,
  proposal: ProposalRow,
  snapshot: ObservationNormalizationSnapshotV1,
  command: ReturnType<typeof normalizeCommand>,
): Promise<CanonicalGraphRow> {
  const rawObservationId = randomUUID();
  const normalizedObservationId = randomUUID();
  const candidateId = randomUUID();
  const candidateRevisionId = randomUUID();
  const candidateProvenanceId = randomUUID();
  const externalReference = {
    schemaVersion: 1,
    aiDiscoveryRunId: proposal.ai_discovery_run_id,
    aiCandidateProposalId: proposal.ai_candidate_proposal_id,
  };
  const aggregateMetadata = { normalizationSnapshot: snapshot };

  await client.query(
    `insert into raw_observations
       (raw_observation_id, source_id, source_policy_revision_id,
        adapter_version, external_reference, aggregate_metadata,
        content_hash, raw_blob, patch_hint, observed_at, collected_at)
     values ($1,$2,$3,'ai-discovery-proposal-v1',$4::jsonb,$5::jsonb,
             $6,null,$7,$8,$9)`,
    [
      rawObservationId,
      authority.source_id,
      authority.source_policy_revision_id,
      JSON.stringify(externalReference),
      JSON.stringify(aggregateMetadata),
      proposal.proposal_hash,
      proposal.patch_key,
      proposal.run_completed_at,
      command.materializedAt,
    ],
  );

  const registered = await registerNormalizedObservationInTransaction(client, {
    actorId: command.actorId,
    candidateId,
    candidateRevisionId,
    correlationId: command.correlationId,
    normalizedObservationId,
    provenanceId: candidateProvenanceId,
    rawObservationId,
    snapshot,
  });

  const provenance = await client.query<{
    candidate_provenance_id: string;
    candidate_revision_id: string;
    normalized_observation_id: string;
    origin: string;
  }>(
    `select candidate_provenance_id,
            candidate_revision_id,
            normalized_observation_id,
            origin
       from candidate_provenance
      where normalized_observation_id = $1
      for share`,
    [registered.normalizedObservationId],
  );
  const proof = provenance.rows[0];
  if (
    !proof
    || proof.origin !== 'ai_generated'
    || proof.candidate_revision_id !== registered.candidateRevisionId
  ) {
    throw new Error('AI_DISCOVERY_CANDIDATE_PROVENANCE_INVALID');
  }

  return {
    raw_observation_id: rawObservationId,
    normalized_observation_id: registered.normalizedObservationId,
    candidate_provenance_id: proof.candidate_provenance_id,
    candidate_id: registered.candidateId,
    candidate_revision_id: registered.candidateRevisionId,
  };
}

function resultFromGraph(
  command: ReturnType<typeof normalizeCommand>,
  graph: CanonicalGraphRow,
  reusedCanonicalGraph: boolean,
): MaterializeAiCandidateProposalResult {
  return {
    aiCandidateMaterializationId: command.aiCandidateMaterializationId,
    aiCandidateProposalId: command.aiCandidateProposalId,
    candidateId: graph.candidate_id,
    candidateRevisionId: graph.candidate_revision_id,
    candidateProvenanceId: graph.candidate_provenance_id,
    normalizedObservationId: graph.normalized_observation_id,
    rawObservationId: graph.raw_observation_id,
    reusedCanonicalGraph,
    replayed: false,
  };
}

export async function materializeAiCandidateProposal(
  pool: Pool,
  input: MaterializeAiCandidateProposalCommand,
): Promise<MaterializeAiCandidateProposalResult> {
  const command = normalizeCommand(input);
  const payloadHash = commandHash(command);

  return withTransaction(pool, async (client) => {
    const replay = await beginIdempotentCommand<MaterializeAiCandidateProposalResult>(
      client,
      IDEMPOTENCY_SCOPE,
      command.idempotencyKey,
      payloadHash,
    );
    if (replay) return { ...replay, replayed: true };

    const proposal = await loadProposal(client, command.aiCandidateProposalId);
    const existingMaterialization = await client.query(
      `select ai_candidate_materialization_id
         from ai_candidate_materializations
        where ai_candidate_proposal_id = $1
        for update`,
      [command.aiCandidateProposalId],
    );
    if (existingMaterialization.rowCount !== 0) {
      throw new Error('AI_DISCOVERY_PROPOSAL_ALREADY_MATERIALIZED');
    }

    await client.query(
      `select pg_advisory_xact_lock(hashtextextended($1::text, 0))`,
      [`ai-discovery-proposal:${proposal.proposal_hash}`],
    );

    const authority = await loadSafeSource(client);
    const snapshot = proposalNormalizationSnapshot(proposalInput(proposal));
    const existingGraph = await loadCanonicalGraph(
      client,
      authority,
      proposal.proposal_hash,
      snapshot,
    );
    const graph = existingGraph ?? await createCanonicalGraph(
      client,
      authority,
      proposal,
      snapshot,
      command,
    );
    const result = resultFromGraph(command, graph, existingGraph !== null);

    await client.query(
      `insert into ai_candidate_materializations
         (ai_candidate_materialization_id, ai_candidate_proposal_id,
          raw_observation_id, normalized_observation_id, candidate_id,
          candidate_revision_id, candidate_provenance_id, actor_id,
          reason, correlation_id, materialized_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        command.aiCandidateMaterializationId,
        command.aiCandidateProposalId,
        result.rawObservationId,
        result.normalizedObservationId,
        result.candidateId,
        result.candidateRevisionId,
        result.candidateProvenanceId,
        command.actorId,
        command.reason,
        command.correlationId,
        command.materializedAt,
      ],
    );

    const eventPayload = {
      schemaVersion: 1,
      aiCandidateMaterializationId: command.aiCandidateMaterializationId,
      aiCandidateProposalId: command.aiCandidateProposalId,
      proposalHash: proposal.proposal_hash,
      rawObservationId: result.rawObservationId,
      normalizedObservationId: result.normalizedObservationId,
      candidateId: result.candidateId,
      candidateRevisionId: result.candidateRevisionId,
      candidateProvenanceId: result.candidateProvenanceId,
      reusedCanonicalGraph: result.reusedCanonicalGraph,
    } as const;

    await client.query(
      `insert into audit_events
         (audit_event_id, actor_id, action, reason, correlation_id, payload)
       values ($1,$2,'ai.candidate.proposal.materialized',$3,$4,$5::jsonb)`,
      [
        randomUUID(),
        command.actorId,
        command.reason,
        command.correlationId,
        JSON.stringify(eventPayload),
      ],
    );
    await client.query(
      `insert into outbox_events
         (outbox_event_id, aggregate_type, aggregate_id, event_type,
          payload, correlation_id)
       values ($1,'ai_candidate_proposal',$2,'AiCandidateProposalMaterialized',$3::jsonb,$4)`,
      [
        randomUUID(),
        command.aiCandidateProposalId,
        JSON.stringify(eventPayload),
        command.correlationId,
      ],
    );

    await completeIdempotentCommand(
      client,
      IDEMPOTENCY_SCOPE,
      command.idempotencyKey,
      result,
    );
    return result;
  });
}
