import type { Pool } from 'pg';
import { ACTIVE_CANDIDATES_SQL, autonomousClock } from './autonomous-review-journal.js';
export async function readAutonomousReviewStatus(pool: Pool, options: {
    enabled: boolean;
    now?: string;
}) {
    const clock = autonomousClock(options.now);
    const [counts, runs] = await Promise.all([
        pool.query<{
            active_catalogs: number;
            current_candidate_revisions: number;
            daily_reserved_count: number;
        }>(`select
   (select count(*)::int from active_catalog_revisions catalog where
    (select lifecycle_state from patch_lifecycle_events where patch_id=catalog.patch_id order by occurred_at desc,created_at desc,patch_lifecycle_event_id desc limit 1)='active') as active_catalogs,
   (select count(*)::int from (${ACTIVE_CANDIDATES_SQL}) current_candidates) as current_candidate_revisions,
   (select count(*)::int from autonomous_ai_review_runs where budget_day=$1::date) as daily_reserved_count`, [clock.day]),
        pool.query<{
            run_id: string;
            started_at: Date;
            utc_tick: Date;
            state: string;
            failure_code: string | null;
            publication_version_id: string | null;
        }>(`select run_id,started_at,utc_tick,state,failure_code,publication_version_id from autonomous_ai_review_runs order by started_at desc,run_id desc limit 32`)
    ]);
    const count = counts.rows[0]!;
    return { enabled: options.enabled, inputState: count.active_catalogs === 0 ? 'MISSING_ACTIVE_CATALOG' : count.current_candidate_revisions === 0 ? 'EMPTY_CANDIDATE_INPUT' : 'STRUCTURAL_INPUT_PRESENT', activeCatalogs: count.active_catalogs, currentCandidateRevisions: count.current_candidate_revisions, budgetDay: clock.day, dailyReservedCount: count.daily_reserved_count, dailyReservationCap: 4, runs: runs.rows.map(row => ({ runId: row.run_id, startedAt: row.started_at.toISOString(), utcTick: row.utc_tick.toISOString(), outcome: row.state, failureCode: row.failure_code, publicationVersionId: row.publication_version_id })) };
}
