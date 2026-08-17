import type { ObservationNormalizationSnapshotV1 } from '../candidate/types.js';

export type AiDiscoveryRunStatus = 'completed' | 'failed';
export type AiDiscoveryMaterializationFilter = 'all' | 'pending' | 'materialized';

export interface AiCandidateProposalInput {
  aiCandidateProposalId: string;
  ordinal: number;
  patchKey: string;
  gameModeExternalId: 'aram_mayhem';
  subjectExternalId: string;
  augmentExternalIds: string[];
  itemExternalIds: string[];
  rationale: string | null;
}

export interface RecordAiDiscoveryRunCommand {
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
  outputHash: string;
  status: AiDiscoveryRunStatus;
  startedAt: string;
  completedAt: string;
  failureCode: string | null;
  proposals: AiCandidateProposalInput[];
}

export interface NormalizedAiCandidateProposal extends AiCandidateProposalInput {
  proposalHash: string;
  normalizationSnapshot: ObservationNormalizationSnapshotV1;
}

export interface NormalizedAiDiscoveryRunCommand extends Omit<
  RecordAiDiscoveryRunCommand,
  'proposals'
> {
  startedAt: string;
  completedAt: string;
  proposals: NormalizedAiCandidateProposal[];
}

export interface RecordAiDiscoveryRunResult {
  aiDiscoveryRunId: string;
  runKey: string;
  status: AiDiscoveryRunStatus;
  proposalIds: string[];
  proposalCount: number;
  replayed: boolean;
}

export interface MaterializeAiCandidateProposalCommand {
  actorId: string;
  aiCandidateMaterializationId: string;
  aiCandidateProposalId: string;
  correlationId: string;
  idempotencyKey: string;
  reason: string;
  materializedAt: string;
}

export interface MaterializeAiCandidateProposalResult {
  aiCandidateMaterializationId: string;
  aiCandidateProposalId: string;
  candidateId: string;
  candidateRevisionId: string;
  candidateProvenanceId: string;
  normalizedObservationId: string;
  rawObservationId: string;
  reusedCanonicalGraph: boolean;
  replayed: boolean;
}

export interface ReadAiDiscoveryProposalsOptions {
  limit?: number;
  materialization?: AiDiscoveryMaterializationFilter;
}

export interface AiDiscoveryProposalReadModel {
  aiDiscoveryRunId: string;
  runKey: string;
  providerKey: string;
  modelKey: string;
  modelRevision: string;
  promptTemplateKey: string;
  promptTemplateVersion: number;
  inputHash: string;
  outputHash: string;
  completedAt: string;
  aiCandidateProposalId: string;
  ordinal: number;
  proposalHash: string;
  patchKey: string;
  gameModeExternalId: 'aram_mayhem';
  subjectExternalId: string;
  augmentExternalIds: string[];
  itemExternalIds: string[];
  rationale: string | null;
  materialized: boolean;
  aiCandidateMaterializationId: string | null;
  candidateId: string | null;
  candidateRevisionId: string | null;
}
