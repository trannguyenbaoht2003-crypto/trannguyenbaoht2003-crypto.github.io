import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { materializeAiCandidateProposal } from '../src/modules/ai-discovery/materialize-ai-candidate-proposal.js';
import { recordAiDiscoveryRun } from '../src/modules/ai-discovery/record-ai-discovery-run.js';
import { evaluateCandidateEligibility } from '../src/modules/eligibility/evaluate-candidate-eligibility.js';
import { seedActiveCatalog } from './helpers/catalog.js';
import { resetDatabase, tableCount } from './helpers/database.js';

test('AI run, proposal, and materialization alone cannot satisfy Eligibility authority', async () => {
  const pool = await resetDatabase();
  await seedActiveCatalog(pool);
  const proposalId = randomUUID();
  await recordAiDiscoveryRun(pool, {
    actorId: 'ai-safety-test',
    aiDiscoveryRunId: randomUUID(),
    correlationId: 'ai-safety-record',
    idempotencyKey: 'ai-safety-record',
    runKey: 'ai-safety-run',
    providerKey: 'fixture-provider',
    modelKey: 'fixture-model',
    modelRevision: 'r1',
    promptTemplateKey: 'aram-discovery',
    promptTemplateVersion: 1,
    inputHash: 'a'.repeat(64),
    outputHash: 'b'.repeat(64),
    status: 'completed',
    startedAt: '2026-08-17T05:00:00.000Z',
    completedAt: '2026-08-17T05:00:01.000Z',
    failureCode: null,
    proposals: [{
      aiCandidateProposalId: proposalId,
      ordinal: 0,
      patchKey: '26.15',
      gameModeExternalId: 'aram_mayhem',
      subjectExternalId: 'samira',
      augmentExternalIds: ['1194'],
      itemExternalIds: ['3006', '6672'],
      rationale: 'advisory only',
    }],
  });
  const materialized = await materializeAiCandidateProposal(pool, {
    actorId: 'ai-safety-test',
    aiCandidateMaterializationId: randomUUID(),
    aiCandidateProposalId: proposalId,
    correlationId: 'ai-safety-materialize',
    idempotencyKey: 'ai-safety-materialize',
    reason: 'eligibility safety fixture',
    materializedAt: '2026-08-17T05:01:00.000Z',
  });

  await assert.rejects(
    evaluateCandidateEligibility(pool, {
      actorId: 'ai-safety-evaluator',
      candidateId: materialized.candidateId,
      candidateRevisionId: materialized.candidateRevisionId,
      correlationId: 'ai-safety-eligibility',
      evaluatedAt: '2026-08-17T05:02:00.000Z',
      evaluationId: randomUUID(),
      idempotencyKey: 'ai-safety-eligibility',
      inputSnapshotId: randomUUID(),
    }),
    /ELIGIBILITY_POLICY_NOT_ACTIVE/,
  );
  assert.equal(await tableCount(pool, 'candidate_eligibility_evaluations'), 0);
  assert.equal(await tableCount(pool, 'current_candidate_eligibility_evaluations'), 0);
  await pool.end();
});
