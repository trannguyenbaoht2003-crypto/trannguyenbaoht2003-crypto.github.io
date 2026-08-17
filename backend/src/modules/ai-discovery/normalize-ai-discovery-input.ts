import { hashCanonicalJson } from '../../shared/hash.js';
import { normalizeObservationSnapshot } from '../candidate/normalize-observation.js';
import type { ObservationNormalizationSnapshotV1 } from '../candidate/types.js';
import type {
  AiCandidateProposalInput,
  NormalizedAiCandidateProposal,
  NormalizedAiDiscoveryRunCommand,
  RecordAiDiscoveryRunCommand,
} from './types.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const PRINTABLE_IDENTIFIER_PATTERN = /^[!-~]+$/u;
const MAX_IDENTIFIER_LENGTH = 128;
const MAX_REASON_LENGTH = 128;
const MAX_RATIONALE_LENGTH = 2_000;
const MAX_PROPOSALS = 100;

function fail(code: string): never {
  throw new Error(code);
}

function requireUuid(value: string, code = 'AI_DISCOVERY_UUID_INVALID'): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) return fail(code);
  return value.toLowerCase();
}

function requireHash(value: string): string {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    return fail('AI_DISCOVERY_HASH_INVALID');
  }
  return value;
}

function requireIdentifier(value: string, code = 'AI_DISCOVERY_IDENTIFIER_INVALID'): string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > MAX_IDENTIFIER_LENGTH
    || value !== value.trim()
    || !PRINTABLE_IDENTIFIER_PATTERN.test(value)
  ) {
    return fail(code);
  }
  return value;
}

function requireTimestamp(value: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    return fail('AI_DISCOVERY_TIMESTAMP_INVALID');
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return fail('AI_DISCOVERY_TIMESTAMP_INVALID');
  return parsed.toISOString();
}

function requireRationale(value: string | null): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length > MAX_RATIONALE_LENGTH) {
    return fail('AI_DISCOVERY_RATIONALE_INVALID');
  }
  return value;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function proposalNormalizationSnapshot(
  proposal: AiCandidateProposalInput,
): ObservationNormalizationSnapshotV1 {
  requireUuid(proposal.aiCandidateProposalId);
  if (!Number.isSafeInteger(proposal.ordinal) || proposal.ordinal < 0) {
    return fail('AI_DISCOVERY_PROPOSAL_ORDINAL_INVALID');
  }
  const patchKey = requireIdentifier(proposal.patchKey);
  const subjectExternalId = requireIdentifier(proposal.subjectExternalId);
  if (proposal.gameModeExternalId !== 'aram_mayhem') {
    return fail('AI_DISCOVERY_PROPOSAL_MODE_INVALID');
  }
  if (!Array.isArray(proposal.augmentExternalIds) || !Array.isArray(proposal.itemExternalIds)) {
    return fail('AI_DISCOVERY_PROPOSAL_SELECTION_INVALID');
  }

  let normalized: ReturnType<typeof normalizeObservationSnapshot>;
  try {
    normalized = normalizeObservationSnapshot({
      schemaVersion: 1,
      patchKey,
      gameModeExternalId: 'aram_mayhem',
      origin: 'ai_generated',
      subjectExternalId,
      augmentExternalIds: proposal.augmentExternalIds,
      itemExternalIds: proposal.itemExternalIds,
    });
  } catch {
    return fail('AI_DISCOVERY_PROPOSAL_SELECTION_INVALID');
  }

  if (
    !sameStrings(proposal.augmentExternalIds, normalized.snapshot.augmentExternalIds)
    || !sameStrings(proposal.itemExternalIds, normalized.snapshot.itemExternalIds)
  ) {
    return fail('AI_DISCOVERY_PROPOSAL_SELECTION_INVALID');
  }

  requireRationale(proposal.rationale);
  return normalized.snapshot;
}

export function proposalHash(proposal: AiCandidateProposalInput): string {
  const snapshot = proposalNormalizationSnapshot(proposal);
  return hashCanonicalJson({
    schemaVersion: 1,
    patchKey: snapshot.patchKey,
    gameModeExternalId: snapshot.gameModeExternalId,
    subjectExternalId: snapshot.subjectExternalId,
    augmentExternalIds: snapshot.augmentExternalIds,
    itemExternalIds: snapshot.itemExternalIds,
  });
}

