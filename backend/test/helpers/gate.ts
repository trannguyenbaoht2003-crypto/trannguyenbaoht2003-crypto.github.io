import type {
  RegisterModerationPolicyRevisionCommand,
} from '../../src/modules/moderation/register-moderation-policy-revision.js';
import {
  registerModerationPolicyRevision,
} from '../../src/modules/moderation/register-moderation-policy-revision.js';
import type {
  RecordCandidateModerationDecisionCommand,
} from '../../src/modules/moderation/record-candidate-moderation-decision.js';
import type {
  ActivateEligibilityPolicyRevisionCommand,
} from '../../src/modules/eligibility/activate-eligibility-policy-revision.js';
import type {
  RegisterEligibilityPolicyRevisionCommand,
} from '../../src/modules/eligibility/register-eligibility-policy-revision.js';
import { TRUST_IDS } from './trust.js';
import { seedTrustReviewContext } from './trust.js';
import type { Pool } from 'pg';

export const GATE_IDS = {
  moderationPolicyId: '76000000-0000-4000-8000-000000000001',
  eligibilityPolicyId: '76000000-0000-4000-8000-000000000002',
  alternateEligibilityPolicyId:
    '76000000-0000-4000-8000-000000000003',
  moderationInputSnapshotId:
    '76000000-0000-4000-8000-000000000004',
  moderationDecisionId:
    '76000000-0000-4000-8000-000000000005',
  secondModerationInputSnapshotId:
    '76000000-0000-4000-8000-000000000006',
  secondModerationDecisionId:
    '76000000-0000-4000-8000-000000000007',
} as const;

export function moderationPolicyCommand(
  overrides: Partial<RegisterModerationPolicyRevisionCommand> = {},
): RegisterModerationPolicyRevisionCommand {
  return {
    actorId: 'gate-policy-operator',
    correlationId: 'moderation-policy-v1',
    idempotencyKey: 'moderation-policy-v1',
    moderationPolicyRevisionId: GATE_IDS.moderationPolicyId,
    policyKey: 'candidate-moderation-v1',
    reason: 'CandidateRevision Moderation policy.',
    revision: 1,
    schemaVersion: 1,
    ...overrides,
  };
}

export function eligibilityPolicyCommand(
  overrides: Partial<RegisterEligibilityPolicyRevisionCommand> = {},
): RegisterEligibilityPolicyRevisionCommand {
  return {
    actorId: 'gate-policy-operator',
    correlationId: 'eligibility-policy-v1',
    eligibilityPolicyRevisionId: GATE_IDS.eligibilityPolicyId,
    evidencePolicyRevisionId: TRUST_IDS.evidencePolicyId,
    idempotencyKey: 'eligibility-policy-v1',
    moderationPolicyRevisionId: GATE_IDS.moderationPolicyId,
    policyKey: 'candidate-eligibility-v1',
    reason: 'Fail-closed CandidateRevision Eligibility policy.',
    reviewPolicyRevisionId: TRUST_IDS.reviewPolicyId,
    revision: 1,
    schemaVersion: 1,
    ...overrides,
  };
}

export function activationCommand(
  overrides: Partial<ActivateEligibilityPolicyRevisionCommand> = {},
): ActivateEligibilityPolicyRevisionCommand {
  return {
    actorId: 'gate-policy-operator',
    correlationId: 'eligibility-policy-activation-v1',
    eligibilityPolicyRevisionId: GATE_IDS.eligibilityPolicyId,
    expectedCurrentEligibilityPolicyRevisionId: null,
    idempotencyKey: 'eligibility-policy-activation-v1',
    reason: 'Activate the first CandidateRevision Eligibility policy.',
    ...overrides,
  };
}

export function moderationDecisionCommand(
  overrides: Partial<RecordCandidateModerationDecisionCommand> = {},
): RecordCandidateModerationDecisionCommand {
  return {
    actorId: 'candidate-moderator',
    candidateId: '62000000-0000-4000-8000-000000000001',
    candidateRevisionId: '62000000-0000-4000-8000-000000000002',
    correlationId: 'moderation-decision-v1',
    decisionId: GATE_IDS.moderationDecisionId,
    evaluatedAt: '2026-07-28T11:00:00.000Z',
    idempotencyKey: 'moderation-decision-v1',
    inputSnapshotId: GATE_IDS.moderationInputSnapshotId,
    moderationPolicyRevisionId: GATE_IDS.moderationPolicyId,
    outcome: 'clear',
    reason: 'CandidateRevision content passed Moderation.',
    ...overrides,
  };
}

export async function seedModerationContext(pool: Pool): Promise<void> {
  await seedTrustReviewContext(pool, false);
  await registerModerationPolicyRevision(
    pool,
    moderationPolicyCommand(),
  );
}
