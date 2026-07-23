import test from 'node:test';
import assert from 'node:assert/strict';
import { parseJunitScenarios, validateEvidenceData } from './evidence-validator.mjs';
import { FAILURE_POINTS, SCENARIOS } from './scenarios.mjs';

const expectedFixtureCounts = {
  rawObservations: 5000,
  candidates: 200,
  claims: 400,
  evidenceAssociations: 1000,
  publications: 10,
  publicationVersions: 20,
};

function validData() {
  const junit = new Map(SCENARIOS.map((scenario) => [
    scenario.id,
    { scenarioId: scenario.id, testName: `${scenario.id} executable`, status: 'PASS', durationSeconds: 0.01 },
  ]));
  const traces = SCENARIOS.map((scenario, index) => ({
    schemaVersion: '1B-C-v2',
    scenarioId: scenario.id,
    testName: `${scenario.id} executable`,
    startedAt: `2026-07-23T00:00:${String(index).padStart(2, '0')}.000Z`,
    completedAt: `2026-07-23T00:01:${String(index).padStart(2, '0')}.000Z`,
    beforeChecksum: `before-${index}`,
    afterChecksum: `after-${index}`,
    beforeCounts: { candidates: 0 },
    afterCounts: { candidates: index + 1 },
  }));
  const failures = Object.keys(FAILURE_POINTS).map((failurePointId, index) => ({
    failurePointId,
    scenarioId: SCENARIOS[index % SCENARIOS.length].id,
    testName: `${SCENARIOS[index % SCENARIOS.length].id} executable`,
    startedAt: '2026-07-23T00:00:00.000Z',
    completedAt: '2026-07-23T00:00:01.000Z',
    beforeChecksum: `failure-before-${index}`,
    afterChecksum: `failure-after-${index}`,
    outcome: 'ASSERTED_BY_PASSING_TEST',
  }));
  return {
    junit,
    traces,
    failures,
    fixtureCounts: expectedFixtureCounts,
    materializedFixtureRecords: Object.values(expectedFixtureCounts).reduce((sum, value) => sum + value, 0),
  };
}

test('JUnit parser takes S1-S24 status from real testcase elements', () => {
  const xml = `<?xml version="1.0"?><testsuites><testsuite>
    <testcase name="S1 transaction atomicity" time="0.5"></testcase>
    <testcase name="S2 collector idempotency" time="0.2"><failure message="boom"/></testcase>
  </testsuite></testsuites>`;
  const parsed = parseJunitScenarios(xml);
  assert.equal(parsed.get('S1').status, 'PASS');
  assert.equal(parsed.get('S2').status, 'FAIL');
});

test('validator accepts a complete runner-backed evidence dataset', () => {
  assert.deepEqual(validateEvidenceData(validData()), { ok: true, scenarioCount: 24, failurePointCount: 12 });
});

test('validator rejects a static PASS row without a runner testcase', () => {
  const data = validData();
  data.junit.delete('S24');
  assert.throws(() => validateEvidenceData(data), /MISSING_JUNIT_SCENARIO:S24/);
});

test('validator rejects repeated uncorrelated scenario checksums', () => {
  const data = validData();
  data.traces = data.traces.map((trace) => ({ ...trace, beforeChecksum: 'same', afterChecksum: 'same' }));
  assert.throws(() => validateEvidenceData(data), /INSUFFICIENT_SCENARIO_STATE_DIVERSITY/);
});

test('validator rejects fixture counts that were not materialized', () => {
  const data = validData();
  data.materializedFixtureRecords = 1;
  assert.throws(() => validateEvidenceData(data), /FIXTURE_NOT_MATERIALIZED/);
});

test('validator rejects failure evidence without timestamps and state', () => {
  const data = validData();
  delete data.failures[0].completedAt;
  assert.throws(() => validateEvidenceData(data), /INVALID_FAILURE_EVIDENCE:F01/);
});
