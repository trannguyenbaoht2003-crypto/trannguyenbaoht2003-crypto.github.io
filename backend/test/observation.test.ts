import assert from 'node:assert/strict';
import test from 'node:test';

import { ingestObservation } from '../src/modules/collector/ingest-observation.js';
import { activateSourcePolicy } from '../src/modules/source-policy/activate-source-policy.js';
import { resetDatabase, tableCount } from './helpers/database.js';

async function seedPolicy(storagePermission: 'blob_allowed' | 'reference_only' | 'prohibited') {
  const pool = await resetDatabase();
  await pool.query(`
    insert into sources (source_id, source_key, display_name)
    values ('30000000-0000-4000-8000-000000000001', 'collector-test', 'Collector test')
  `);
  await activateSourcePolicy(pool, {
    actorId: 'operator',
    collectorEnabled: true,
    correlationId: 'policy-correlation',
    reason: 'test policy',
    revision: 1,
    revisionId: '30000000-0000-4000-8000-000000000002',
    sourceId: '30000000-0000-4000-8000-000000000001',
    storagePermission,
  });
  await pool.query('truncate audit_events, outbox_events');
  return pool;
}

function command() {
  return {
    actorId: 'collector',
    adapterVersion: 'collector-test@1',
    collectedAt: new Date('2026-07-23T01:00:00Z'),
    correlationId: 'observation-correlation',
    externalReference: { url: 'https://example.invalid/public' },
    idempotencyKey: 'observation-key-1',
    observationId: '30000000-0000-4000-8000-000000000003',
    rawBlob: 'public metadata body',
    sourceId: '30000000-0000-4000-8000-000000000001',
  };
}

test('reference-only policy never stores a raw blob', async () => {
  const pool = await seedPolicy('reference_only');
  const result = await ingestObservation(pool, command());
  const stored = await pool.query<{ raw_blob: string | null }>(
    'select raw_blob from raw_observations',
  );
  assert.equal(result.blobStored, false);
  assert.equal(stored.rows[0]?.raw_blob, null);
  await pool.end();
});

test('same idempotency key and payload replays without duplicate side effects', async () => {
  const pool = await seedPolicy('blob_allowed');
  const first = await ingestObservation(pool, command());
  const replay = await ingestObservation(pool, command());
  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  assert.equal(await tableCount(pool, 'raw_observations'), 1);
  assert.equal(await tableCount(pool, 'audit_events'), 1);
  assert.equal(await tableCount(pool, 'outbox_events'), 1);
  await pool.end();
});

test('same idempotency key with a different payload is rejected', async () => {
  const pool = await seedPolicy('blob_allowed');
  await ingestObservation(pool, command());
  await assert.rejects(
    ingestObservation(pool, { ...command(), rawBlob: 'different body' }),
    /IDEMPOTENCY_PAYLOAD_CONFLICT/,
  );
  assert.equal(await tableCount(pool, 'raw_observations'), 1);
  await pool.end();
});

test('prohibited policy rejects ingest without side effects', async () => {
  const pool = await seedPolicy('prohibited');
  await assert.rejects(ingestObservation(pool, command()), /SOURCE_POLICY_PROHIBITS_INGEST/);
  assert.equal(await tableCount(pool, 'raw_observations'), 0);
  assert.equal(await tableCount(pool, 'audit_events'), 0);
  assert.equal(await tableCount(pool, 'outbox_events'), 0);
  assert.equal(await tableCount(pool, 'idempotency_records'), 0);
  await pool.end();
});
