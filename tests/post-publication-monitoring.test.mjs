import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const read = async (path) => readFile(new URL(path, root), 'utf8');

const alertCodes = [
  'ACTIVE_PUBLICATION_REVALIDATION_REQUIRED',
  'ACTIVE_PUBLICATION_NEEDS_REVIEW',
  'ACTIVE_PUBLICATION_INELIGIBLE',
];

test('Sprint 7A runbook documents every advisory monitoring state', async () => {
  const runbook = await read('docs/runbooks/post-publication-monitoring.md');
  for (const code of alertCodes) {
    assert.match(runbook, new RegExp(code));
  }
  assert.match(runbook, /advisory/i);
  assert.match(runbook, /never.*(?:publish|rollback)|no automatic (?:publish|rollback)/i);
  assert.match(runbook, /SPRINT_7A_REPO_READY/);
  assert.match(runbook, /PRODUCTION_DELIVERY_READY/);
});

test('monitoring queue and private worker runtime are wired with exact names', async () => {
  const [names, worker] = await Promise.all([
    read('backend/src/queue/names.ts'),
    read('backend/src/worker.ts'),
  ]);
  assert.match(names, /hai-dau-monitoring-v1/);
  assert.match(worker, /MONITORING_QUEUE_NAME/);
  assert.match(worker, /createMonitoringWorker/);
  assert.match(worker, /monitoring:\s*monitoringQueue/);
});

test('Sprint 7A uses forward migration 0012 and never rewrites migration 0011', async () => {
  const migrations = await readdir(new URL('backend/migrations/', root));
  assert.ok(migrations.includes('0011_publication_live_eligibility.sql'));
  assert.ok(migrations.includes('0012_post_publication_monitoring.sql'));
  assert.equal(migrations.filter((name) => name.startsWith('0012_')).length, 1);
});

test('monitoring production code cannot call or write Publication mutation authority', async () => {
  const productionFiles = [
    'backend/src/modules/monitoring/compute-publication-monitoring.ts',
    'backend/src/modules/monitoring/evaluate-publication-monitoring.ts',
    'backend/src/modules/monitoring/read-open-publication-monitoring-alerts.ts',
    'backend/src/queue/monitoring-worker.ts',
  ];
  const text = (await Promise.all(productionFiles.map(read))).join('\n');
  assert.doesNotMatch(text, /publish-candidate-revision|rollback-publication/);
  assert.doesNotMatch(
    text,
    /(?:insert\s+into|update|delete\s+from)\s+(?:publications|publication_versions|publication_activation_history|active_publication_versions)\b/i,
  );
});

test('backend source exposes no public monitoring or Publication mutation route', async () => {
  const files = await readdir(new URL('backend/src/', root), { recursive: true });
  const sourceFiles = files.filter((name) => name.endsWith('.ts'));
  const source = (await Promise.all(sourceFiles.map((name) => read(`backend/src/${name}`)))).join('\n');
  assert.doesNotMatch(
    source,
    /\.(?:post|put|patch|delete)\s*\([^\n]*(?:monitoring|publications)/i,
  );
});

test('dedicated Sprint 7A gate is read-only and contains no deployment path', async () => {
  const workflow = await read('.github/workflows/sprint-7a-post-publication-monitoring.yml');
  assert.match(workflow, /^name: Sprint 7A post-publication monitoring gate$/m);
  assert.match(workflow, /^permissions:\n  contents: read$/m);
  assert.match(workflow, /postgres:17/);
  assert.match(workflow, /redis:7/);
  assert.match(workflow, /22\.13\.0/);
  assert.doesNotMatch(workflow, /(contents|packages|pages|id-token):\s*write/);
  assert.doesNotMatch(
    workflow,
    /railway\s+up|wrangler\s+deploy|docker\s+push|git\s+push|actions\/deploy-pages|npm run deploy/i,
  );
});

test('Sprint 7A repository surface contains no committed production credentials', async () => {
  const paths = [
    'backend/src/modules/monitoring/evaluate-publication-monitoring.ts',
    'backend/src/queue/monitoring-worker.ts',
    'backend/src/worker.ts',
    'docs/runbooks/post-publication-monitoring.md',
    '.github/workflows/sprint-7a-post-publication-monitoring.yml',
  ];
  const text = (await Promise.all(paths.map(read))).join('\n');
  const withoutKnownLocalTestFixture = text.replaceAll(
    'postgres://postgres:postgres@127.0.0.1:5432/hai_dau_test',
    'TEST_DATABASE_URL',
  );
  assert.doesNotMatch(withoutKnownLocalTestFixture, /BEGIN (?:RSA|OPENSSH|EC) PRIVATE KEY/);
  assert.doesNotMatch(withoutKnownLocalTestFixture, /postgres(?:ql)?:\/\/[^\s]+:[^\s]+@/i);
  assert.doesNotMatch(withoutKnownLocalTestFixture, /redis:\/\/[^\s]+:[^\s]+@/i);
  assert.doesNotMatch(withoutKnownLocalTestFixture, /Bearer\s+[A-Za-z0-9._-]{20,}/);
});
