import assert from 'node:assert/strict';
import type { OutgoingHttpHeaders } from 'node:http';
import test from 'node:test';

import {
  OPERATOR_CSS,
  OPERATOR_HTML,
  OPERATOR_JS,
} from '../src/operator/assets.js';
import { buildOperatorApp } from '../src/operator/http.js';
import type {
  OperatorCandidateReviewQueue,
  OperatorSnapshot,
} from '../src/modules/operator/types.js';

const EMPTY_SNAPSHOT: OperatorSnapshot = {
  schemaVersion: 1,
  generatedAt: '2026-08-17T04:00:00.000Z',
  sinceHours: 168,
  summary: { critical: 0, warning: 0, feedbackOnly: 0, total: 0 },
  signals: [],
};

const EMPTY_CANDIDATE_QUEUE: OperatorCandidateReviewQueue = {
  schemaVersion: 1,
  generatedAt: '2026-08-28T03:00:00.000Z',
  activeReviewPolicyRevisionId: '91000000-0000-4000-8000-000000000007',
  limit: 50,
  summary: {
    returned: 0,
    unreviewed: 0,
    inProgress: 0,
    unscored: 0,
    low: 0,
    medium: 0,
    high: 0,
    veryHigh: 0,
  },
  items: [],
};

function expectedSecurityHeaders(headers: OutgoingHttpHeaders) {
  assert.equal(headers['cache-control'], 'no-store');
  assert.equal(headers['x-content-type-options'], 'nosniff');
  assert.equal(headers['referrer-policy'], 'no-referrer');
  const csp = headers['content-security-policy'];
  assert.equal(typeof csp, 'string');
  assert.match(String(csp), /default-src 'none'/);
  assert.match(String(csp), /connect-src 'self'/);
  assert.match(String(csp), /frame-ancestors 'none'/);
}

test('operator snapshot route returns a closed snapshot and passes strict bounded options', async () => {
  let observedOptions: unknown;
  const app = buildOperatorApp({
    logger: false,
    checkPostgres: async () => true,
    readCandidateQueue: async () => EMPTY_CANDIDATE_QUEUE,
    readSnapshot: async (options) => {
      observedOptions = options;
      return {
        ...EMPTY_SNAPSHOT,
        generatedAt: options.now.toISOString(),
        sinceHours: options.sinceHours,
      };
    },
    now: () => new Date('2026-08-17T05:00:00.000Z'),
  });

  const response = await app.inject({
    method: 'GET',
    url: '/api/operator/v1/snapshot?sinceHours=24&limit=10&detailSampleLimit=2',
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    ...EMPTY_SNAPSHOT,
    generatedAt: '2026-08-17T05:00:00.000Z',
    sinceHours: 24,
  });
  assert.deepEqual(observedOptions, {
    sinceHours: 24,
    limit: 10,
    detailSampleLimit: 2,
    now: new Date('2026-08-17T05:00:00.000Z'),
  });
  expectedSecurityHeaders(response.headers);
  await app.close();
});

test('operator snapshot route applies exact defaults', async () => {
  let observedOptions: unknown;
  const app = buildOperatorApp({
    logger: false,
    checkPostgres: async () => true,
    readCandidateQueue: async () => EMPTY_CANDIDATE_QUEUE,
    readSnapshot: async (options) => {
      observedOptions = options;
      return EMPTY_SNAPSHOT;
    },
  });

  const response = await app.inject({ method: 'GET', url: '/api/operator/v1/snapshot' });
  assert.equal(response.statusCode, 200);
  assert.ok(observedOptions && typeof observedOptions === 'object');
  const defaults = observedOptions as {
    sinceHours: number;
    limit: number;
    detailSampleLimit: number;
    now: unknown;
  };
  assert.equal(defaults.sinceHours, 168);
  assert.equal(defaults.limit, 50);
  assert.equal(defaults.detailSampleLimit, 3);
  assert.ok(defaults.now instanceof Date);
  await app.close();
});

