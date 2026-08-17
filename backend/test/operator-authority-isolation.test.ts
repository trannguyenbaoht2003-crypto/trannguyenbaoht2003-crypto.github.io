import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import test from 'node:test';

const BACKEND_ROOT = new URL('../', import.meta.url);

async function collectTypeScript(relativeDirectory: string): Promise<string[]> {
  const directory = new URL(relativeDirectory, BACKEND_ROOT);
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const relative = join(relativeDirectory, entry.name).replaceAll('\\', '/');
    if (entry.isDirectory()) {
      files.push(...await collectTypeScript(`${relative}/`));
    } else if (entry.isFile() && extname(entry.name) === '.ts') {
      files.push(relative);
    }
  }
  return files;
}

function importSpecifiers(source: string): string[] {
  return [...source.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)].map((match) => match[1] ?? '');
}

test('operator production modules import only read-side PostgreSQL boundaries', async () => {
  const productionFiles = [
    'src/operator-server.ts',
    ...await collectTypeScript('src/operator/'),
    ...await collectTypeScript('src/modules/operator/'),
  ];

  const forbiddenImport = /(?:^|\/)(?:
    publish-candidate-revision|
    rollback-publication|
    submit-publication-feedback|
    evaluate-publication-monitoring|
    evidence(?:\/|-)|
    human-review|
    moderation(?:\/|-)|
    eligibility(?:\/|-)|
    queue(?:\/|-)
  )(?:$|\.|\/)/x;

  for (const relativePath of productionFiles) {
    const source = await readFile(new URL(relativePath, BACKEND_ROOT), 'utf8');
    const imports = importSpecifiers(source);

    for (const specifier of imports) {
      assert.doesNotMatch(
        specifier,
        forbiddenImport,
        `${relativePath} must not import mutation/queue authority: ${specifier}`,
      );
      assert.doesNotMatch(
        specifier,
        /(?:^|\/)(?:ioredis|bullmq)(?:$|\/)/,
        `${relativePath} must not import Redis/BullMQ: ${specifier}`,
      );
    }

    assert.doesNotMatch(source, /\b(?:POST|PUT|PATCH|DELETE)\b\s*['"`]/i, relativePath);
  }
});

test('operator surface has no direct publication/trust mutation call names', async () => {
  const productionFiles = [
    'src/operator-server.ts',
    ...await collectTypeScript('src/operator/'),
    ...await collectTypeScript('src/modules/operator/'),
  ];
  const source = (await Promise.all(
    productionFiles.map((relativePath) => readFile(new URL(relativePath, BACKEND_ROOT), 'utf8')),
  )).join('\n');

  for (const forbidden of [
    'publishCandidateRevision',
    'rollbackPublication',
    'submitPublicationFeedback',
    'evaluatePublicationMonitoring',
    'createHumanReview',
    'recordModeration',
    'evaluateCandidateEligibility',
  ]) {
    assert.doesNotMatch(source, new RegExp(`\\b${forbidden}\\b`), forbidden);
  }
});
