import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import type { Pool } from 'pg';

import { registerAiReviewPolicy } from '../src/modules/ai-review/review-authority.js';
import {
  deterministicPreparationUuid,
  prepareCandidateReview,
} from '../src/modules/ai-review/prepare-candidate-review.js';
import { registerNormalizedObservation } from '../src/modules/candidate/register-normalized-observation.js';
import { activateEligibilityPolicyRevision } from '../src/modules/eligibility/activate-eligibility-policy-revision.js';
import { registerEligibilityPolicyRevision } from '../src/modules/eligibility/register-eligibility-policy-revision.js';
import { registerModerationPolicyRevision } from '../src/modules/moderation/register-moderation-policy-revision.js';
import { registerPatchEvent } from '../src/modules/patch/register-patch-event.js';
import { defineCandidateClaimSet } from '../src/modules/trust/define-candidate-claim-set.js';
import { recordClaimEvidenceDecision } from '../src/modules/trust/record-claim-evidence-decision.js';
import { registerTrustPolicyRevision } from '../src/modules/trust/register-trust-policy-revision.js';
import { CANDIDATE_IDS, validNormalizationSnapshot } from './helpers/candidate.js';
import { CATALOG_IDS, seedActiveCatalog } from './helpers/catalog.js';
import { resetDatabase, tableCount } from './helpers/database.js';

const POLICY = {
  evidence: '81000000-0000-4000-8000-000000000001',
  review: '81000000-0000-4000-8000-000000000002',
  moderation: '81000000-0000-4000-8000-000000000003',
  eligibility: '81000000-0000-4000-8000-000000000004',
  alternateEligibility: '81000000-0000-4000-8000-000000000005',
} as const;

const OBSERVATIONS = [{
  sourceId: '82000000-0000-4000-8000-000000000001',
  sourcePolicyId: '82000000-0000-4000-8000-000000000002',
  rawId: '82000000-0000-4000-8000-000000000003',
  normalizedId: '82000000-0000-4000-8000-000000000004',
  provenanceId: '82000000-0000-4000-8000-000000000005',
  sourceKey: 'bilibili-public-test',
  url: 'https://www.bilibili.com/video/BV1test?vd_source=secret&utm_source=secret#comments',
  author: 'build-reporter',
}, {
  sourceId: '83000000-0000-4000-8000-000000000001',
  sourcePolicyId: '83000000-0000-4000-8000-000000000002',
  rawId: '83000000-0000-4000-8000-000000000003',
  normalizedId: '83000000-0000-4000-8000-000000000004',
  provenanceId: '83000000-0000-4000-8000-000000000005',
  sourceKey: 'zhihu-public-test',
  url: 'https://www.zhihu.com/question/123?utm_campaign=secret',
  author: null,
}, {
  sourceId: '84000000-0000-4000-8000-000000000001',
  sourcePolicyId: '84000000-0000-4000-8000-000000000002',
  rawId: '84000000-0000-4000-8000-000000000003',
  normalizedId: '84000000-0000-4000-8000-000000000004',
  provenanceId: '84000000-0000-4000-8000-000000000005',
  sourceKey: 'douyin-public-test',
  url: 'https://www.douyin.com/video/456',
  author: 'third-reporter',
}] as const;