test('operator snapshot rejects malformed, out-of-range, duplicate, and unknown query parameters before reading', async () => {
  let reads = 0;
  const app = buildOperatorApp({
    logger: false,
    checkPostgres: async () => true,
    readCandidateQueue: async () => EMPTY_CANDIDATE_QUEUE,
    readSnapshot: async () => {
      reads += 1;
      return EMPTY_SNAPSHOT;
    },
  });

  const invalidUrls = [
    '/api/operator/v1/snapshot?sinceHours=0',
    '/api/operator/v1/snapshot?sinceHours=721',
    '/api/operator/v1/snapshot?sinceHours=1.5',
    '/api/operator/v1/snapshot?limit=0',
    '/api/operator/v1/snapshot?limit=101',
    '/api/operator/v1/snapshot?detailSampleLimit=-1',
    '/api/operator/v1/snapshot?detailSampleLimit=6',
    '/api/operator/v1/snapshot?limit=1&limit=2',
    '/api/operator/v1/snapshot?unexpected=1',
  ];

  for (const url of invalidUrls) {
    const response = await app.inject({ method: 'GET', url });
    assert.equal(response.statusCode, 400, url);
    assert.deepEqual(response.json(), {
      error: {
        code: 'INVALID_OPERATOR_QUERY',
        message: 'Invalid operator snapshot query',
      },
    });
  }
  assert.equal(reads, 0);
  await app.close();
});

test('operator snapshot failure is sanitized and write methods are absent', async () => {
  const app = buildOperatorApp({
    logger: false,
    checkPostgres: async () => true,
    readCandidateQueue: async () => EMPTY_CANDIDATE_QUEUE,
    readSnapshot: async () => {
      throw new Error('postgres://secret-user:secret-password@database/internal');
    },
  });

  const failed = await app.inject({ method: 'GET', url: '/api/operator/v1/snapshot' });
  assert.equal(failed.statusCode, 503);
  assert.deepEqual(failed.json(), {
    error: {
      code: 'OPERATOR_SNAPSHOT_UNAVAILABLE',
      message: 'Operator snapshot is temporarily unavailable',
    },
  });
  assert.doesNotMatch(failed.body, /secret|postgres:\/\//i);

  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
    const response = await app.inject({ method, url: '/api/operator/v1/snapshot' });
    assert.equal(response.statusCode, 404, method);
  }
  await app.close();
});

test('operator readiness checks PostgreSQL only and shell assets stay available', async () => {
  let checks = 0;
  const app = buildOperatorApp({
    logger: false,
    checkPostgres: async () => {
      checks += 1;
      return false;
    },
    readCandidateQueue: async () => EMPTY_CANDIDATE_QUEUE,
    readSnapshot: async () => EMPTY_SNAPSHOT,
  });

  const live = await app.inject({ method: 'GET', url: '/health/live' });
  assert.equal(live.statusCode, 200);
  assert.deepEqual(live.json(), { status: 'live' });

  const ready = await app.inject({ method: 'GET', url: '/health/ready' });
  assert.equal(ready.statusCode, 503);
  assert.deepEqual(ready.json(), { status: 'not_ready' });
  assert.equal(checks, 1);

  for (const [url, contentType] of [
    ['/', 'text/html'],
    ['/operator.js', 'text/javascript'],
    ['/operator.css', 'text/css'],
  ] as const) {
    const response = await app.inject({ method: 'GET', url });
    assert.equal(response.statusCode, 200, url);
    assert.match(String(response.headers['content-type']), new RegExp(contentType));
    expectedSecurityHeaders(response.headers);
  }
  await app.close();
});

