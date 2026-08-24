import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

async function read(path) {
  return readFile(path, 'utf8');
}

test('production queue backend is Aiven Valkey and not Railway Redis', async () => {
  const [envExample, runbook, backendRunbook, adr] = await Promise.all([
    read('deploy/production/production.env.example'),
    read('docs/runbooks/production-delivery.md'),
    read('backend/README.md'),
    read('docs/adr/0003-production-queue-backend-valkey.md'),
  ]);

  assert.match(envExample, /^REDIS_URL=<AIVEN_VALKEY_SERVICE_URI_SECRET>$/m);
  assert.doesNotMatch(envExample, /\$\{\{Redis\.REDIS_URL\}\}/);

  for (const contract of [
    'Aiven Valkey',
    'rediss://',
    'REDIS_URL',
    'Railway Redis',
    'credential rotation',
  ]) {
    assert.ok(runbook.includes(contract), `production runbook is missing Valkey contract: ${contract}`);
  }

  assert.ok(backendRunbook.includes('Aiven Valkey'));
  assert.ok(backendRunbook.includes('Redis 7'));
  assert.ok(backendRunbook.includes('local/CI'));

  for (const contract of [
    'Status: Accepted',
    'Aiven Valkey',
    'REDIS_URL',
    'Redis 7',
    'PostgreSQL remains',
    'public read',
  ]) {
    assert.ok(adr.includes(contract), `Valkey ADR is missing contract: ${contract}`);
  }
});
