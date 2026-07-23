import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { checksum } from './generate-fixture.mjs';

function counts(snapshot) {
  return snapshot?.counts ?? {};
}

export function createEvidenceRecorder({ platform, tracePath = process.env.EVIDENCE_TRACE_FILE } = {}) {
  let active = null;

  async function append(record) {
    if (!tracePath) return;
    await mkdir(path.dirname(tracePath), { recursive: true });
    await appendFile(tracePath, `${JSON.stringify(record)}\n`);
  }

  return Object.freeze({
    enabled: Boolean(tracePath),

    async begin(scenario, snapshot) {
      active = {
        schemaVersion: '1B-C-v2',
        platform,
        scenarioId: scenario.id,
        testName: null,
        startedAt: new Date().toISOString(),
        beforeChecksum: checksum(snapshot),
        beforeCounts: counts(snapshot),
        beforeFixtureCounts: snapshot?.fixtureCounts ?? {},
        failurePoints: scenario.failurePoints,
      };
    },

    async complete({ testName, snapshot, evidence = null }) {
      if (!active) return;
      const completed = {
        ...active,
        testName,
        completedAt: new Date().toISOString(),
        afterChecksum: checksum(snapshot),
        afterCounts: counts(snapshot),
        beforeFixtureCounts: active.beforeFixtureCounts ?? {},
        afterFixtureCounts: snapshot?.fixtureCounts ?? {},
        activePublications: snapshot?.activePublications ?? [],
        candidateProjection: snapshot?.candidateProjection ?? [],
        auditEvents: evidence?.auditEvents ?? [],
        outboxLedger: evidence?.outboxLedger ?? [],
        deadLetters: evidence?.deadLetters ?? [],
      };
      active = null;
      await append(completed);
    },
  });
}