test('operator assets are self-contained, manual-refresh only, and render untrusted detail as text', () => {
  const assets = `${OPERATOR_HTML}\n${OPERATOR_CSS}\n${OPERATOR_JS}`;
  assert.doesNotMatch(assets, /https?:\/\//i);
  assert.doesNotMatch(assets, /localStorage|sessionStorage|indexedDB/i);
  assert.doesNotMatch(assets, /innerHTML|insertAdjacentHTML|document\.write/i);
  assert.doesNotMatch(assets, /setInterval|setTimeout/i);
  assert.match(OPERATOR_JS, /textContent/);
  assert.match(OPERATOR_JS, /Làm mới/);
  assert.match(OPERATOR_JS, /\/api\/operator\/v1\/snapshot/);
  assert.match(OPERATOR_JS, /\/api\/operator\/v1\/candidate-review-queue/);
  assert.match(OPERATOR_HTML, /Candidate review/);
  assert.match(OPERATOR_HTML, /Monitoring &amp; feedback/);
  assert.match(OPERATOR_HTML, /review-state/);
  assert.match(OPERATOR_HTML, /confidence-band/);
  assert.match(OPERATOR_JS, /provenanceQualityScore/);
  assert.match(OPERATOR_JS, /evidenceDiversityScore/);
  assert.match(OPERATOR_JS, /patchAlignmentScore/);
  assert.match(OPERATOR_JS, /freshnessScore/);
  assert.doesNotMatch(assets, /\b(?:approve|decline|rollback)\b/i);
});

test('a stale candidate failure cannot overwrite the active monitoring view', async () => {
  type Listener = () => void;
  class FakeElement {
    checked = false;
    children: FakeElement[] = [];
    className = '';
    disabled = false;
    hidden = false;
    listeners = new Map<string, Listener>();
    textContent = '';
    type = '';
    value = '';

    addEventListener(event: string, listener: Listener) {
      this.listeners.set(event, listener);
    }

    append(...children: FakeElement[]) {
      this.children.push(...children);
    }

    appendChild(child: FakeElement) {
      this.children.push(child);
      return child;
    }

    dispatch(event: string) {
      this.listeners.get(event)?.();
    }

    replaceChildren(...children: FakeElement[]) {
      this.children = children;
    }

    get firstChild(): FakeElement | null {
      return this.children[0] ?? null;
    }

    removeChild(child: FakeElement) {
      this.children = this.children.filter((candidate) => candidate !== child);
      return child;
    }

    setAttribute() {}
  }

  const ids = [
    'view-candidates',
    'view-signals',
    'candidate-view',
    'signal-view',
    'generated',
    'status',
    'refresh',
    'candidate-summary',
    'candidate-items',
    'review-state',
    'confidence-band',
    'candidate-search',
    'summary',
    'signals',
    'priority',
    'active-only',
    'search',
  ] as const;
  const elements = new Map<string, FakeElement>(
    ids.map((id) => [id, new FakeElement()]),
  );
  elements.get('active-only')!.checked = true;

  type DeferredResponse = {
    promise: Promise<{ ok: boolean; json(): Promise<unknown> }>;
    reject(error: Error): void;
    resolve(value: unknown): void;
  };
  function deferredResponse(): DeferredResponse {
    let resolvePromise!: DeferredResponse['resolve'];
    let rejectPromise!: DeferredResponse['reject'];
    const promise = new Promise<{ ok: boolean; json(): Promise<unknown> }>(
      (resolve, reject) => {
        resolvePromise = (value) => resolve({ ok: true, json: async () => value });
        rejectPromise = reject;
      },
    );
    return { promise, reject: rejectPromise, resolve: resolvePromise };
  }

  const candidateResponses = [
    deferredResponse(),
    deferredResponse(),
    deferredResponse(),
  ];
  const snapshotResponse = deferredResponse();
  const requests: string[] = [];
  let candidateRequestIndex = 0;
  const fetch = (url: string) => {
    requests.push(url);
    return url.endsWith('/snapshot')
      ? snapshotResponse.promise
      : candidateResponses[candidateRequestIndex++]!.promise;
  };
  const document = {
    createElement: () => new FakeElement(),
    getElementById: (id: string) => elements.get(id) ?? null,
  };

  Function('document', 'fetch', OPERATOR_JS)(document, fetch);
  elements.get('view-signals')!.dispatch('click');
  assert.deepEqual(requests, [
    '/api/operator/v1/candidate-review-queue',
    '/api/operator/v1/snapshot',
  ]);

  snapshotResponse.resolve(EMPTY_SNAPSHOT);
  await Promise.resolve();
  await Promise.resolve();
  assert.match(elements.get('generated')!.textContent, /2026-08-17/);
  assert.equal(elements.get('status')!.textContent, '');

  candidateResponses[0]!.reject(new Error('stale candidate request failed'));
  await Promise.resolve();
  await Promise.resolve();
  assert.match(elements.get('generated')!.textContent, /2026-08-17/);
  assert.equal(elements.get('status')!.textContent, '');
  assert.equal(elements.get('refresh')!.disabled, false);

  elements.get('view-candidates')!.dispatch('click');
  elements.get('view-signals')!.dispatch('click');
  elements.get('view-candidates')!.dispatch('click');
  assert.deepEqual(requests.slice(2), [
    '/api/operator/v1/candidate-review-queue',
    '/api/operator/v1/candidate-review-queue',
  ]);

  candidateResponses[2]!.resolve({
    ...EMPTY_CANDIDATE_QUEUE,
    generatedAt: '2026-08-30T05:00:00.000Z',
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.match(elements.get('generated')!.textContent, /2026-08-30T05:00/);

  candidateResponses[1]!.resolve({
    ...EMPTY_CANDIDATE_QUEUE,
    generatedAt: '2026-08-30T04:00:00.000Z',
  });
  await Promise.resolve();
  await Promise.resolve();
  elements.get('view-signals')!.dispatch('click');
  elements.get('view-candidates')!.dispatch('click');
  assert.match(elements.get('generated')!.textContent, /2026-08-30T05:00/);
});

test('candidate queue route returns a closed queue and passes a strict bounded limit', async () => {
  let observedOptions: unknown;
  const app = buildOperatorApp({
    logger: false,
    checkPostgres: async () => true,
    readSnapshot: async () => EMPTY_SNAPSHOT,
    readCandidateQueue: async (options) => {
      observedOptions = options;
      return {
        ...EMPTY_CANDIDATE_QUEUE,
        generatedAt: options.now.toISOString(),
        limit: options.limit,
      };
    },
    now: () => new Date('2026-08-30T03:00:00.000Z'),
  });

  const response = await app.inject({
    method: 'GET',
    url: '/api/operator/v1/candidate-review-queue?limit=25',
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    ...EMPTY_CANDIDATE_QUEUE,
    generatedAt: '2026-08-30T03:00:00.000Z',
    limit: 25,
  });
  assert.deepEqual(observedOptions, {
    limit: 25,
    now: new Date('2026-08-30T03:00:00.000Z'),
  });
  expectedSecurityHeaders(response.headers);
  await app.close();
});

test('candidate queue route defaults to 50 and rejects every non-closed query before reading', async () => {
  let reads = 0;
  let defaultOptions: unknown;
  const app = buildOperatorApp({
    logger: false,
    checkPostgres: async () => true,
    readSnapshot: async () => EMPTY_SNAPSHOT,
    readCandidateQueue: async (options) => {
      reads += 1;
      defaultOptions = options;
      return EMPTY_CANDIDATE_QUEUE;
    },
  });

  const valid = await app.inject({
    method: 'GET',
    url: '/api/operator/v1/candidate-review-queue',
  });
  assert.equal(valid.statusCode, 200);
  assert.ok(defaultOptions && typeof defaultOptions === 'object');
  assert.equal((defaultOptions as { limit: number }).limit, 50);
  assert.ok((defaultOptions as { now: unknown }).now instanceof Date);

  const invalidUrls = [
    '/api/operator/v1/candidate-review-queue?limit=0',
    '/api/operator/v1/candidate-review-queue?limit=101',
    '/api/operator/v1/candidate-review-queue?limit=1.5',
    '/api/operator/v1/candidate-review-queue?limit=+1',
    '/api/operator/v1/candidate-review-queue?limit=%201',
    '/api/operator/v1/candidate-review-queue?limit=1&limit=2',
    '/api/operator/v1/candidate-review-queue?unexpected=1',
  ];
  for (const url of invalidUrls) {
    const response = await app.inject({ method: 'GET', url });
    assert.equal(response.statusCode, 400, url);
    assert.deepEqual(response.json(), {
      error: {
        code: 'INVALID_OPERATOR_CANDIDATE_QUEUE_QUERY',
        message: 'Invalid operator candidate queue query',
      },
    });
  }
  assert.equal(reads, 1);
  await app.close();
});

test('candidate queue failures are sanitized and write methods remain absent', async () => {
  const app = buildOperatorApp({
    logger: false,
    checkPostgres: async () => true,
    readSnapshot: async () => EMPTY_SNAPSHOT,
    readCandidateQueue: async () => {
      throw new Error('postgres://secret-user:secret-password@database/internal');
    },
  });

  const failed = await app.inject({
    method: 'GET',
    url: '/api/operator/v1/candidate-review-queue',
  });
  assert.equal(failed.statusCode, 503);
  assert.deepEqual(failed.json(), {
    error: {
      code: 'OPERATOR_CANDIDATE_QUEUE_UNAVAILABLE',
      message: 'Operator candidate queue is temporarily unavailable',
    },
  });
  assert.doesNotMatch(failed.body, /secret|postgres:\/\//i);

  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
    const response = await app.inject({
      method,
      url: '/api/operator/v1/candidate-review-queue',
    });
    assert.equal(response.statusCode, 404, method);
  }
  await app.close();
});
