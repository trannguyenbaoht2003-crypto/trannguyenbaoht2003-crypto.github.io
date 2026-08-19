import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import {
  activateAiOperationsPolicyRevision,
} from '../src/modules/ai-operations/activate-ai-operations-policy-revision.js';
import {
  registerAiOperationsPolicyRevision,
} from '../src/modules/ai-operations/register-ai-operations-policy-revision.js';
import { resetDatabase } from './helpers/database.js';

function registerCommand(overrides: Record<string, unknown> = {}) {
  return {
    actorId: 'operator:test',
    correlationId: 'corr-policy-register',
    idempotencyKey: 'idem-policy-register',
    aiOperationsPolicyRevisionId: randomUUID(),
    revision: 2,
    enabled: true,
    maxRunsPerUtcDay: 4,
    minIntervalSeconds: 600,
    maxProposalsPerRun: 12,
    reason: 'enable bounded private AI discovery',
    ...overrides,
  };
}

test('registers immutable AI operations policy revision and replays idempotently', async () => {
  const pool = await resetDatabase();
  const command = registerCommand();

  const first = await registerAiOperationsPolicyRevision(pool, command);
  const second = await registerAiOperationsPolicyRevision(pool, command);

  assert.deepEqual(first, {
    aiOperationsPolicyRevisionId: command.aiOperationsPolicyRevisionId,
    revision: 2,
    replayed: false,
  });
  assert.deepEqual(second, { ...first, replayed: true });

  const rows = await pool.query(
    `select revision, enabled, max_runs_per_utc_day,
            min_interval_seconds, max_proposals_per_run
       from ai_operations_policy_revisions
      where ai_operations_policy_revision_id = $1`,
    [command.aiOperationsPolicyRevisionId],
  );
  assert.equal(rows.rowCount, 1);
  assert.deepEqual(rows.rows[0], {
    revision: 2,
    enabled: true,
    max_runs_per_utc_day: 4,
    min_interval_seconds: 600,
    max_proposals_per_run: 12,
  });

  const audit = await pool.query(
    `select count(*)::int as count
       from audit_events
      where action = 'ai.operations.policy_revision_registered'
        and correlation_id = $1`,
    [command.correlationId],
  );
  assert.equal(audit.rows[0]?.count, 1);
  await pool.end();
});

test('rejects enabled policy with zero daily run budget', async () => {
  const pool = await resetDatabase();
  await assert.rejects(
    registerAiOperationsPolicyRevision(
      pool,
      registerCommand({ maxRunsPerUtcDay: 0 }),
    ),
    /AI_OPERATIONS_POLICY_INVALID/,
  );
  await pool.end();
});

test('activates policy with expected-current compare-and-set and replays safely', async () => {
  const pool = await resetDatabase();
  const active = await pool.query<{ ai_operations_policy_revision_id: string }>(
    `select ai_operations_policy_revision_id
       from active_ai_operations_policy_revision
      where scope = 'ai_discovery_provider'`,
  );
  const previous = active.rows[0]!.ai_operations_policy_revision_id;
  const registered = registerCommand();
  await registerAiOperationsPolicyRevision(pool, registered);

  const activation = {
    actorId: 'operator:test',
    correlationId: 'corr-policy-activate',
    idempotencyKey: 'idem-policy-activate',
    aiOperationsPolicyRevisionId: registered.aiOperationsPolicyRevisionId,
    expectedCurrentAiOperationsPolicyRevisionId: previous,
    reason: 'activate reviewed bounded policy',
  };
  const first = await activateAiOperationsPolicyRevision(pool, activation);
  const second = await activateAiOperationsPolicyRevision(pool, activation);

  assert.deepEqual(first, {
    currentAiOperationsPolicyRevisionId: registered.aiOperationsPolicyRevisionId,
    previousAiOperationsPolicyRevisionId: previous,
    replayed: false,
  });
  assert.deepEqual(second, { ...first, replayed: true });

  const audit = await pool.query(
    `select count(*)::int as count
       from audit_events
      where action = 'ai.operations.policy_revision_activated'
        and correlation_id = $1`,
    [activation.correlationId],
  );
  assert.equal(audit.rows[0]?.count, 1);
  await pool.end();
});

test('rejects activation when expected-current policy pointer is stale', async () => {
  const pool = await resetDatabase();
  const registered = registerCommand();
  await registerAiOperationsPolicyRevision(pool, registered);

  await assert.rejects(
    activateAiOperationsPolicyRevision(pool, {
      actorId: 'operator:test',
      correlationId: 'corr-policy-conflict',
      idempotencyKey: 'idem-policy-conflict',
      aiOperationsPolicyRevisionId: registered.aiOperationsPolicyRevisionId,
      expectedCurrentAiOperationsPolicyRevisionId: randomUUID(),
      reason: 'stale pointer must fail closed',
    }),
    /AI_OPERATIONS_POLICY_ACTIVE_POINTER_CONFLICT/,
  );
  await pool.end();
});
