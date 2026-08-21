import { createHash } from 'node:crypto';

import type { AiProviderAttemptOrdinal } from './types.js';

const NAMESPACE_HEX = '6f0b8b9b3f6a5f76a5c9c714ca6a08e1';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function formatUuid(bytes: Buffer): string {
  const hex = bytes.toString('hex');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}

export function deterministicAiProviderClientRequestId(
  executionId: string,
  ordinal: AiProviderAttemptOrdinal,
): string {
  if (!UUID_PATTERN.test(executionId) || ![1,2,3].includes(ordinal)) {
    throw new Error('AI_PROVIDER_EXECUTION_IDENTITY_INVALID');
  }
  const namespace = Buffer.from(NAMESPACE_HEX, 'hex');
  const digest = createHash('sha1')
    .update(namespace)
    .update(Buffer.from(`${executionId.toLowerCase()}:${ordinal}`, 'utf8'))
    .digest();
  const bytes = Buffer.from(digest.subarray(0,16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  return formatUuid(bytes);
}
