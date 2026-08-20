import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const roots = [
  'backend/src/modules/ai-provider-execution/process-ai-provider-execution.ts',
  'backend/src/modules/ai-provider-execution/recover-stale-ai-provider-executions.ts',
  'backend/src/modules/ai-provider-execution/reconcile-ai-provider-execution.ts',
];

test('Sprint 8E provider execution authority cannot mutate downstream trust/publication authorities', async () => {
  const source = (await Promise.all(roots.map((path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8')))).join('\n');
  for (const forbidden of [
    'materializeAiCandidateProposal',
    'completeHumanReview',
    'recordEvidence',
    'createPublication',
    'activatePublication',
    'moderation',
    'eligibility',
  ]) assert.doesNotMatch(source, new RegExp(forbidden, 'i'));
  assert.doesNotMatch(source, /OPENAI_API_KEY|Authorization:\s*Bearer|raw prompt|raw provider/i);
});

test('Sprint 8E has a dedicated workflow and remains deployment/secret gated', async () => {
  const workflow = await readFile(new URL('../.github/workflows/sprint-8e-ai-provider-execution-recovery.yml', import.meta.url), 'utf8');
  assert.match(workflow, /Sprint 8E/i);
  assert.doesNotMatch(workflow, /railway\s+up|wrangler\s+deploy|docker\s+push|OPENAI_API_KEY/i);
});
