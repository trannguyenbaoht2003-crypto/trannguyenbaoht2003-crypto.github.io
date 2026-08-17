import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { materializeAiCandidateProposal } from '../src/modules/ai-discovery/materialize-ai-candidate-proposal.js';
import { recordAiDiscoveryRun } from '../src/modules/ai-discovery/record-ai-discovery-run.js';
import type {
  MaterializeAiCandidateProposalCommand,
  RecordAiDiscoveryRunCommand,
} from '../src/modules/ai-discovery/types.js';
import { activateSourcePolicy } from '../src/modules/source-policy/activate-source-policy.js';
import { seedActiveCatalog } from './helpers/catalog.js';
import { resetDatabase, tableCount } from './helpers/database.js';

function runCommand(
  proposalId: string,
  runKey = `run-${randomUUID()}`,
  overrides: Partial<RecordAiDiscoveryRunCommand['proposals'][number]> = {},
): RecordAiDiscoveryRunCommand {
  return {
    actorId: 'ai-discovery-materialization-test',
    aiDiscoveryRunId: randomUUID(),
    correlationId: `record-${randomUUID()}`,
    idempotencyKey: `record-${randomUUID()}`,
    runKey,
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
      ...overrides,
    }],
  };
}

function materializeCommand(
  proposalId: string,
  overrides: Partial<MaterializeAiCandidateProposalCommand> = {},
): MaterializeAiCandidateProposalCommand {
  return {
    actorId: 'ai-materializer',
    aiCandidateMaterializationId: randomUUID(),
    aiCandidateProposalId: proposalId,
    correlationId: `materialize-${randomUUID()}`,
    idempotencyKey: `materialize-${randomUUID()}`,
    reason: 'operator selected proposal for governed candidate review',
    materializedAt: '2026-08-17T05:01:00.000Z',
    ...overrides,
  };
}

test('materialize AI candidate proposal enters Candidate Registry with ai_generated provenance', async () => {
  const pool = await resetDatabase();
  await seedActiveCatalog(pool);
  const proposalId = randomUUID();
  await recordAiDiscoveryRun(pool, runCommand(proposalId));
  const beforeAudit = await tableCount(pool, 'audit_events');
  const beforeOutbox = await tableCount(pool, 'outbox_events');

  const result = await materializeAiCandidateProposal(pool, materializeCommand(proposalId));

  assert.equal(result.aiCandidateProposalId, proposalId);
  assert.equal(result.reusedCanonicalGraph, false);
  assert.equal(result.replayed, false);
  assert.equal(await tableCount(pool, 'ai_candidate_materializations'), 1);
  assert.equal(await tableCount(pool, 'raw_observations'), 1);
  assert.equal(await tableCount(pool, 'normalized_observations'), 1);
  assert.equal(await tableCount(pool, 'candidates'), 1);
  assert.equal(await tableCount(pool, 'candidate_revisions'), 1);
  assert.equal(await tableCount(pool, 'candidate_provenance'), 1);

  const graph = await pool.query<{
    adapter_version: string;
    content_hash: string;
    origin: string;
    raw_blob: string | null;
    source_key: string;
  }>(
    `select raw.adapter_version,
            raw.content_hash,
            raw.raw_blob,
            source.source_key,
            provenance.origin
       from ai_candidate_materializations materialization
       join raw_observations raw
         on raw.raw_observation_id = materialization.raw_observation_id
       join sources source on source.source_id = raw.source_id
       join candidate_provenance provenance
         on provenance.candidate_provenance_id = materialization.candidate_provenance_id
      where materialization.ai_candidate_proposal_id = $1`,
    [proposalId],
  );
  assert.equal(graph.rows[0]?.adapter_version, 'ai-discovery-proposal-v1');
  assert.equal(graph.rows[0]?.origin, 'ai_generated');
  assert.equal(graph.rows[0]?.raw_blob, null);
  assert.equal(graph.rows[0]?.source_key, 'ai-discovery');
  assert.match(graph.rows[0]?.content_hash ?? '', /^[a-f0-9]{64}$/u);
  assert.equal(await tableCount(pool, 'audit_events'), beforeAudit + 2);
  assert.equal(await tableCount(pool, 'outbox_events'), beforeOutbox + 2);
  await pool.end();
});

