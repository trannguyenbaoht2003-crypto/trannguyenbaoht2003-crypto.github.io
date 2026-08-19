import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

function read(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
}

const REQUIRED = [
  'backend/migrations/0015_ai_operations_policy.sql',
  'backend/src/modules/ai-operations/types.ts',
  'backend/src/modules/ai-operations/register-ai-operations-policy-revision.ts',
  'backend/src/modules/ai-operations/activate-ai-operations-policy-revision.ts',
  'backend/src/modules/ai-operations/reserve-ai-operations-run-budget.ts',
  'backend/src/modules/ai-operations/read-ai-operations-snapshot.ts',
  'backend/src/modules/ai-operations/execute-policy-governed-ai-discovery-run.ts',
  'backend/src/ai-operations-policy-cli.ts',
  'backend/src/ai-operations-tick-cli.ts',
  'backend/src/ai-discovery-materialize-cli.ts',
  'docs/runbooks/ai-operations-policy.md',
  'docs/superpowers/specs/2026-08-18-ai-operations-policy-design.md',
  'docs/superpowers/plans/2026-08-18-ai-operations-policy.md',
  '.github/workflows/sprint-8c-ai-operations-policy.yml',
];

test('Sprint 8C repository contains the complete private operations boundary', () => {
  for (const path of REQUIRED) {
    assert.equal(
      existsSync(new URL(`../${path}`, import.meta.url)),
      true,
      `missing ${path}`,
    );
  }
});

test('AI operations never add public mutation routes or put provider work in the core BullMQ worker', () => {
  const app = read('backend/src/app.ts');
  const operatorHttp = read('backend/src/operator/http.ts');
  const worker = read('backend/src/worker.ts');
  const queueNames = read('backend/src/queue/names.ts');

  for (const source of [app, operatorHttp]) {
    assert.doesNotMatch(source, /ai[-_ ]operations|ai[-_ ]discovery.*materializ/i);
    assert.doesNotMatch(source, /materializeAiCandidateProposal/);
  }
  assert.doesNotMatch(worker, /ai[-_ ]operations|ai[-_ ]provider|ai[-_ ]discovery/i);

  const approvedAiQueueLines = queueNames
    .split('\n')
    .filter((line) => /AI.*QUEUE|ai[-_ ]operations|ai[-_ ]provider/i.test(line));
  assert.deepEqual(approvedAiQueueLines, [
    "export const AI_DISCOVERY_AUTOMATION_QUEUE_NAME = 'hai-dau-ai-discovery-automation-v1';",
  ]);
});

test('policy-governed tick cannot automatically materialize candidates or mutate downstream authorities', () => {
  const governed = read('backend/src/modules/ai-operations/execute-policy-governed-ai-discovery-run.ts');
  const tick = read('backend/src/ai-operations-tick-cli.ts');
  const combined = `${governed}\n${tick}`;

  assert.doesNotMatch(combined, /materializeAiCandidateProposal/);
  assert.doesNotMatch(combined, /completeHumanReview|recordCandidateModerationDecision|evaluateCandidateEligibility|publishCandidateRevision/);
  assert.match(governed, /executeAiDiscoveryProviderRun/);
  assert.match(governed, /reserveAiOperationsRunBudget/);
});

test('explicit materialization CLI is single-proposal and delegates only to existing Sprint 8A authority', () => {
  const materialize = read('backend/src/ai-discovery-materialize-cli.ts');
  assert.match(materialize, /materializeAiCandidateProposal/);
  assert.match(materialize, /aiCandidateProposalId/);
  assert.doesNotMatch(materialize, /proposalIds|Promise\.all|for\s*\([^)]*proposal/i);
  assert.doesNotMatch(materialize, /completeHumanReview|recordCandidateModerationDecision|evaluateCandidateEligibility|publishCandidateRevision/);
});

test('private backend scripts expose policy, tick, and explicit materialization without new dependencies', () => {
  const backendPackage = JSON.parse(read('backend/package.json'));
  assert.equal(backendPackage.scripts['ai-operations:policy'], 'node dist/src/ai-operations-policy-cli.js');
  assert.equal(backendPackage.scripts['ai-operations:tick'], 'node dist/src/ai-operations-tick-cli.js');
  assert.equal(backendPackage.scripts['ai-discovery:materialize'], 'node dist/src/ai-discovery-materialize-cli.js');
  assert.deepEqual(Object.keys(backendPackage.dependencies).sort(), ['bullmq', 'fastify', 'ioredis', 'pg']);
});

test('root verification includes Sprint 8C contract', () => {
  const rootPackage = JSON.parse(read('package.json'));
  assert.equal(
    rootPackage.scripts['test:ai-operations-policy'],
    'node --test tests/ai-operations-policy-contract.test.mjs',
  );
  assert.match(rootPackage.scripts.test, /test:ai-operations-policy/);
});

test('Sprint 8C workflow covers all authority paths, runs the contract, and remains deployment-free', () => {
  const workflow = read('.github/workflows/sprint-8c-ai-operations-policy.yml');
  const requiredPaths = [
    'backend/migrations/0015_ai_operations_policy.sql',
    'backend/src/modules/ai-operations/**',
    'backend/src/ai-operations-policy-cli.ts',
    'backend/src/ai-operations-tick-cli.ts',
    'backend/src/ai-discovery-materialize-cli.ts',
    'backend/test/ai-operations-*.test.ts',
    'backend/test/execute-policy-governed-ai-discovery-run.test.ts',
    'tests/ai-operations-policy-contract.test.mjs',
    'docs/runbooks/ai-operations-policy.md',
    'package.json',
    'backend/package.json',
  ];
  for (const path of requiredPaths) assert.match(workflow, new RegExp(path.replaceAll('*', '\\*')));
  assert.match(workflow, /Sprint 8C repository contract/);
  assert.match(workflow, /npm run test:ai-operations-policy/);
  assert.match(workflow, /permissions:\s*\n\s*contents: read/);
  assert.doesNotMatch(workflow, /(contents|packages|pages|id-token):\s*write/i);

  const executableWorkflow = workflow.split('      - name: Deployment and secret guard')[0] ?? workflow;
  assert.doesNotMatch(
    executableWorkflow,
    /railway\s+up|git\s+push|docker\s+(login|push)|wrangler\s+deploy|actions\/deploy-pages|kubectl|terraform|pulumi/i,
  );
});
