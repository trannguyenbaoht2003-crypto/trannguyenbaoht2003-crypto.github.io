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
    const empty = await adapter.snapshotState();
    assert.equal(empty.outboxEvents, 0);
    assert.equal(empty.consumerEffects, 0);
    assert.equal(empty.deliveredOutboxEvents, 0);

    await adapter.executeCommand({
      type: 'activate_source_policy',
      policyId: 'policy-smoke',
      sourceId: 'source-smoke',
      revision: 1,
      storagePermission: 'reference_only',
      auditId: 'audit-smoke',
      eventId: 'event-smoke',
    });
    await adapter.dispatchOutbox();
    await adapter.drainQueue({ expectedEffects: 1 });

    const delivered = await adapter.snapshotState();
    assert.equal(delivered.outboxEvents, 1);
    assert.equal(delivered.consumerEffects, 1);
    assert.equal(delivered.deliveredOutboxEvents, 1);

    await adapter.executeCommand({
      type: 'redeliver_event',
      eventId: 'event-smoke',
      eventType: 'SourcePolicyActivated',
      payload: { policyId: 'policy-smoke' },
    });
    await adapter.drainQueue({ expectedEffects: 1 });
    assert.equal((await adapter.snapshotState()).consumerEffects, 1, 'duplicate queue delivery must not duplicate its side effect');
  } finally {
    await adapter.close?.();
  }
});
