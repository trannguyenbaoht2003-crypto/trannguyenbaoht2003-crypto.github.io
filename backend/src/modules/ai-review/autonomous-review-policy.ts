import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { deterministicPreparationUuid } from './prepare-candidate-review.js';
import { createAiReviewProvider } from './ai-review-provider.js';
import { registerAiReviewPolicy } from './review-authority.js';
import { registerTrustPolicyRevision } from '../trust/register-trust-policy-revision.js';
import { registerModerationPolicyRevision } from '../moderation/register-moderation-policy-revision.js';
import { registerEligibilityPolicyRevision } from '../eligibility/register-eligibility-policy-revision.js';
import { activateEligibilityPolicyRevision } from '../eligibility/activate-eligibility-policy-revision.js';
export async function ensureAutonomousReviewPolicy(pool: Pool, { model }: {
    model: string;
}) {
    createAiReviewProvider({ apiKey: 'validation-only', model });
    // Serialize enabled startup only. Domain commands retain their own short transactions/audit.
    const lock = await pool.connect();
    try {
        await lock.query("select pg_advisory_lock(hashtextextended('autonomous-ai-policy-bootstrap-v1',0))");
        const active = (await pool.query<{
            eligibility_policy_revision_id: string;
            evidence_policy_revision_id: string;
            moderation_policy_revision_id: string;
        }>(`
      select policy.* from active_eligibility_policy_revision active
      join eligibility_policy_revisions policy using (eligibility_policy_revision_id) where active.scope='candidate_revision'`)).rows[0];
        const evidencePolicyRevisionId = active?.evidence_policy_revision_id ?? deterministicPreparationUuid('autonomous-evidence', '1');
        const moderationPolicyRevisionId = active?.moderation_policy_revision_id ?? deterministicPreparationUuid('autonomous-moderation', '1');
        const reviewPolicyRevisionId = deterministicPreparationUuid('autonomous-review', JSON.stringify([model, 1]));
        const eligibilityPolicyRevisionId = deterministicPreparationUuid('autonomous-eligibility', JSON.stringify([reviewPolicyRevisionId, evidencePolicyRevisionId, moderationPolicyRevisionId, 1]));
        const metadata = (id: string) => ({ actorId: 'system:ai-reviewer', reason: 'Explicitly enabled autonomous AI review startup.', correlationId: `autonomous-policy:${id}`, idempotencyKey: `autonomous-policy:${id}` });
        if (!active) {
            await registerTrustPolicyRevision(pool, { ...metadata(evidencePolicyRevisionId), policyKind: 'evidence', policyRevisionId: evidencePolicyRevisionId, policyKey: 'autonomous-evidence-v1', revision: 1, schemaVersion: 1 });
            await registerModerationPolicyRevision(pool, { ...metadata(moderationPolicyRevisionId), moderationPolicyRevisionId, policyKey: 'autonomous-moderation-v1', revision: 1, schemaVersion: 1 });
        }
        await registerAiReviewPolicy(pool, { ...metadata(reviewPolicyRevisionId), reviewPolicyRevisionId, policyKey: `autonomous-review-${reviewPolicyRevisionId}`, revision: 1, model, promptVersion: 1 });
        await registerEligibilityPolicyRevision(pool, { ...metadata(eligibilityPolicyRevisionId), eligibilityPolicyRevisionId, evidencePolicyRevisionId, moderationPolicyRevisionId, reviewPolicyRevisionId, policyKey: `autonomous-eligibility-${eligibilityPolicyRevisionId}`, revision: 1, schemaVersion: 1 });
        if (active?.eligibility_policy_revision_id !== eligibilityPolicyRevisionId) {
            await activateEligibilityPolicyRevision(pool, { ...metadata(eligibilityPolicyRevisionId), idempotencyKey: `autonomous-activation:${randomUUID()}`, eligibilityPolicyRevisionId, expectedCurrentEligibilityPolicyRevisionId: active?.eligibility_policy_revision_id ?? null });
        }
        return { eligibilityPolicyRevisionId, evidencePolicyRevisionId, moderationPolicyRevisionId, reviewPolicyRevisionId };
    }
    finally {
        try {
            await lock.query("select pg_advisory_unlock(hashtextextended('autonomous-ai-policy-bootstrap-v1',0))");
        }
        finally {
            lock.release();
        }
    }
}
