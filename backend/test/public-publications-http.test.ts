import assert from 'node:assert/strict';
import test from 'node:test';

import { buildApp } from '../src/app.js';
import type { ActivePublicationRead } from '../src/modules/publication/types.js';
import type { ResourceHealth } from '../src/resources.js';

const PUBLICATION_ID = '77000000-0000-4000-8000-000000000001';

const resources: ResourceHealth = {
  async checkPostgres() {
    return true;
  },
  async checkRedis() {
    return true;
  },
};

const activePublication: ActivePublicationRead = {
  publicationId: PUBLICATION_ID,
  candidateId: '62000000-0000-4000-8000-000000000001',
  candidateRevisionId: '62000000-0000-4000-8000-000000000002',
  publicationVersionId: '77000000-0000-4000-8000-000000000002',
  versionNumber: 1,
  publishedAt: '2026-07-29T02:00:00.000Z',
  payload: {
    schemaVersion: 1,
    mode: 'aram_mayhem',
    patchKey: '26.15',
    catalogRevisionId: '40000000-0000-4000-8000-000000000005',
    championExternalId: 'samira',
    augmentExternalIds: ['1194'],
    itemExternalIds: ['3006', '6672'],
  },
};

interface StubReader {
  findCalls: string[];
  listCalls: number;
  findActiveById(publicationId: string): Promise<ActivePublicationRead | null>;
  listActive(): Promise<ActivePublicationRead[]>;
}

function createReader(): StubReader {
  const reader: StubReader = {
    findCalls: [],
    listCalls: 0,
    async findActiveById(publicationId) {
      reader.findCalls.push(publicationId);
      return activePublication;
    },
    async listActive() {
      reader.listCalls += 1;
      return [activePublication];
    },
  };
  return reader;
}

function buildTestApp(reader: StubReader) {
  const options = {
    logger: false,
    publications: reader,
    resources,
  };
  return buildApp(options);
}

test('Publication HTTP list returns the closed list envelope', async () => {
  const app = buildTestApp(createReader());

  const response = await app.inject({
    method: 'GET',
    url: '/api/v1/publications',
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    schemaVersion: 1,
    publications: [activePublication],
  });
  await app.close();
});

test('Publication HTTP single returns the closed single envelope', async () => {
  const reader = createReader();
  const app = buildTestApp(reader);

  const response = await app.inject({
    method: 'GET',
    url: `/api/v1/publications/${PUBLICATION_ID}`,
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    schemaVersion: 1,
    publication: activePublication,
  });
  assert.deepEqual(reader.findCalls, [PUBLICATION_ID]);
  await app.close();
});

test('Publication HTTP invalid UUID returns safe 400 before reader invocation', async () => {
  const reader = createReader();
  const app = buildTestApp(reader);

  const response = await app.inject({
    method: 'GET',
    url: '/api/v1/publications/not-a-uuid',
  });

  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.json(), {
    error: {
      code: 'INVALID_PUBLICATION_ID',
      message: 'Invalid publication id',
    },
  });
  assert.deepEqual(reader.findCalls, []);
  await app.close();
});

test('Publication HTTP missing active Publication returns safe 404', async () => {
  const reader = createReader();
  reader.findActiveById = async (publicationId) => {
    reader.findCalls.push(publicationId);
    return null;
  };
  const app = buildTestApp(reader);

  const response = await app.inject({
    method: 'GET',
    url: `/api/v1/publications/${PUBLICATION_ID}`,
  });

  assert.equal(response.statusCode, 404);
  assert.deepEqual(response.json(), {
    error: {
      code: 'PUBLICATION_NOT_FOUND',
      message: 'Publication not found',
    },
  });
  await app.close();
});

test('Publication HTTP reader failure returns safe 500 without leaking source detail', async () => {
  const sourceDetail = 'password=secret postgres://internal-host/private';
  const reader = createReader();
  reader.listActive = async () => {
    reader.listCalls += 1;
    throw new Error(sourceDetail);
  };
  const app = buildTestApp(reader);

  const response = await app.inject({
    method: 'GET',
    url: '/api/v1/publications',
  });

  assert.equal(response.statusCode, 500);
  assert.deepEqual(response.json(), {
    error: {
      code: 'PUBLICATION_READ_FAILED',
      message: 'Publication read failed',
    },
  });
  assert.doesNotMatch(response.body, /password|postgres:|internal-host|private/i);
  await app.close();
});

test('Publication mutation HTTP methods are not registered', async () => {
  const app = buildTestApp(createReader());

  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
    const response = await app.inject({
      method,
      url: `/api/v1/publications/${PUBLICATION_ID}`,
      payload: {},
    });
    assert.equal(response.statusCode, 404, `${method} must remain unregistered`);
  }
  await app.close();
});
