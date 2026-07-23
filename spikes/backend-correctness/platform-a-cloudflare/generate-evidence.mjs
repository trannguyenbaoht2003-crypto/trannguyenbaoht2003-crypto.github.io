import path from 'node:path';
import { buildEvidenceBundle } from '../common/build-evidence-bundle.mjs';
import { createCloudflareAdapter, PLATFORM_A_METADATA } from './adapter.mjs';

const outputDir = path.resolve('spikes/backend-correctness/platform-a-cloudflare/evidence-v2');
const adapter = await createCloudflareAdapter({ mode: 'local-test' });
try {
  await buildEvidenceBundle({
    adapter,
    metadata: PLATFORM_A_METADATA,
    runtimeVersions: { node: process.version, compatibilityDate: '2026-05-22', runtime: 'Miniflare/workerd' },
    outputDir,
    title: 'Platform A Correctness Summary v2',
  });
} finally {
  await adapter.close();
}
