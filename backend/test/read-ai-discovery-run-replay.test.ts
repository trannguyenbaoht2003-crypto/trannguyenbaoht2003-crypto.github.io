import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { readAiDiscoveryRunReplay } from '../src/modules/ai-discovery/read-ai-discovery-run-replay.js';
import { recordAiDiscoveryRun } from '../src/modules/ai-discovery/record-ai-discovery-run.js';
import type { RecordAiDiscoveryRunCommand } from '../src/modules/ai-discovery/types.js';
import { resetDatabase } from './helpers/database.js';

const INPUT_HASH = 'a'.repeat(64);
const OUTPUT_HASH = 'b'.repeat(64);

function command(overrides: Partial<RecordAiDiscoveryRunCommand> = {}): RecordAiDiscoveryRunCommand {
  return {
    actorId: 'operator-replay-test',
    aiDiscoveryRunId: randomUUID(),
    correlationId: `corr-${randomUUID()}`,
    idempotencyKey: `idem-${randomUUID()}`,
    runKey: `run-${randomUUID()}`,
    providerKey: 'openai',
    modelKey: 'fixture-model',
    modelRevision: 'fixture-model-r1',
    promptTemplateKey: 'aram-mayhem-discovery',
    promptTemplateVersion: 1,
    inputHash: INPUT_HASH,
    outputHash: OUTPUT_HASH,
    status: 'completed',
    startedAt: '2026-08-17T05:00:00.000Z',
    completedAt: '2026-08-17T05:00:05.000Z',
    failureCode: null,
    proposals: [{
      aiCandidateProposalId: randomUUID(),
      ordinal: 0,
      patchKey: '26.17',
      gameModeExternalId: 'aram_mayhem',
      subjectExternalId: 'samira',
      augmentExternalIds: ['1194'],
      itemExternalIds: ['3006'],
      rationale: 'advisory only',
    }],
    ...overrides,
  };
}

function identity(input: RecordAiDiscoveryRunCommand) {
  return {
    actorId: input.actorId,
    aiDiscoveryRunId: input.aiDiscoveryRunId,
    correlationId: input.correlationId,
    idempotencyKey: input.idempotencyKey,
    runKey: input.runKey,
    providerKey: input.providerKey,
    modelKey: input.modelKey,
    modelRevision: input.modelRevision,
    promptTemplateKey: input.promptTemplateKey,
    promptTemplateVersion: input.promptTemplateVersion,
    inputHash: input.inputHash,
    startedAt: input.startedAt,
  };
}

test('AI discovery replay preflight returns null before any matching authority exists', async () => {
  const pool = await resetDatabase();
  const input = command();
  assert.equal(await readAiDiscoveryRunReplay(pool, identity(input)), null);
  await pool.end();
});

test('AI discovery replay preflight returns completed durable result without re-execution', async () => {
  const pool = await resetDatabase();
  const input = command();
  const fresh = await recordAiDiscoveryRun(pool, input);

  const replay = await readAiDiscoveryRunReplay(pool, identity(input));

  assert.deepEqual(replay, { ...fresh, replayed: true });
  await pool.end();
});

test('AI discovery replay preflight rejects a reused idempotency key whose static command identity changed', async () => {
  const pool = await resetDatabase();
  const input = command();
  await recordAiDiscoveryRun(pool, input);

  await assert.rejects(
    readAiDiscoveryRunReplay(pool, {
      ...identity(input),
      modelRevision: 'different-model-revision',
    }),
    /IDEMPOTENCY_PAYLOAD_CONFLICT/,
  );
  await assert.rejects(
    readAiDiscoveryRunReplay(pool, {
      ...identity(input),
      actorId: 'different-operator',
    }),
    /IDEMPOTENCY_PAYLOAD_CONFLICT/,
  );
  await pool.end();
});

test('AI discovery replay preflight rejects an in-progress idempotency record before provider execution', async () => {
  const pool = await resetDatabase();
  const input = command();
  await pool.query(
    `insert into idempotency_records (scope, idempotency_key, payload_hash, state)
     values ('ai.discovery.run.record', $1, $2, 'in_progress')`,
    [input.idempotencyKey, 'c'.repeat(64)],
  );

  await assert.rejects(
    readAiDiscoveryRunReplay(pool, identity(input)),
    /IDEMPOTENCY_OPERATION_IN_PROGRESS/,
  );
  await pool.end();
});

test('AI discovery replay preflight rejects an existing run identity paired with a new idempotency key', async () => {
  const pool = await resetDatabase();
  const input = command();
  await recordAiDiscoveryRun(pool, input);

  await assert.rejects(
    readAiDiscoveryRunReplay(pool, {
      ...identity(input),
      idempotencyKey: `new-idem-${randomUUID()}`,
    }),
    /AI_DISCOVERY_RUN_CONFLICT/,
  );
  await pool.end();
});
