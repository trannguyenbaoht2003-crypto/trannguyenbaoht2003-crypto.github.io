import type { Pool } from 'pg';

import {
  readActivePublicationById,
  readActivePublications,
} from './read-active-publications.js';
import type { ActivePublicationRead } from './types.js';

export interface PublicPublicationReader {
  findActiveById(
    publicationId: string,
  ): Promise<ActivePublicationRead | null>;
  listActive(): Promise<ActivePublicationRead[]>;
}

export function createPublicPublicationReader(
  pool: Pool,
): PublicPublicationReader {
  return {
    findActiveById(publicationId) {
      return readActivePublicationById(pool, publicationId);
    },
    listActive() {
      return readActivePublications(pool);
    },
  };
}
