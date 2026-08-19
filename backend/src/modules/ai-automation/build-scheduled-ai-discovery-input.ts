import type { Pool } from 'pg';

import { validateCatalogSelection } from '../catalog/validate-catalog-selection.js';
import {
  normalizeAiProviderExecutionInput,
} from '../ai-provider/normalize-provider-execution-input.js';
import type { NormalizedAiProviderExecutionInput } from '../ai-provider/types.js';
import { deriveScheduledAiDiscoveryIdentity } from './scheduled-run-identity.js';
import type {
  BuiltScheduledAiDiscoveryInput,
  ScheduledAiDiscoveryContentV1,
  ScheduledAiDiscoverySubjectV1,
} from './types.js';

const MAX_SUBJECTS = 8;
const MAX_OBSERVATIONS_PER_SUBJECT = 4;

type AllowedOrigin = 'collector_detected' | 'community_submitted' | 'editorial';

interface ActiveAuthorityRow {
  patch_id: string;
  patch_key: string;
  catalog_revision_id: string;
}

interface ObservationRow {
  normalized_observation_id: string;
  subject_external_id: string;
  canonical_payload: unknown;
  origin: AllowedOrigin;
  created_at: string | Date;
}

interface CandidatePayload {
  schemaVersion: 1;
  augmentExternalIds: string[];
  itemExternalIds: string[];
}

interface ValidObservation {
  id: string;
  createdAt: number;
  origin: AllowedOrigin;
  augmentExternalIds: string[];
  itemExternalIds: string[];
  serialized: string;
}

function compareAscii(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalIds(value: unknown): string[] | null {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) return null;
  const ids = [...value];
  if (ids.some((id) => id.length === 0 || id !== id.trim())) return null;
  ids.sort(compareAscii);
  if (new Set(ids).size !== ids.length) return null;
  return ids;
}

function candidatePayload(value: unknown): CandidatePayload | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort(compareAscii);
  if (keys.join('|') !== 'augmentExternalIds|itemExternalIds|schemaVersion') return null;
  if (record.schemaVersion !== 1) return null;
  const augmentExternalIds = canonicalIds(record.augmentExternalIds);
  const itemExternalIds = canonicalIds(record.itemExternalIds);
  if (!augmentExternalIds || !itemExternalIds) return null;
  return { schemaVersion: 1, augmentExternalIds, itemExternalIds };
}

