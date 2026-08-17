import { createHash } from 'node:crypto';

import {
  FEEDBACK_REASON_CODES,
  type FeedbackReasonCode,
  type NormalizedFeedbackInput,
} from './types.js';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;
const URL_LIKE_PATTERN = /(?:https?:\/\/|www\.)/iu;
const ALLOWED_KEYS = new Set([
  'schemaVersion',
  'submissionId',
  'publicationVersionId',
  'reasonCode',
  'details',
]);
const REASON_CODES = new Set<string>(FEEDBACK_REASON_CODES);

function requireRecord(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Invalid feedback payload');
  }
  const record = input as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!ALLOWED_KEYS.has(key)) {
      throw new Error('Invalid feedback payload property');
    }
  }
  return record;
}

function requireUuid(value: unknown, field: 'submission' | 'version'): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new Error(`Invalid ${field} id`);
  }
  return value.toLowerCase();
}

function requireReasonCode(value: unknown): FeedbackReasonCode {
  if (typeof value !== 'string' || !REASON_CODES.has(value)) {
    throw new Error('Invalid feedback reason code');
  }
  return value as FeedbackReasonCode;
}

function normalizeDetails(value: unknown, reasonCode: FeedbackReasonCode): string | null {
  if (value === undefined || value === null) {
    if (reasonCode === 'OTHER') throw new Error('OTHER feedback requires details');
    return null;
  }
  if (typeof value !== 'string') throw new Error('Invalid feedback details');
  if (CONTROL_CHARACTER_PATTERN.test(value)) throw new Error('Invalid feedback details');

  const normalized = value.normalize('NFC').trim().replace(/\s+/gu, ' ');
  const length = Array.from(normalized).length;
  if (length === 0) {
    if (reasonCode === 'OTHER') throw new Error('OTHER feedback requires details');
    return null;
  }
  if (length > 280 || URL_LIKE_PATTERN.test(normalized)) {
    throw new Error('Invalid feedback details');
  }
  return normalized;
}

export function normalizeFeedbackInput(input: unknown): NormalizedFeedbackInput {
  const record = requireRecord(input);
  if (record.schemaVersion !== 1) throw new Error('Unsupported feedback schema version');

  const reasonCode = requireReasonCode(record.reasonCode);
  return {
    schemaVersion: 1,
    submissionId: requireUuid(record.submissionId, 'submission'),
    publicationVersionId: requireUuid(record.publicationVersionId, 'version'),
    reasonCode,
    details: normalizeDetails(record.details, reasonCode),
  };
}

export function hashFeedbackRequest(
  publicationId: string,
  input: NormalizedFeedbackInput,
): string {
  if (!UUID_PATTERN.test(publicationId)) throw new Error('Invalid publication id');
  const canonical = JSON.stringify({
    schemaVersion: 1,
    publicationId: publicationId.toLowerCase(),
    publicationVersionId: input.publicationVersionId,
    reasonCode: input.reasonCode,
    details: input.details,
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}
