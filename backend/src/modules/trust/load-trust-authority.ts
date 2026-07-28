import type { PoolClient } from 'pg';

import type { CandidateRevisionAuthority } from './types.js';

interface CandidateRevisionRow {
  candidate_id: string;
  candidate_revision_id: string;
  patch_id: string;
  catalog_revision_id: string;
  canonical_payload: unknown;
  normalized_signature: string;
}

export async function lockCandidateRevisionAuthority(
  client: PoolClient,
  candidateId: string,
  candidateRevisionId: string,
): Promise<CandidateRevisionAuthority> {
  const candidate = await client.query(
    `select candidate_id
       from candidates
      where candidate_id = $1
      for update`,
    [candidateId],
  );
  if (candidate.rowCount !== 1) {
    throw new Error('CANDIDATE_REVISION_NOT_FOUND');
  }

  const revision = await client.query<CandidateRevisionRow>(
    `select candidate_id,
            candidate_revision_id,
            patch_id,
            catalog_revision_id,
            canonical_payload,
            normalized_signature
       from candidate_revisions
      where candidate_revision_id = $1
        and candidate_id = $2
      for update`,
    [candidateRevisionId, candidateId],
  );
  const row = revision.rows[0];
  if (!row) {
    throw new Error('CANDIDATE_REVISION_NOT_FOUND');
  }
  return {
    candidateId: row.candidate_id,
    candidateRevisionId: row.candidate_revision_id,
    patchId: row.patch_id,
    catalogRevisionId: row.catalog_revision_id,
    canonicalPayload: row.canonical_payload,
    normalizedSignature: row.normalized_signature,
  };
}
