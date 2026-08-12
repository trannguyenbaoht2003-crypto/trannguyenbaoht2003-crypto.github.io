import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import {
  registerModerationPolicyRevision,
} from '../src/modules/moderation/register-moderation-policy-revision.js';
import {
  activateEligibilityPolicyRevision,
} from '../src/modules/eligibility/activate-eligibility-policy-revision.js';
import {
  registerEligibilityPolicyRevision,
} from '../src/modules/eligibility/register-eligibility-policy-revision.js';
import { resetDatabase, tableCount } from './helpers/database.js';
import {
  GATE_IDS,
  activationCommand,
  eligibilityPolicyCommand,
  moderationPolicyCommand,
} from './helpers/gate.js';
import {
  TRUST_IDS,
  seedTrustReviewContext,
} from './helpers/trust.js';

async function seedSubordinatePolicies(
  pool: Awaited<ReturnType<typeof resetDatabase>>,
): Promise<void> {
  await seedTrustReviewContext(pool, false);
}

test('gate policy commands register exact revisions and activate by compare-and-swap', async () => {
  const pool = await resetDatabase();
  await seedSubordinatePolicies(pool);

  const moderation = await registerModerationPolicyRevision(
    pool,
    moderationPolicyCommand(),
  );
  assert.deepEqual(moderation, {
    moderationPolicyRevisionId: GATE_IDS.moderationPolicyId,
    replayed: false,
  });

  const eligibility = await registerEligibilityPolicyRevision(
    pool,
    eligibilityPolicyCommand(),
  );
  assert.deepEqual(eligibility, {
    eligibilityPolicyRevisionId: GATE_IDS.eligibilityPolicyId,
    replayed: false,
  });

  const activation = await activateEligibilityPolicyRevision(
    pool,
    activationCommand(),
  );
  assert.deepEqual(activation, {
    currentEligibilityPolicyRevisionId: GATE_IDS.eligibilityPolicyId,
    previousEligibilityPolicyRevisionId: null,
    replayed: false,
  });

  assert.equal(await tableCount(pool, 'moderation_policy_revisions'), 1);
  assert.equal(await tableCount(pool, 'eligibility_policy_revisions'), 1);
  assert.equal(
    await tableCount(pool, 'active_eligibility_policy_revision'),
    1,
  );
  const effects = await pool.query<{ event_type: string }>(
    `select event_type
       from outbox_events
      where event_type in (
        'ModerationPolicyRevisionRegistered',
        'EligibilityPolicyRevisionRegistered',
        'EligibilityPolicyRevisionActivated'
      )
      order by event_type`,
  );
  assert.deepEqual(
    effects.rows.map((row) => row.event_type),
    [
      'EligibilityPolicyRevisionActivated',
      'EligibilityPolicyRevisionRegistered',
      'ModerationPolicyRevisionRegistered',
    ],
  );
  await pool.end();
});

test('gate policy replay returns recorded results without duplicate effects', async () => {
  const pool = await resetDatabase();
  await seedSubordinatePolicies(pool);

  await registerModerationPolicyRevision(pool, moderationPolicyCommand());
  const moderationReplay = await registerModerationPolicyRevision(
    pool,
    moderationPolicyCommand(),
  );
  await registerEligibilityPolicyRevision(pool, eligibilityPolicyCommand());
  const eligibilityReplay = await registerEligibilityPolicyRevision(
    pool,
    eligibilityPolicyCommand(),
  );
  await activateEligibilityPolicyRevision(pool, activationCommand());
  const activationReplay = await activateEligibilityPolicyRevision(
    pool,
    activationCommand(),
  );

  assert.equal(moderationReplay.replayed, true);
  assert.equal(eligibilityReplay.replayed, true);
  assert.equal(activationReplay.replayed, true);
  assert.equal(await tableCount(pool, 'moderation_policy_revisions'), 1);
  assert.equal(await tableCount(pool, 'eligibility_policy_revisions'), 1);
  assert.equal(
    await tableCount(pool, 'active_eligibility_policy_revision'),
    1,
  );
  const gateOutbox = await pool.query<{ count: string }>(
    `select count(*)
       from outbox_events
      where event_type in (
        'ModerationPolicyRevisionRegistered',
        'EligibilityPolicyRevisionRegistered',
        'EligibilityPolicyRevisionActivated'
      )`,
  );
  assert.equal(gateOutbox.rows[0]?.count, '3');
  await pool.end();
});

test('gate policy idempotency rejects a changed payload', async () => {
  const pool = await resetDatabase();
  await seedSubordinatePolicies(pool);
  await registerModerationPolicyRevision(pool, moderationPolicyCommand());

  await assert.rejects(
    registerModerationPolicyRevision(
      pool,
      moderationPolicyCommand({ reason: 'Changed policy reason.' }),
    ),
    /IDEMPOTENCY_PAYLOAD_CONFLICT/,
  );
  assert.equal(await tableCount(pool, 'moderation_policy_revisions'), 1);
  await pool.end();
});

