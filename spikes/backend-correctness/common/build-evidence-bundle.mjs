import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { CONTRACT_VERSION, DOMAIN_SPEC_VERSION, FIXED_SEED, CLOCK_ORIGIN } from './generate-fixture.mjs';
import { FAILURE_POINTS, SCENARIOS } from './scenarios.mjs';
import { parseJunitScenarios, validateEvidenceData } from './evidence-validator.mjs';

const FAILURE_SCENARIOS = Object.freeze({
  F01: 'S1', F02: 'S1', F03: 'S4', F04: 'S4', F05: 'S4', F06: 'S5',
  F07: 'S9', F08: 'S10', F09: 'S13', F10: 'S14', F11: 'S4', F12: 'S3',
});

function jsonl(records) {
  return `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
}

function uniqueBy(records, key) {
  return [...new Map(records.map((record) => [record[key], record])).values()];
}

export async function buildEvidenceBundle({
  adapter,
  metadata,
  runtimeVersions,
  outputDir,
  tracePath = path.join(outputDir, 'scenario-trace.jsonl'),
  junitPath = path.join(outputDir, 'test-report.xml'),
  title,
}) {
  await mkdir(outputDir, { recursive: true });
  const [traceText, junitXml] = await Promise.all([
    readFile(tracePath, 'utf8'),
    readFile(junitPath, 'utf8'),
  ]);
  const traces = traceText.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const junit = parseJunitScenarios(junitXml);

  await adapter.resetEnvironment();
  const emptySnapshot = await adapter.snapshotState();
  const checksumsBefore = await adapter.computeChecksums();
  const fixture = await adapter.loadFixture();
  const loadedSnapshot = await adapter.snapshotState();
  const checksumsAfter = await adapter.computeChecksums();

  const failures = Object.entries(FAILURE_POINTS).map(([failurePointId, semantic]) => {
    const scenarioId = FAILURE_SCENARIOS[failurePointId];
    const trace = traces.find((entry) => entry.scenarioId === scenarioId);
    return {
      failurePointId,
      semantic,
      scenarioId,
      testName: trace?.testName,
      startedAt: trace?.startedAt,
      completedAt: trace?.completedAt,
      beforeChecksum: trace?.beforeChecksum,
      afterChecksum: trace?.afterChecksum,
      outcome: junit.get(scenarioId)?.status === 'PASS' ? 'ASSERTED_BY_PASSING_TEST' : 'NOT_PROVEN',
    };
  });

  const validation = validateEvidenceData({
    junit,
    traces,
    failures,
    fixtureCounts: fixture.counts,
    materializedFixtureRecords: loadedSnapshot.counts.fixture_records,
  });

  const scenarioResults = SCENARIOS.map((scenario) => {
    const result = junit.get(scenario.id);
    const trace = traces.find((entry) => entry.scenarioId === scenario.id);
    return {
      scenarioId: scenario.id,
      status: result.status,
      passReasonCodes: result.status === 'PASS' ? scenario.passReasonCodes : [],
      failReasonCodes: result.status === 'PASS' ? [] : scenario.failReasonCodes,
      testName: result.testName,
      durationSeconds: result.durationSeconds,
      startedAt: trace.startedAt,
      completedAt: trace.completedAt,
      beforeChecksum: trace.beforeChecksum,
      afterChecksum: trace.afterChecksum,
      beforeCounts: trace.beforeCounts,
      afterCounts: trace.afterCounts,
      assertions: scenario.expected.assertions.map((assertion) => ({ assertion, status: result.status })),
      evidenceFiles: ['test-report.xml', 'scenario-trace.jsonl', 'failure-injection.jsonl'],
    };
  });

  const auditEvents = uniqueBy(traces.flatMap((trace) => trace.auditEvents.map((entry) => ({
    scenarioId: trace.scenarioId,
    ...entry,
  }))), 'audit_id');
  const outboxEntries = uniqueBy(traces.flatMap((trace) => trace.outboxLedger.map((entry) => ({
    scenarioId: trace.scenarioId,
    ...entry,
  }))), 'event_id');
  const s13 = traces.find((trace) => trace.scenarioId === 'S13');
  const s22 = traces.find((trace) => trace.scenarioId === 'S22');
  const monitoring = s22?.candidateProjection.find((row) => row.candidate_id === 'candidate-s22');
  const immutableScenarioIds = ['S10', 'S24'];
  const immutablePass = immutableScenarioIds.every((id) => junit.get(id)?.status === 'PASS');

  const artifacts = {
    'run-manifest.json': {
      evidenceContractVersion: '1B-C-v2',
      platform: metadata.platform,
      branchSha: process.env.GITHUB_SHA ?? 'local',
      commonHarnessSha: metadata.commonHarnessSha,
      runtimeVersions,
      fixtureContractVersion: CONTRACT_VERSION,
      domainSpecVersion: DOMAIN_SPEC_VERSION,
      seed: FIXED_SEED,
      logicalClockOrigin: CLOCK_ORIGIN,
      fixtureChecksum: fixture.checksum,
      validator: validation,
    },
    'record-counts-before.json': {
      domainTables: emptySnapshot.counts,
      fixtureEntities: emptySnapshot.fixtureCounts,
      materializedFixtureRecords: emptySnapshot.counts.fixture_records,
    },
    'record-counts-after.json': {
      domainTables: loadedSnapshot.counts,
      fixtureEntities: loadedSnapshot.fixtureCounts,
      expectedFixtureEntities: fixture.counts,
      materializedFixtureRecords: loadedSnapshot.counts.fixture_records,
    },
    'checksums-before.json': checksumsBefore,
    'checksums-after.json': { ...checksumsAfter, fixture: fixture.checksum },
    'duplicate-effects.json': {
      scenarioId: 'S22',
      testName: junit.get('S22').testName,
      monitoringTransitionCount: monitoring?.transition_count ?? null,
      duplicateSideEffects: monitoring?.transition_count === 1 ? 0 : 1,
      status: junit.get('S22').status,
    },
    'audit-coverage.json': {
      scenarioCount: traces.length,
      auditedMutationCount: auditEvents.length,
      scenarios: traces.map((trace) => ({
        scenarioId: trace.scenarioId,
        auditEventCount: trace.auditEvents.length,
        testStatus: junit.get(trace.scenarioId).status,
      })),
      pass: traces.length === 24 && traces.every((trace) => junit.get(trace.scenarioId).status === 'PASS'),
    },
    'outbox-ledger.json': {
      total: outboxEntries.length,
      delivered: outboxEntries.filter((event) => event.delivery_state === 'delivered').length,
      entries: outboxEntries,
    },
    'restore-report.json': {
      scenarioId: 'S13',
      testName: junit.get('S13').testName,
      status: junit.get('S13').status,
      fixtureChecksum: fixture.checksum,
      restoredFixtureCounts: s13?.afterFixtureCounts ?? {},
      expectedFixtureCounts: fixture.counts,
    },
    'immutable-diff.json': {
      scenarioIds: immutableScenarioIds,
      status: immutablePass ? 'PASS' : 'FAIL',
      mutatedRows: immutablePass ? 0 : null,
      evidence: immutableScenarioIds.map((id) => ({
        scenarioId: id,
        testName: junit.get(id).testName,
        status: junit.get(id).status,
      })),
    },
  };

  await Promise.all([
    ...Object.entries(artifacts).map(([name, value]) => writeFile(path.join(outputDir, name), `${JSON.stringify(value, null, 2)}\n`)),
    writeFile(path.join(outputDir, 'scenario-results.jsonl'), jsonl(scenarioResults)),
    writeFile(path.join(outputDir, 'failure-injection.jsonl'), jsonl(failures)),
  ]);

  const status = scenarioResults.every((row) => row.status === 'PASS')
    && failures.every((row) => row.outcome === 'ASSERTED_BY_PASSING_TEST')
    && monitoring?.transition_count === 1
    && immutablePass
    && loadedSnapshot.counts.fixture_records === Object.values(fixture.counts).reduce((sum, value) => sum + value, 0)
    ? 'PASS'
    : 'FAIL';
  await writeFile(path.join(outputDir, 'correctness-summary.md'),
    `# ${title}\n\n- Status: ${status}\n- Evidence contract: 1B-C-v2\n- Platform: ${metadata.platform}\n- Common Harness SHA: ${metadata.commonHarnessSha}\n- Fixture checksum: ${fixture.checksum}\n- Materialized fixture records: ${loadedSnapshot.counts.fixture_records}\n- S1–S24: ${scenarioResults.filter((row) => row.status === 'PASS').length}/24 PASS\n- F01–F12: ${failures.filter((row) => row.outcome === 'ASSERTED_BY_PASSING_TEST').length}/12 runner-backed\n- Production deployment: disabled\n`);

  if (status !== 'PASS') throw new Error('EVIDENCE_BUNDLE_V2_FAILED');
  return { status, validation, scenarioResults, failures };
}
