import { randomUUID } from 'node:crypto';

import type { Pool, PoolClient } from 'pg';

import { withTransaction } from '../../database/transaction.js';
import { hashCanonicalJson } from '../../shared/hash.js';
import { validateCatalogSelection } from '../catalog/validate-catalog-selection.js';
import {
  fingerprintCandidate,
  normalizeObservationSnapshot,
} from './normalize-observation.js';
const NORMALIZER_VERSION = 'candidate-selection-v1';

interface ReplayRow {
  candidate_id: string;
  candidate_revision_id: string;
  canonical_payload: unknown;
  game_mode_external_id: string;
  normalized_observation_id: string;
  normalized_signature: string;
  origin: string;
  patch_key: string;
  subject_external_id: string;
}

interface ActiveCatalogRow {
  catalog_revision_id: string;
  patch_id: string;
}

interface SubjectRow {
  game_entity_id: string;
  game_entity_revision_id: string;
}

interface CandidateRow {
  candidate_id: string;
  game_mode_external_id: string;
  patch_id: string;
  subject_game_entity_id: string;
}

interface CandidateRevisionRow {
  candidate_revision_id: string;
  canonical_payload: unknown;
}

export interface RegisterNormalizedObservationCommand {
  actorId: string;
  candidateId: string;
  candidateRevisionId: string;
  correlationId: string;
  normalizedObservationId: string;
  provenanceId: string;
  rawObservationId: string;
  snapshot: unknown;
}

export interface RegisterNormalizedObservationResult {
  candidateCreated: boolean;
  candidateId: string;
  candidateRevisionCreated: boolean;
  candidateRevisionId: string;
  normalizedObservationId: string;
  provenanceAdded: boolean;
}

function sameCanonicalJson(left: unknown, right: unknown): boolean {
  return hashCanonicalJson(left) === hashCanonicalJson(right);
}

async function loadReplay(
  client: PoolClient,
  rawObservationId: string,
): Promise<ReplayRow | null> {
  const result = await client.query<ReplayRow>(
    `select c.candidate_id,
            cr.candidate_revision_id,
            no.canonical_payload,
            no.game_mode_external_id,
            no.normalized_observation_id,
            no.normalized_signature,
            cp.origin,
            p.patch_key,
            ge.canonical_external_id as subject_external_id
       from normalized_observations no
       join patches p on p.patch_id = no.patch_id
       join game_entity_revisions ger
         on ger.game_entity_revision_id =
            no.subject_game_entity_revision_id
       join game_entities ge on ge.game_entity_id = ger.game_entity_id
       join candidate_provenance cp
         on cp.normalized_observation_id =
            no.normalized_observation_id
       join candidate_revisions cr
         on cr.candidate_revision_id = cp.candidate_revision_id
       join candidates c on c.candidate_id = cr.candidate_id
      where no.raw_observation_id = $1
      for share of no, cp, cr, c`,
    [rawObservationId],
  );
  return result.rows[0] ?? null;
}

function replayResult(
  replay: ReplayRow,
  command: RegisterNormalizedObservationCommand,
  normalized: ReturnType<typeof normalizeObservationSnapshot>,
): RegisterNormalizedObservationResult {
  if (
    replay.patch_key !== normalized.snapshot.patchKey
    || replay.game_mode_external_id
       !== normalized.snapshot.gameModeExternalId
    || replay.subject_external_id
       !== normalized.snapshot.subjectExternalId
    || replay.normalized_signature !== normalized.normalizedSignature
    || replay.origin !== normalized.snapshot.origin
    || !sameCanonicalJson(replay.canonical_payload, normalized.payload)
  ) {
    throw new Error('NORMALIZATION_REPLAY_CONFLICT');
  }
  return {
    candidateCreated: false,
    candidateId: replay.candidate_id,
    candidateRevisionCreated: false,
    candidateRevisionId: replay.candidate_revision_id,
    normalizedObservationId: replay.normalized_observation_id,
    provenanceAdded: false,
  };
}

async function lockRawObservation(
  client: PoolClient,
  rawObservationId: string,
): Promise<void> {
  const result = await client.query(
    `select raw_observation_id
       from raw_observations
      where raw_observation_id = $1
      for key share`,
    [rawObservationId],
  );
  if (result.rowCount !== 1) {
    throw new Error('NORMALIZATION_RAW_OBSERVATION_NOT_FOUND');
  }
}

async function lockActiveCatalog(
  client: PoolClient,
  patchKey: string,
  gameModeExternalId: 'aram_mayhem',
): Promise<ActiveCatalogRow> {
  const result = await client.query<ActiveCatalogRow>(
    `select p.patch_id,
            acr.catalog_revision_id
       from patches p
       join active_catalog_revisions acr
         on acr.patch_id = p.patch_id
        and acr.game_mode_external_id = $2
      where p.patch_key = $1
        and (
          select ple.lifecycle_state
            from patch_lifecycle_events ple
           where ple.patch_id = p.patch_id
           order by ple.occurred_at desc,
                    ple.created_at desc,
                    ple.patch_lifecycle_event_id desc
           limit 1
        ) = 'active'
      for share of p, acr`,
    [patchKey, gameModeExternalId],
  );
  const authority = result.rows[0];
  if (!authority) {
    throw new Error('NORMALIZATION_ACTIVE_CATALOG_NOT_FOUND');
  }
  return authority;
}

