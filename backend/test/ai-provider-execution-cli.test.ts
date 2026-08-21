import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const cliUrl = new URL('../src/ai-provider-execution-cli.ts', import.meta.url);

test('private provider execution CLI supports status/recover/reconcile without provider credentials', async () => {
  const source = await readFile(cliUrl, 'utf8');
  assert.match(source, /status/);
  assert.match(source, /recover/);
  assert.match(source, /reconcile/);
  assert.doesNotMatch(source, /OPENAI_API_KEY|createOpenAiResponsesProvider|materializeAiCandidateProposal/);
});