function normalizeProposal(proposal: AiCandidateProposalInput): NormalizedAiCandidateProposal {
  const normalizationSnapshot = proposalNormalizationSnapshot(proposal);
  return {
    aiCandidateProposalId: requireUuid(proposal.aiCandidateProposalId),
    ordinal: proposal.ordinal,
    patchKey: normalizationSnapshot.patchKey,
    gameModeExternalId: 'aram_mayhem',
    subjectExternalId: normalizationSnapshot.subjectExternalId,
    augmentExternalIds: [...normalizationSnapshot.augmentExternalIds],
    itemExternalIds: [...normalizationSnapshot.itemExternalIds],
    rationale: requireRationale(proposal.rationale),
    proposalHash: proposalHash(proposal),
    normalizationSnapshot,
  };
}

export function normalizeAiDiscoveryRunCommand(
  command: RecordAiDiscoveryRunCommand,
): NormalizedAiDiscoveryRunCommand {
  const startedAt = requireTimestamp(command.startedAt);
  const completedAt = requireTimestamp(command.completedAt);
  if (new Date(completedAt).getTime() < new Date(startedAt).getTime()) {
    return fail('AI_DISCOVERY_TIMESTAMP_INVALID');
  }
  if (!Number.isSafeInteger(command.promptTemplateVersion) || command.promptTemplateVersion < 1) {
    return fail('AI_DISCOVERY_PROMPT_VERSION_INVALID');
  }
  if (!Array.isArray(command.proposals) || command.proposals.length > MAX_PROPOSALS) {
    return fail('AI_DISCOVERY_PROPOSALS_INVALID');
  }
  if (command.status !== 'completed' && command.status !== 'failed') {
    return fail('AI_DISCOVERY_STATUS_INVALID');
  }
  if (command.status === 'failed') {
    if (command.proposals.length !== 0) {
      return fail('AI_DISCOVERY_FAILED_RUN_PROPOSALS_FORBIDDEN');
    }
    if (
      typeof command.failureCode !== 'string'
      || command.failureCode.length === 0
      || command.failureCode.length > MAX_REASON_LENGTH
      || command.failureCode !== command.failureCode.trim()
      || !PRINTABLE_IDENTIFIER_PATTERN.test(command.failureCode)
    ) {
      return fail('AI_DISCOVERY_FAILURE_CODE_INVALID');
    }
  } else if (command.failureCode !== null) {
    return fail('AI_DISCOVERY_COMPLETED_RUN_FAILURE_CODE_FORBIDDEN');
  }

  const proposals = command.proposals.map(normalizeProposal);
  if (new Set(proposals.map((proposal) => proposal.aiCandidateProposalId)).size !== proposals.length) {
    return fail('AI_DISCOVERY_PROPOSAL_ID_DUPLICATE');
  }
  if (new Set(proposals.map((proposal) => proposal.ordinal)).size !== proposals.length) {
    return fail('AI_DISCOVERY_PROPOSAL_ORDINAL_DUPLICATE');
  }
  if (new Set(proposals.map((proposal) => proposal.proposalHash)).size !== proposals.length) {
    return fail('AI_DISCOVERY_PROPOSAL_HASH_DUPLICATE');
  }

  return {
    actorId: requireIdentifier(command.actorId),
    aiDiscoveryRunId: requireUuid(command.aiDiscoveryRunId),
    correlationId: requireIdentifier(command.correlationId),
    idempotencyKey: requireIdentifier(command.idempotencyKey),
    runKey: requireIdentifier(command.runKey),
    providerKey: requireIdentifier(command.providerKey),
    modelKey: requireIdentifier(command.modelKey),
    modelRevision: requireIdentifier(command.modelRevision),
    promptTemplateKey: requireIdentifier(command.promptTemplateKey),
    promptTemplateVersion: command.promptTemplateVersion,
    inputHash: requireHash(command.inputHash),
    outputHash: requireHash(command.outputHash),
    status: command.status,
    startedAt,
    completedAt,
    failureCode: command.failureCode,
    proposals,
  };
}
