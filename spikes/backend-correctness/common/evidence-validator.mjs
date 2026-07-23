import { FAILURE_POINTS, SCENARIOS } from './scenarios.mjs';

function decodeXml(value) {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

function attribute(source, name) {
  const match = source.match(new RegExp(`\\b${name}="([^"]*)"`));
  return match ? decodeXml(match[1]) : null;
}

export function parseJunitScenarios(xml) {
  const results = new Map();
  const testcasePattern = /<testcase\b([^>]*)(?:\/>|>([\s\S]*?)<\/testcase>)/g;
  for (const match of xml.matchAll(testcasePattern)) {
    const testName = attribute(match[1], 'name') ?? '';
    const scenarioId = testName.match(/^S(?:[1-9]|1\d|2[0-4])\b/)?.[0];
    if (!scenarioId) continue;
    const body = match[2] ?? '';
    const status = /<(?:failure|error)\b/.test(body) ? 'FAIL' : /<skipped\b/.test(body) ? 'SKIP' : 'PASS';
    results.set(scenarioId, {
      scenarioId,
      testName,
      status,
      durationSeconds: Number(attribute(match[1], 'time') ?? 0),
    });
  }
  return results;
}

function requiredString(record, field) {
  return typeof record?.[field] === 'string' && record[field].length > 0;
}

export function validateEvidenceData(data) {
  for (const scenario of SCENARIOS) {
    const junit = data.junit.get(scenario.id);
    if (!junit) throw new Error(`MISSING_JUNIT_SCENARIO:${scenario.id}`);
    if (junit.status !== 'PASS') throw new Error(`SCENARIO_NOT_PASSING:${scenario.id}:${junit.status}`);
    const trace = data.traces.find((entry) => entry.scenarioId === scenario.id);
    if (!trace) throw new Error(`MISSING_SCENARIO_TRACE:${scenario.id}`);
    for (const field of ['testName', 'startedAt', 'completedAt', 'beforeChecksum', 'afterChecksum']) {
      if (!requiredString(trace, field)) throw new Error(`INVALID_SCENARIO_TRACE:${scenario.id}:${field}`);
    }
    if (trace.testName !== junit.testName) throw new Error(`TESTCASE_TRACE_MISMATCH:${scenario.id}`);
    if (!trace.beforeCounts || !trace.afterCounts) throw new Error(`MISSING_SCENARIO_COUNTS:${scenario.id}`);
  }

  const statePairs = new Set(data.traces.map((trace) => `${trace.beforeChecksum}:${trace.afterChecksum}`));
  if (statePairs.size < 12) throw new Error('INSUFFICIENT_SCENARIO_STATE_DIVERSITY');

  const expectedMaterialized = Object.values(data.fixtureCounts).reduce((sum, value) => sum + Number(value), 0);
  if (data.materializedFixtureRecords < expectedMaterialized) throw new Error('FIXTURE_NOT_MATERIALIZED');

  for (const failurePointId of Object.keys(FAILURE_POINTS)) {
    const entry = data.failures.find((failure) => failure.failurePointId === failurePointId);
    if (!entry || !['scenarioId', 'testName', 'startedAt', 'completedAt', 'beforeChecksum', 'afterChecksum', 'outcome']
      .every((field) => requiredString(entry, field))) {
      throw new Error(`INVALID_FAILURE_EVIDENCE:${failurePointId}`);
    }
    if (data.junit.get(entry.scenarioId)?.status !== 'PASS') {
      throw new Error(`FAILURE_EVIDENCE_NOT_BACKED_BY_PASSING_TEST:${failurePointId}`);
    }
  }

  return { ok: true, scenarioCount: SCENARIOS.length, failurePointCount: Object.keys(FAILURE_POINTS).length };
}
