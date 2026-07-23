import path from 'node:path';
import { buildEvidenceBundle } from '../common/build-evidence-bundle.mjs';
import { createPostgresBullmqAdapter, PLATFORM_B_METADATA } from './adapter.mjs';

const outputDir = path.resolve('spikes/backend-correctness/platform-b-postgres-bullmq/evidence-v2');
const adapter = await createPostgresBullmqAdapter({ mode: 'local-test' });
try {
  await buildEvidenceBundle({
    adapter,
    metadata: PLATFORM_B_METADATA,
    runtimeVersions: { node: process.version, fastify: '5', postgresql: '17', bullmq: '5', redis: '7' },
    outputDir,
    title: 'Platform B Correctness Summary v2',
  });
} finally {
  await adapter.close();
}
