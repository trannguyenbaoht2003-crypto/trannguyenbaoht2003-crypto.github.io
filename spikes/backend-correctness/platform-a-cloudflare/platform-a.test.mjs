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
    });

    await adapter.executeCommand({
      type: 'record_outbox_event',
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
