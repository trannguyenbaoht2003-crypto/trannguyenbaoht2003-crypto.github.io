import assert from 'node:assert/strict';
import test from 'node:test';

import { submitPublicFeedback } from '../app/public-data/feedback-client.ts';

const base = {
  publicationId: '7b800000-0000-4000-8000-000000000001',
  publicationVersionId: '7b800000-0000-4000-8000-000000000002',
  submissionId: '7b800000-0000-4000-8000-000000000003',
  reasonCode: 'WRONG_ITEMS' as const,
  details: 'Sai trang bị',
};

test('feedback client sends same-origin JSON pinned to exact PublicationVersion and submission id', async () => {
  let captured: { input?: RequestInfo | URL; init?: RequestInit } = {};
  const fetchImpl: typeof fetch = async (input, init) => {
    captured = { input, init };
    return new Response(JSON.stringify({ status: 'accepted' }), { status: 202 });
  };

  assert.deepEqual(await submitPublicFeedback({ ...base, fetchImpl }), { outcome: 'accepted' });
  assert.equal(captured.input, `/api/v1/publications/${base.publicationId}/feedback`);
  assert.equal(captured.init?.method, 'POST');
  assert.equal((captured.init?.headers as Record<string, string>)['Content-Type'], 'application/json');
  assert.equal((captured.init?.headers as Record<string, string>)['X-Hai-Dau-Feedback'], 'web-v1');
  assert.equal((captured.init?.headers as Record<string, string>).Authorization, undefined);
  assert.equal(captured.init?.credentials, undefined);
  assert.deepEqual(JSON.parse(String(captured.init?.body)), {
    schemaVersion: 1,
    submissionId: base.submissionId,
    publicationVersionId: base.publicationVersionId,
    reasonCode: base.reasonCode,
    details: base.details,
  });
});

test('feedback client maps accepted, invalid, rate-limited, unavailable, and network failures', async () => {
  const withStatus = (status: number, headers?: HeadersInit): typeof fetch =>
    async () => new Response('', { status, headers });

  assert.deepEqual(await submitPublicFeedback({ ...base, fetchImpl: withStatus(202) }), { outcome: 'accepted' });
  assert.deepEqual(await submitPublicFeedback({ ...base, fetchImpl: withStatus(400) }), { outcome: 'invalid' });
  assert.deepEqual(await submitPublicFeedback({ ...base, fetchImpl: withStatus(409) }), { outcome: 'invalid' });
  assert.deepEqual(
    await submitPublicFeedback({ ...base, fetchImpl: withStatus(429, { 'Retry-After': '42' }) }),
    { outcome: 'rate_limited', retryAfterSeconds: 42 },
  );
  assert.deepEqual(await submitPublicFeedback({ ...base, fetchImpl: withStatus(503) }), { outcome: 'unavailable' });
  assert.deepEqual(
    await submitPublicFeedback({ ...base, fetchImpl: async () => { throw new Error('offline'); } }),
    { outcome: 'unavailable' },
  );
});

test('feedback client omits details when not supplied', async () => {
  let body = '';
  const fetchImpl: typeof fetch = async (_input, init) => {
    body = String(init?.body);
    return new Response('', { status: 202 });
  };
  const { details: _details, ...withoutDetails } = base;
  await submitPublicFeedback({ ...withoutDetails, fetchImpl });
  assert.deepEqual(JSON.parse(body), {
    schemaVersion: 1,
    submissionId: base.submissionId,
    publicationVersionId: base.publicationVersionId,
    reasonCode: base.reasonCode,
  });
});
