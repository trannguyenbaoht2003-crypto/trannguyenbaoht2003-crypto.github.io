import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import {
  normalizeAiDiscoveryRunCommand,
  proposalHash,
  proposalNormalizationSnapshot,
} from '../src/modules/ai-discovery/normalize-ai-discovery-input.js';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

function proposal() {
  return {
    aiCandidateProposalId: randomUUID(),
    ordinal: 0,
    patchKey: '26.17',
    gameModeExternalId: 'aram_mayhem' as const,
    subjectExternalId: 'samira',
    augmentExternalIds: ['1194', '2001'],
    itemExternalIds: ['3006', '6672'],
    rationale: 'untrusted explanation',
  };
}

function command() {
  return {
    actorId: 'ai-discovery-test',
    aiDiscoveryRunId: randomUUID(),
    correlationId: 'corr-ai-discovery-test',
    idempotencyKey: 'idem-ai-discovery-test',
    runKey: 'run-26.17-001',
    providerKey: 'fixture-provider',
    modelKey: 'fixture-model',
    modelRevision: 'r1',
    promptTemplateKey: 'aram-discovery',
    promptTemplateVersion: 1,
    inputHash: SHA_A,
    outputHash: SHA_B,
    status: 'completed' as const,
    startedAt: '2026-08-17T05:00:00.000Z',
    completedAt: '2026-08-17T05:00:01.000Z',
    failureCode: null,
    proposals: [proposal()],
  };
}

test('AI discovery proposal hash depends only on canonical selection identity', () => {
  const first = proposal();
  const second = {
    ...first,
    aiCandidateProposalId: randomUUID(),
    ordinal: 9,
    rationale: 'different rationale',
  };

  assert.equal(proposalHash(first), proposalHash(second));
  assert.notEqual(
    proposalHash(first),
    proposalHash({ ...second, itemExternalIds: ['3006', '6673'] }),
  );
});

test('AI discovery normalization produces ai_generated candidate snapshot', () => {
  const snapshot = proposalNormalizationSnapshot(proposal());
  assert.equal(snapshot.schemaVersion, 1);
  assert.equal(snapshot.origin, 'ai_generated');
  assert.equal(snapshot.gameModeExternalId, 'aram_mayhem');
  assert.deepEqual(snapshot.augmentExternalIds, ['1194', '2001']);
  assert.deepEqual(snapshot.itemExternalIds, ['3006', '6672']);
});

test('AI discovery normalization rejects unsafe or noncanonical input', () => {
  assert.throws(
    () => normalizeAiDiscoveryRunCommand({
      ...command(),
      proposals: [{ ...proposal(), itemExternalIds: ['6672', '3006'] }],
    }),
    /AI_DISCOVERY_PROPOSAL_SELECTION_INVALID/,
  );
  assert.throws(
    () => normalizeAiDiscoveryRunCommand({
      ...command(),
      status: 'failed',
      failureCode: 'PROVIDER_ERROR',
      proposals: [proposal()],
    }),
    /AI_DISCOVERY_FAILED_RUN_PROPOSALS_FORBIDDEN/,
  );
  assert.throws(
    () => normalizeAiDiscoveryRunCommand({
      ...command(),
      inputHash: 'not-a-sha',
    }),
    /AI_DISCOVERY_HASH_INVALID/,
  );
});