async function seedPolicies(pool: Awaited<ReturnType<typeof resetDatabase>>): Promise<void> {
  await registerTrustPolicyRevision(pool, {
    actorId: 'test-policy', correlationId: 'prepare-evidence', idempotencyKey: 'prepare-evidence',
    policyKey: 'prepare-evidence-v1', policyKind: 'evidence', policyRevisionId: POLICY.evidence,
    reason: 'Preparation evidence policy.', revision: 1, schemaVersion: 1,
  });
  await registerModerationPolicyRevision(pool, {
    actorId: 'test-policy', correlationId: 'prepare-moderation', idempotencyKey: 'prepare-moderation',
    moderationPolicyRevisionId: POLICY.moderation, policyKey: 'prepare-moderation-v1',
    reason: 'Preparation moderation policy.', revision: 1, schemaVersion: 1,
  });
  await registerAiReviewPolicy(pool, {
    actorId: 'test-policy', correlationId: 'prepare-review', idempotencyKey: 'prepare-review',
    model: 'gpt-test', policyKey: 'prepare-ai-review-v1', promptVersion: 1,
    reason: 'Preparation AI review policy.', reviewPolicyRevisionId: POLICY.review, revision: 1,
  });
  await registerEligibilityPolicyRevision(pool, {
    actorId: 'test-policy', correlationId: 'prepare-eligibility', idempotencyKey: 'prepare-eligibility',
    eligibilityPolicyRevisionId: POLICY.eligibility, evidencePolicyRevisionId: POLICY.evidence,
    moderationPolicyRevisionId: POLICY.moderation, policyKey: 'prepare-eligibility-v1',
    reason: 'Preparation eligibility policy.', reviewPolicyRevisionId: POLICY.review,
    revision: 1, schemaVersion: 1,
  });
  await activateEligibilityPolicyRevision(pool, {
    actorId: 'test-policy', correlationId: 'prepare-activation', idempotencyKey: 'prepare-activation',
    eligibilityPolicyRevisionId: POLICY.eligibility, expectedCurrentEligibilityPolicyRevisionId: null,
    reason: 'Activate preparation policy.',
  });
}

async function addObservation(
  pool: Awaited<ReturnType<typeof resetDatabase>>,
  index: number,
  origin: 'community_submitted' | 'ai_generated' = 'community_submitted',
  author: unknown = OBSERVATIONS[index]!.author,
): Promise<void> {
  const value = OBSERVATIONS[index]!;
  await pool.query(`insert into sources (source_id,source_key,display_name,status) values ($1,$2,$2,'active')`, [value.sourceId, value.sourceKey]);
  await pool.query(`insert into source_policy_revisions
    (source_policy_revision_id,source_id,revision,storage_permission,collector_enabled,reason,created_by)
    values ($1,$2,1,'reference_only',true,'Public reference test','test')`, [value.sourcePolicyId, value.sourceId]);
  await pool.query(`insert into raw_observations
    (raw_observation_id,source_id,source_policy_revision_id,adapter_version,external_reference,content_hash,raw_blob,collected_at)
    values ($1,$2,$3,'prepare-test',$4::jsonb,$5,'RAW_SECRET_MUST_NOT_LEAVE_DATABASE',clock_timestamp())`, [
    value.rawId, value.sourceId, value.sourcePolicyId,
    JSON.stringify({ url: value.url, author, privateMetadata: 'PRIVATE_SECRET' }),
    `content-${index}`,
  ]);
  await registerNormalizedObservation(pool, {
    actorId: 'prepare-test', candidateId: CANDIDATE_IDS.candidateId,
    candidateRevisionId: CANDIDATE_IDS.candidateRevisionId, correlationId: `observation-${index}`,
    normalizedObservationId: value.normalizedId, provenanceId: value.provenanceId, rawObservationId: value.rawId,
    snapshot: validNormalizationSnapshot(origin),
  });
}

