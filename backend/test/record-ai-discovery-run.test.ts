import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { recordAiDiscoveryRun } from '../src/modules/ai-discovery/record-ai-discovery-run.js';
import type { RecordAiDiscoveryRunCommand } from '../src/modules/ai-discovery/types.js';
import { resetDatabase, tableCount } from './helpers/database.js';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

function command(overrides: Partial<RecordAiDiscoveryRunCommand> = {}): RecordAiDiscoveryRunCommand {
  return {
    actorId: 'ai-discovery-recorder',
    aiDiscoveryRunId: randomUUID(),
    correlationId: `corr-${randomUUID()}`,
    idempotencyKey: `idem-${randomUUID()}`,
    runKey: `run-${randomUUID()}`,
    providerKey: 'fixture-provider',
    modelKey: 'fixture-model',
    modelRevision: 'r1',
    promptTemplateKey: 'aram-discovery',
    promptTemplateVersion: 1,
    inputHash: SHA_A,
    outputHash: SHA_B,
    status: 'completed',
    startedAt: '2026-08-17T05:00:00.000Z',
    completedAt: '2026-08-17T05:00:01.000Z',
    failureCode: null,
    proposals: [
      {
        aiCandidateProposalId: randomUUID(),
        ordinal: 0,
        patchKey: '26.17',
        gameModeExternalId: 'aram_mayhem',
        subjectExternalId: 'samira',
        augmentExternalIds: ['1194', '2001'],
        itemExternalIds: ['3006', '6672'],
        rationale: 'community-derived suggestion; not evidence',
      },
      {
        aiCandidateProposalId: randomUUID(),
        ordinal: 1,
        patchKey: '26.17',
        gameModeExternalId: 'aram_mayhem',
        subjectExternalId: 'sona',
        augmentExternalIds: ['1200'],
        itemExternalIds: ['3003', '6657'],
        rationale: null,
      },
    ],
    ...overrides,
  };
}

test('record AI discovery run atomically persists immutable run, proposals, audit and outbox', async () => {
  const pool = await resetDatabase();
  const input = command();

  const result = await recordAiDiscoveryRun(pool, input);

  assert.deepEqual(result, {
    aiDiscoveryRunId: input.aiDiscoveryRunId,
    runKey: input.runKey,
    status: 'completed',
    proposalIds: input.proposals.map((proposal) => proposal.aiCandidateProposalId),
    proposalCount: 2,
    replayed: false,
  });
  assert.equal(await tableCount(pool, 'ai_discovery_runs'), 1);
  assert.equal(await tableCount(pool, 'ai_candidate_proposals'), 2);
  assert.equal(await tableCount(pool, 'audit_events'), 1);
  assert.equal(await tableCount(pool, 'outbox_events'), 1);

  const event = await pool.query<{ payload: Record<string, unknown> }>(
    `select payload from outbox_events where event_type = 'AiDiscoveryRunRecorded'`,
  );
  assert.equal(event.rowCount, 1);
  const serialized = JSON.stringify(event.rows[0]?.payload);
  assert.doesNotMatch(serialized, /community-derived suggestion|rationale|raw provider/i);
  assert.match(serialized, new RegExp(input.aiDiscoveryRunId));
  assert.match(serialized, /proposalCount/);

  const audit = await pool.query<{ payload: Record<string, unknown> }>(
    `select payload from audit_events where action = 'ai.discovery.run.recorded'`,
  );
  assert.equal(audit.rowCount, 1);
  assert.doesNotMatch(JSON.stringify(audit.rows[0]?.payload), /community-derived suggestion|rationale/i);
  await pool.end();
});

test('record AI discovery run supports failed run with zero proposals', async () => {
  const pool = await resetDatabase();
  const input = command({
    status: 'failed',
    failureCode: 'PROVIDER_ERROR',
    proposals: [],
  });

  const result = await recordAiDiscoveryRun(pool, input);
  assert.equal(result.status, 'failed');
  assert.equal(result.proposalCount, 0);
  assert.equal(await tableCount(pool, 'ai_candidate_proposals'), 0);
  await pool.end();
});

test('record AI discovery run exact replay is duplicate-noop', async () => {
  const pool = await resetDatabase();
  const input = command();

  const first = await recordAiDiscoveryRun(pool, input);
  const second = await recordAiDiscoveryRun(pool, input);

  assert.equal(first.replayed, false);
  assert.equal(second.replayed, true);
  assert.equal(await tableCount(pool, 'ai_discovery_runs'), 1);
  assert.equal(await tableCount(pool, 'ai_candidate_proposals'), 2);
  assert.equal(await tableCount(pool, 'audit_events'), 1);
  assert.equal(await tableCount(pool, 'outbox_events'), 1);
  await pool.end();
});

test('record AI discovery run rejects idempotency and run-key conflicts without partial writes', async () => {
  const pool = await resetDatabase();
  const original = command();
  await recordAiDiscoveryRun(pool, original);

  await assert.rejects(
    recordAiDiscoveryRun(pool, {
      ...original,
      outputHash: 'c'.repeat(64),
    }),
    /IDEMPOTENCY_PAYLOAD_CONFLICT/,
  );

  await assert.rejects(
    recordAiDiscoveryRun(pool, command({
      runKey: original.runKey,
      outputHash: 'd'.repeat(64),
    })),
    /AI_DISCOVERY_RUN_CONFLICT/,
  );

  assert.equal(await tableCount(pool, 'ai_discovery_runs'), 1);
  assert.equal(await tableCount(pool, 'ai_candidate_proposals'), 2);
  assert.equal(await tableCount(pool, 'audit_events'), 1);
  assert.equal(await tableCount(pool, 'outbox_events'), 1);
  await pool.end();
});
