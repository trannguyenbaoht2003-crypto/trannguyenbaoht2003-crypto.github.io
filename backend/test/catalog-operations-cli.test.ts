import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { validCatalogSnapshot } from './helpers/catalog.js';

const cli = new URL('../src/catalog-operations-cli.ts', import.meta.url);
const privateValue = 'postgres://private:do-not-log@127.0.0.1:1/private';

function run(input: unknown, args: string[] = [], databaseUrl = privateValue) {
  return spawnSync(process.execPath, ['--import', 'tsx', cli.pathname, ...args], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
    env: { ...process.env, DATABASE_URL: databaseUrl },
    input: typeof input === 'string' ? input : JSON.stringify(input),
    timeout: 10_000,
    maxBuffer: 2 * 1024 * 1024,
  });
}

test('inspect summarizes a snapshot without a database or source-verification claim', () => {
  const result = run({ action: 'inspect', snapshot: validCatalogSnapshot() });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  const output = JSON.parse(result.stdout);
  assert.equal(output.action, 'inspect');
  assert.equal(output.patchKey, '26.15');
  assert.equal(output.gameModeExternalId, 'aram_mayhem');
  assert.deepEqual(output.entityCounts, { champion: 1, item: 2, augment: 1, mode: 1 });
  assert.equal(output.ruleCount, 1);
  assert.equal(output.sourceVerified, false);
  assert.equal(output.databaseValidated, false);
  assert.match(output.contentHash, /^[a-f0-9]{64}$/u);
  assert.ok(!result.stdout.includes(privateValue));
});

test('inspect hash binds content and ignores only entity/rule ordering', () => {
  const snapshot = validCatalogSnapshot();
  const first = run({ action: 'inspect', snapshot });
  assert.equal(first.status, 0, first.stderr);
  snapshot.entities.reverse();
  snapshot.rules.reverse();
  const reordered = run({ action: 'inspect', snapshot });
  assert.equal(reordered.status, 0, reordered.stderr);
  assert.equal(JSON.parse(first.stdout).contentHash, JSON.parse(reordered.stdout).contentHash);
  snapshot.entities[0]!.displayName = 'A changed catalog name';
  const changed = run({ action: 'inspect', snapshot });
  assert.equal(changed.status, 0, changed.stderr);
  assert.notEqual(JSON.parse(first.stdout).contentHash, JSON.parse(changed.stdout).contentHash);
});

test('malformed snapshots fail before any database operation and do not echo input', () => {
  const snapshot = validCatalogSnapshot();
  const cases: unknown[] = [
    '{broken-json',
    { action: 'publish', secret: privateValue },
    { action: 'inspect', snapshot: validCatalogSnapshot(), apply: true },
  ];
  for (const malformed of [
    { ...snapshot, gameModeExternalId: 'cherry' },
    { ...snapshot, entities: [{ ...snapshot.entities[0], active: 'true' }, ...snapshot.entities.slice(1)] },
    { ...snapshot, entities: [{ ...snapshot.entities[0], unexpected: privateValue }, ...snapshot.entities.slice(1)] },
    { ...snapshot, rules: [{ ...snapshot.rules[0], constraintType: 'invented' }] },
    { ...snapshot, rules: [{ ...snapshot.rules[0], definition: { ...snapshot.rules[0]!.definition, maxSelections: 0 } }] },
    { ...snapshot, source: { ...snapshot.source, sourceDigest: privateValue } },
    { ...snapshot, entities: [...snapshot.entities, snapshot.entities[0]] },
  ]) {
    cases.push({ action: 'inspect', snapshot: malformed });
  }
  for (const input of cases) {
    const result = run(input);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'CATALOG_OPERATIONS_INPUT_INVALID\n');
  }
});

test('activation requires an explicit expected pointer and a private database', () => {
  const input = {
    action: 'activate',
    actorId: 'catalog-operator',
    correlationId: 'catalog-activation-test',
    catalogRevisionId: '40000000-0000-4000-8000-000000000005',
    patchId: '40000000-0000-4000-8000-000000000003',
    reason: 'Activate reviewed catalog',
  };
  const missingPointer = run(input, [], '');
  assert.equal(missingPointer.status, 1);
  assert.equal(missingPointer.stderr, 'CATALOG_OPERATIONS_INPUT_INVALID\n');
  const missingDatabase = run({ ...input, expectedCurrentCatalogRevisionId: null }, [], '');
  assert.equal(missingDatabase.status, 1);
  assert.equal(missingDatabase.stderr, 'CATALOG_OPERATIONS_CONFIG_INVALID\n');
  assert.equal(missingDatabase.stdout, '');
});

test('CLI refuses positional arguments and oversized stdin instead of interpreting them', () => {
  const args = run({ action: 'inspect', snapshot: validCatalogSnapshot() }, ['activate']);
  assert.equal(args.status, 1);
  assert.equal(args.stdout, '');
  assert.equal(args.stderr, 'CATALOG_OPERATIONS_INPUT_INVALID\n');
  const oversized = run(' '.repeat(8 * 1024 * 1024 + 1));
  assert.equal(oversized.status, 1);
  assert.equal(oversized.stdout, '');
  assert.equal(oversized.stderr, 'CATALOG_OPERATIONS_INPUT_INVALID\n');
});

test('database failures expose a safe code without connection strings or stack traces', () => {
  const result = run({
    action: 'validate', actorId: 'catalog-operator', correlationId: 'connection-failure',
    catalogRevisionId: '40000000-0000-4000-8000-000000000005',
    catalogValidationResultId: '47000000-0000-4000-8000-000000000003',
    validatorRulesetVersion: 'catalog-rules-v1', reason: 'Private connection failure check',
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'CATALOG_OPERATIONS_FAILED\n');
});