test('materialize AI candidate proposal exact retry is a duplicate-noop', async () => {
  const pool = await resetDatabase();
  await seedActiveCatalog(pool);
  const proposalId = randomUUID();
  await recordAiDiscoveryRun(pool, runCommand(proposalId));
  const command = materializeCommand(proposalId);

  const first = await materializeAiCandidateProposal(pool, command);
  const counts = {
    raw: await tableCount(pool, 'raw_observations'),
    normalized: await tableCount(pool, 'normalized_observations'),
    provenance: await tableCount(pool, 'candidate_provenance'),
    materializations: await tableCount(pool, 'ai_candidate_materializations'),
    audit: await tableCount(pool, 'audit_events'),
    outbox: await tableCount(pool, 'outbox_events'),
  };
  const replay = await materializeAiCandidateProposal(pool, command);

  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  assert.equal(replay.rawObservationId, first.rawObservationId);
  assert.equal(replay.normalizedObservationId, first.normalizedObservationId);
  assert.deepEqual({
    raw: await tableCount(pool, 'raw_observations'),
    normalized: await tableCount(pool, 'normalized_observations'),
    provenance: await tableCount(pool, 'candidate_provenance'),
    materializations: await tableCount(pool, 'ai_candidate_materializations'),
    audit: await tableCount(pool, 'audit_events'),
    outbox: await tableCount(pool, 'outbox_events'),
  }, counts);
  await pool.end();
});

test('identical AI proposal selections converge to one canonical AI graph', async () => {
  const pool = await resetDatabase();
  await seedActiveCatalog(pool);
  const firstProposalId = randomUUID();
  const secondProposalId = randomUUID();
  await recordAiDiscoveryRun(pool, runCommand(firstProposalId));
  await recordAiDiscoveryRun(pool, runCommand(secondProposalId));

  const first = await materializeAiCandidateProposal(pool, materializeCommand(firstProposalId));
  const second = await materializeAiCandidateProposal(pool, materializeCommand(secondProposalId));

  assert.equal(first.reusedCanonicalGraph, false);
  assert.equal(second.reusedCanonicalGraph, true);
  assert.equal(second.rawObservationId, first.rawObservationId);
  assert.equal(second.normalizedObservationId, first.normalizedObservationId);
  assert.equal(second.candidateProvenanceId, first.candidateProvenanceId);
  assert.equal(second.candidateId, first.candidateId);
  assert.equal(second.candidateRevisionId, first.candidateRevisionId);
  assert.equal(await tableCount(pool, 'raw_observations'), 1);
  assert.equal(await tableCount(pool, 'normalized_observations'), 1);
  assert.equal(await tableCount(pool, 'candidate_provenance'), 1);
  assert.equal(await tableCount(pool, 'ai_candidate_materializations'), 2);
  await pool.end();
});

test('invalid AI proposal catalog selection rolls back synthetic observation and linkage', async () => {
  const pool = await resetDatabase();
  await seedActiveCatalog(pool);
  const proposalId = randomUUID();
  await recordAiDiscoveryRun(pool, runCommand(proposalId, undefined, {
    itemExternalIds: ['3006', 'missing-item'],
  }));
  const beforeAudit = await tableCount(pool, 'audit_events');
  const beforeOutbox = await tableCount(pool, 'outbox_events');

  await assert.rejects(
    materializeAiCandidateProposal(pool, materializeCommand(proposalId)),
    /CATALOG_ENTITY_MISSING|NORMALIZATION_CATALOG_SELECTION_INVALID/,
  );
  assert.equal(await tableCount(pool, 'raw_observations'), 0);
  assert.equal(await tableCount(pool, 'normalized_observations'), 0);
  assert.equal(await tableCount(pool, 'candidate_provenance'), 0);
  assert.equal(await tableCount(pool, 'ai_candidate_materializations'), 0);
  assert.equal(await tableCount(pool, 'audit_events'), beforeAudit);
  assert.equal(await tableCount(pool, 'outbox_events'), beforeOutbox);
  await pool.end();
});

test('materialization fails closed when reserved AI source policy is unsafe', async () => {
  const pool = await resetDatabase();
  await seedActiveCatalog(pool);
  const proposalId = randomUUID();
  await recordAiDiscoveryRun(pool, runCommand(proposalId));
  const source = await pool.query<{ source_id: string }>(
    `select source_id from sources where source_key='ai-discovery'`,
  );
  const sourceId = source.rows[0]?.source_id;
  assert.ok(sourceId);
  await activateSourcePolicy(pool, {
    actorId: 'unsafe-policy-test',
    collectorEnabled: true,
    correlationId: 'unsafe-ai-policy',
    reason: 'test unsafe change',
    revision: 2,
    revisionId: randomUUID(),
    sourceId,
    storagePermission: 'blob_allowed',
  });

  await assert.rejects(
    materializeAiCandidateProposal(pool, materializeCommand(proposalId)),
    /AI_DISCOVERY_RESERVED_POLICY_UNSAFE/,
  );
  assert.equal(await tableCount(pool, 'raw_observations'), 0);
  assert.equal(await tableCount(pool, 'ai_candidate_materializations'), 0);
  await pool.end();
});
