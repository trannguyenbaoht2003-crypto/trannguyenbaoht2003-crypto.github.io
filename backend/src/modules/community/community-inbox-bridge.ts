import { createHash } from 'node:crypto';

import type {
  IngestObservationCommand,
} from '../collector/ingest-observation.js';

const ADAPTER_VERSION = 'community-collector-bridge-v1';
const ACTOR_ID = 'community-collector';
const PATCH_PATTERN = /^[!-~]{1,128}$/u;

type SkipReason =
  | 'MODE_NOT_CONFIRMED'
  | 'CANDIDATE_STALE'
  | 'CANDIDATE_DISQUALIFIED'
  | 'CANDIDATE_SCHEMA_INVALID'
  | 'SUBJECT_NOT_EXACT'
  | 'SELECTION_IDS_INVALID'
  | 'COLLECTED_AT_INVALID';

export interface CommunityObservationSkip {
  candidateId: string;
  reason: SkipReason;
}

export interface CommunityObservationBatch {
  commands: IngestObservationCommand[];
  skipped: CommunityObservationSkip[];
}

export interface BuildCommunityObservationBatchInput {
  inbox: unknown;
  patchKey: string;
  sourceId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function scalarId(value: unknown): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const normalized = String(value).trim();
  if (!normalized || normalized.length > 128 || !PATCH_PATTERN.test(normalized)) {
    return undefined;
  }
  return normalized;
}

function selectedIds(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const ids: string[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) return undefined;
    const id = scalarId(entry.id);
    if (!id) return undefined;
    ids.push(id);
  }
  return [...new Set(ids)].sort();
}

function stableCollectedAt(candidate: Record<string, unknown>): Date | undefined {
  for (const value of [candidate.firstSeenAt, candidate.publishedAt]) {
    const candidateDate = text(value);
    if (!candidateDate) continue;
    const parsed = new Date(
      /^\d{4}-\d{2}-\d{2}$/u.test(candidateDate)
        ? `${candidateDate}T00:00:00.000Z`
        : candidateDate,
    );
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return undefined;
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function deterministicUuid(seed: string): string {
  const bytes = Buffer.from(createHash('sha256').update(seed).digest().subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
}

function boundedExternalReference(candidate: Record<string, unknown>) {
  return {
    schemaVersion: 1,
    candidateId: text(candidate.id),
    platform: text(candidate.platform),
    url: text(candidate.url),
    author: text(candidate.author),
    publishedAt: text(candidate.publishedAt),
    status: text(candidate.status),
    score: finiteNumber(candidate.score),
    evidenceVersion: finiteNumber(candidate.evidenceVersion),
    evidenceReviewState: text(candidate.evidenceReviewState),
    sourceContentId: text(candidate.sourceContentId),
  };
}

function skip(
  skipped: CommunityObservationSkip[],
  candidateId: string,
  reason: SkipReason,
): void {
  skipped.push({ candidateId, reason });
}

export function buildCommunityObservationBatch(
  input: BuildCommunityObservationBatchInput,
): CommunityObservationBatch {
  const patchKey = text(input.patchKey);
  if (!patchKey || !PATCH_PATTERN.test(patchKey)) {
    throw new Error('COMMUNITY_PATCH_REQUIRED');
  }
  if (
    !isRecord(input.inbox)
    || input.inbox.schemaVersion !== 1
    || !Array.isArray(input.inbox.candidates)
  ) {
    throw new Error('COMMUNITY_INBOX_SCHEMA_UNSUPPORTED');
  }

  const commands: IngestObservationCommand[] = [];
  const skipped: CommunityObservationSkip[] = [];

  for (const value of input.inbox.candidates) {
    if (!isRecord(value)) {
      throw new Error('COMMUNITY_CANDIDATE_SCHEMA_UNSUPPORTED');
    }
    const candidateId = text(value.id);
    if (!candidateId) {
      throw new Error('COMMUNITY_CANDIDATE_ID_REQUIRED');
    }
    if (value.modeValid !== true) {
      skip(skipped, candidateId, 'MODE_NOT_CONFIRMED');
      continue;
    }
    if (value.currentEnough !== true) {
      skip(skipped, candidateId, 'CANDIDATE_STALE');
      continue;
    }
    if (!Array.isArray(value.disqualifiers)) {
      skip(skipped, candidateId, 'CANDIDATE_SCHEMA_INVALID');
      continue;
    }
    if (value.disqualifiers.length > 0) {
      skip(skipped, candidateId, 'CANDIDATE_DISQUALIFIED');
      continue;
    }
    if (!Array.isArray(value.championMatches) || value.championMatches.length !== 1) {
      skip(skipped, candidateId, 'SUBJECT_NOT_EXACT');
      continue;
    }
    const champion = value.championMatches[0];
    const subjectExternalId = isRecord(champion) ? scalarId(champion.id) : undefined;
    if (!subjectExternalId) {
      skip(skipped, candidateId, 'SUBJECT_NOT_EXACT');
      continue;
    }
    const augmentExternalIds = selectedIds(value.augmentMatches);
    const itemExternalIds = selectedIds(value.itemMatches);
    if (!augmentExternalIds || !itemExternalIds) {
      skip(skipped, candidateId, 'SELECTION_IDS_INVALID');
      continue;
    }
    const collectedAt = stableCollectedAt(value);
    if (!collectedAt) {
      skip(skipped, candidateId, 'COLLECTED_AT_INVALID');
      continue;
    }

    const normalizationSnapshot = {
      schemaVersion: 1 as const,
      patchKey,
      gameModeExternalId: 'aram_mayhem' as const,
      origin: 'collector_detected' as const,
      subjectExternalId,
      augmentExternalIds,
      itemExternalIds,
    };
    const externalReference = boundedExternalReference(value);
    const contentDigest = digest({ normalizationSnapshot, externalReference });
    const identitySeed = `${candidateId}:${contentDigest}`;

    commands.push({
      actorId: ACTOR_ID,
      adapterVersion: ADAPTER_VERSION,
      aggregateMetadata: { normalizationSnapshot },
      collectedAt,
      correlationId: `community:${candidateId}:${contentDigest.slice(0, 16)}`,
      externalReference,
      idempotencyKey: `community:${candidateId}:${contentDigest}`,
      observationId: deterministicUuid(identitySeed),
      sourceId: input.sourceId,
    });
  }

  return { commands, skipped };
}