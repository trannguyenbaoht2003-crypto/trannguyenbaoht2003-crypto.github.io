import assert from 'node:assert/strict';
import test from 'node:test';

import {
  hashFeedbackRequest,
  normalizeFeedbackInput,
} from '../src/modules/feedback/normalize-feedback-input.js';

const SUBMISSION_ID = '7b200000-0000-4000-8000-000000000001';
const VERSION_ID = '7b200000-0000-4000-8000-000000000002';
const PUBLICATION_ID = '7b200000-0000-4000-8000-000000000003';

function base(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    submissionId: SUBMISSION_ID,
    publicationVersionId: VERSION_ID,
    reasonCode: 'WRONG_ITEMS',
    ...overrides,
  };
}

test('normalizes bounded Vietnamese Unicode details deterministically', () => {
  const result = normalizeFeedbackInput(base({
    details: '  Sai   trang bị ở vòng cuối  ',
  }));

  assert.equal(result.details, 'Sai trang bị ở vòng cuối');
  assert.equal(result.reasonCode, 'WRONG_ITEMS');
  assert.equal(result.schemaVersion, 1);
});

test('normalizes omitted non-OTHER details to null', () => {
  assert.equal(normalizeFeedbackInput(base()).details, null);
});

test('OTHER requires a non-empty detail', () => {
  assert.throws(() => normalizeFeedbackInput(base({ reasonCode: 'OTHER' })), /details/i);
  assert.throws(
    () => normalizeFeedbackInput(base({ reasonCode: 'OTHER', details: '   ' })),
    /details/i,
  );
});

test('rejects oversized, control-character, and URL-like details', () => {
  assert.throws(() => normalizeFeedbackInput(base({ details: 'x'.repeat(281) })), /details/i);
  assert.throws(() => normalizeFeedbackInput(base({ details: 'sai\u0000item' })), /details/i);
  assert.throws(() => normalizeFeedbackInput(base({ details: 'xem https://example.com' })), /details/i);
  assert.throws(() => normalizeFeedbackInput(base({ details: 'HTTP://EXAMPLE.COM' })), /details/i);
  assert.throws(() => normalizeFeedbackInput(base({ details: 'www.example.com' })), /details/i);
});

test('rejects open shapes, unknown reasons, unsupported schema, and invalid UUIDs', () => {
  assert.throws(() => normalizeFeedbackInput(base({ extra: true })), /feedback/i);
  assert.throws(() => normalizeFeedbackInput(base({ reasonCode: 'NOPE' })), /reason/i);
  assert.throws(() => normalizeFeedbackInput(base({ schemaVersion: 2 })), /schema/i);
  assert.throws(() => normalizeFeedbackInput(base({ submissionId: 'not-a-uuid' })), /submission/i);
  assert.throws(() => normalizeFeedbackInput(base({ publicationVersionId: 'not-a-uuid' })), /version/i);
});

test('canonical request hash is stable after semantic normalization and changes with authority input', () => {
  const a = normalizeFeedbackInput(base({ details: ' Sai   item ' }));
  const b = normalizeFeedbackInput(base({ details: 'Sai item' }));
  const c = normalizeFeedbackInput(base({ reasonCode: 'OUTDATED', details: 'Sai item' }));
  const d = normalizeFeedbackInput(base({
    publicationVersionId: '7b200000-0000-4000-8000-000000000004',
    details: 'Sai item',
  }));

  const hashA = hashFeedbackRequest(PUBLICATION_ID, a);
  assert.match(hashA, /^[a-f0-9]{64}$/);
  assert.equal(hashA, hashFeedbackRequest(PUBLICATION_ID, b));
  assert.notEqual(hashA, hashFeedbackRequest(PUBLICATION_ID, c));
  assert.notEqual(hashA, hashFeedbackRequest(PUBLICATION_ID, d));
  assert.notEqual(
    hashA,
    hashFeedbackRequest('7b200000-0000-4000-8000-000000000005', a),
  );
});
