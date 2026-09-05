import { Pool } from 'pg';

import {
  readOperatorCandidateReviewDossier,
} from './modules/operator/read-candidate-review-dossier.js';
import {
  readOperatorCandidateReviewQueue,
} from './modules/operator/read-candidate-review-queue.js';
import {
  readOperatorPublicationSignals,
} from './modules/operator/read-operator-publication-signals.js';
import { parseOperatorConfig } from './operator/config.js';
import { buildOperatorApp } from './operator/http.js';

async function main(): Promise<void> {
  const config = parseOperatorConfig(process.env);
  const pool = new Pool({ connectionString: config.databaseUrl });

  const app = buildOperatorApp({
    readCandidateDossier: ({ candidateRevisionId, now }) =>
      readOperatorCandidateReviewDossier(
        pool,
        candidateRevisionId,
        { now },
      ),
    readCandidateQueue: (options) =>
      readOperatorCandidateReviewQueue(pool, options),
    readSnapshot: (options) => readOperatorPublicationSignals(pool, options),
    checkPostgres: async () => {
      try {
        await pool.query('select 1');
        return true;
      } catch {
        return false;
      }
    },
  });

  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, 'shutting down operator server');
    await app.close();
    await pool.end();
  };

  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ host: config.host, port: config.port });
}

void main().catch(() => {
  process.stderr.write('Operator startup failed\n');
  process.exitCode = 1;
});
