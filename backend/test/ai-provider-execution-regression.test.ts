import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import type { Pool } from 'pg';

import { activateAiOperationsPolicyRevision } from '../src/modules/ai-operations/activate-ai-operations-policy-revision.js';
import { executePolicyGovernedAiDiscoveryRun } from '../src/modules/ai-operations/execute-policy-governed-ai-discovery-run.js';
import { registerAiOperationsPolicyRevision } from '../src/modules/ai-operations/register-ai-operations-policy-revision.js';
import { claimAiProviderExecution } from '../src/modules/ai-provider-execution/claim-ai-provider-execution.js';
import { finalizeAiProviderExecution } from '../src/modules/ai-provider-execution/finalize-ai-provider-execution.js';
import { markAiProviderAttemptInFlight } from '../src/modules/ai-provider-execution/mark-ai-provider-attempt-in-flight.js';
import { prepareAiProviderExecution } from '../src/modules/ai-provider-execution/prepare-ai-provider-execution.js';
import { AiProviderError, type AiDiscoveryProvider } from '../src/modules/ai-provider/openai-responses-provider.js';
import { resetDatabase } from './helpers/database.js';

async function enablePolicy(pool: Pool): Promise<void> {
  const active = await pool.query<{ ai_operations_policy_revision_id: string }>(
    `select ai_operations_policy_revision_id
       from active_ai_operations_policy_revision
      where scope = 'ai_discovery_provider'`,
  );
  const previous = active.rows[0]!.ai_operations_policy_revision_id;
  const policyId = randomUUID();
  await registerAiOperationsPolicyRevision(pool, {
    actorId: 'operator:test',
    correlationId: `corr-8e-regression-register-${policyId}`,
    idempotencyKey: `idem-8e-regression-register-${policyId}`,
    aiOperationsPolicyRevisionId: policyId,
    revision: 2,
    enabled: true,
    maxRunsPerUtcDay: 8,
    minIntervalSeconds: 0,
    maxProposalsPerRun: 4,
    reason: 'enable Sprint 8E regression test policy',
  });
  await activateAiOperationsPolicyRevision(pool, {
    actorId: 'operator:test',
    correlationId: `corr-8e-regression-activate-${policyId}`,
    idempotencyKey: `idem-8e-regression-activate-${policyId}`,
    aiOperationsPolicyRevisionId: policyId,
    expectedCurrentAiOperationsPolicyRevisionId: previous,
    reason: 'activate Sprint 8E regression test policy',
  });
}

function providerInput(runKey: string) {
  return {
    runKey,
    patchKey: '26.17',
    gameModeExternalId: 'aram_mayhem' as const,
    subjects: [{
      subjectExternalId: 'samira',
      allowedAugmentExternalIds: ['1194'],
      allowedItemExternalIds: ['3006'],
      observations: ['Bounded regression fixture.'],
    }],
  };
}

function prepareCommand() {
  const aiDiscoveryRunId = randomUUID();
  return {
    actorId: 'operator:test',
    correlationId: `corr-prepare-${aiDiscoveryRunId}`,
    idempotencyKey: `idem-prepare-${aiDiscoveryRunId}`,
    aiDiscoveryRunId,
    runKey: `run-prepare-${aiDiscoveryRunId}`,
    providerKey: 'fixture-provider',
    modelKey: 'fixture-model',
    modelRevision: 'fixture-r1',
    promptTemplateKey: 'aram-mayhem-discovery',
    promptTemplateVersion: 1,
    inputHash: 'a'.repeat(64),
    startedAt: '2026-08-20T08:00:00.000Z',
    gameModeExternalId: 'aram_mayhem' as const,
  };
}

function failedRun(command: ReturnType<typeof prepareCommand>, overrides: Record<string, unknown> = {}) {
  return {
    actorId: command.actorId,
    aiDiscoveryRunId: command.aiDiscoveryRunId,
    correlationId: command.correlationId,
    idempotencyKey: command.idempotencyKey,
    runKey: command.runKey,
    providerKey: command.providerKey,
    modelKey: command.modelKey,
    modelRevision: command.modelRevision,
    promptTemplateKey: command.promptTemplateKey,
    promptTemplateVersion: command.promptTemplateVersion,
    inputHash: command.inputHash,
    outputHash: 'b'.repeat(64),
    status: 'failed' as const,
    startedAt: command.startedAt,
    completedAt: '2026-08-20T08:00:01.000Z',
    failureCode: 'PROVIDER_AUTH_REJECTED',
    proposals: [],
    ...overrides,
  };
}

