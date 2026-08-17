import assert from 'node:assert/strict';
import test from 'node:test';

import { buildApp } from '../src/app.js';
import type { PublicFeedbackIntake } from '../src/http/public-feedback.js';
import type { ActivePublicationRead } from '../src/modules/publication/types.js';
import type { ResourceHealth } from '../src/resources.js';

const PUBLICATION_ID = '7b500000-0000-4000-8000-000000000001';
const VERSION_ID = '7b500000-0000-4000-8000-000000000002';
const SUBMISSION_ID = '7b500000-0000-4000-8000-000000000003';

const resources: ResourceHealth = {
  async checkPostgres() { return true; },
  async checkRedis() { return true; },
};

const publications = {
  async listActive(): Promise<ActivePublicationRead[]> { return []; },
  async findActiveById(): Promise<ActivePublicationRead | null> { return null; },
};

function payload(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    submissionId: SUBMISSION_ID,
    publicationVersionId: VERSION_ID,
    reasonCode: 'WRONG_ITEMS',
    details: 'Sai trang bị',
    ...overrides,
  };
}

function createIntake() {
  const calls = { fingerprints: [] as string[], limits: 0, submits: 0 };
  const intake: PublicFeedbackIntake = {
    fingerprint(gatewayIp) {
      calls.fingerprints.push(gatewayIp);
      return 'a'.repeat(64);
    },
    async rateLimit() {
      calls.limits += 1;
      return { outcome: 'allowed' };
    },
    async submit() {
      calls.submits += 1;
      return { outcome: 'accepted', replayed: false };
    },
  };
  return { intake, calls };
}

function appWith(feedback?: PublicFeedbackIntake) {
  return buildApp({
    logger: false,
    resources,
    publications,
    ...(feedback ? { feedback } : {}),
  });
}

function validRequest() {
  return {
    method: 'POST' as const,
    url: `/api/v1/publications/${PUBLICATION_ID}/feedback`,
    headers: {
      'content-type': 'application/json',
      'x-hai-dau-feedback': 'web-v1',
      'x-hai-dau-client-ip': '203.0.113.9',
    },
    payload: payload(),
  };
}

test('disabled app registers no feedback POST route', async () => {
  const app = appWith();
  const response = await app.inject(validRequest());
  assert.equal(response.statusCode, 404);
  await app.close();
});

test('feedback route rejects missing custom header and malformed input before dependencies', async () => {
  const { intake, calls } = createIntake();
  const app = appWith(intake);

  const missingHeader = validRequest();
  delete (missingHeader.headers as Record<string, string>)['x-hai-dau-feedback'];
  assert.equal((await app.inject(missingHeader)).statusCode, 400);

  assert.equal((await app.inject({ ...validRequest(), url: '/api/v1/publications/not-a-uuid/feedback' })).statusCode, 400);
  assert.equal((await app.inject({ ...validRequest(), payload: payload({ schemaVersion: 2 }) })).statusCode, 400);
  assert.equal((await app.inject({ ...validRequest(), payload: payload({ extra: true }) })).statusCode, 400);
  assert.equal(calls.limits, 0);
  assert.equal(calls.submits, 0);
  await app.close();
});

test('feedback route requires the gateway-overwritten client IP', async () => {
  const { intake, calls } = createIntake();
  const app = appWith(intake);
  const request = validRequest();
  delete (request.headers as Record<string, string>)['x-hai-dau-client-ip'];
  assert.equal((await app.inject(request)).statusCode, 503);
  assert.deepEqual(calls.fingerprints, []);
  assert.equal(calls.submits, 0);
  await app.close();
});

test('feedback route maps limiter and submission outcomes to bounded responses', async () => {
  const first = createIntake();
  first.intake.rateLimit = async () => ({ outcome: 'denied', retryAfterSeconds: 42 });
  const rateApp = appWith(first.intake);
  const rate = await rateApp.inject(validRequest());
  assert.equal(rate.statusCode, 429);
  assert.equal(rate.headers['retry-after'], '42');
  assert.doesNotMatch(rate.body, /203\.0\.113\.9|Sai trang bị/);
  await rateApp.close();

  const unavailable = createIntake();
  unavailable.intake.rateLimit = async () => { throw new Error('redis internal secret'); };
  const unavailableApp = appWith(unavailable.intake);
  const failed = await unavailableApp.inject(validRequest());
  assert.equal(failed.statusCode, 503);
  assert.equal(unavailable.calls.submits, 0);
  assert.doesNotMatch(failed.body, /redis|secret/i);
  await unavailableApp.close();

  for (const [outcome, statusCode] of [
    [{ outcome: 'accepted', replayed: false } as const, 202],
    [{ outcome: 'accepted', replayed: true } as const, 202],
    [{ outcome: 'not_found' } as const, 404],
    [{ outcome: 'conflict' } as const, 409],
  ] as const) {
    const stub = createIntake();
    stub.intake.submit = async () => outcome;
    const app = appWith(stub.intake);
    const response = await app.inject(validRequest());
    assert.equal(response.statusCode, statusCode);
    assert.doesNotMatch(response.body, /203\.0\.113\.9|Sai trang bị|a{64}/);
    await app.close();
  }
});

test('feedback body limit is 2 KiB and public GET remains independent of feedback failure', async () => {
  const stub = createIntake();
  stub.intake.rateLimit = async () => { throw new Error('limiter down'); };
  const app = appWith(stub.intake);

  const tooLarge = await app.inject({
    ...validRequest(),
    payload: payload({ details: 'x'.repeat(2500) }),
  });
  assert.equal(tooLarge.statusCode, 413);

  const get = await app.inject({ method: 'GET', url: '/api/v1/publications' });
  assert.equal(get.statusCode, 200);
  await app.close();
});
