import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migrationUrl = new URL('../migrations/0017_ai_provider_execution_journal.sql', import.meta.url);

test('0017 defines durable provider execution, attempt, and reconciliation authority', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  for (const table of [
    'ai_provider_executions',
    'ai_provider_execution_attempts',
    'ai_provider_execution_reconciliations',
  ]) assert.match(sql, new RegExp(`create table ${table}`, 'i'));
  for (const status of ['PREPARED','IN_FLIGHT','COMPLETED','FAILED','UNCERTAIN']) assert.match(sql, new RegExp(status));
  for (const decision of ['CONFIRMED_NOT_RECEIVED','CONFIRMED_RECEIVED','ABANDONED']) assert.match(sql, new RegExp(decision));
  assert.match(sql, /current_attempt_ordinal[\s\S]*between 1 and 3/i);
  assert.match(sql, /client_request_id[\s\S]*unique/i);
  assert.match(sql, /raise exception[\s\S]*delete/i);
});
