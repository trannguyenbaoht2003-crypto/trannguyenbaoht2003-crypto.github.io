import test from 'node:test';
import assert from 'node:assert/strict';
import { assertAdapterContract } from '../common/scenarios.mjs';
import { createCloudflareAdapter, PLATFORM_A_METADATA } from './adapter.mjs';

test('Platform A identifies the locked Cloudflare spike stack', () => {
  assert.deepEqual(PLATFORM_A_METADATA, {
    platform: 'cloudflare-worker-d1-queues',
    commonHarnessSha: 'dc8deebb478cc5892304662e14dbf8b07ecd1627',
    remoteResourcesAllowed: false,
    productionDeploymentAllowed: false,
  });
});

test('Platform A implements the complete common adapter contract', async () => {
  const adapter = await createCloudflareAdapter({ mode: 'local-test' });
  assert.equal(assertAdapterContract(adapter), true);
  await adapter.close?.();
});

test('Platform A runs D1 and Queues locally with idempotent delivery', async () => {
  const adapter = await createCloudflareAdapter({ mode: 'local-test' });
  try {
    await adapter.resetEnvironment();
    assert.deepEqual(await adapter.snapshotState(), {
      outboxEvents: 0,
      consumerEffects: 0,
      deliveredOutboxEvents: 0,
      idempotencyRecords: 0,
    });

    await adapter.executeCommand({
      type: 'record_outbox_event',
      idempotencyKey: 'smoke-record-0001',
      eventId: 'event-0001',
      eventType: 'PlatformASmokeTest',
      payload: { candidateId: 'candidate-000001' },
    });

    await adapter.dispatchOutbox();
    await adapter.drainQueue();

    assert.deepEqual(await adapter.snapshotState(), {
      outboxEvents: 1,
      consumerEffects: 1,
      deliveredOutboxEvents: 1,
      idempotencyRecords: 1,
    });

    await adapter.executeCommand({
      type: 'redeliver_event',
      eventId: 'event-0001',
      eventType: 'PlatformASmokeTest',
      payload: { candidateId: 'candidate-000001' },
    });
    await adapter.drainQueue();

    const finalState = await adapter.snapshotState();
    assert.equal(finalState.consumerEffects, 1, 'duplicate queue delivery must not duplicate its side effect');
  } finally {
    await adapter.close?.();
  }
});

test('Platform A command idempotency replays the same payload and rejects conflicts', async () => {
  const adapter = await createCloudflareAdapter({ mode: 'local-test' });
  try {
    await adapter.resetEnvironment();
    const command = {
      type: 'record_outbox_event',
      idempotencyKey: 'record-event-key-0001',
      eventId: 'event-idempotent-0001',
      eventType: 'IdempotencyTest',
      payload: { claimId: 'claim-000001' },
    };

    const first = await adapter.executeCommand(command);
    const replay = await adapter.executeCommand(command);
    assert.equal(first.replayed, false);
    assert.equal(replay.replayed, true);
    assert.equal((await adapter.snapshotState()).outboxEvents, 1);
    assert.equal((await adapter.snapshotState()).idempotencyRecords, 1);

    await assert.rejects(
      adapter.executeCommand({ ...command, eventId: 'event-idempotent-0002' }),
      /IDEMPOTENCY_PAYLOAD_CONFLICT/,
    );
    assert.equal((await adapter.snapshotState()).outboxEvents, 1);
  } finally {
    await adapter.close?.();
  }
});
