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
  OperatorCandidateReviewDossier,
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

const DOSSIER_ID = 'a2000000-0000-4000-8000-000000000001';
const DOSSIER: OperatorCandidateReviewDossier = {
  schemaVersion: 1,
  generatedAt: '2026-09-03T01:00:00.000Z',
  activeReviewPolicyRevisionId: 'a2000000-0000-4000-8000-000000000002',
  candidate: {
    candidateId: 'a2000000-0000-4000-8000-000000000003',
    candidateRevisionId: DOSSIER_ID,
    revision: 1,
    patchId: 'a2000000-0000-4000-8000-000000000004',
    patchKey: '26.18',
    catalogRevisionId: 'a2000000-0000-4000-8000-000000000005',
    subjectExternalId: 'samira',
    selection: {
      augmentExternalIds: ['1194'],
      itemExternalIds: ['3006', '6672'],
    },
    createdAt: '2026-09-03T00:00:00.000Z',
  },
  review: {
    state: 'unreviewed',
    confirmedCount: 0,
    requiredCount: 2,
  },
  confidence: null,
  claimSet: {
    claimSetSealId: 'a2000000-0000-4000-8000-000000000006',
    claimSetHash: 'a'.repeat(64),
    claimCount: 1,
  },
  provenance: [],
  claims: [],
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
    readCandidateDossier: async () => null,
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
    readCandidateDossier: async () => null,
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
    readCandidateDossier: async () => null,
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
    readCandidateDossier: async () => null,
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
    readCandidateDossier: async () => null,
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
  assert.match(OPERATOR_JS, /candidate-review-dossiers/);
  assert.match(OPERATOR_JS, /Xem hồ sơ/);
  assert.match(OPERATOR_HTML, /Candidate review/);
  assert.match(OPERATOR_HTML, /Monitoring &amp; feedback/);
  assert.match(OPERATOR_HTML, /Quay lại hàng đợi/);
  assert.match(OPERATOR_HTML, /Làm mới hồ sơ/);
  assert.match(OPERATOR_HTML, /review-state/);
  assert.match(OPERATOR_HTML, /confidence-band/);
  assert.match(OPERATOR_JS, /provenanceQualityScore/);
  assert.match(OPERATOR_JS, /evidenceDiversityScore/);
  assert.match(OPERATOR_JS, /patchAlignmentScore/);
  assert.match(OPERATOR_JS, /freshnessScore/);
  assert.match(OPERATOR_JS, /createTextNode/);
  assert.match(OPERATOR_JS, /target = '_blank'/);
  assert.match(OPERATOR_JS, /rel = 'noopener noreferrer'/);
  assert.match(OPERATOR_JS, /referrerPolicy = 'no-referrer'/);
  assert.doesNotMatch(assets, /\b(?:approve|decline|rollback)\b/i);
  assert.doesNotMatch(OPERATOR_HTML, /Phê duyệt|Từ chối|Xuất bản/);
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
    'candidate-queue-panel', 'candidate-dossier', 'dossier-back', 'dossier-refresh',
    'dossier-status', 'dossier-summary', 'dossier-provenance', 'dossier-claims',
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

test('dossier controls render literal text and safe links, clear failures, and ignore late responses', async () => {
  class Element {
    children: Element[] = [];
    textContent = '';
    value = 'all';
    hidden = false;
    disabled = false;
    href = '';
    target = '';
    rel = '';
    referrerPolicy = '';
    listeners = new Map<string, () => void>();
    addEventListener(event: string, listener: () => void) { this.listeners.set(event, listener); }
    click() { this.listeners.get('click')?.(); }
    appendChild(child: Element) { this.children.push(child); return child; }
    get firstChild(): Element | null { return this.children[0] ?? null; }
    removeChild(child: Element) { this.children.splice(this.children.indexOf(child), 1); }
    setAttribute() {}
    all(): Element[] { return [this, ...this.children.flatMap((child) => child.all())]; }
  }
  const elements = new Map<string, Element>();
  const get = (id: string) => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id)!;
  };
  get('candidate-search').value = '';
  get('search').value = '';
  const queue = {
    ...EMPTY_CANDIDATE_QUEUE,
    items: [{ ...DOSSIER.candidate, review: DOSSIER.review, confidence: null }],
  };
  type Response = { ok: boolean; status: number; json(): Promise<unknown> };
  const pending: Array<(response: Response) => void> = [];
  const requests: string[] = [];
  const fetch = (url: string) => {
    requests.push(url);
    if (url.endsWith('/candidate-review-queue')) return Promise.resolve({ ok: true, json: async () => queue });
    if (url.endsWith('/snapshot')) return Promise.resolve({ ok: true, json: async () => EMPTY_SNAPSHOT });
    return new Promise<Response>((resolve) => pending.push(resolve));
  };
  const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
  const resolve = (status: number, value: unknown) => pending.shift()!({ ok: status === 200, status, json: async () => value });
  const open = () => get('candidate-items').all().find((element) => element.textContent === 'Xem hồ sơ')!.click();
  const content = (id: string) => get(id).all().map((element) => element.textContent).join('\n');
  Function('document', 'fetch', OPERATOR_JS)({
    createElement: () => new Element(), getElementById: get,
    createTextNode: (text: string) => Object.assign(new Element(), { textContent: text }),
  }, fetch);
  await flush();
  open();
  assert.equal(get('candidate-queue-panel').hidden, true);
  assert.equal(get('dossier-refresh').disabled, true);
  const statement = '<img src=x onerror=alert(1)>';
  const value = {
    ...DOSSIER,
    provenance: [{
      candidateProvenanceId: 'provenance-id', origin: 'editorial', observedAt: null, collectedAt: DOSSIER.generatedAt,
      source: { sourceId: 'source-id', sourceKey: 'editorial', displayName: statement, status: 'suspended', sourcePolicyRevisionId: 'policy-id', storagePermission: 'reference_only' },
      reference: { url: 'https://example.com/source', platform: 'example', author: statement, publishedAt: null, sourceContentId: null },
    }],
    claims: [
      { claimId: 'one', claimKey: 'one', claimType: 'performance', importance: 'critical', statement, statementHash: 'a'.repeat(64), decision: null },
      { claimId: 'two', claimKey: 'two', claimType: 'performance', importance: 'critical', statement: 'Second claim', statementHash: 'b'.repeat(64), decision: { decisionId: 'decision-id', evidencePolicyRevisionId: 'policy-id', outcome: 'insufficient', reason: statement, evaluatedAt: DOSSIER.generatedAt, evidence: [] } },
    ],
  };
  resolve(200, value);
  await flush();
  assert.ok(content('dossier-claims').includes(statement));
  assert.match(content('dossier-claims'), /Chưa có quyết định Evidence hiện hành/);
  assert.match(content('dossier-claims'), /Quyết định hiện hành không gắn Evidence/);
  const link = get('dossier-provenance').all().find((element) => element.href)!;
  assert.equal(link.href, value.provenance[0]!.reference.url);
  assert.equal(link.target, '_blank');
  assert.equal(link.rel, 'noopener noreferrer');
  assert.equal(link.referrerPolicy, 'no-referrer');
  assert.ok(requests.every((url) => url.startsWith('/api/operator/v1/')));

  get('dossier-refresh').click();
  assert.equal(get('dossier-claims').children.length, 0);
  resolve(503, { private: 'secret' });
  await flush();
  assert.match(get('dossier-status').textContent, /Không thể tải hồ sơ/);
  assert.equal(get('dossier-summary').children.length, 0);
  get('dossier-refresh').click();
  get('dossier-back').click();
  open();
  resolve(200, value); // Previous request for the same candidate must stay invisible.
  await flush();
  assert.equal(get('dossier-summary').children.length, 0);
  resolve(404, null);
  await flush();
  assert.match(get('dossier-status').textContent, /không còn trong hàng đợi/);
  const before = requests.length;
  get('dossier-back').click();
  await flush();
  assert.equal(requests.length, before + 1);
  assert.ok(requests.at(-1)!.endsWith('/candidate-review-queue'));
  open();
  get('view-signals').click();
  await flush();
  resolve(200, value);
  await flush();
  assert.match(get('generated').textContent, /2026-08-17/);
  assert.equal(get('status').textContent, '');
  assert.equal(get('refresh').disabled, false);
});

