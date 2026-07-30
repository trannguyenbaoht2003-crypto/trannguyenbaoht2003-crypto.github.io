import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { buildApp } from '../src/app.js';
import {
  createPublicPublicationReader,
} from '../src/modules/publication/public-publication-reader.js';
import {
  publishCandidateRevision,
} from '../src/modules/publication/publish-candidate-revision.js';
import {
  rollbackPublication,
} from '../src/modules/publication/rollback-publication.js';
import type {
  PublishCandidateRevisionCommand,
  RollbackPublicationCommand,
} from '../src/modules/publication/types.js';
import type { ResourceHealth } from '../src/resources.js';
import { resetDatabase, tableCount } from './helpers/database.js';
import { GATE_IDS } from './helpers/gate.js';
import {
  PUBLICATION_IDS,
  SECOND_PUBLICATION_CONTEXT_IDS,
  seedEligiblePublicationContext,
  seedSecondEligiblePublicationContext,
} from './helpers/publication.js';
import { CROSS_PATCH_IDS } from './helpers/trust.js';

const SECOND_VERSION_IDS = {
  publicationVersionId: '79000000-0000-4000-8000-000000000001',
  activationId: '79000000-0000-4000-8000-000000000002',
  auditId: '79000000-0000-4000-8000-000000000003',
  outboxEventId: '79000000-0000-4000-8000-000000000004',
} as const;

const ROLLBACK_IDS = {
  activationId: '79000000-0000-4000-8000-000000000005',
  auditId: '79000000-0000-4000-8000-000000000006',
  outboxEventId: '79000000-0000-4000-8000-000000000007',
} as const;

const unavailableResources: ResourceHealth = {
  async checkPostgres() {
    return false;
  },
  async checkRedis() {
    return false;
  },
};

function firstPublishCommand(
  overrides: Partial<PublishCandidateRevisionCommand> = {},
): PublishCandidateRevisionCommand {
  return {
    publicationId: PUBLICATION_IDS.publicationId,
    publicationVersionId: PUBLICATION_IDS.publicationVersionId,
    activationId: PUBLICATION_IDS.activationId,
    candidateRevisionId: '62000000-0000-4000-8000-000000000002',
    expectedActiveEligibilityPolicyRevisionId:
      GATE_IDS.eligibilityPolicyId,
    expectedEligibilityEvaluationId: GATE_IDS.eligibilityEvaluationId,
    expectedModerationDecisionId: GATE_IDS.moderationDecisionId,
    expectedActivePublicationVersionId: null,
    authorization: {
      actorId: 'publication-api-editor',
      permissions: ['publisher'],
    },
    auditId: PUBLICATION_IDS.auditId,
    outboxEventId: PUBLICATION_IDS.outboxEventId,
    correlationId: 'publication-api-publish-v1',
    idempotencyKey: 'publication-api-publish-v1',
    occurredAt: '2026-07-29T02:00:00.000Z',
    ...overrides,
  };
}

function secondPublishCommand(): PublishCandidateRevisionCommand {
  return firstPublishCommand({
    publicationVersionId: SECOND_VERSION_IDS.publicationVersionId,
    activationId: SECOND_VERSION_IDS.activationId,
    expectedActivePublicationVersionId:
      PUBLICATION_IDS.publicationVersionId,
    auditId: SECOND_VERSION_IDS.auditId,
    outboxEventId: SECOND_VERSION_IDS.outboxEventId,
    correlationId: 'publication-api-publish-v2',
    idempotencyKey: 'publication-api-publish-v2',
    occurredAt: '2026-07-29T02:10:00.000Z',
  });
}

function secondItemPublishCommand(): PublishCandidateRevisionCommand {
  return {
    publicationId: SECOND_PUBLICATION_CONTEXT_IDS.publicationId,
    publicationVersionId:
      SECOND_PUBLICATION_CONTEXT_IDS.publicationVersionId,
    activationId: SECOND_PUBLICATION_CONTEXT_IDS.activationId,
    candidateRevisionId: CROSS_PATCH_IDS.candidateRevisionId,
    expectedActiveEligibilityPolicyRevisionId:
      GATE_IDS.eligibilityPolicyId,
    expectedEligibilityEvaluationId:
      SECOND_PUBLICATION_CONTEXT_IDS.eligibilityEvaluationId,
    expectedModerationDecisionId:
      SECOND_PUBLICATION_CONTEXT_IDS.moderationDecisionId,
    expectedActivePublicationVersionId: null,
    authorization: {
      actorId: 'second-publication-api-editor',
      permissions: ['publisher'],
    },
    auditId: SECOND_PUBLICATION_CONTEXT_IDS.auditId,
    outboxEventId: SECOND_PUBLICATION_CONTEXT_IDS.outboxEventId,
    correlationId: 'second-publication-api-publish-v1',
    idempotencyKey: 'second-publication-api-publish-v1',
    occurredAt: '2026-07-29T02:05:00.000Z',
  };
}

function rollbackCommand(): RollbackPublicationCommand {
  return {
    publicationId: PUBLICATION_IDS.publicationId,
    targetPublicationVersionId: PUBLICATION_IDS.publicationVersionId,
    activationId: ROLLBACK_IDS.activationId,
    expectedActivePublicationVersionId:
      SECOND_VERSION_IDS.publicationVersionId,
    authorization: {
      actorId: 'publication-api-editor',
      permissions: ['publisher'],
    },
    auditId: ROLLBACK_IDS.auditId,
    outboxEventId: ROLLBACK_IDS.outboxEventId,
    correlationId: 'publication-api-rollback-v1',
    idempotencyKey: 'publication-api-rollback-v1',
    occurredAt: '2026-07-29T02:20:00.000Z',
  };
}

