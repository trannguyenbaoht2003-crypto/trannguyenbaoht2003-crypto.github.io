import assert from 'node:assert/strict';
import test from 'node:test';

import {
  registerTrustPolicyRevision,
  type RegisterTrustPolicyRevisionCommand,
} from '../src/modules/trust/register-trust-policy-revision.js';
import { resetDatabase, tableCount } from './helpers/database.js';

const IDS = {
  evidencePolicyId: '72000000-0000-4000-8000-000000000001',
  reviewPolicyOneId: '72000000-0000-4000-8000-000000000002',
  reviewPolicyTwoId: '72000000-0000-4000-8000-000000000003',
  conflictingPolicyId: '72000000-0000-4000-8000-000000000004',
} as const;

function evidenceCommand(
  overrides: Partial<Extract<
    RegisterTrustPolicyRevisionCommand,
    { policyKind: 'evidence' }
  >> = {},
): Extract<
  RegisterTrustPolicyRevisionCommand,
  { policyKind: 'evidence' }
> {
  return {
    actorId: 'trust-operator',
    correlationId: 'trust-policy-evidence-1',
    idempotencyKey: 'trust-policy-evidence-1',
    policyKey: 'evidence-v3',
    policyKind: 'evidence',
    policyRevisionId: IDS.evidencePolicyId,
    reason: 'Claim-level Evidence v3 structural policy',
    revision: 1,
    schemaVersion: 1,
    ...overrides,
  };
}

function reviewCommand(
  minimumConfirmedReviews: number,
  overrides: Partial<Extract<
    RegisterTrustPolicyRevisionCommand,
    { policyKind: 'human_review' }
  >> = {},
): Extract<
  RegisterTrustPolicyRevisionCommand,
  { policyKind: 'human_review' }
> {
  return {
    actorId: 'trust-operator',
    appliesToAiProvenance: true,
    correlationId: `trust-policy-review-${minimumConfirmedReviews}`,
    idempotencyKey: `trust-policy-review-${minimumConfirmedReviews}`,
    minimumConfirmedReviews,
    policyKey: 'human-review-v1',
    policyKind: 'human_review',
    policyRevisionId: minimumConfirmedReviews === 1
      ? IDS.reviewPolicyOneId
      : IDS.reviewPolicyTwoId,
    reason: 'Human Review distinct reviewer policy',
    requireDistinctReviewers: true,
    requiredPermission: 'reviewer',
    revision: minimumConfirmedReviews,
    ...overrides,
  };
}

test('Evidence policy registration is atomic with reliability history', async () => {
  const pool = await resetDatabase();

  const result = await registerTrustPolicyRevision(
    pool,
    evidenceCommand(),
  );

  assert.deepEqual(result, {
    policyKind: 'evidence',
    policyRevisionId: IDS.evidencePolicyId,
    replayed: false,
  });
  assert.equal(await tableCount(pool, 'evidence_policy_revisions'), 1);
  assert.equal(await tableCount(pool, 'review_policy_revisions'), 0);
  assert.equal(await tableCount(pool, 'audit_events'), 1);
  assert.equal(await tableCount(pool, 'outbox_events'), 1);
  assert.equal(await tableCount(pool, 'idempotency_records'), 1);

  const stored = await pool.query<{
    action: string;
    event_type: string;
    idempotency_state: string;
    outbox_payload: {
      policyKey: string;
      policyKind: string;
      policyRevisionId: string;
      revision: number;
    };
  }>(
    `select audit.action,
            outbox.event_type,
            idempotency.state as idempotency_state,
            outbox.payload as outbox_payload
       from audit_events audit
       cross join outbox_events outbox
       cross join idempotency_records idempotency`,
  );
  assert.deepEqual(stored.rows[0], {
    action: 'trust.policy_revision_registered',
    event_type: 'TrustPolicyRevisionRegistered',
    idempotency_state: 'completed',
    outbox_payload: {
      policyKey: 'evidence-v3',
      policyKind: 'evidence',
      policyRevisionId: IDS.evidencePolicyId,
      revision: 1,
    },
  });
  await pool.end();
});

