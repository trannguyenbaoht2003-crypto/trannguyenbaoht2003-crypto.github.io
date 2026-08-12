import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('pull-request regression gate audits and builds both production images without deploying', async () => {
  const workflow = await readFile('.github/workflows/backend-production-foundation.yml', 'utf8');

  assert.match(workflow, /Runtime dependency audit/);
  assert.match(workflow, /npm --prefix backend audit --omit=dev --audit-level=high/);
  assert.match(workflow, /Build production gateway image/);
  assert.match(workflow, /docker build -f deploy\/production\/Dockerfile\.gateway/);
  assert.match(workflow, /Build production backend image/);
  assert.match(workflow, /docker build -f backend\/Dockerfile/);

  assert.doesNotMatch(workflow, /railway up/);
  assert.doesNotMatch(workflow, /RAILWAY_TOKEN/);
  assert.doesNotMatch(workflow, /contents:\s*write|pages:\s*write|id-token:\s*write/);
});