function timestamp(value: string | Date): number | null {
  const time = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

async function loadActiveAuthority(pool: Pool): Promise<ActiveAuthorityRow> {
  const result = await pool.query<ActiveAuthorityRow>(
    `select acr.patch_id,
            p.patch_key,
            acr.catalog_revision_id
       from active_catalog_revisions acr
       join patches p on p.patch_id = acr.patch_id
      where acr.game_mode_external_id = 'aram_mayhem'
        and (
          select ple.lifecycle_state
            from patch_lifecycle_events ple
           where ple.patch_id = acr.patch_id
           order by ple.occurred_at desc,
                    ple.created_at desc,
                    ple.patch_lifecycle_event_id desc
           limit 1
        ) = 'active'
      order by p.patch_key collate "C"`,
  );
  if (result.rowCount !== 1) throw new Error('AI_AUTOMATION_ACTIVE_CATALOG_UNAVAILABLE');
  return result.rows[0]!;
}

async function loadObservations(
  pool: Pool,
  authority: ActiveAuthorityRow,
): Promise<ObservationRow[]> {
  const result = await pool.query<ObservationRow>(
    `select no.normalized_observation_id,
            ge.canonical_external_id as subject_external_id,
            no.canonical_payload,
            cp.origin,
            no.created_at
       from normalized_observations no
       join candidate_provenance cp
         on cp.normalized_observation_id = no.normalized_observation_id
       join game_entity_revisions ger
         on ger.game_entity_revision_id = no.subject_game_entity_revision_id
        and ger.catalog_revision_id = no.catalog_revision_id
       join game_entities ge on ge.game_entity_id = ger.game_entity_id
      where no.patch_id = $1
        and no.catalog_revision_id = $2
        and no.game_mode_external_id = 'aram_mayhem'
        and cp.origin in ('collector_detected', 'community_submitted', 'editorial')
        and ge.entity_type = 'champion'
        and ger.active = true
      order by no.created_at desc,
               no.normalized_observation_id asc`,
    [authority.patch_id, authority.catalog_revision_id],
  );
  return result.rows;
}

function serializeObservation(
  origin: AllowedOrigin,
  payload: CandidatePayload,
): string {
  return JSON.stringify({
    schemaVersion: 1,
    origin,
    augmentExternalIds: payload.augmentExternalIds,
    itemExternalIds: payload.itemExternalIds,
  });
}

function providerObservationIsValid(
  patchKey: string,
  subjectExternalId: string,
  observation: ValidObservation,
): boolean {
  try {
    normalizeAiProviderExecutionInput({
      runKey: 'scheduled-validation-v1',
      patchKey,
      gameModeExternalId: 'aram_mayhem',
      subjects: [{
        subjectExternalId,
        allowedAugmentExternalIds: observation.augmentExternalIds,
        allowedItemExternalIds: observation.itemExternalIds,
        observations: [observation.serialized],
      }],
    });
    return true;
  } catch {
    return false;
  }
}

async function validateObservation(
  pool: Pool,
  authority: ActiveAuthorityRow,
  row: ObservationRow,
): Promise<ValidObservation | null> {
  const payload = candidatePayload(row.canonical_payload);
  const createdAt = timestamp(row.created_at);
  if (!payload || createdAt === null) return null;
  const selection = await validateCatalogSelection(pool, {
    augmentExternalIds: payload.augmentExternalIds,
    catalogRevisionId: authority.catalog_revision_id,
    championExternalId: row.subject_external_id,
    gameModeExternalId: 'aram_mayhem',
    itemExternalIds: payload.itemExternalIds,
    patchId: authority.patch_id,
  });
  if (!selection.valid) return null;
  const observation: ValidObservation = {
    id: row.normalized_observation_id,
    createdAt,
    origin: row.origin,
    augmentExternalIds: payload.augmentExternalIds,
    itemExternalIds: payload.itemExternalIds,
    serialized: serializeObservation(row.origin, payload),
  };
  return providerObservationIsValid(authority.patch_key, row.subject_external_id, observation)
    ? observation
    : null;
}

function buildSubject(
  subjectExternalId: string,
  observations: ValidObservation[],
): ScheduledAiDiscoverySubjectV1 {
  const selected = observations
    .sort((left, right) => right.createdAt - left.createdAt || compareAscii(left.id, right.id))
    .slice(0, MAX_OBSERVATIONS_PER_SUBJECT);
  const augments = new Set<string>();
  const items = new Set<string>();
  for (const observation of selected) {
    observation.augmentExternalIds.forEach((id) => augments.add(id));
    observation.itemExternalIds.forEach((id) => items.add(id));
  }
  return {
    subjectExternalId,
    allowedAugmentExternalIds: [...augments].sort(compareAscii),
    allowedItemExternalIds: [...items].sort(compareAscii),
    observations: selected.map((observation) => observation.serialized),
  };
}

export async function buildScheduledAiDiscoveryInput(
  pool: Pool,
): Promise<BuiltScheduledAiDiscoveryInput | null> {
  const authority = await loadActiveAuthority(pool);
  const rows = await loadObservations(pool, authority);
  const bySubject = new Map<string, ValidObservation[]>();
  for (const row of rows) {
    const observation = await validateObservation(pool, authority, row);
    if (!observation) continue;
    const subject = bySubject.get(row.subject_external_id) ?? [];
    subject.push(observation);
    bySubject.set(row.subject_external_id, subject);
  }
  if (bySubject.size === 0) return null;

  const ranked = [...bySubject.entries()]
    .map(([subjectExternalId, observations]) => ({
      subjectExternalId,
      observations,
      newest: Math.max(...observations.map((observation) => observation.createdAt)),
    }))
    .sort((left, right) => (
      right.newest - left.newest || compareAscii(left.subjectExternalId, right.subjectExternalId)
    ))
    .slice(0, MAX_SUBJECTS);

  const content: ScheduledAiDiscoveryContentV1 = {
    patchKey: authority.patch_key,
    gameModeExternalId: 'aram_mayhem',
    subjects: ranked.map(({ subjectExternalId, observations }) => (
      buildSubject(subjectExternalId, observations)
    )),
  };
  const identity = deriveScheduledAiDiscoveryIdentity(content);
  const input: NormalizedAiProviderExecutionInput = normalizeAiProviderExecutionInput({
    ...content,
    runKey: identity.runKey,
  });
  return { content, input, ...identity };
}
