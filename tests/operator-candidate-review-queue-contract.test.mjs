import assert from 'node:assert/strict';
import { access, readFile, readdir } from 'node:fs/promises';
import test from 'node:test';

async function text(path) {
  return readFile(path, 'utf8');
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

test('candidate review queue has one closed GET-only reader boundary', async () => {
  const [reader, http, server] = await Promise.all([
    text('backend/src/modules/operator/read-candidate-review-queue.ts'),
    text('backend/src/operator/http.ts'),
    text('backend/src/operator-server.ts'),
  ]);

  assert.match(reader, /REPEATABLE READ READ ONLY/);
  assert.doesNotMatch(reader, /\b(?:insert\s+into|update\s+\S+\s+set|delete\s+from)\b/i);
  assert.match(http, /app\.get<\{[\s\S]*?\}>\('\/api\/operator\/v1\/candidate-review-queue'/);
  assert.doesNotMatch(http, /(?:post|put|patch|delete)\('\/api\/operator\/v1\/candidate-review-queue'/i);
  assert.match(server, /readOperatorCandidateReviewQueue/);
});

test('candidate review queue remains absent from public and deployment surfaces', async () => {
  const [productionCaddy, stagingCaddy, productionFiles] = await Promise.all([
    text('deploy/production/Caddyfile'),
    text('deploy/staging/Caddyfile'),
    readdir('deploy/production'),
  ]);
  const productionDeployment = (await Promise.all(
    productionFiles
      .filter((name) => /railway|dockerfile|\.sh$|\.env/i.test(name))
      .map((name) => text(`deploy/production/${name}`)),
  )).join('\n');

  for (const surface of [productionCaddy, stagingCaddy, productionDeployment]) {
    assert.doesNotMatch(surface, /candidate-review-queue|operator-server|operator:dev/i);
  }
  assert.equal(await exists('app/operator'), false);
  assert.equal(await exists('app/api/operator'), false);
});

test('Sprint 9B runbook and deployment-free CI gate are wired', async () => {
  const [runbook, workflow, packageJson] = await Promise.all([
    text('docs/runbooks/operator-surface.md'),
    text('.github/workflows/sprint-9b-candidate-review-queue.yml'),
    text('package.json'),
  ]);

  for (const required of [
    'active catalog',
    'latest revision',
    'sealed claim set',
    'unresolved active review policy',
    'persisted and advisory',
    'never evaluated on read',
    'in_progress',
    'unreviewed',
    'very_high',
    'unscored',
    'sanitized',
  ]) {
    assert.ok(runbook.includes(required), `runbook missing Sprint 9B contract: ${required}`);
  }

  assert.match(packageJson, /"test:operator-candidate-review-queue"/);
  assert.match(workflow, /permissions:\s*\n\s+contents: read/);
  assert.match(workflow, /postgres:17/);
  assert.match(workflow, /redis:7/);
  assert.match(workflow, /node-version: 22\.13\.0/);
  assert.match(workflow, /npm run test:operator-candidate-review-queue/);
  assert.match(workflow, /npm run test:operator-surface/);

  const executableWorkflow = workflow.split(/\n\s*- name: Deployment guard\n/, 1)[0];
  assert.doesNotMatch(executableWorkflow, /(?:contents|packages|pages|id-token):\s*write/);
  assert.doesNotMatch(
    executableWorkflow,
    /railway\s+up|git\s+push|actions\/deploy-pages|npm run deploy/i,
  );
});