function buildDatabaseApp(
  pool: Awaited<ReturnType<typeof resetDatabase>>,
) {
  return buildApp({
    logger: false,
    publications: createPublicPublicationReader(pool),
    resources: unavailableResources,
  });
}

test('HTTP list hides eligible but unpublished Candidates', async () => {
  const pool = await resetDatabase();
  await seedEligiblePublicationContext(pool);
  const app = buildDatabaseApp(pool);

  const list = await app.inject({
    method: 'GET',
    url: '/api/v1/publications',
  });
  const single = await app.inject({
    method: 'GET',
    url: `/api/v1/publications/${PUBLICATION_IDS.publicationId}`,
  });

  assert.equal(list.statusCode, 200);
  assert.deepEqual(list.json(), { schemaVersion: 1, publications: [] });
  assert.equal(single.statusCode, 404);
  assert.deepEqual(single.json(), {
    error: {
      code: 'PUBLICATION_NOT_FOUND',
      message: 'Publication not found',
    },
  });
  await app.close();
  await pool.end();
});

test('HTTP read returns only the active immutable version and follows rollback immediately', async () => {
  const pool = await resetDatabase();
  await seedEligiblePublicationContext(pool);
  await publishCandidateRevision(pool, firstPublishCommand());
  await publishCandidateRevision(pool, secondPublishCommand());
  const app = buildDatabaseApp(pool);

  const beforeRollback = await app.inject({
    method: 'GET',
    url: `/api/v1/publications/${PUBLICATION_IDS.publicationId}`,
  });
  assert.equal(beforeRollback.statusCode, 200);
  assert.equal(
    beforeRollback.json().publication.publicationVersionId,
    SECOND_VERSION_IDS.publicationVersionId,
  );
  assert.equal(beforeRollback.json().publication.versionNumber, 2);

  await rollbackPublication(pool, rollbackCommand());

  const afterRollback = await app.inject({
    method: 'GET',
    url: `/api/v1/publications/${PUBLICATION_IDS.publicationId}`,
  });
  assert.equal(afterRollback.statusCode, 200);
  assert.equal(
    afterRollback.json().publication.publicationVersionId,
    PUBLICATION_IDS.publicationVersionId,
  );
  assert.equal(afterRollback.json().publication.versionNumber, 1);
  await app.close();
  await pool.end();
});

test('HTTP list preserves deterministic Publication ordering', async () => {
  const pool = await resetDatabase();
  await seedEligiblePublicationContext(pool);
  await seedSecondEligiblePublicationContext(pool);
  await publishCandidateRevision(pool, firstPublishCommand());
  await publishCandidateRevision(pool, secondItemPublishCommand());
  const app = buildDatabaseApp(pool);

  const response = await app.inject({
    method: 'GET',
    url: '/api/v1/publications',
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(
    response.json().publications.map(
      (publication: { publicationId: string }) => publication.publicationId,
    ),
    [
      PUBLICATION_IDS.publicationId,
      SECOND_PUBLICATION_CONTEXT_IDS.publicationId,
    ],
  );
  await app.close();
  await pool.end();
});

test('HTTP Publication reads work with Redis unavailable and zero projection effects', async () => {
  const pool = await resetDatabase();
  await seedEligiblePublicationContext(pool);
  await publishCandidateRevision(pool, firstPublishCommand());
  assert.equal(await tableCount(pool, 'publication_projection_effects'), 0);
  const previousTestRedisUrl = process.env.TEST_REDIS_URL;
  const previousRedisUrl = process.env.REDIS_URL;
  process.env.TEST_REDIS_URL = 'redis://127.0.0.1:1';
  process.env.REDIS_URL = 'redis://127.0.0.1:1';
  const app = buildDatabaseApp(pool);

  try {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/publications',
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(
      response.json().publications.map(
        (publication: { publicationId: string }) => publication.publicationId,
      ),
      [PUBLICATION_IDS.publicationId],
    );
  } finally {
    if (previousTestRedisUrl === undefined) {
      delete process.env.TEST_REDIS_URL;
    } else {
      process.env.TEST_REDIS_URL = previousTestRedisUrl;
    }
    if (previousRedisUrl === undefined) {
      delete process.env.REDIS_URL;
    } else {
      process.env.REDIS_URL = previousRedisUrl;
    }
    await app.close();
    await pool.end();
  }
});

test('Publication HTTP adapter excludes queue and mutation dependencies and server composes the PostgreSQL reader', async () => {
  const routeSource = await readFile(
    new URL('../src/http/public-publications.ts', import.meta.url),
    'utf8',
  );
  const serverSource = await readFile(
    new URL('../src/server.ts', import.meta.url),
    'utf8',
  );

  assert.doesNotMatch(
    routeSource,
    /from ['"][^'"]*(?:pg|ioredis|bullmq|queue|dispatcher|worker|publish-candidate-revision|rollback-publication)[^'"]*['"];/,
  );
  assert.match(
    serverSource,
    /createPublicPublicationReader/,
    'server must import the PostgreSQL Publication reader adapter',
  );
  assert.match(
    serverSource,
    /publications:\s*createPublicPublicationReader\(pool\)/,
    'server must pass only the PostgreSQL reader to Publication routes',
  );
});
