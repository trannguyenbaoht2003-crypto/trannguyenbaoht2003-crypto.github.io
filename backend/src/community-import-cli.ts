import { readFile } from 'node:fs/promises';

import { createPool } from './database/pool.js';
import { ingestObservation } from './modules/collector/ingest-observation.js';
import { bootstrapCommunitySource } from './modules/community/bootstrap-community-source.js';
import { buildCommunityObservationBatch, communityReportPatch } from './modules/community/community-inbox-bridge.js';

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value || value.startsWith('--')) {
    throw new Error(`COMMUNITY_IMPORT_ARGUMENT_REQUIRED:${name}`);
  }
  return value;
}

async function jsonFile(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL_REQUIRED');

  const inboxPath = argument('--inbox');
  const reportPath = argument('--report');
  const [inbox, report] = await Promise.all([
    jsonFile(inboxPath),
    jsonFile(reportPath),
  ]);
  const patchKey = communityReportPatch(report);

  const pool = createPool(databaseUrl);
  try {
    const authority = await bootstrapCommunitySource(pool);
    const batch = buildCommunityObservationBatch({
      inbox,
      patchKey,
      sourceId: authority.sourceId,
    });

    let inserted = 0;
    let replayed = 0;
    for (const command of batch.commands) {
      const result = await ingestObservation(pool, command);
      if (result.replayed) replayed += 1;
      else inserted += 1;
    }

    const skippedByReason = new Map<string, number>();
    for (const item of batch.skipped) {
      skippedByReason.set(item.reason, (skippedByReason.get(item.reason) ?? 0) + 1);
    }
    const skipSummary = [...skippedByReason.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([reason, count]) => `${reason}=${count}`)
      .join(',');

    process.stdout.write(
      `community-import inserted=${inserted} replayed=${replayed} skipped=${batch.skipped.length}`
      + `${skipSummary ? ` reasons=${skipSummary}` : ''}\n`,
    );
  } finally {
    await pool.end();
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'UNKNOWN_ERROR';
  process.stderr.write(`community-import failed: ${message}\n`);
  process.exitCode = 1;
});