test('Human Review policy persists quorum one and quorum two', async () => {
  const pool = await resetDatabase();

  await registerTrustPolicyRevision(pool, reviewCommand(1));
  await registerTrustPolicyRevision(pool, reviewCommand(2));

  const policies = await pool.query<{
    minimum_confirmed_reviews: number;
    require_distinct_reviewers: boolean;
    required_permission: string;
  }>(
    `select minimum_confirmed_reviews,
            require_distinct_reviewers,
            required_permission
       from review_policy_revisions
      order by revision`,
  );
  assert.deepEqual(policies.rows, [
    {
      minimum_confirmed_reviews: 1,
      require_distinct_reviewers: true,
      required_permission: 'reviewer',
    },
    {
      minimum_confirmed_reviews: 2,
      require_distinct_reviewers: true,
      required_permission: 'reviewer',
    },
  ]);
  await pool.end();
});

test('same policy command replays without duplicate effects', async () => {
  const pool = await resetDatabase();
  const command = evidenceCommand();
  await registerTrustPolicyRevision(pool, command);
  const before = {
    audit: await tableCount(pool, 'audit_events'),
    idempotency: await tableCount(pool, 'idempotency_records'),
    outbox: await tableCount(pool, 'outbox_events'),
    policies: await tableCount(pool, 'evidence_policy_revisions'),
  };

  const replay = await registerTrustPolicyRevision(pool, command);

  assert.deepEqual(replay, {
    policyKind: 'evidence',
    policyRevisionId: IDS.evidencePolicyId,
    replayed: true,
  });
  assert.deepEqual(
    {
      audit: await tableCount(pool, 'audit_events'),
      idempotency: await tableCount(pool, 'idempotency_records'),
      outbox: await tableCount(pool, 'outbox_events'),
      policies: await tableCount(pool, 'evidence_policy_revisions'),
    },
    before,
  );
  await pool.end();
});

test('same idempotency key rejects changed policy configuration', async () => {
  const pool = await resetDatabase();
  const command = reviewCommand(2);
  await registerTrustPolicyRevision(pool, command);

  await assert.rejects(
    registerTrustPolicyRevision(pool, {
      ...command,
      minimumConfirmedReviews: 3,
    }),
    /IDEMPOTENCY_PAYLOAD_CONFLICT/,
  );
  assert.equal(await tableCount(pool, 'review_policy_revisions'), 1);
  assert.equal(await tableCount(pool, 'audit_events'), 1);
  assert.equal(await tableCount(pool, 'outbox_events'), 1);
  await pool.end();
});

test('duplicate policy key and revision maps to a stable conflict', async () => {
  const pool = await resetDatabase();
  await registerTrustPolicyRevision(pool, evidenceCommand());

  await assert.rejects(
    registerTrustPolicyRevision(pool, evidenceCommand({
      correlationId: 'trust-policy-evidence-conflict',
      idempotencyKey: 'trust-policy-evidence-conflict',
      policyRevisionId: IDS.conflictingPolicyId,
    })),
    /TRUST_POLICY_REVISION_CONFLICT/,
  );
  assert.equal(await tableCount(pool, 'evidence_policy_revisions'), 1);
  assert.equal(await tableCount(pool, 'idempotency_records'), 1);
  assert.equal(await tableCount(pool, 'audit_events'), 1);
  assert.equal(await tableCount(pool, 'outbox_events'), 1);
  await pool.end();
});

test('invalid policy shapes fail before storage', async () => {
  const pool = await resetDatabase();
  const invalidCommands: unknown[] = [
    reviewCommand(0),
    reviewCommand(17),
    {
      ...reviewCommand(2),
      requiredPermission: 'publisher',
    },
    {
      ...reviewCommand(2),
      requireDistinctReviewers: false,
    },
    {
      ...reviewCommand(2),
      policyKey: 'not canonical',
    },
    {
      ...evidenceCommand(),
      unexpectedAuthority: 'must be rejected',
    },
  ];

  for (const command of invalidCommands) {
    await assert.rejects(
      registerTrustPolicyRevision(
        pool,
        command as RegisterTrustPolicyRevisionCommand,
      ),
      /TRUST_POLICY_INVALID|TRUST_OBJECT_KEYS_INVALID/,
    );
  }
  assert.equal(await tableCount(pool, 'evidence_policy_revisions'), 0);
  assert.equal(await tableCount(pool, 'review_policy_revisions'), 0);
  assert.equal(await tableCount(pool, 'idempotency_records'), 0);
  assert.equal(await tableCount(pool, 'audit_events'), 0);
  assert.equal(await tableCount(pool, 'outbox_events'), 0);
  await pool.end();
});
