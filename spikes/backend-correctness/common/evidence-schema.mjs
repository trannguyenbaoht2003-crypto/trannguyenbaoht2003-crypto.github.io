export const EVIDENCE_ARTIFACTS = Object.freeze([
  'run-manifest.json',
  'scenario-results.jsonl',
  'test-report.xml',
  'failure-injection.jsonl',
  'record-counts-before.json',
  'record-counts-after.json',
  'checksums-before.json',
  'checksums-after.json',
  'duplicate-effects.json',
  'audit-coverage.json',
  'outbox-ledger.json',
  'restore-report.json',
  'immutable-diff.json',
  'correctness-summary.md',
]);

export const RUN_MANIFEST_FIELDS = Object.freeze([
  'platform',
  'branchSha',
  'commonHarnessSha',
  'runtimeVersions',
  'fixtureContractVersion',
  'domainSpecVersion',
  'seed',
  'logicalClockOrigin',
]);

export const SCENARIO_RESULT_FIELDS = Object.freeze([
  'scenarioId',
  'status',
  'passReasonCodes',
  'failReasonCodes',
  'beforeChecksum',
  'afterChecksum',
  'assertions',
  'evidenceFiles',
]);
