import type { PgQueryable } from '../../database/queryable.js';
import type {
  AiDiscoveryMaterializationFilter,
  AiDiscoveryProposalReadModel,
  ReadAiDiscoveryProposalsOptions,
} from './types.js';

interface ProposalReadRow {
  ai_discovery_run_id: string;
  run_key: string;
  provider_key: string;
  model_key: string;
  model_revision: string;
  prompt_template_key: string;
  prompt_template_version: number;
  input_hash: string;
  output_hash: string;
  completed_at: Date | string;
  ai_candidate_proposal_id: string;
  ordinal: number;
  proposal_hash: string;
  patch_key: string;
  game_mode_external_id: 'aram_mayhem';
  subject_external_id: string;
  augment_external_ids: string[];
  item_external_ids: string[];
  rationale: string | null;
  ai_candidate_materialization_id: string | null;
  candidate_id: string | null;
  candidate_revision_id: string | null;
}

function normalizeOptions(options: ReadAiDiscoveryProposalsOptions) {
  const limit = options.limit ?? 50;
  const materialization = options.materialization ?? 'pending';
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new Error('AI_DISCOVERY_READ_OPTIONS_INVALID');
  }
  if (!(['all', 'pending', 'materialized'] as const).includes(
    materialization as AiDiscoveryMaterializationFilter,
  )) {
    throw new Error('AI_DISCOVERY_READ_OPTIONS_INVALID');
  }
  return { limit, materialization };
}

function toIso(value: Date | string): string {
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error('AI_DISCOVERY_READ_INVALID');
  return parsed.toISOString();
}

export async function readAiDiscoveryProposals(
  database: PgQueryable,
  options: ReadAiDiscoveryProposalsOptions = {},
): Promise<AiDiscoveryProposalReadModel[]> {
  const normalized = normalizeOptions(options);
  const filter = normalized.materialization === 'pending'
    ? 'and materialization.ai_candidate_materialization_id is null'
    : normalized.materialization === 'materialized'
      ? 'and materialization.ai_candidate_materialization_id is not null'
      : '';

  const result = await database.query<ProposalReadRow>(
    `select run.ai_discovery_run_id,
            run.run_key,
            run.provider_key,
            run.model_key,
            run.model_revision,
            run.prompt_template_key,
            run.prompt_template_version,
            run.input_hash,
            run.output_hash,
            run.completed_at,
            proposal.ai_candidate_proposal_id,
            proposal.ordinal,
            proposal.proposal_hash,
            proposal.patch_key,
            proposal.game_mode_external_id,
            proposal.subject_external_id,
            proposal.augment_external_ids,
            proposal.item_external_ids,
            proposal.rationale,
            materialization.ai_candidate_materialization_id,
            materialization.candidate_id,
            materialization.candidate_revision_id
       from ai_candidate_proposals proposal
       join ai_discovery_runs run
         on run.ai_discovery_run_id = proposal.ai_discovery_run_id
       left join ai_candidate_materializations materialization
         on materialization.ai_candidate_proposal_id = proposal.ai_candidate_proposal_id
      where run.status = 'completed'
        ${filter}
      order by run.created_at desc,
               proposal.ordinal asc,
               proposal.ai_candidate_proposal_id asc
      limit $1`,
    [normalized.limit],
  );

  return result.rows.map((row) => ({
    aiDiscoveryRunId: row.ai_discovery_run_id,
    runKey: row.run_key,
    providerKey: row.provider_key,
    modelKey: row.model_key,
    modelRevision: row.model_revision,
    promptTemplateKey: row.prompt_template_key,
    promptTemplateVersion: row.prompt_template_version,
    inputHash: row.input_hash,
    outputHash: row.output_hash,
    completedAt: toIso(row.completed_at),
    aiCandidateProposalId: row.ai_candidate_proposal_id,
    ordinal: row.ordinal,
    proposalHash: row.proposal_hash,
    patchKey: row.patch_key,
    gameModeExternalId: row.game_mode_external_id,
    subjectExternalId: row.subject_external_id,
    augmentExternalIds: [...row.augment_external_ids],
    itemExternalIds: [...row.item_external_ids],
    rationale: row.rationale,
    materialized: row.ai_candidate_materialization_id !== null,
    aiCandidateMaterializationId: row.ai_candidate_materialization_id,
    candidateId: row.candidate_id,
    candidateRevisionId: row.candidate_revision_id,
  }));
}
