import assert from 'node:assert/strict';
import test from 'node:test';
import { Pool } from 'pg';

import { runHumanReviewCli } from '../src/human-review-cli.js';
import { completeHumanReview } from '../src/modules/trust/complete-human-review.js';
import { resolveHumanReviewContext } from '../src/modules/trust/resolve-human-review-context.js';
import { resetDatabase, tableCount, testDatabaseUrl } from './helpers/database.js';
import { CANDIDATE_IDS } from './helpers/candidate.js';
import { seedActivatedGateContext } from './helpers/gate.js';

const databaseTest = { skip: !process.env.TEST_DATABASE_URL, timeout: 20_000 };

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolver) => { resolve = resolver; });
  return { promise, resolve };
}

function args(actor = 'cli-reviewer-a', key = 'cli-review-a', reason = 'Reviewed current evidence'): string[] {
  return [
    '--candidate-revision-id', CANDIDATE_IDS.candidateRevisionId,
    '--actor-id', actor,
    '--outcome', 'confirmed',
    '--reason', reason,
    '--idempotency-key', key,
  ];
}

function debugPool(databaseUrl: string): Pool {
  const pool = new Pool({ connectionString: databaseUrl });
  const connect = pool.connect.bind(pool);
  pool.connect = (async () => {
    const client = await connect();
    const query = client.query.bind(client);
    client.query = (async (...queryArgs: unknown[]) => {
      const result = await Reflect.apply(query, client, queryArgs);
      const sql = typeof queryArgs[0] === 'string' ? queryArgs[0].replace(/\s+/g, ' ').trim() : '';
      if (/from (active_|candidate_|review_|eligibility_|patches|candidates)/i.test(sql)) {
        console.error('DEBUG_QUERY ' + JSON.stringify({ sql, rows: result.rows }));
      }
      return result;
    }) as typeof client.query;
    return client;
  }) as typeof pool.connect;
  return pool;
}

function run(command = args()) {
  return runHumanReviewCli(command, { DATABASE_URL: testDatabaseUrl() }, {
    createPool: debugPool,
    resolveContext: async (pool, candidateRevisionId) => {
      try {
        const context = await resolveHumanReviewContext(pool, candidateRevisionId);
        console.error('DEBUG_CONTEXT ' + JSON.stringify(context));
        return context;
      } catch (error) {
        console.error('DEBUG_CONTEXT_ERROR ' + (error instanceof Error ? error.message : String(error)));
        throw error;
      }
    },
    completeReview: async (pool, commandInput, options) => {
      console.error('DEBUG_COMMAND ' + JSON.stringify(commandInput));
      try {
        return await completeHumanReview(pool, commandInput, options);
      } catch (error) {
        console.error('DEBUG_COMPLETE_ERROR ' + (error instanceof Error ? error.message : String(error)));
        throw error;
      }
    },
  });
}

async function counts(pool: Pool) {
  const tables = [
    'human_reviews', 'review_input_snapshots', 'review_quorum_evaluations',
    'review_quorum_evaluation_reviews', 'audit_events', 'outbox_events',
    'idempotency_records', 'candidate_revisions', 'publication_versions',
  ];
  return Promise.all(tables.map((table) => tableCount(pool, table)));
}

test('real CLI retries before and after quorum preserve the original receipt and all row counts', databaseTest, async (t) => {
  const pool = await resetDatabase();
  t.after(() => pool.end());
  await seedActivatedGateContext(pool);
  const first = await run();
  assert.equal(first.exitCode, 0, first.stderr);
  assert.equal(JSON.parse(first.stdout).quorumSatisfied, false);
  const firstCounts = await counts(pool);
  const retry = await run();
  assert.equal(retry.exitCode, 0, retry.stderr);
  assert.deepEqual(JSON.parse(retry.stdout), { ...JSON.parse(first.stdout), replayed: true });
  assert.deepEqual(await counts(pool), firstCounts);

  const second = await run(args('cli-reviewer-b', 'cli-review-b'));
  assert.equal(second.exitCode, 0, second.stderr);
  assert.equal(JSON.parse(second.stdout).quorumSatisfied, true);
  const completedCounts = await counts(pool);
  const completedRetry = await run(args('cli-reviewer-b', 'cli-review-b'));
  assert.equal(completedRetry.exitCode, 0, completedRetry.stderr);
  assert.deepEqual(JSON.parse(completedRetry.stdout), { ...JSON.parse(second.stdout), replayed: true });
  assert.deepEqual(await counts(pool), completedCounts);

  const afterQuorum = await run(args('cli-reviewer-c', 'cli-review-c'));
  assert.equal(afterQuorum.exitCode, 3);
  assert.deepEqual(await counts(pool), completedCounts);
});

