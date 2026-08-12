import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

async function read(path) {
  try {
    return await readFile(new URL(`../${path}`, import.meta.url), 'utf8');
  } catch (error) {
    assert.fail(
      `required Sprint 5D release artifact is missing: ${path}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

test('release rehearsal keeps Publication authority behind domain commands', async () => {
  const data = await read('backend/src/rehearsal/release-rehearsal-data.ts');
  const versioning = await read('backend/src/rehearsal/release-rehearsal-versioning.ts');
  const cli = await read('backend/src/rehearsal/release-rehearsal-cli.ts');
  const combined = `${data}\n${versioning}\n${cli}`;

  assert.doesNotMatch(combined, /insert\s+into\s+publications\b/i);
  assert.doesNotMatch(combined, /insert\s+into\s+publication_versions\b/i);
  assert.doesNotMatch(combined, /update\s+active_publication_versions\b/i);
  assert.doesNotMatch(combined, /delete\s+from\s+publication(?:s|_versions)?\b/i);
  assert.match(data, /publishCandidateRevision\s*\(/);
  assert.match(versioning, /publishCandidateRevision\s*\(/);
  assert.match(versioning, /rollbackPublication\s*\(/);
  assert.match(cli, /STAGING_REHEARSAL_ENABLED|assertReleaseRehearsalEnabled/);
  for (const operation of ['seed-v1', 'publish-v2', 'rollback-v1', 'verify']) {
    assert.match(cli, new RegExp(operation));
  }
});

test('release browser, backup, security and exact-head workflow artifacts are explicit', async () => {
  const browser = await read('scripts/release-browser-e2e.mjs');
  const backup = await read('scripts/staging-backup-restore.mjs');
  const security = await read('scripts/release-security-gate.mjs');
  const workflow = await read('.github/workflows/sprint-5d-release-candidate.yml');
  const frontendDockerfile = await read('deploy/staging/Dockerfile.frontend');
  const caddy = await read('deploy/staging/Caddyfile');
  const compose = await read('deploy/staging/compose.yml');
  const publicRoutes = await read('backend/src/http/public-publications.ts');

  assert.match(browser, /google-chrome|chromium/i);
  assert.doesNotMatch(browser, /setInterval|setTimeout\s*\([^,]+,\s*\d+/);
  assert.match(backup, /finally\s*\{/);
  assert.match(security, /non-root|Config\.User|docker inspect/i);

  assert.match(frontendDockerfile, /^USER\s+\S+/mi);
  assert.match(caddy, /:8080\b/);
  assert.match(compose, /\$\{STAGING_PORT:-8080\}:8080/);
  assert.doesNotMatch(compose, /^\s{2}worker:/m);

  assert.doesNotMatch(publicRoutes, /\.(?:post|put|patch|delete)\s*\(/i);

  assert.match(workflow, /permissions:\s*\n\s+contents:\s*read/);
  assert.match(workflow, /github\.event\.pull_request\.head\.sha/);
  assert.match(workflow, /git rev-parse HEAD/);
  assert.match(workflow, /RC_READY/);
  assert.match(workflow, /if:\s*always\(\)/);
});

test('release candidate source contract keeps deployment and worker boundaries closed', async () => {
  const workflow = await read('.github/workflows/sprint-5d-release-candidate.yml');
  const compose = await read('deploy/staging/compose.yml');

  assert.doesNotMatch(compose, /^\s{2}worker:/m);
  assert.doesNotMatch(workflow, /gh-pages|pages\/deploy|kubectl\s+apply|terraform\s+apply|wrangler\s+deploy|docker\s+push/i);
  assert.match(workflow, /STAGING_REHEARSAL_ENABLED/);
});
