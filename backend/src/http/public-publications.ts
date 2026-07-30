import type { FastifyInstance } from 'fastify';

import type {
  PublicPublicationReader,
} from '../modules/publication/public-publication-reader.js';
import type {
  ActivePublicationRead,
} from '../modules/publication/types.js';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const INVALID_PUBLICATION_ID = {
  error: {
    code: 'INVALID_PUBLICATION_ID',
    message: 'Invalid publication id',
  },
} as const;

const PUBLICATION_NOT_FOUND = {
  error: {
    code: 'PUBLICATION_NOT_FOUND',
    message: 'Publication not found',
  },
} as const;

const PUBLICATION_READ_FAILED = {
  error: {
    code: 'PUBLICATION_READ_FAILED',
    message: 'Publication read failed',
  },
} as const;

function toPublicPublicationResponse(read: ActivePublicationRead) {
  return {
    publicationId: read.publicationId,
    candidateId: read.candidateId,
    candidateRevisionId: read.candidateRevisionId,
    publicationVersionId: read.publicationVersionId,
    versionNumber: read.versionNumber,
    publishedAt: read.publishedAt,
    payload: {
      schemaVersion: read.payload.schemaVersion,
      mode: read.payload.mode,
      patchKey: read.payload.patchKey,
      catalogRevisionId: read.payload.catalogRevisionId,
      championExternalId: read.payload.championExternalId,
      augmentExternalIds: [...read.payload.augmentExternalIds],
      itemExternalIds: [...read.payload.itemExternalIds],
    },
  };
}

export function registerPublicPublicationRoutes(
  app: FastifyInstance,
  reader: PublicPublicationReader,
): void {
  app.get('/api/v1/publications', async (_request, reply) => {
    try {
      const publications = await reader.listActive();
      return {
        schemaVersion: 1,
        publications: publications.map(toPublicPublicationResponse),
      };
    } catch (error) {
      app.log.error({ err: error }, 'public Publication list failed');
      return reply.code(500).send(PUBLICATION_READ_FAILED);
    }
  });

  app.get<{
    Params: { publicationId: string };
  }>('/api/v1/publications/:publicationId', async (request, reply) => {
    const { publicationId } = request.params;
    if (!UUID_PATTERN.test(publicationId)) {
      return reply.code(400).send(INVALID_PUBLICATION_ID);
    }

    try {
      const publication = await reader.findActiveById(publicationId);
      if (!publication) {
        return reply.code(404).send(PUBLICATION_NOT_FOUND);
      }
      return {
        schemaVersion: 1,
        publication: toPublicPublicationResponse(publication),
      };
    } catch (error) {
      app.log.error(
        { err: error, publicationId },
        'public Publication read failed',
      );
      return reply.code(500).send(PUBLICATION_READ_FAILED);
    }
  });
}
