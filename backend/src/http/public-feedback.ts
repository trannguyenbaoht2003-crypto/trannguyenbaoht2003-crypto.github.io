import type { FastifyInstance } from 'fastify';

import {
  hashFeedbackRequest,
  normalizeFeedbackInput,
} from '../modules/feedback/normalize-feedback-input.js';
import type {
  FeedbackRateLimitInput,
  FeedbackRateLimitResult,
  SubmitPublicationFeedbackCommand,
  SubmitPublicationFeedbackResult,
} from '../modules/feedback/types.js';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface PublicFeedbackIntake {
  fingerprint(gatewayIp: string): string;
  rateLimit(input: FeedbackRateLimitInput): Promise<FeedbackRateLimitResult>;
  submit(command: SubmitPublicationFeedbackCommand): Promise<SubmitPublicationFeedbackResult>;
}

const errorBody = (code: string, message: string) => ({ error: { code, message } });

export function registerPublicFeedbackRoute(
  app: FastifyInstance,
  intake: PublicFeedbackIntake,
): void {
  app.post<{
    Params: { publicationId: string };
    Body: unknown;
  }>(
    '/api/v1/publications/:publicationId/feedback',
    { bodyLimit: 2048 },
    async (request, reply) => {
      const { publicationId } = request.params;
      if (!UUID_PATTERN.test(publicationId)) {
        return reply.code(400).send(errorBody('INVALID_PUBLICATION_ID', 'Invalid publication id'));
      }
      if (request.headers['x-hai-dau-feedback'] !== 'web-v1') {
        return reply.code(400).send(errorBody('INVALID_FEEDBACK_HEADER', 'Invalid feedback request'));
      }
      if (!request.isMultipart() && !request.headers['content-type']?.toLowerCase().startsWith('application/json')) {
        return reply.code(400).send(errorBody('INVALID_CONTENT_TYPE', 'Feedback requires JSON'));
      }

      let normalized;
      try {
        normalized = normalizeFeedbackInput(request.body);
      } catch {
        return reply.code(400).send(errorBody('INVALID_FEEDBACK', 'Invalid feedback'));
      }

      const gatewayIpHeader = request.headers['x-hai-dau-client-ip'];
      const gatewayIp = Array.isArray(gatewayIpHeader) ? undefined : gatewayIpHeader;
      if (!gatewayIp) {
        return reply.code(503).send(errorBody('FEEDBACK_UNAVAILABLE', 'Feedback is temporarily unavailable'));
      }

      const requestHash = hashFeedbackRequest(publicationId, normalized);
      let fingerprint: string;
      try {
        fingerprint = intake.fingerprint(gatewayIp);
      } catch {
        return reply.code(503).send(errorBody('FEEDBACK_UNAVAILABLE', 'Feedback is temporarily unavailable'));
      }

      let limitResult: FeedbackRateLimitResult;
      try {
        limitResult = await intake.rateLimit({
          fingerprint,
          submissionId: normalized.submissionId,
          publicationVersionId: normalized.publicationVersionId,
          reasonCode: normalized.reasonCode,
        });
      } catch {
        app.log.error(
          { publicationId, submissionId: normalized.submissionId, code: 'FEEDBACK_LIMITER_FAILED' },
          'feedback intake failed closed',
        );
        return reply.code(503).send(errorBody('FEEDBACK_UNAVAILABLE', 'Feedback is temporarily unavailable'));
      }

      if (limitResult.outcome === 'denied') {
        return reply
          .header('Retry-After', String(limitResult.retryAfterSeconds))
          .code(429)
          .send(errorBody('FEEDBACK_RATE_LIMITED', 'Feedback rate limit exceeded'));
      }

      try {
        const result = await intake.submit({
          ...normalized,
          publicationId,
          requestHash,
          receivedAt: new Date(),
        });
        if (result.outcome === 'accepted') {
          return reply.code(202).send({ schemaVersion: 1, status: 'accepted' });
        }
        if (result.outcome === 'not_found') {
          return reply.code(404).send(errorBody('PUBLICATION_VERSION_NOT_FOUND', 'Publication version not found'));
        }
        return reply.code(409).send(errorBody('IDEMPOTENCY_CONFLICT', 'Feedback submission conflict'));
      } catch {
        app.log.error(
          { publicationId, submissionId: normalized.submissionId, code: 'FEEDBACK_PERSIST_FAILED' },
          'feedback intake failed closed',
        );
        return reply.code(503).send(errorBody('FEEDBACK_UNAVAILABLE', 'Feedback is temporarily unavailable'));
      }
    },
  );
}
