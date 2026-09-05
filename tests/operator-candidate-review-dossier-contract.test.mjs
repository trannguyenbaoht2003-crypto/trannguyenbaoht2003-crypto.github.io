import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';

const text = (path) => readFile(path, 'utf8');

async function files(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map((entry) => entry.isDirectory()
    ? files(`${directory}/${entry.name}`)
    : [`${directory}/${entry.name}`]))).flat();
}

test('candidate dossier has one closed GET-only read boundary', async () => {
  const [reader, http, server] = await Promise.all([
    text('backend/src/modules/operator/read-candidate-review-dossier.ts'),
    text('backend/src/operator/http.ts'),
    text('backend/src/operator-server.ts'),
  ]);
  assert.match(reader, /REPEATABLE READ READ ONLY/);
  assert.doesNotMatch(reader, /\b(?:insert\s+into|update\s+\S+\s+set|delete\s+from)\b/i);
  assert.match(http, /app\.get<[\s\S]*candidate-review-dossiers\/:candidateRevisionId/);
  assert.doesNotMatch(http, /app\.(?:post|put|patch|delete)\([^\n]*candidate-review-dossiers/i);
  assert.match(server, /readOperatorCandidateReviewDossier/);
  assert.doesNotMatch(reader, /raw_blob|aggregate_metadata|content_hash|actor_id|correlation_id/);
  assert.doesNotMatch(reader, /import\s+(?!type\b).*from ['"][^'"]*(?:trust|publication|confidence|ai-)/);
});

test('candidate dossier remains absent from public and deployment surfaces', async () => {
  const paths = (await Promise.all(['app', 'deploy/production', 'deploy/staging'].map(files))).flat();
  for (const path of paths.filter((path) => /\.(?:tsx?|jsx?|json|ya?ml|toml|sh)$|Caddyfile|Dockerfile|\.env/.test(path))) {
    assert.doesNotMatch(await text(path), /candidate-review-dossiers|operator-server|operator:dev/i, path);
  }
});

test('Sprint 9C runbook and deployment-free CI gate are wired', async () => {
  const [runbook, workflow, packageText] = await Promise.all([
    text('docs/runbooks/operator-surface.md'),
    text('.github/workflows/sprint-9c-candidate-review-dossier.yml'),
    text('package.json'),
  ]);
  for (const required of [
    'GET /api/operator/v1/candidate-review-dossiers/:candidateRevisionId',
    'canonical lowercase', 'no query keys', 'latest revision', 'active catalog',
    'sealed claim set', 'unresolved active review policy', 'immutable input-snapshot',
    'current Claim Evidence decision', 'HTTPS', '256 Claims', '64 Evidence', '2,048',
    '400', '404', '503', 'sanitized', 'raw_blob', 'aggregate_metadata',
    'actor', 'correlation', 'HumanReview', 'no mutations',
  ]) assert.ok(runbook.includes(required), `runbook missing: ${required}`);
  const { scripts } = JSON.parse(packageText);
  assert.equal(scripts['test:operator-candidate-review-dossier'], 'node --test tests/operator-candidate-review-dossier-contract.test.mjs');
  assert.match(scripts.test, /test:operator-candidate-review-queue && npm run test:operator-candidate-review-dossier/);
  assert.match(workflow, /permissions:\s*\n\s+contents: read/);
  assert.match(workflow, /postgres:17/);
  assert.match(workflow, /redis:7/); // Only the inherited full backend suite needs Redis.
  assert.match(workflow, /node-version: 22\.13\.0/);
  for (const command of ['npm run test:operator-candidate-review-dossier', 'npm run test:operator-candidate-review-queue', 'npm run test:operator-surface', 'npm --prefix backend test', 'npm --prefix backend run typecheck', 'npm --prefix backend run build']) {
    assert.ok(workflow.includes(command), `CI missing: ${command}`);
  }
  const executable = workflow.split(/\n\s*- name: Deployment guard\n/, 1)[0];
  assert.doesNotMatch(executable, /(?:contents|packages|pages|id-token):\s*write/);
  assert.doesNotMatch(executable, /railway\s+up|git\s+push|actions\/deploy-pages|npm run deploy|wrangler\s+deploy|docker\s+(?:login|push)|kubectl|terraform|pulumi/i);
  assert.doesNotMatch(executable, /RAILWAY_TOKEN|CLOUDFLARE_API_TOKEN|OPENAI_API_KEY|ANTHROPIC_API_KEY|BEGIN (?:RSA|OPENSSH|EC) PRIVATE KEY/);
});
