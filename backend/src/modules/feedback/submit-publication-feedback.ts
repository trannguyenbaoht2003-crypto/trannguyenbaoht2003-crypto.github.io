import { randomUUID } from 'node:crypto';

import type { Pool, PoolClient } from 'pg';

import { withTransaction } from '../../database/transaction.js';
import type {
  SubmitPublicationFeedbackCommand,
  SubmitPublicationFeedbackResult,
} from './types.js';

async function resolveExisting(
  client: PoolClient,
  submissionId: string,
  requestHash: string,
): Promise<SubmitPublicationFeedbackResult | null> {
  const existing = await client.query<{ request_hash: string }>(
    `select request_hash
       from publication_feedback_submissions
      where client_submission_id = $1`,
    [submissionId],
  );
  const row = existing.rows[0];
  if (!row) return null;
  return row.request_hash === requestHash
    ? { outcome: 'accepted', replayed: true }
    : { outcome: 'conflict' };
}

export async function submitPublicationFeedback(
  pool: Pool,
  command: SubmitPublicationFeedbackCommand,
): Promise<SubmitPublicationFeedbackResult> {
  return withTransaction(pool, async (client) => {
    const replay = await resolveExisting(
      client,
      command.submissionId,
      command.requestHash,
    );
    if (replay) return replay;

    const target = await client.query<{ was_active: boolean }>(
      `select exists (
         select 1
           from active_publication_versions active
          where active.publication_id = version.publication_id
            and active.publication_version_id = version.publication_version_id
       ) as was_active
         from publication_versions version
        where version.publication_id = $1
          and version.publication_version_id = $2`,
      [command.publicationId, command.publicationVersionId],
    );
    const targetRow = target.rows[0];
    if (!targetRow) return { outcome: 'not_found' };

    const inserted = await client.query(
      `insert into publication_feedback_submissions
         (id, client_submission_id, request_hash, publication_id,
          publication_version_id, reason_code, details,
          was_active_at_submission, received_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       on conflict (client_submission_id) do nothing
       returning client_submission_id`,
      [
        randomUUID(),
        command.submissionId,
        command.requestHash,
        command.publicationId,
        command.publicationVersionId,
        command.reasonCode,
        command.details,
        targetRow.was_active,
        command.receivedAt,
      ],
    );
    if ((inserted.rowCount ?? 0) === 1) {
      return { outcome: 'accepted', replayed: false };
    }

    const raced = await resolveExisting(
      client,
      command.submissionId,
      command.requestHash,
    );
    if (!raced) {
      throw new Error('feedback idempotency race did not resolve');
    }
    return raced;
  });
}
