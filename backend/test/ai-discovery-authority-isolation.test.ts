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
    if (entry.isDirectory()) files.push(...await collectTypeScript(`${relative}/`));
    else if (entry.isFile() && extname(entry.name) === '.ts') files.push(relative);
  }
  return files;
}

function importSpecifiers(source: string): string[] {
  return [...source.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)].map((match) => match[1] ?? '');
}

test('AI discovery production modules cannot bypass trust or Publication authority', async () => {
  const productionFiles = await collectTypeScript('src/modules/ai-discovery/');
  const forbiddenImport = /(?:^|\/)(?:evidence|human-review|moderation|eligibility|publication|monitoring|feedback|queue)(?:$|\/|-)/i;

  for (const relativePath of productionFiles) {
    const source = await readFile(new URL(relativePath, BACKEND_ROOT), 'utf8');
    for (const specifier of importSpecifiers(source)) {
      assert.doesNotMatch(specifier, forbiddenImport, `${relativePath}: ${specifier}`);
      assert.doesNotMatch(specifier, /(?:^|\/)(?:ioredis|bullmq|openai|anthropic|axios|undici)(?:$|\/)/i);
    }
    assert.doesNotMatch(source, /\b(?:publishCandidateRevision|rollbackPublication|recordClaimEvidenceDecision|completeHumanReview|evaluateCandidateEligibility|evaluatePublicationMonitoring|submitPublicationFeedback)\b/);
    assert.doesNotMatch(source, /\bfetch\s*\(/);
    assert.doesNotMatch(
      source,
      /\b(?:insert\s+into|update|delete\s+from)\s+(?:candidates|candidate_revisions|normalized_observations|candidate_provenance)\b/i,
      `${relativePath} may only materialize Candidate authority through the existing registration boundary`,
    );
  }
});

test('AI materializer explicitly uses the existing Candidate Registry registration boundary', async () => {
  const source = await readFile(
    new URL('src/modules/ai-discovery/materialize-ai-candidate-proposal.ts', BACKEND_ROOT),
    'utf8',
  );
  assert.match(source, /registerNormalizedObservationInTransaction/);
});
