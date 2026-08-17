import type { Pool } from 'pg';

import {
  FEEDBACK_REASON_CODES,
  type FeedbackReasonCode,
  type PublicationFeedbackSignal,
} from './types.js';

const REASON_CODES = new Set<string>(FEEDBACK_REASON_CODES);

export type ReadPublicationFeedbackSignalOptions = {
  sinceHours?: number;
  limit?: number;
  detailSampleLimit?: number;
  now?: Date;
};

function boundedInteger(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function reasonCode(value: string): FeedbackReasonCode {
  if (!REASON_CODES.has(value)) {
    throw new Error('feedback reader encountered an invalid reason code');
  }
  return value as FeedbackReasonCode;
}

export async function readPublicationFeedbackSignals(
  pool: Pool,
  options: ReadPublicationFeedbackSignalOptions = {},
): Promise<PublicationFeedbackSignal[]> {
  const sinceHours = boundedInteger(options.sinceHours, 168, 1, 720);
  const limit = boundedInteger(options.limit, 50, 1, 100);
  const detailSampleLimit = boundedInteger(options.detailSampleLimit, 3, 0, 5);
  const now = options.now ?? new Date();
  const since = new Date(now.getTime() - sinceHours * 60 * 60 * 1000);

  const groups = await pool.query<{
    publication_id: string;
    publication_version_id: string;
    is_active: boolean;
    total_count: string;
    newest_received_at: Date;
  }>(
    `select feedback.publication_id,
            feedback.publication_version_id,
            exists (
              select 1
                from active_publication_versions active
               where active.publication_id = feedback.publication_id
                 and active.publication_version_id = feedback.publication_version_id
            ) as is_active,
            count(*)::text as total_count,
            max(feedback.received_at) as newest_received_at
       from publication_feedback_submissions feedback
      where feedback.received_at >= $1
        and feedback.received_at <= $2
      group by feedback.publication_id, feedback.publication_version_id
      order by is_active desc,
               count(*) desc,
               max(feedback.received_at) desc,
               feedback.publication_id,
               feedback.publication_version_id
      limit $3`,
    [since, now, limit],
  );

  const signals: PublicationFeedbackSignal[] = [];
  for (const group of groups.rows) {
    const counts = await pool.query<{ reason_code: string; reason_count: string }>(
      `select reason_code, count(*)::text as reason_count
         from publication_feedback_submissions
        where publication_id = $1
          and publication_version_id = $2
          and received_at >= $3
          and received_at <= $4
        group by reason_code
        order by reason_code`,
      [group.publication_id, group.publication_version_id, since, now],
    );

    const countsByReason: Partial<Record<FeedbackReasonCode, number>> = {};
    for (const row of counts.rows) {
      countsByReason[reasonCode(row.reason_code)] = Number(row.reason_count);
    }

    const recentDetails = detailSampleLimit === 0
      ? { rows: [] as Array<{ reason_code: string; details: string; received_at: Date }> }
      : await pool.query<{ reason_code: string; details: string; received_at: Date }>(
          `select reason_code, details, received_at
             from publication_feedback_submissions
            where publication_id = $1
              and publication_version_id = $2
              and received_at >= $3
              and received_at <= $4
              and details is not null
            order by received_at desc, id desc
            limit $5`,
          [group.publication_id, group.publication_version_id, since, now, detailSampleLimit],
        );

    signals.push({
      publicationId: group.publication_id,
      publicationVersionId: group.publication_version_id,
      isActive: group.is_active,
      totalCount: Number(group.total_count),
      countsByReason,
      newestReceivedAt: group.newest_received_at.toISOString(),
      recentDetails: recentDetails.rows.map((row) => ({
        reasonCode: reasonCode(row.reason_code),
        details: row.details,
        receivedAt: row.received_at.toISOString(),
      })),
    });
  }

  return signals;
}
