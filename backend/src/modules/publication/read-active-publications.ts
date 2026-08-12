import type { Pool } from 'pg';

import {
  requireUuid,
} from '../trust/normalize-trust-input.js';
import { buildPublicationPayload } from './build-publication-payload.js';
import type {
  ActivePublicationRead,
  PublicationPayloadV1,
} from './types.js';

export type { ActivePublicationRead } from './types.js';

const PAYLOAD_KEYS = [
  'schemaVersion',
  'mode',
  'patchKey',
  'catalogRevisionId',
  'championExternalId',
  'augmentExternalIds',
  'itemExternalIds',
] as const;

interface ActivePublicationRow {
  publication_id: string;
  candidate_id: string;
  candidate_revision_id: string;
  publication_version_id: string;
  version_number: number;
  published_at: Date | string;
  publication_payload: unknown;
  payload_hash: string;
}

const ACTIVE_PUBLICATION_SELECT = `
  select publication.publication_id,
         publication.candidate_id,
         publication_version.candidate_revision_id,
         publication_version.publication_version_id,
         publication_version.version_number,
         publication_version.published_at,
         publication_version.publication_payload,
         publication_version.payload_hash
    from publications publication
    join active_publication_versions active
      on active.publication_id = publication.publication_id
    join publication_versions publication_version
      on publication_version.publication_version_id =
         active.publication_version_id
     and publication_version.publication_id =
         publication.publication_id
     and publication_version.candidate_id = publication.candidate_id`;

function compareCanonical(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function requireClosedPayload(
  value: unknown,
): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('PUBLICATION_READ_INVALID');
  }
  const actual = Object.keys(value).sort(compareCanonical);
  const expected = [...PAYLOAD_KEYS].sort(compareCanonical);
  if (
    actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])
  ) {
    throw new Error('PUBLICATION_READ_INVALID');
  }
}

function parseTimestamp(value: Date | string): string {
  const parsed = value instanceof Date
    ? value
    : new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error('PUBLICATION_READ_INVALID');
  }
  return parsed.toISOString();
}

function parsePayload(
  row: ActivePublicationRow,
): PublicationPayloadV1 {
  requireClosedPayload(row.publication_payload);
  const value = row.publication_payload;
  const built = buildPublicationPayload({
    candidateId: row.candidate_id,
    candidateRevisionId: row.candidate_revision_id,
    patchKey: value.patchKey as string,
    catalogRevisionId: value.catalogRevisionId as string,
    gameModeExternalId: value.mode as 'aram_mayhem',
    championExternalId: value.championExternalId as string,
    canonicalPayload: {
      schemaVersion: value.schemaVersion as 1,
      augmentExternalIds:
        value.augmentExternalIds as readonly string[],
      itemExternalIds: value.itemExternalIds as readonly string[],
    },
  });
  if (built.payloadHash !== row.payload_hash) {
    throw new Error('PUBLICATION_READ_INVALID');
  }
  return built.payload;
}

function parseRead(row: ActivePublicationRow): ActivePublicationRead {
  try {
    if (!Number.isSafeInteger(row.version_number) || row.version_number < 1) {
      throw new Error('PUBLICATION_READ_INVALID');
    }
    return {
      publicationId: requireUuid(
        row.publication_id,
        'publicationId',
      ),
      candidateId: requireUuid(row.candidate_id, 'candidateId'),
      candidateRevisionId: requireUuid(
        row.candidate_revision_id,
        'candidateRevisionId',
      ),
      publicationVersionId: requireUuid(
        row.publication_version_id,
        'publicationVersionId',
      ),
      versionNumber: row.version_number,
      publishedAt: parseTimestamp(row.published_at),
      payload: parsePayload(row),
    };
  } catch (error) {
    if (
      error instanceof Error
      && error.message === 'PUBLICATION_READ_INVALID'
    ) {
      throw error;
    }
    throw new Error('PUBLICATION_READ_INVALID', { cause: error });
  }
}

function normalizePublicationId(publicationId: string): string {
  try {
    return requireUuid(publicationId, 'publicationId');
  } catch (error) {
    throw new Error('PUBLICATION_READ_INVALID', { cause: error });
  }
}

export async function readActivePublications(
  pool: Pool,
): Promise<ActivePublicationRead[]> {
  const result = await pool.query<ActivePublicationRow>(
    `${ACTIVE_PUBLICATION_SELECT}
     order by publication.publication_id`,
  );
  return result.rows.map(parseRead);
}

export async function readActivePublicationById(
  pool: Pool,
  publicationIdInput: string,
): Promise<ActivePublicationRead | null> {
  const publicationId = normalizePublicationId(publicationIdInput);
  const result = await pool.query<ActivePublicationRow>(
    `${ACTIVE_PUBLICATION_SELECT}
     where publication.publication_id = $1`,
    [publicationId],
  );
  return result.rows[0] ? parseRead(result.rows[0]) : null;
}