function interleaveAiReviewContext(
  pool: Pool,
  beforeContextRead: () => Promise<void>,
): { pool: Pool; didInterleave: () => boolean } {
  let interleaved = false;
  const proxy = new Proxy(pool, {
    get(target, property, receiver) {
      if (property === 'connect') {
        return async () => {
          const client = await target.connect();
          return new Proxy(client, {
            get(clientTarget, clientProperty, clientReceiver) {
              if (clientProperty === 'query') {
                return async (...args: unknown[]) => {
                  const statement = args[0];
                  const sql = typeof statement === 'string'
                    ? statement
                    : statement && typeof statement === 'object' && 'text' in statement
                      ? String(statement.text)
                      : '';
                  if (!interleaved && sql.includes('select revision.patch_id as "patchId"')) {
                    interleaved = true;
                    await beforeContextRead();
                  }
                  return Reflect.apply(clientTarget.query, clientTarget, args);
                };
              }
              const value = Reflect.get(clientTarget, clientProperty, clientReceiver) as unknown;
              return typeof value === 'function' ? value.bind(clientTarget) : value;
            },
          });
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { pool: proxy, didInterleave: () => interleaved };
}

async function seedCandidate(
  pool: Awaited<ReturnType<typeof resetDatabase>>,
  indexes: number[],
  origin: 'community_submitted' | 'ai_generated' = 'community_submitted',
): Promise<void> {
  await seedActiveCatalog(pool);
  for (const index of indexes) await addObservation(pool, index, origin);
  await seedPolicies(pool);
}

test('deterministic preparation UUID is stable UUID v4 with a domain-separated literal', () => {
  assert.equal(
    deterministicPreparationUuid('claim', '10000000-0000-4000-8000-000000000001'),
    '311d09c6-b012-485f-8d29-5b25b8eabd2f',
  );
  assert.notEqual(
    deterministicPreparationUuid('claim', '10000000-0000-4000-8000-000000000001'),
    deterministicPreparationUuid('evidence', '10000000-0000-4000-8000-000000000001'),
  );
});

test('current exact reports from two sites seal and replay one source-backed preparation', async (t) => {
  const pool = await resetDatabase(); t.after(() => pool.end());
  await seedCandidate(pool, [0, 1]);

  const first = await prepareCandidateReview(pool, CANDIDATE_IDS.candidateId, CANDIDATE_IDS.candidateRevisionId);
  assert.ok(first);
  assert.equal(first.eligibilityPolicyRevisionId, POLICY.eligibility);
  assert.equal(first.evidencePolicyRevisionId, POLICY.evidence);
  assert.equal(first.moderationPolicyRevisionId, POLICY.moderation);
  assert.equal(first.reviewPolicyRevisionId, POLICY.review);
  assert.equal(first.inputHash, first.request.inputHash);
  assert.equal(first.requestHash.length, 64);
  assert.equal(first.request.requiredClaims.length, 1);
  assert.match(first.request.requiredClaims[0]!.statement, /exact .*selection.*reported.*supplied public sources/iu);
  assert.deepEqual(first.request.evidence.map(({ sourceHost }) => sourceHost), ['bilibili.com', 'zhihu.com']);
  assert.equal(first.request.evidence[0]!.url, 'https://www.bilibili.com/video/BV1test');
  assert.doesNotMatch(JSON.stringify(first.request), /RAW_SECRET|PRIVATE_SECRET|utm_|vd_source|comments/u);
  const before = await Promise.all(['candidate_claims', 'claim_evidence_decisions', 'evidence_records', 'evidence_associations']
    .map((table) => tableCount(pool, table)));

  const replay = await prepareCandidateReview(pool, CANDIDATE_IDS.candidateId, CANDIDATE_IDS.candidateRevisionId);
  assert.deepEqual(replay, first);
  assert.deepEqual(await Promise.all(['candidate_claims', 'claim_evidence_decisions', 'evidence_records', 'evidence_associations']
    .map((table) => tableCount(pool, table))), before);
});

test('one-site and AI-only provenance hold before claims or evidence mutate', async (t) => {
  for (const [indexes, origin] of [[[0], 'community_submitted'], [[0, 1], 'ai_generated']] as const) {
    const pool = await resetDatabase();
    await seedCandidate(pool, [...indexes], origin);
    assert.equal(await prepareCandidateReview(pool, CANDIDATE_IDS.candidateId, CANDIDATE_IDS.candidateRevisionId), null);
    assert.equal(await tableCount(pool, 'candidate_claims'), 0);
    assert.equal(await tableCount(pool, 'evidence_records'), 0);
    await pool.end();
  }
  t.after(() => undefined);
});

test('object-valued source author holds before claims or private metadata can leave preparation', async (t) => {
  const pool = await resetDatabase(); t.after(() => pool.end());
  await seedActiveCatalog(pool);
  await addObservation(pool, 0);
  await addObservation(pool, 1, 'community_submitted', { private: 'SECRET_OBJECT_AUTHOR' });
  await seedPolicies(pool);

  assert.equal(
    await prepareCandidateReview(pool, CANDIDATE_IDS.candidateId, CANDIDATE_IDS.candidateRevisionId),
    null,
  );
  assert.equal(await tableCount(pool, 'candidate_claims'), 0);
  assert.equal(await tableCount(pool, 'evidence_records'), 0);
});

test('stale patch and mismatched candidate identity hold', async (t) => {
  const pool = await resetDatabase(); t.after(() => pool.end());
  await seedCandidate(pool, [0, 1]);
  assert.equal(await prepareCandidateReview(pool, randomUUID(), CANDIDATE_IDS.candidateRevisionId), null);
  await registerPatchEvent(pool, {
    actorId: 'test-policy', correlationId: 'supersede', displayLabel: '26.15', eventId: randomUUID(),
    lifecycleState: 'superseded', occurredAt: new Date('2026-09-09T00:00:00.000Z'),
    patchId: CATALOG_IDS.patchId, patchKey: '26.15', reason: 'Stale preparation test.',
  });
  assert.equal(await prepareCandidateReview(pool, CANDIDATE_IDS.candidateId, CANDIDATE_IDS.candidateRevisionId), null);
});

test('normalized report payload mismatch holds before claims or evidence mutate', async (t) => {
  const pool = await resetDatabase(); t.after(() => pool.end());
  await seedCandidate(pool, [0, 1]);
  await pool.query('alter table normalized_observations disable trigger normalized_observations_immutable');
  try {
    await pool.query(`update normalized_observations
      set canonical_payload = '{"schemaVersion":1,"augmentExternalIds":["1194"],"itemExternalIds":["3006","9999"]}'::jsonb
      where normalized_observation_id = $1`, [OBSERVATIONS[1]!.normalizedId]);
  } finally {
    await pool.query('alter table normalized_observations enable trigger normalized_observations_immutable');
  }

  assert.equal(
    await prepareCandidateReview(pool, CANDIDATE_IDS.candidateId, CANDIDATE_IDS.candidateRevisionId),
    null,
  );
  assert.equal(await tableCount(pool, 'candidate_claims'), 0);
  assert.equal(await tableCount(pool, 'evidence_records'), 0);
});

test('policy switch reusing the review policy cannot pair a new authority hash with old policy metadata', async (t) => {
  const pool = await resetDatabase(); t.after(() => pool.end());
  await seedCandidate(pool, [0, 1]);
  await registerEligibilityPolicyRevision(pool, {
    actorId: 'test-policy', correlationId: 'alternate-eligibility', idempotencyKey: 'alternate-eligibility',
    eligibilityPolicyRevisionId: POLICY.alternateEligibility, evidencePolicyRevisionId: POLICY.evidence,
    moderationPolicyRevisionId: POLICY.moderation, policyKey: 'prepare-eligibility-v2',
    reason: 'Interleaved preparation policy.', reviewPolicyRevisionId: POLICY.review,
    revision: 2, schemaVersion: 1,
  });
  const interleaving = interleaveAiReviewContext(pool, async () => {
    await activateEligibilityPolicyRevision(pool, {
      actorId: 'test-policy', correlationId: 'alternate-activation', idempotencyKey: 'alternate-activation',
      eligibilityPolicyRevisionId: POLICY.alternateEligibility,
      expectedCurrentEligibilityPolicyRevisionId: POLICY.eligibility,
      reason: 'Switch during AI review preparation.',
    });
  });

  assert.equal(
    await prepareCandidateReview(interleaving.pool, CANDIDATE_IDS.candidateId, CANDIDATE_IDS.candidateRevisionId),
    null,
  );
  assert.equal(interleaving.didInterleave(), true);
});

test('source append during authority hashing cannot return a hash paired with stale evidence', async (t) => {
  const pool = await resetDatabase(); t.after(() => pool.end());
  await seedCandidate(pool, [0, 1]);
  const interleaving = interleaveAiReviewContext(pool, () => addObservation(pool, 2));

  assert.equal(
    await prepareCandidateReview(interleaving.pool, CANDIDATE_IDS.candidateId, CANDIDATE_IDS.candidateRevisionId),
    null,
  );
  assert.equal(interleaving.didInterleave(), true);
});

test('an existing contradicted owned claim holds without overwrite', async (t) => {
  const pool = await resetDatabase(); t.after(() => pool.end());
  await seedCandidate(pool, [0, 1]);
  const first = await prepareCandidateReview(pool, CANDIDATE_IDS.candidateId, CANDIDATE_IDS.candidateRevisionId);
  assert.ok(first);
  await addObservation(pool, 2);
  const claimId = first.request.requiredClaims[0]!.claimId;
  await recordClaimEvidenceDecision(pool, {
    actorId: 'human-evidence-reviewer', associations: [{
      associationId: randomUUID(), crossPatchRevalidated: false, evidenceId: randomUUID(),
      normalizedObservationId: OBSERVATIONS[2].normalizedId, revalidationReason: null, stance: 'contradicts',
    }],
    candidateId: CANDIDATE_IDS.candidateId, candidateRevisionId: CANDIDATE_IDS.candidateRevisionId,
    claimId, correlationId: 'contradicted-owned', decision: 'contradicted', decisionId: randomUUID(),
    evaluatedAt: new Date().toISOString(), evidenceInputSnapshotId: randomUUID(),
    evidencePolicyRevisionId: POLICY.evidence, idempotencyKey: 'contradicted-owned',
    reason: 'A later governed evaluation contradicted the owned claim.',
  });
  const decisionCount = await tableCount(pool, 'claim_evidence_decisions');
  assert.equal(await prepareCandidateReview(pool, CANDIDATE_IDS.candidateId, CANDIDATE_IDS.candidateRevisionId), null);
  assert.equal(await tableCount(pool, 'claim_evidence_decisions'), decisionCount);
});

test('pre-existing supported required claims remain untouched', async (t) => {
  const pool = await resetDatabase(); t.after(() => pool.end());
  await seedCandidate(pool, [0, 1]);
  const existingClaimId = '85000000-0000-4000-8000-000000000001';
  await defineCandidateClaimSet(pool, {
    actorId: 'claim-editor', candidateId: CANDIDATE_IDS.candidateId,
    candidateRevisionId: CANDIDATE_IDS.candidateRevisionId,
    claims: [{ claimId: existingClaimId, claimKey: 'existing-required', claimType: 'compatibility',
      importance: 'required', statement: 'The selection matches the current catalog.' }],
    correlationId: 'existing-claim', idempotencyKey: 'existing-claim',
  });
  await recordClaimEvidenceDecision(pool, {
    actorId: 'evidence-reviewer', associations: [{
      associationId: '85000000-0000-4000-8000-000000000002', crossPatchRevalidated: false,
      evidenceId: '85000000-0000-4000-8000-000000000003',
      normalizedObservationId: OBSERVATIONS[0].normalizedId, revalidationReason: null, stance: 'supports',
    }], candidateId: CANDIDATE_IDS.candidateId, candidateRevisionId: CANDIDATE_IDS.candidateRevisionId,
    claimId: existingClaimId, correlationId: 'existing-evidence', decision: 'supported',
    decisionId: '85000000-0000-4000-8000-000000000004', evaluatedAt: '2026-09-09T01:00:00.000Z',
    evidenceInputSnapshotId: '85000000-0000-4000-8000-000000000005',
    evidencePolicyRevisionId: POLICY.evidence, idempotencyKey: 'existing-evidence', reason: 'Supported existing claim.',
  });
  const before = await tableCount(pool, 'claim_evidence_decisions');
  const prepared = await prepareCandidateReview(pool, CANDIDATE_IDS.candidateId, CANDIDATE_IDS.candidateRevisionId);
  assert.ok(prepared);
  assert.deepEqual(prepared.request.requiredClaims, [{
    claimId: existingClaimId, statement: 'The selection matches the current catalog.',
  }]);
  assert.equal(await tableCount(pool, 'candidate_claims'), 1);
  assert.equal(await tableCount(pool, 'claim_evidence_decisions'), before);
});
