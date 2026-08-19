import { createHash } from 'node:crypto';

import { hashCanonicalJson } from '../../shared/hash.js';
import type {
  ScheduledAiDiscoveryContentV1,
  ScheduledAiDiscoveryIdentity,
} from './types.js';

const SCHEDULED_RUN_NAMESPACE = '3d0f4c4e-5b7a-5c4d-8f5e-7cc2f6968d01';
const UUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

function uuidBytes(value: string): Buffer {
  if (!UUID_TEXT.test(value)) throw new Error('AI_AUTOMATION_UUID_NAMESPACE_INVALID');
  return Buffer.from(value.replaceAll('-', ''), 'hex');
}

function formatUuid(bytes: Buffer): string {
  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
}

export function deterministicScheduledRunUuid(scheduledContentHash: string): string {
  if (!/^[a-f0-9]{64}$/u.test(scheduledContentHash)) {
    throw new Error('AI_AUTOMATION_CONTENT_HASH_INVALID');
  }
  const digest = createHash('sha1')
    .update(uuidBytes(SCHEDULED_RUN_NAMESPACE))
    .update(Buffer.from(scheduledContentHash, 'utf8'))
    .digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  return formatUuid(bytes).toLowerCase();
}

export function deriveScheduledAiDiscoveryIdentity(
  content: ScheduledAiDiscoveryContentV1,
): ScheduledAiDiscoveryIdentity {
  const scheduledContentHash = hashCanonicalJson({
    patchKey: content.patchKey,
    gameModeExternalId: content.gameModeExternalId,
    subjects: content.subjects,
  });
  return {
    scheduledContentHash,
    runKey: `scheduled:v1:${scheduledContentHash}`,
    idempotencyKey: `ai-discovery-scheduled:v1:${scheduledContentHash}`,
    aiDiscoveryRunId: deterministicScheduledRunUuid(scheduledContentHash),
  };
}
