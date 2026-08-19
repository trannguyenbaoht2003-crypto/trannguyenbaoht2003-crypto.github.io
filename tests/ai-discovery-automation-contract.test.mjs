import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import test from 'node:test';

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

test('Sprint 8D repository surface exists and remains private', async () => {
  for (const path of [
    'backend/src/ai-automation-worker.ts',
    'backend/src/ai-automation-status-cli.ts',
    'backend/src/queue/ai-discovery-scheduler.ts',
    'backend/src/queue/ai-discovery-automation-worker.ts',
    '.github/workflows/sprint-8d-ai-discovery-automation.yml',
    'docs/runbooks/ai-discovery-automation.md',
  ]) {
    assert.equal(await exists(path), true, `missing Sprint 8D artifact: ${path}`);
  }

  const backendPackage = JSON.parse(await readFile('backend/package.json', 'utf8'));
  const rootPackage = JSON.parse(await readFile('package.json', 'utf8'));
  assert.equal(typeof backendPackage.scripts?.['start:ai-automation'], 'string');
  assert.equal(typeof backendPackage.scripts?.['ai-automation:status'], 'string');
  assert.equal(typeof rootPackage.scripts?.['test:ai-discovery-automation'], 'string');

  const scheduler = await readFile('backend/src/queue/ai-discovery-scheduler.ts', 'utf8');
  assert.match(scheduler, /ai-discovery-hourly-v1/u);

  const worker = await readFile('backend/src/ai-automation-worker.ts', 'utf8');
  for (const forbidden of [
    'materializeAiCandidateProposal',
    'publishCandidate',
    'activatePublication',
  ]) {
    assert.equal(worker.includes(forbidden), false, `forbidden automation authority: ${forbidden}`);
  }
});