async function loadSubject(
  client: PoolClient,
  catalogRevisionId: string,
  subjectExternalId: string,
): Promise<SubjectRow> {
  const result = await client.query<SubjectRow>(
    `select ge.game_entity_id,
            ger.game_entity_revision_id
       from game_entity_revisions ger
       join game_entities ge on ge.game_entity_id = ger.game_entity_id
      where ger.catalog_revision_id = $1
        and ge.entity_type = 'champion'
        and ge.canonical_external_id = $2
        and ger.active = true`,
    [catalogRevisionId, subjectExternalId],
  );
  const subject = result.rows[0];
  if (!subject) {
    throw new Error('CATALOG_ENTITY_MISSING');
  }
  return subject;
}

async function loadCandidate(
  client: PoolClient,
  fingerprint: string,
): Promise<CandidateRow> {
  const result = await client.query<CandidateRow>(
    `select candidate_id,
            patch_id,
            game_mode_external_id,
            subject_game_entity_id
       from candidates
      where fingerprint = $1
      for update`,
    [fingerprint],
  );
  const candidate = result.rows[0];
  if (!candidate) {
    throw new Error('CANDIDATE_INSERT_NOT_VISIBLE');
  }
  return candidate;
}

function requireCandidateIdentity(
  candidate: CandidateRow,
  authority: ActiveCatalogRow,
  subject: SubjectRow,
  gameModeExternalId: 'aram_mayhem',
): void {
  if (
    candidate.patch_id !== authority.patch_id
    || candidate.game_mode_external_id !== gameModeExternalId
    || candidate.subject_game_entity_id !== subject.game_entity_id
  ) {
    throw new Error('CANDIDATE_FINGERPRINT_CONFLICT');
  }
}

async function resolveCandidateRevision(
  client: PoolClient,
  command: RegisterNormalizedObservationCommand,
  candidateId: string,
  catalogRevisionId: string,
  normalizedSignature: string,
  canonicalPayload: unknown,
): Promise<{
  candidateRevisionCreated: boolean;
  candidateRevisionId: string;
}> {
  const existing = await client.query<CandidateRevisionRow>(
    `select candidate_revision_id, canonical_payload
       from candidate_revisions
      where candidate_id = $1
        and catalog_revision_id = $2
        and normalized_signature = $3`,
    [candidateId, catalogRevisionId, normalizedSignature],
  );
  const revision = existing.rows[0];
  if (revision) {
    if (!sameCanonicalJson(revision.canonical_payload, canonicalPayload)) {
      throw new Error('CANDIDATE_REVISION_SIGNATURE_CONFLICT');
    }
    return {
      candidateRevisionCreated: false,
      candidateRevisionId: revision.candidate_revision_id,
    };
  }

  const nextRevision = await client.query<{ revision: number }>(
    `select coalesce(max(revision), 0)::integer + 1 as revision
       from candidate_revisions
      where candidate_id = $1`,
    [candidateId],
  );
  const revisionNumber = nextRevision.rows[0]?.revision;
  if (!revisionNumber) {
    throw new Error('CANDIDATE_REVISION_NUMBER_UNAVAILABLE');
  }
  await client.query(
    `insert into candidate_revisions
      (candidate_revision_id, candidate_id, revision,
       catalog_revision_id, normalized_signature, canonical_payload)
     values ($1, $2, $3, $4, $5, $6::jsonb)`,
    [
      command.candidateRevisionId,
      candidateId,
      revisionNumber,
      catalogRevisionId,
      normalizedSignature,
      JSON.stringify(canonicalPayload),
    ],
  );
  return {
    candidateRevisionCreated: true,
    candidateRevisionId: command.candidateRevisionId,
  };
}

