import Fastify, { type FastifyInstance } from 'fastify';

import {
  registerPublicFeedbackRoute,
  type PublicFeedbackIntake,
} from './http/public-feedback.js';
import {
  registerPublicPublicationRoutes,
} from './http/public-publications.js';
import type {
  PublicPublicationReader,
} from './modules/publication/public-publication-reader.js';
import type { ResourceHealth } from './resources.js';

const loggerOptions = {
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.headers.x-hai-dau-client-ip',
      'req.remoteAddress',
      'req.ip',
      'databaseUrl',
      'redisUrl',
      '*.apiKey',
      '*.token',
      '*.feedbackFingerprintSecret',
    ],
    censor: '[REDACTED]',
  },
};

export interface BuildAppOptions {
  resources: ResourceHealth;
  publications: PublicPublicationReader;
  feedback?: PublicFeedbackIntake;
  logger?: boolean;
}

export function buildApp(options: BuildAppOptions): FastifyInstance {
  const app =
    options.logger === false
      ? Fastify({ logger: false })
      : Fastify({ logger: loggerOptions });

  app.get('/health/live', async () => ({ status: 'live' }));

  app.get('/health/ready', async (_request, reply) => {
    const [postgresReady, redisReady] = await Promise.all([
      options.resources.checkPostgres(),
      options.resources.checkRedis(),
    ]);

    if (!postgresReady || !redisReady) {
      return reply.code(503).send({ status: 'not_ready' });
    }
    return { status: 'ready' };
  });

  registerPublicPublicationRoutes(app, options.publications);
  if (options.feedback) {
    registerPublicFeedbackRoute(app, options.feedback);
  }

  return app;
}
