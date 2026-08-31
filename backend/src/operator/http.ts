import Fastify, { type FastifyInstance } from 'fastify';

import type {
  OperatorCandidateReviewQueue,
  OperatorCandidateReviewQueueOptions,
  OperatorSnapshot,
} from '../modules/operator/types.js';
import type {
  ReadOperatorPublicationSignalsOptions,
} from '../modules/operator/read-operator-publication-signals.js';
import {
  OPERATOR_CSS,
  OPERATOR_HTML,
  OPERATOR_JS,
} from './assets.js';

export type OperatorSnapshotRequestOptions = Required<
  Pick<
    ReadOperatorPublicationSignalsOptions,
    'sinceHours' | 'limit' | 'detailSampleLimit' | 'now'
  >
>;

export type OperatorCandidateQueueRequestOptions = Required<
  Pick<OperatorCandidateReviewQueueOptions, 'limit' | 'now'>
>;

export interface BuildOperatorAppOptions {
  readSnapshot(options: OperatorSnapshotRequestOptions): Promise<OperatorSnapshot>;
  readCandidateQueue(
    options: OperatorCandidateQueueRequestOptions,
  ): Promise<OperatorCandidateReviewQueue>;
  checkPostgres(): Promise<boolean>;
  now?: () => Date;
  logger?: boolean;
}

const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
  ].join('; '),
} as const;

const INVALID_QUERY = {
  error: {
    code: 'INVALID_OPERATOR_QUERY',
    message: 'Invalid operator snapshot query',
  },
} as const;

const SNAPSHOT_UNAVAILABLE = {
  error: {
    code: 'OPERATOR_SNAPSHOT_UNAVAILABLE',
    message: 'Operator snapshot is temporarily unavailable',
  },
} as const;

const INVALID_CANDIDATE_QUEUE_QUERY = {
  error: {
    code: 'INVALID_OPERATOR_CANDIDATE_QUEUE_QUERY',
    message: 'Invalid operator candidate queue query',
  },
} as const;

const CANDIDATE_QUEUE_UNAVAILABLE = {
  error: {
    code: 'OPERATOR_CANDIDATE_QUEUE_UNAVAILABLE',
    message: 'Operator candidate queue is temporarily unavailable',
  },
} as const;

const QUERY_KEYS = new Set(['sinceHours', 'limit', 'detailSampleLimit']);
const CANDIDATE_QUEUE_QUERY_KEYS = new Set(['limit']);

function strictInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)$/.test(value)) {
    throw new Error('INVALID_OPERATOR_QUERY');
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error('INVALID_OPERATOR_QUERY');
  }
  return parsed;
}

function parseSnapshotQuery(
  query: Record<string, unknown>,
  now: Date,
): OperatorSnapshotRequestOptions {
  for (const key of Object.keys(query)) {
    if (!QUERY_KEYS.has(key)) throw new Error('INVALID_OPERATOR_QUERY');
  }

  return {
    sinceHours: strictInteger(query.sinceHours, 168, 1, 720),
    limit: strictInteger(query.limit, 50, 1, 100),
    detailSampleLimit: strictInteger(query.detailSampleLimit, 3, 0, 5),
    now,
  };
}

function parseCandidateQueueQuery(
  query: Record<string, unknown>,
  now: Date,
): OperatorCandidateQueueRequestOptions {
  for (const key of Object.keys(query)) {
    if (!CANDIDATE_QUEUE_QUERY_KEYS.has(key)) {
      throw new Error('INVALID_OPERATOR_CANDIDATE_QUEUE_QUERY');
    }
  }
  return {
    limit: strictInteger(query.limit, 50, 1, 100),
    now,
  };
}

export function buildOperatorApp(
  options: BuildOperatorAppOptions,
): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? false });

  app.addHook('onSend', async (_request, reply, payload) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      reply.header(name, value);
    }
    return payload;
  });

  app.get('/health/live', async () => ({ status: 'live' }));

  app.get('/health/ready', async (_request, reply) => {
    try {
      if (await options.checkPostgres()) return { status: 'ready' };
    } catch {
      // Readiness is intentionally closed and PostgreSQL-only.
    }
    return reply.code(503).send({ status: 'not_ready' });
  });

  app.get<{
    Querystring: Record<string, unknown>;
  }>('/api/operator/v1/snapshot', async (request, reply) => {
    let snapshotOptions: OperatorSnapshotRequestOptions;
    try {
      snapshotOptions = parseSnapshotQuery(
        request.query,
        (options.now ?? (() => new Date()))(),
      );
    } catch {
      return reply.code(400).send(INVALID_QUERY);
    }

    try {
      return await options.readSnapshot(snapshotOptions);
    } catch {
      app.log.error(
        { code: 'OPERATOR_SNAPSHOT_READ_FAILED' },
        'operator snapshot read failed',
      );
      return reply.code(503).send(SNAPSHOT_UNAVAILABLE);
    }
  });

  app.get<{
    Querystring: Record<string, unknown>;
  }>('/api/operator/v1/candidate-review-queue', async (request, reply) => {
    let queueOptions: OperatorCandidateQueueRequestOptions;
    try {
      queueOptions = parseCandidateQueueQuery(
        request.query,
        (options.now ?? (() => new Date()))(),
      );
    } catch {
      return reply.code(400).send(INVALID_CANDIDATE_QUEUE_QUERY);
    }

    try {
      return await options.readCandidateQueue(queueOptions);
    } catch {
      app.log.error(
        { code: 'OPERATOR_CANDIDATE_QUEUE_READ_FAILED' },
        'operator candidate queue read failed',
      );
      return reply.code(503).send(CANDIDATE_QUEUE_UNAVAILABLE);
    }
  });

  app.get('/', async (_request, reply) =>
    reply.type('text/html; charset=utf-8').send(OPERATOR_HTML));

  app.get('/operator.js', async (_request, reply) =>
    reply.type('text/javascript; charset=utf-8').send(OPERATOR_JS));

  app.get('/operator.css', async (_request, reply) =>
    reply.type('text/css; charset=utf-8').send(OPERATOR_CSS));

  return app;
}