test('received HTTP 429 durably advances to attempt 2 and then completes', async () => {
  const pool = await resetDatabase();
  await enablePolicy(pool);
  let calls = 0;
  const clientRequestIds: string[] = [];
  const provider: AiDiscoveryProvider = {
    providerKey: 'fixture-provider',
    async execute(_request, options) {
      calls += 1;
      if (options?.clientRequestId) clientRequestIds.push(options.clientRequestId);
      if (calls === 1) {
        throw new AiProviderError(
          'PROVIDER_RATE_LIMITED',
          true,
          'PROVIDER_RATE_LIMITED',
          'req-rate-limited',
        );
      }
      return {
        providerRequestId: 'req-success',
        providerResponseId: 'resp-success',
        outputText: '{}',
        proposals: [],
      };
    },
  };
  const aiDiscoveryRunId = randomUUID();
  const result = await executePolicyGovernedAiDiscoveryRun(pool, {
    actorId: 'operator:test',
    correlationId: `corr-429-${aiDiscoveryRunId}`,
    idempotencyKey: `idem-429-${aiDiscoveryRunId}`,
    aiDiscoveryRunId,
    provider,
    modelKey: 'fixture-model',
    modelRevision: 'fixture-r1',
    input: providerInput(`run-429-${aiDiscoveryRunId}`),
    startedAt: '2026-08-20T08:00:00.000Z',
  }, {
    now: () => '2026-08-20T08:00:01.000Z',
    sleep: async () => {},
  });

  assert.equal(result.status, 'completed');
  assert.equal(calls, 2);
  assert.equal(clientRequestIds.length, 2);
  assert.notEqual(clientRequestIds[0], clientRequestIds[1]);
  const attempts = await pool.query<{ ordinal: number; status: string; failure_code: string | null }>(
    `select ordinal, status, failure_code
       from ai_provider_execution_attempts
      order by ordinal`,
  );
  assert.deepEqual(attempts.rows, [
    { ordinal: 1, status: 'FAILED', failure_code: 'PROVIDER_RATE_LIMITED' },
    { ordinal: 2, status: 'COMPLETED', failure_code: null },
  ]);
  const execution = await pool.query<{ status: string; current_attempt_ordinal: number }>(
    `select status, current_attempt_ordinal from ai_provider_executions`,
  );
  assert.deepEqual(execution.rows[0], { status: 'COMPLETED', current_attempt_ordinal: 2 });
  await pool.end();
});

test('existing provider execution rejects identity mismatch instead of replaying journal state', async () => {
  const pool = await resetDatabase();
  await enablePolicy(pool);
  const command = prepareCommand();
  const first = await prepareAiProviderExecution(pool, command, { minimumIntervalFloorSeconds: 0 });
  assert.equal(first.kind, 'PREPARED');

  await assert.rejects(
    prepareAiProviderExecution(pool, {
      ...command,
      modelRevision: 'fixture-r2-conflict',
    }, { minimumIntervalFloorSeconds: 0 }),
    /AI_PROVIDER_EXECUTION_IDENTITY_CONFLICT/,
  );
  await pool.end();
});

test('finalization rejects a non-current attempt id and leaves both run and journal uncommitted', async () => {
  const pool = await resetDatabase();
  await enablePolicy(pool);
  const command = prepareCommand();
  const prepared = await prepareAiProviderExecution(pool, command, { minimumIntervalFloorSeconds: 0 });
  assert.equal(prepared.kind, 'PREPARED');
  if (prepared.kind !== 'PREPARED') throw new Error('fixture preparation failed');
  const leaseToken = randomUUID();
  assert.equal(await claimAiProviderExecution(pool, {
    executionId: prepared.executionId,
    leaseToken,
    leaseSeconds: 120,
  }), true);
  await markAiProviderAttemptInFlight(pool, {
    executionId: prepared.executionId,
    attemptId: prepared.attemptId,
    leaseToken,
  });

  await assert.rejects(
    finalizeAiProviderExecution(pool, {
      executionId: prepared.executionId,
      attemptId: randomUUID(),
      ordinal: 1,
      disposition: {
        kind: 'SAFE_TERMINAL',
        failureCode: 'PROVIDER_AUTH_REJECTED',
        providerRequestId: 'req-auth',
      },
      failedRun: failedRun(command),
    }),
    /AI_PROVIDER_EXECUTION_FINALIZATION_CONFLICT/,
  );
  const runs = await pool.query<{ count: number }>(`select count(*)::int as count from ai_discovery_runs`);
  assert.equal(runs.rows[0]?.count, 0);
  const execution = await pool.query<{ status: string }>(
    `select status from ai_provider_executions where ai_provider_execution_id=$1`,
    [prepared.executionId],
  );
  assert.equal(execution.rows[0]?.status, 'IN_FLIGHT');
  await pool.end();
});

test('finalization rejects AI run identity that does not match the durable execution journal', async () => {
  const pool = await resetDatabase();
  await enablePolicy(pool);
  const command = prepareCommand();
  const prepared = await prepareAiProviderExecution(pool, command, { minimumIntervalFloorSeconds: 0 });
  assert.equal(prepared.kind, 'PREPARED');
  if (prepared.kind !== 'PREPARED') throw new Error('fixture preparation failed');
  const leaseToken = randomUUID();
  assert.equal(await claimAiProviderExecution(pool, {
    executionId: prepared.executionId,
    leaseToken,
    leaseSeconds: 120,
  }), true);
  await markAiProviderAttemptInFlight(pool, {
    executionId: prepared.executionId,
    attemptId: prepared.attemptId,
    leaseToken,
  });

  await assert.rejects(
    finalizeAiProviderExecution(pool, {
      executionId: prepared.executionId,
      attemptId: prepared.attemptId,
      ordinal: 1,
      disposition: {
        kind: 'SAFE_TERMINAL',
        failureCode: 'PROVIDER_AUTH_REJECTED',
        providerRequestId: 'req-auth',
      },
      failedRun: failedRun(command, { modelRevision: 'fixture-r2-conflict' }),
    }),
    /AI_PROVIDER_EXECUTION_IDENTITY_CONFLICT/,
  );
  const runs = await pool.query<{ count: number }>(`select count(*)::int as count from ai_discovery_runs`);
  assert.equal(runs.rows[0]?.count, 0);
  const attempt = await pool.query<{ status: string }>(
    `select status from ai_provider_execution_attempts where ai_provider_execution_attempt_id=$1`,
    [prepared.attemptId],
  );
  assert.equal(attempt.rows[0]?.status, 'IN_FLIGHT');
  await pool.end();
});

