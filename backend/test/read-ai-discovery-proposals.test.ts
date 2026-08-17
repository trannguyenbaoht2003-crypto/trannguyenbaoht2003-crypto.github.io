import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { materializeAiCandidateProposal } from '../src/modules/ai-discovery/materialize-ai-candidate-proposal.js';
import { readAiDiscoveryProposals } from '../src/modules/ai-discovery/read-ai-discovery-proposals.js';
import { recordAiDiscoveryRun } from '../src/modules/ai-discovery/record-ai-discovery-run.js';
import { seedActiveCatalog } from './helpers/catalog.js';
import { resetDatabase } from './helpers/database.js';

function run(proposalId: string, runKey: string, completedAt: string) {
  return {
    actorId: 'ai-reader-test',
    aiDiscoveryRunId: randomUUID(),
    correlationId: `reader-${randomUUID()}`,
    idempotencyKey: `reader-${randomUUID()}`,
    runKey,
    providerKey: 'fixture-provider',
    modelKey: 'fixture-model',
    modelRevision: 'r1',
    promptTemplateKey: 'aram-discovery',
    promptTemplateVersion: 1,
    inputHash: 'a'.repeat(64),
    outputHash: 'b'.repeat(64),
    status: 'completed' as const,
    startedAt: '2026-08-17T05:00:00.000Z',
    completedAt,
    failureCode: null,
    proposals: [{
      aiCandidateProposalId: proposalId,
      ordinal: 0,
      patchKey: '26.15',
      gameModeExternalId: 'aram_mayhem' as const,
      subjectExternalId: 'samira',
      augmentExternalIds: ['1194'],
      itemExternalIds: ['3006', '6672'],
      rationale: `detail-${runKey}`,
    }],
  };
}

test('AI discovery proposal reader defaults to pending and supports materialized/all filters', async () => {
  const pool = await resetDatabase();
  await seedActiveCatalog(pool);
  const materializedProposalId = randomUUID();
  const pendingProposalId = randomUUID();
  await recordAiDiscoveryRun(pool, run(materializedProposalId, 'older-run', '2026-08-17T05:00:01.000Z'));
  await recordAiDiscoveryRun(pool, run(pendingProposalId, 'newer-run', '2026-08-17T05:10:01.000Z'));
  await materializeAiCandidateProposal(pool, {
    actorId: 'ai-reader-test',
    aiCandidateMaterializationId: randomUUID(),
    aiCandidateProposalId: materializedProposalId,
    correlationId: 'reader-materialize',
    idempotencyKey: 'reader-materialize',
    reason: 'reader fixture',
    materializedAt: '2026-08-17T05:11:00.000Z',
  });

  const pending = await readAiDiscoveryProposals(pool);
  assert.equal(pending.length, 1);
  assert.equal(pending[0]?.aiCandidateProposalId, pendingProposalId);
  assert.equal(pending[0]?.materialized, false);

  const materialized = await readAiDiscoveryProposals(pool, { materialization: 'materialized' });
  assert.equal(materialized.length, 1);
  assert.equal(materialized[0]?.aiCandidateProposalId, materializedProposalId);
  assert.equal(materialized[0]?.materialized, true);
  assert.ok(materialized[0]?.candidateRevisionId);

  const all = await readAiDiscoveryProposals(pool, { materialization: 'all', limit: 10 });
  assert.deepEqual(
    all.map((entry) => entry.runKey),
    ['newer-run', 'older-run'],
  );
  await pool.end();
});

test('AI discovery proposal reader rejects invalid options', async () => {
  const pool = await resetDatabase();
  await assert.rejects(readAiDiscoveryProposals(pool, { limit: 0 }), /AI_DISCOVERY_READ_OPTIONS_INVALID/);
  await assert.rejects(
    readAiDiscoveryProposals(pool, { materialization: 'unknown' as 'pending' }),
    /AI_DISCOVERY_READ_OPTIONS_INVALID/,
  );
  await pool.end();
});