test('gate policy registration rejects a duplicate policy key and revision', async () => {
  const pool = await resetDatabase();
  await seedSubordinatePolicies(pool);
  await registerModerationPolicyRevision(pool, moderationPolicyCommand());

  await assert.rejects(
    registerModerationPolicyRevision(
      pool,
      moderationPolicyCommand({
        correlationId: 'moderation-policy-conflict',
        idempotencyKey: 'moderation-policy-conflict',
        moderationPolicyRevisionId: randomUUID(),
      }),
    ),
    /GATE_POLICY_REVISION_CONFLICT/,
  );
  assert.equal(await tableCount(pool, 'moderation_policy_revisions'), 1);
  await pool.end();
});

test('Eligibility policy rejects an unknown subordinate policy graph', async () => {
  const pool = await resetDatabase();
  await seedSubordinatePolicies(pool);
  await registerModerationPolicyRevision(pool, moderationPolicyCommand());

  await assert.rejects(
    registerEligibilityPolicyRevision(
      pool,
      eligibilityPolicyCommand({
        evidencePolicyRevisionId: randomUUID(),
      }),
    ),
    /GATE_POLICY_INVALID/,
  );
  assert.equal(await tableCount(pool, 'eligibility_policy_revisions'), 0);
  await pool.end();
});

test('Eligibility policy activation rejects a stale expected pointer', async () => {
  const pool = await resetDatabase();
  await seedSubordinatePolicies(pool);
  await registerModerationPolicyRevision(pool, moderationPolicyCommand());
  await registerEligibilityPolicyRevision(pool, eligibilityPolicyCommand());
  await activateEligibilityPolicyRevision(pool, activationCommand());

  await assert.rejects(
    activateEligibilityPolicyRevision(
      pool,
      activationCommand({
        correlationId: 'eligibility-stale-activation',
        expectedCurrentEligibilityPolicyRevisionId: null,
        idempotencyKey: 'eligibility-stale-activation',
      }),
    ),
    /ELIGIBILITY_POLICY_ACTIVE_POINTER_CONFLICT/,
  );
  const pointer = await pool.query<{
    eligibility_policy_revision_id: string;
  }>(
    `select eligibility_policy_revision_id
       from active_eligibility_policy_revision`,
  );
  assert.equal(
    pointer.rows[0]?.eligibility_policy_revision_id,
    GATE_IDS.eligibilityPolicyId,
  );
  await pool.end();
});

test('late audit failure rolls back gate policy and idempotency', async () => {
  const pool = await resetDatabase();
  await seedSubordinatePolicies(pool);
  await pool.query(`
    create function reject_gate_policy_audit()
    returns trigger
    language plpgsql
    as $$
    begin
      if new.action = 'gate.policy_revision_registered' then
        raise exception 'injected gate policy audit failure';
      end if;
      return new;
    end;
    $$;
    create trigger reject_gate_policy_audit
    before insert on audit_events
    for each row execute function reject_gate_policy_audit();
  `);

  await assert.rejects(
    registerModerationPolicyRevision(pool, moderationPolicyCommand()),
    /injected gate policy audit failure/,
  );
  assert.equal(await tableCount(pool, 'moderation_policy_revisions'), 0);
  const idempotency = await pool.query<{ count: string }>(
    `select count(*)
       from idempotency_records
      where scope = 'moderation_policy_registration'`,
  );
  assert.equal(idempotency.rows[0]?.count, '0');
  const audit = await pool.query<{ count: string }>(
    `select count(*)
       from audit_events
      where action = 'gate.policy_revision_registered'`,
  );
  assert.equal(audit.rows[0]?.count, '0');
  await pool.end();
});

test('Eligibility policy pins the exact existing Evidence and Review revisions', async () => {
  const pool = await resetDatabase();
  await seedSubordinatePolicies(pool);
  await registerModerationPolicyRevision(pool, moderationPolicyCommand());
  await registerEligibilityPolicyRevision(pool, eligibilityPolicyCommand());

  const policy = await pool.query<{
    evidence_policy_revision_id: string;
    review_policy_revision_id: string;
  }>(
    `select evidence_policy_revision_id, review_policy_revision_id
       from eligibility_policy_revisions
      where eligibility_policy_revision_id = $1`,
    [GATE_IDS.eligibilityPolicyId],
  );
  assert.deepEqual(policy.rows[0], {
    evidence_policy_revision_id: TRUST_IDS.evidencePolicyId,
    review_policy_revision_id: TRUST_IDS.reviewPolicyId,
  });
  await pool.end();
});
