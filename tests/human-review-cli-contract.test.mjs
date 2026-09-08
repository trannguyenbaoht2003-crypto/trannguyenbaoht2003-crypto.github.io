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

test('Human Review CLI is a private adapter over the trust authority', async () => {
  const [cli, packageText, backendPackageText, runbook] = await Promise.all([
    text('backend/src/human-review-cli.ts'),
    text('package.json'),
    text('backend/package.json'),
    text('docs/runbooks/human-review-cli.md'),
  ]);
  const { scripts } = JSON.parse(packageText);
  const { scripts: backendScripts } = JSON.parse(backendPackageText);

  assert.equal(
    scripts['test:human-review-cli'],
    'node --test tests/human-review-cli-contract.test.mjs',
  );
  assert.equal(
    backendScripts['human-review:complete'],
    'node dist/src/human-review-cli.js',
  );
  assert.match(cli, /completeHumanReview/);
  assert.match(cli, /requireActiveReviewPolicy:\s*true/);
  assert.doesNotMatch(cli, /app\.(?:get|post|put|patch|delete)\s*\(/);
  assert.doesNotMatch(cli, /operator-server|fastify|listen\s*\(/i);
  assert.match(runbook, /idempotency|exit code|REVIEW_INPUT_STALE|loopback|no public route/i);
});

test('Human Review CLI is absent from public and deployment surfaces', async () => {
  const paths = (await Promise.all(
    ['app', 'deploy/production', 'deploy/staging'].map(files),
  )).flat();
  for (const path of paths.filter((value) => (
    /\.(?:tsx?|jsx?|json|ya?ml|toml|sh)$|Caddyfile|Dockerfile|\.env/.test(value)
  ))) {
    assert.doesNotMatch(await text(path), /human-review:complete|human-review-cli/i, path);
  }
});

test('Sprint 9D gate is deployment-free and runs the required verification', async () => {
  const workflow = await text('.github/workflows/sprint-9d-human-review-cli.yml');
  assert.match(workflow, /permissions:\s*\n\s+contents: read/);
  assert.match(workflow, /postgres:17/);
  assert.match(workflow, /redis:7/);
  assert.match(workflow, /node-version: 22\.13\.0/);
  for (const command of [
    'npm run test:human-review-cli',
    'npm run test:operator-surface',
    'npm --prefix backend run typecheck',
    'npm --prefix backend test',
    'npm --prefix backend run build',
    'git diff --check',
  ]) {
    assert.ok(workflow.includes(command), `CI missing: ${command}`);
  }
  const executable = workflow.split(/\n\s*- name: Deployment guard\n/, 1)[0];
  assert.doesNotMatch(executable, /(?:contents|packages|pages|id-token):\s*write/);
  assert.doesNotMatch(executable, /railway\s+up|git\s+push|actions\/deploy-pages|wrangler\s+deploy|docker\s+(?:login|push)|kubectl|terraform|pulumi/i);
  assert.doesNotMatch(executable, /RAILWAY_TOKEN|CLOUDFLARE_API_TOKEN|OPENAI_API_KEY|ANTHROPIC_API_KEY|BEGIN (?:RSA|OPENSSH|EC) PRIVATE KEY/);
});