test('finalization rejects a caller that does not present the active lease token', async () => {
  const pool = await resetDatabase();
  try {
    await enablePolicy(pool);
    const command = prepareCommand();
    const prepared = await prepareAiProviderExecution(pool, command, { minimumIntervalFloorSeconds: 0 });
    assert.equal(prepared.kind, 'PREPARED');
    if (prepared.kind !== 'PREPARED') throw new Error('fixture preparation failed');
    const leaseToken = randomUUID();
    assert.equal(await claimAiProviderExecution(pool, {
      executionId: prepared.executionId,
      leaseToken,
      leaseSeconds: 120,
    }), true);
    await markAiProviderAttemptInFlight(pool, {
      executionId: prepared.executionId,
      attemptId: prepared.attemptId,
      leaseToken,
    });

    const staleHolderCommand = {
      executionId: prepared.executionId,
      attemptId: prepared.attemptId,
      ordinal: 1 as const,
      leaseToken: randomUUID(),
      disposition: {
        kind: 'SAFE_TERMINAL' as const,
        failureCode: 'PROVIDER_AUTH_REJECTED',
        providerRequestId: 'req-auth',
      },
      failedRun: failedRun(command),
    };
    await assert.rejects(
      finalizeAiProviderExecution(pool, staleHolderCommand),
      /AI_PROVIDER_EXECUTION_FINALIZATION_CONFLICT/,
    );
    const runs = await pool.query<{ count: number }>(`select count(*)::int as count from ai_discovery_runs`);
    assert.equal(runs.rows[0]?.count, 0);
  } finally {
    await pool.end();
  }
});

test('database rejects IN_FLIGHT to PREPARED without a durable safe-429 next attempt transition', async () => {
  const pool = await resetDatabase();
  try {
    await enablePolicy(pool);
    const command = prepareCommand();
    const prepared = await prepareAiProviderExecution(pool, command, { minimumIntervalFloorSeconds: 0 });
    assert.equal(prepared.kind, 'PREPARED');
    if (prepared.kind !== 'PREPARED') throw new Error('fixture preparation failed');
    const leaseToken = randomUUID();
    assert.equal(await claimAiProviderExecution(pool, {
      executionId: prepared.executionId,
      leaseToken,
      leaseSeconds: 120,
    }), true);
    await markAiProviderAttemptInFlight(pool, {
      executionId: prepared.executionId,
      attemptId: prepared.attemptId,
      leaseToken,
    });

    await assert.rejects(
      pool.query(
        `update ai_provider_executions
            set status='PREPARED', updated_at=clock_timestamp()
          where ai_provider_execution_id=$1`,
        [prepared.executionId],
      ),
      /safe rate-limit retry|provider execution transition/i,
    );
  } finally {
    await pool.end();
  }
});

test('database rejects terminal execution state without a matching durable AI discovery run', async () => {
  const pool = await resetDatabase();
  try {
    await enablePolicy(pool);
    const command = prepareCommand();
    const prepared = await prepareAiProviderExecution(pool, command, { minimumIntervalFloorSeconds: 0 });
    assert.equal(prepared.kind, 'PREPARED');
    if (prepared.kind !== 'PREPARED') throw new Error('fixture preparation failed');
    const leaseToken = randomUUID();
    assert.equal(await claimAiProviderExecution(pool, {
      executionId: prepared.executionId,
      leaseToken,
      leaseSeconds: 120,
    }), true);
    await markAiProviderAttemptInFlight(pool, {
      executionId: prepared.executionId,
      attemptId: prepared.attemptId,
      leaseToken,
    });
    await pool.query(
      `update ai_provider_execution_attempts
          set status='FAILED',failure_code='PROVIDER_AUTH_REJECTED',completed_at=clock_timestamp()
        where ai_provider_execution_attempt_id=$1`,
      [prepared.attemptId],
    );

    await assert.rejects(
      pool.query(
        `update ai_provider_executions
            set status='FAILED',lease_token=null,leased_at=null,lease_expires_at=null,
                terminal_at=clock_timestamp(),updated_at=clock_timestamp()
          where ai_provider_execution_id=$1`,
        [prepared.executionId],
      ),
      /matching durable AI discovery run|terminal provider execution/i,
    );
  } finally {
    await pool.end();
  }
});