test('real concurrent CLI retries commit one review and return one replay', databaseTest, async (t) => {
  const pool = await resetDatabase();
  t.after(() => pool.end());
  await seedActivatedGateContext(pool);
  const results = await Promise.all([run(), run()]);
  for (const result of results) assert.equal(result.exitCode, 0, result.stderr);
  const receipts = results.map((result) => JSON.parse(result.stdout));
  assert.equal(receipts[0].humanReviewId, receipts[1].humanReviewId);
  assert.deepEqual(receipts.map((result) => result.replayed).sort(), [false, true]);
  assert.equal(await tableCount(pool, 'human_reviews'), 1);
});

test('real concurrent distinct CLI reviewers preserve both reviews and satisfy quorum', databaseTest, async (t) => {
  const pool = await resetDatabase();
  t.after(() => pool.end());
  await seedActivatedGateContext(pool);
  const results = await Promise.all([run(), run(args('cli-reviewer-b', 'cli-review-b'))]);
  for (const result of results) assert.equal(result.exitCode, 0, result.stderr);
  assert.deepEqual(results.map((result) => JSON.parse(result.stdout).confirmedReviewerCount).sort(), [1, 2]);
  assert.equal(await tableCount(pool, 'human_reviews'), 2);
});

test('real CLI rejects changed input under one key and duplicate reviewers without extra effects', databaseTest, async (t) => {
  const pool = await resetDatabase();
  t.after(() => pool.end());
  await seedActivatedGateContext(pool);
  assert.equal((await run()).exitCode, 0);
  const before = await counts(pool);
  const changed = await run(args('cli-reviewer-a', 'cli-review-a', 'Different review'));
  assert.equal(changed.exitCode, 2);
  assert.equal(changed.stdout, '');
  const duplicate = await run(args('cli-reviewer-a', 'another-key'));
  assert.equal(duplicate.exitCode, 4);
  assert.deepEqual(await counts(pool), before);
});

test('real CLI rejects new writes against an inactive catalog while replaying a committed receipt', databaseTest, async (t) => {
  const pool = await resetDatabase();
  t.after(() => pool.end());
  await seedActivatedGateContext(pool);
  assert.equal((await run()).exitCode, 0);
  await pool.query('delete from active_catalog_revisions');
  const before = await counts(pool);
  assert.equal((await run(args('cli-reviewer-b', 'cli-review-b'))).exitCode, 3);
  const replay = await run();
  assert.equal(replay.exitCode, 0, replay.stderr);
  assert.equal(JSON.parse(replay.stdout).replayed, true);
  assert.deepEqual(await counts(pool), before);
});

  for (const [table, column] of [
  ['active_eligibility_policy_revision', 'eligibility_policy_revision_id'],
  ['active_catalog_revisions', 'catalog_revision_id'],
  ] as const) {
  test(`real CLI holds ${table} stable until review commit`, databaseTest, async (t) => {
    const pool = await resetDatabase();
    t.after(() => pool.end());
    await seedActivatedGateContext(pool);
    const entered = deferred<void>();
    const release = deferred<void>();
    const lockQueryPattern = table === 'active_catalog_revisions'
      ? /from active_catalog_revisions/i
      : /from active_eligibility_policy_revision[\s\S]*for share/i;
    const reviewerPool = new Pool({ connectionString: testDatabaseUrl() });
    const connect = reviewerPool.connect.bind(reviewerPool);
    reviewerPool.connect = (async () => {
      const client = await connect();
      const query = client.query.bind(client);
      client.query = (async (...queryArgs: unknown[]) => {
        const result = await Reflect.apply(query, client, queryArgs);
        if (typeof queryArgs[0] === 'string' && lockQueryPattern.test(queryArgs[0])) {
          entered.resolve();
          await release.promise;
        }
        return result;
      }) as typeof client.query;
      return client;
    }) as typeof reviewerPool.connect;
    const review = runHumanReviewCli(args(), { DATABASE_URL: testDatabaseUrl() }, {
      createPool: () => reviewerPool,
      resolveContext: resolveHumanReviewContext,
      completeReview: completeHumanReview,
    });
    const updater = await pool.connect();
    const pid = (await updater.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid;
    let update: Promise<unknown> | undefined;
    let updated = false;
    try {
      await entered.promise;
      update = updater.query(`update ${table} set ${column} = ${column}`).then(() => { updated = true; });
      let blocked = false;
      const deadline = Date.now() + 3_000;
      while (!updated && Date.now() < deadline) {
        const state = await pool.query<{ wait_event_type: string }>(
          'select wait_event_type from pg_stat_activity where pid = $1', [pid],
        );
        if (state.rows[0]?.wait_event_type === 'Lock') { blocked = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(updated, false, 'authority pointer changed before the review committed');
      assert.equal(blocked, true, 'authority pointer update must wait for the review transaction');
    } finally {
      release.resolve();
      const result = await review;
      await update;
      updater.release();
      assert.equal(result.exitCode, 0, result.stderr);
    }
  });
}