export async function registerNormalizedObservationInTransaction(
  client: PoolClient,
  command: RegisterNormalizedObservationCommand,
): Promise<RegisterNormalizedObservationResult> {
  const normalized = normalizeObservationSnapshot(command.snapshot);
  const replay = await loadReplay(client, command.rawObservationId);
  if (replay) {
    return replayResult(replay, command, normalized);
  }

  await lockRawObservation(client, command.rawObservationId);
  const authority = await lockActiveCatalog(
    client,
    normalized.snapshot.patchKey,
    normalized.snapshot.gameModeExternalId,
  );
  const selection = await validateCatalogSelection(client, {
    augmentExternalIds: normalized.payload.augmentExternalIds,
    catalogRevisionId: authority.catalog_revision_id,
    championExternalId: normalized.snapshot.subjectExternalId,
    gameModeExternalId: normalized.snapshot.gameModeExternalId,
    itemExternalIds: normalized.payload.itemExternalIds,
    patchId: authority.patch_id,
  });
  if (!selection.valid) {
    throw new Error(
      `NORMALIZATION_CATALOG_SELECTION_INVALID:${selection.reasonCodes.join(',')}`,
    );
  }
  const subject = await loadSubject(
    client,
    authority.catalog_revision_id,
    normalized.snapshot.subjectExternalId,
  );
  const fingerprint = fingerprintCandidate({
    gameModeExternalId: normalized.snapshot.gameModeExternalId,
    normalizedSignature: normalized.normalizedSignature,
    patchId: authority.patch_id,
    subjectExternalId: normalized.snapshot.subjectExternalId,
  });

  await client.query(
    `insert into normalized_observations
      (normalized_observation_id, raw_observation_id, patch_id,
       catalog_revision_id, game_mode_external_id,
       subject_game_entity_revision_id, normalizer_version,
       normalized_signature, canonical_payload)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
    [
      command.normalizedObservationId,
      command.rawObservationId,
      authority.patch_id,
      authority.catalog_revision_id,
      normalized.snapshot.gameModeExternalId,
      subject.game_entity_revision_id,
      NORMALIZER_VERSION,
      normalized.normalizedSignature,
      JSON.stringify(normalized.payload),
    ],
  );
  const insertedCandidate = await client.query(
    `insert into candidates
      (candidate_id, fingerprint, patch_id, game_mode_external_id,
       subject_game_entity_id)
     values ($1, $2, $3, $4, $5)
     on conflict (fingerprint) do nothing
     returning candidate_id`,
    [
      command.candidateId,
      fingerprint,
      authority.patch_id,
      normalized.snapshot.gameModeExternalId,
      subject.game_entity_id,
    ],
  );
  const candidateCreated = insertedCandidate.rowCount === 1;
  const candidate = await loadCandidate(client, fingerprint);
  requireCandidateIdentity(
    candidate,
    authority,
    subject,
    normalized.snapshot.gameModeExternalId,
  );
  const revision = await resolveCandidateRevision(
    client,
    command,
    candidate.candidate_id,
    authority.catalog_revision_id,
    normalized.normalizedSignature,
    normalized.payload,
  );

  await client.query(
    `insert into candidate_provenance
      (candidate_provenance_id, candidate_revision_id,
       normalized_observation_id, origin)
     values ($1, $2, $3, $4)`,
    [
      command.provenanceId,
      revision.candidateRevisionId,
      command.normalizedObservationId,
      normalized.snapshot.origin,
    ],
  );

  const action = candidateCreated
    ? 'candidate.registered'
    : revision.candidateRevisionCreated
      ? 'candidate.revision_registered'
      : 'candidate.provenance_added';
  const eventType = candidateCreated
    ? 'CandidateRegistered'
    : revision.candidateRevisionCreated
      ? 'CandidateRevisionRegistered'
      : 'CandidateProvenanceAdded';
  const eventPayload = {
    candidateCreated,
    candidateId: candidate.candidate_id,
    candidateRevisionCreated: revision.candidateRevisionCreated,
    candidateRevisionId: revision.candidateRevisionId,
    catalogRevisionId: authority.catalog_revision_id,
    fingerprint,
    normalizedObservationId: command.normalizedObservationId,
    origin: normalized.snapshot.origin,
  };
  await client.query(
    `insert into audit_events
      (audit_event_id, actor_id, action, reason, correlation_id, payload)
     values ($1, $2, $3, 'deterministic normalization registration',
             $4, $5::jsonb)`,
    [
      randomUUID(),
      command.actorId,
      action,
      command.correlationId,
      JSON.stringify(eventPayload),
    ],
  );
  await client.query(
    `insert into outbox_events
      (outbox_event_id, aggregate_type, aggregate_id, event_type,
       payload, correlation_id)
     values ($1, 'candidate', $2, $3, $4::jsonb, $5)`,
    [
      randomUUID(),
      candidate.candidate_id,
      eventType,
      JSON.stringify(eventPayload),
      command.correlationId,
    ],
  );

  return {
    candidateCreated,
    candidateId: candidate.candidate_id,
    candidateRevisionCreated: revision.candidateRevisionCreated,
    candidateRevisionId: revision.candidateRevisionId,
    normalizedObservationId: command.normalizedObservationId,
    provenanceAdded: true,
  };
}

export async function registerNormalizedObservation(
  pool: Pool,
  command: RegisterNormalizedObservationCommand,
): Promise<RegisterNormalizedObservationResult> {
  normalizeObservationSnapshot(command.snapshot);
  return withTransaction(pool, async (client) => (
    registerNormalizedObservationInTransaction(client, command)
  ));
}
