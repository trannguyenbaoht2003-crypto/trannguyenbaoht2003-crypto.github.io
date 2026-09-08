import type { Pool } from 'pg';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface HumanReviewContext {
  candidateId: string;
  reviewPolicyRevisionId: string;
}

interface HumanReviewContextRow {
  candidate_id: unknown;
  review_policy_revision_id: unknown;
}

function stale(): never {
  throw new Error('REVIEW_INPUT_STALE');
}

function requireUuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) return stale();
  return value.toLowerCase();
}

export async function resolveHumanReviewContext(
  pool: Pool,
  candidateRevisionId: string,
): Promise<HumanReviewContext> {
  const revisionId = requireUuid(candidateRevisionId);
  const client = await pool.connect();
  try {
    await client.query(
      'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
    );
    const result = await client.query<HumanReviewContextRow>(
      `with active_policy as (
         select policy.review_policy_revision_id
           from active_eligibility_policy_revision active
           join eligibility_policy_revisions eligibility_policy
             on eligibility_policy.eligibility_policy_revision_id =
                active.eligibility_policy_revision_id
           join review_policy_revisions policy
             on policy.review_policy_revision_id =
                eligibility_policy.review_policy_revision_id
          where active.scope = 'candidate_revision'
            and policy.review_authority = 'human'
       )
       select revision.candidate_id,
              active_policy.review_policy_revision_id
         from candidate_revisions revision
         join candidates candidate
           on candidate.candidate_id = revision.candidate_id
         join candidate_claim_set_seals seal
           on seal.candidate_revision_id = revision.candidate_revision_id
         cross join active_policy
        where revision.candidate_revision_id = $1
          and candidate.candidate_id = revision.candidate_id`,
      [revisionId],
    );
    if (result.rows.length !== 1) return stale();
    const row = result.rows[0]!;
    const candidateId = requireUuid(row.candidate_id);
    const reviewPolicyRevisionId = requireUuid(row.review_policy_revision_id);
    await client.query('COMMIT');
    return { candidateId, reviewPolicyRevisionId };
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // The original failure remains the stable public error.
    }
    throw error;
  } finally {
    client.release();
  }
}