test('candidate queue route returns a closed queue and passes a strict bounded limit', async () => {
  let observedOptions: unknown;
  const app = buildOperatorApp({
    logger: false,
    checkPostgres: async () => true,
    readCandidateDossier: async () => null,
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
    readCandidateDossier: async () => null,
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
    readCandidateDossier: async () => null,
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

test('candidate dossier route returns the closed dossier and exact request options', async () => {
  const observed: unknown[] = [];
  const app = buildOperatorApp({
    logger: false,
    checkPostgres: async () => true,
    readSnapshot: async () => EMPTY_SNAPSHOT,
    readCandidateQueue: async () => EMPTY_CANDIDATE_QUEUE,
    readCandidateDossier: async (options) => {
      observed.push(options);
      return DOSSIER;
    },
    now: () => new Date('2026-09-03T01:00:00.000Z'),
  });

  const response = await app.inject({
    method: 'GET',
    url: `/api/operator/v1/candidate-review-dossiers/${DOSSIER_ID}`,
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), DOSSIER);
  assert.deepEqual(observed, [{
    candidateRevisionId: DOSSIER_ID,
    now: new Date('2026-09-03T01:00:00.000Z'),
  }]);
  expectedSecurityHeaders(response.headers);
  await app.close();
});

test('candidate dossier rejects noncanonical IDs and every query key before reading', async () => {
  let reads = 0;
  const app = buildOperatorApp({
    logger: false,
    checkPostgres: async () => true,
    readSnapshot: async () => EMPTY_SNAPSHOT,
    readCandidateQueue: async () => EMPTY_CANDIDATE_QUEUE,
    readCandidateDossier: async () => {
      reads += 1;
      return DOSSIER;
    },
  });
  const invalidUrls = [
    `/api/operator/v1/candidate-review-dossiers/${DOSSIER_ID.toUpperCase()}`,
    '/api/operator/v1/candidate-review-dossiers/a2000000-0000-6000-8000-000000000001',
    '/api/operator/v1/candidate-review-dossiers/not-a-uuid',
    `/api/operator/v1/candidate-review-dossiers/${DOSSIER_ID}?limit=1`,
    `/api/operator/v1/candidate-review-dossiers/${DOSSIER_ID}?x=1&x=2`,
  ];

  for (const url of invalidUrls) {
    const response = await app.inject({ method: 'GET', url });
    assert.equal(response.statusCode, 400, url);
    assert.deepEqual(response.json(), {
      error: {
        code: 'INVALID_OPERATOR_CANDIDATE_DOSSIER_REQUEST',
        message: 'Invalid operator candidate dossier request',
      },
    });
  }
  assert.equal(reads, 0);
  await app.close();
});

test('candidate dossier maps not-found and failures without registering writes', async () => {
  let fail = false;
  const app = buildOperatorApp({
    logger: false,
    checkPostgres: async () => true,
    readSnapshot: async () => EMPTY_SNAPSHOT,
    readCandidateQueue: async () => EMPTY_CANDIDATE_QUEUE,
    readCandidateDossier: async () => {
      if (fail) {
        throw new Error('postgres://secret-user:secret-password@database/internal');
      }
      return null;
    },
  });
  const url = `/api/operator/v1/candidate-review-dossiers/${DOSSIER_ID}`;

  const missing = await app.inject({ method: 'GET', url });
  assert.equal(missing.statusCode, 404);
  assert.deepEqual(missing.json(), {
    error: {
      code: 'OPERATOR_CANDIDATE_DOSSIER_NOT_FOUND',
      message: 'Operator candidate dossier not found',
    },
  });

  fail = true;
  const unavailable = await app.inject({ method: 'GET', url });
  assert.equal(unavailable.statusCode, 503);
  assert.deepEqual(unavailable.json(), {
    error: {
      code: 'OPERATOR_CANDIDATE_DOSSIER_UNAVAILABLE',
      message: 'Operator candidate dossier is temporarily unavailable',
    },
  });
  assert.doesNotMatch(unavailable.body, /secret|postgres:\/\//i);

  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
    const response = await app.inject({ method, url });
    assert.equal(response.statusCode, 404, method);
  }
  await app.close();
});
