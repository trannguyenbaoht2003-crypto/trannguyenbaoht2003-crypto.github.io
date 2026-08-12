import type { Pool } from 'pg';

import { publishCandidateRevision } from '../modules/publication/publish-candidate-revision.js';
import { rollbackPublication } from '../modules/publication/rollback-publication.js';
import {
  verifyReleaseRehearsal,
  type ReleaseRehearsalState,
} from './release-rehearsal-data.js';

const IDS = {
  candidateRevisionId: '8d000000-0000-4000-8000-000000000010',
  moderationDecisionId: '8d000000-0000-4000-8000-000000000027',
  eligibilityPolicyRevisionId: '8d000000-0000-4000-8000-000000000028',
  eligibilityEvaluationId: '8d000000-0000-4000-8000-000000000030',
  publicationId: '8d000000-0000-4000-8000-000000000031',
  publicationVersionIdV1: '8d000000-0000-4000-8000-000000000032',
  publicationVersionIdV2: '8d000000-0000-4000-8000-000000000036',
  publicationActivationIdV2: '8d000000-0000-4000-8000-000000000037',
  publicationAuditIdV2: '8d000000-0000-4000-8000-000000000038',
  publicationOutboxEventIdV2: '8d000000-0000-4000-8000-000000000039',
  rollbackActivationIdV1: '8d000000-0000-4000-8000-000000000040',
  rollbackAuditIdV1: '8d000000-0000-4000-8000-000000000041',
  rollbackOutboxEventIdV1: '8d000000-0000-4000-8000-000000000042',
} as const;

export async function publishReleaseRehearsalV2(
  pool: Pool,
): Promise<ReleaseRehearsalState> {
  await publishCandidateRevision(pool, {
    publicationId: IDS.publicationId,
    publicationVersionId: IDS.publicationVersionIdV2,
    activationId: IDS.publicationActivationIdV2,
    candidateRevisionId: IDS.candidateRevisionId,
    expectedActiveEligibilityPolicyRevisionId:
      IDS.eligibilityPolicyRevisionId,
    expectedEligibilityEvaluationId: IDS.eligibilityEvaluationId,
    expectedModerationDecisionId: IDS.moderationDecisionId,
    expectedActivePublicationVersionId: IDS.publicationVersionIdV1,
    authorization: {
      actorId: 'release-rehearsal-publisher',
      permissions: ['publisher'],
    },
    auditId: IDS.publicationAuditIdV2,
    outboxEventId: IDS.publicationOutboxEventIdV2,
    correlationId: 'release-rehearsal-publish-v2',
    idempotencyKey: 'release-rehearsal-publish-v2',
    occurredAt: '2026-08-12T00:31:00.000Z',
  });
  return verifyReleaseRehearsal(pool);
}

export async function rollbackReleaseRehearsalToV1(
  pool: Pool,
): Promise<ReleaseRehearsalState> {
  await rollbackPublication(pool, {
    publicationId: IDS.publicationId,
    targetPublicationVersionId: IDS.publicationVersionIdV1,
    activationId: IDS.rollbackActivationIdV1,
    expectedActivePublicationVersionId: IDS.publicationVersionIdV2,
    authorization: {
      actorId: 'release-rehearsal-publisher',
      permissions: ['publisher'],
    },
    auditId: IDS.rollbackAuditIdV1,
    outboxEventId: IDS.rollbackOutboxEventIdV1,
    correlationId: 'release-rehearsal-rollback-v1',
    idempotencyKey: 'release-rehearsal-rollback-v1',
    occurredAt: '2026-08-12T00:32:00.000Z',
  });
  return verifyReleaseRehearsal(pool);
}
