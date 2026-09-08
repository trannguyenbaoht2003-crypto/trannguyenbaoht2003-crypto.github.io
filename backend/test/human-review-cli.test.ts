import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool } from 'pg';

import {
  parseHumanReviewCliArgs,
  parseHumanReviewCliConfig,
  runHumanReviewCli,
} from '../src/human-review-cli.js';
import type { HumanReviewCliDependencies } from '../src/human-review-cli.js';
import type { CompleteHumanReviewOptions } from '../src/modules/trust/complete-human-review.js';
import { resolveHumanReviewContext } from '../src/modules/trust/resolve-human-review-context.js';

const IDS = {
  candidate: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  policy: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
};

function validArgs(): string[] {
  return [
    '--candidate-revision-id', IDS.candidate,
    '--actor-id', 'reviewer-01',
    '--outcome', 'confirmed',
    '--reason', 'Evidence reviewed against the current dossier',
    '--idempotency-key', 'review-2026-09-05-001',
  ];
}

test('human review CLI parses the exact reviewer-facing contract', () => {
  assert.deepEqual(parseHumanReviewCliArgs(validArgs()), {
    candidateRevisionId: IDS.candidate,
    actorId: 'reviewer-01',
    outcome: 'confirmed',
    reason: 'Evidence reviewed against the current dossier',
    idempotencyKey: 'review-2026-09-05-001',
    correlationId: undefined,
  });
});

test('human review CLI accepts an optional correlation id', () => {
  assert.equal(
    parseHumanReviewCliArgs([
      ...validArgs(),
      '--correlation-id', IDS.policy,
    ]).correlationId,
    IDS.policy,
  );
});

test('human review CLI rejects caller-controlled authority ids and unknown flags', () => {
  assert.throws(
    () => parseHumanReviewCliArgs([
      ...validArgs(),
      '--review-policy-revision-id', IDS.policy,
    ]),
    /HUMAN_REVIEW_CLI_INPUT_INVALID/,
  );
  assert.throws(
    () => parseHumanReviewCliArgs([...validArgs(), '--unknown', 'value']),
    /HUMAN_REVIEW_CLI_INPUT_INVALID/,
  );
});

test('human review CLI rejects duplicate, missing, malformed, and out-of-range values', () => {
  assert.throws(
    () => parseHumanReviewCliArgs([
      ...validArgs(),
      '--outcome', 'declined',
    ]),
    /HUMAN_REVIEW_CLI_INPUT_INVALID/,
  );
  assert.throws(
    () => parseHumanReviewCliArgs(validArgs().slice(0, -1)),
    /HUMAN_REVIEW_CLI_INPUT_INVALID/,
  );
  assert.throws(
    () => parseHumanReviewCliArgs([
      ...validArgs().slice(0, 4),
      'not-a-uuid',
      '--reason', 'reason',
      '--idempotency-key', 'key',
    ]),
    /HUMAN_REVIEW_CLI_INPUT_INVALID/,
  );
  assert.throws(
    () => parseHumanReviewCliArgs([
      '--candidate-revision-id', IDS.candidate,
      '--actor-id', 'reviewer-01',
      '--outcome', 'approved',
      '--reason', 'reason',
      '--idempotency-key', 'key',
    ]),
    /HUMAN_REVIEW_CLI_INPUT_INVALID/,
  );
  assert.throws(
    () => parseHumanReviewCliArgs([
      '--candidate-revision-id', IDS.candidate,
      '--actor-id', ' '.repeat(257),
      '--outcome', 'confirmed',
      '--reason', 'reason',
      '--idempotency-key', 'key',
    ]),
    /HUMAN_REVIEW_CLI_INPUT_INVALID/,
  );
  assert.throws(
    () => parseHumanReviewCliArgs([
      '--candidate-revision-id', IDS.candidate,
      '--actor-id', 'reviewer-01',
      '--outcome', 'confirmed',
      '--reason', 'x'.repeat(1_025),
      '--idempotency-key', 'key',
    ]),
    /HUMAN_REVIEW_CLI_INPUT_INVALID/,
  );
});

test('human review CLI validates DATABASE_URL without exposing its value', () => {
  assert.deepEqual(
    parseHumanReviewCliConfig({ DATABASE_URL: 'postgres://localhost/hai_dau' }),
    { databaseUrl: 'postgres://localhost/hai_dau' },
  );
  assert.throws(
    () => parseHumanReviewCliConfig({ DATABASE_URL: ' ' }),
    /HUMAN_REVIEW_CLI_CONFIG_INVALID/,
  );
});

function fakePool(rows: Array<Record<string, unknown>>): {
  pool: Pool;
  calls: Array<{ text: string; values?: unknown[] }>;
  released: () => number;
} {
  const calls: Array<{ text: string; values?: unknown[] }> = [];
  let releaseCount = 0;
  const client = {
    async query(text: string, values?: unknown[]) {
      calls.push(values === undefined ? { text } : { text, values });
      if (/^(?:select|with)\b/i.test(text.trim())) {
        return { rows, rowCount: rows.length };
      }
      return { rows: [], rowCount: 0 };
    },
    release() {
      releaseCount += 1;
    },
  };
  return {
    pool: { connect: async () => client } as unknown as Pool,
    calls,
    released: () => releaseCount,
  };
}

test('resolver returns candidate ownership and the active review policy in a read-only transaction', async () => {
  const db = fakePool([{
    candidate_id: IDS.candidate,
    review_policy_revision_id: IDS.policy,
  }]);

  assert.deepEqual(
    await resolveHumanReviewContext(db.pool, IDS.candidate),
    {
      candidateId: IDS.candidate,
      reviewPolicyRevisionId: IDS.policy,
    },
  );
  assert.equal(db.calls[0]?.text, 'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  assert.equal(db.calls.at(-1)?.text, 'COMMIT');
  assert.equal(db.released(), 1);
  assert.ok(db.calls.some((call) => /^(?:select|with)\b/i.test(call.text.trim())));
  assert.ok(db.calls.every((call) => !/\b(?:insert|update|delete)\b/i.test(call.text)));
});

test('resolver fails closed when the revision or active policy is not unique', async () => {
  await assert.rejects(
    resolveHumanReviewContext(fakePool([]).pool, IDS.candidate),
    /REVIEW_INPUT_STALE/,
  );
  await assert.rejects(
    resolveHumanReviewContext(fakePool([
      { candidate_id: IDS.candidate, review_policy_revision_id: IDS.policy },
      { candidate_id: IDS.candidate, review_policy_revision_id: IDS.policy },
    ]).pool, IDS.candidate),
    /REVIEW_INPUT_STALE/,
  );
});

test('human review CLI emits a closed JSON result and enforces the active-policy option', async () => {
  const pool = { end: async () => undefined } as unknown as Pool;
  let receivedCommand: {
    permissionUsed?: string;
    candidateId?: string;
    reviewPolicyRevisionId?: string;
  } | undefined;
  let receivedOptions: CompleteHumanReviewOptions | undefined;
  const result = await runHumanReviewCli(
    validArgs(),
    { DATABASE_URL: 'postgres://localhost/hai_dau' },
    {
      createPool: () => pool,
      resolveContext: async () => ({
        candidateId: IDS.candidate,
        reviewPolicyRevisionId: IDS.policy,
      }),
      completeReview: async (_pool, command, options) => {
        receivedCommand = command;
        receivedOptions = options;
        return {
          candidateRevisionId: IDS.candidate,
          humanReviewId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          inputHash: 'd'.repeat(64),
          quorumEvaluationId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
          confirmedReviewerCount: 1,
          requiredConfirmedReviews: 1,
          quorumSatisfied: true,
          replayed: false,
        };
      },
    },
  );

  assert.deepEqual(result, {
    exitCode: 0,
    stdout: `${JSON.stringify({
      candidateRevisionId: IDS.candidate,
      humanReviewId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      outcome: 'confirmed',
      confirmedReviewerCount: 1,
      requiredConfirmedReviews: 1,
      quorumSatisfied: true,
      replayed: false,
    })}\n`,
    stderr: '',
  });
  assert.equal(receivedCommand?.permissionUsed, 'reviewer');
  assert.equal(receivedCommand?.candidateId, IDS.candidate);
  assert.equal(receivedCommand?.reviewPolicyRevisionId, IDS.policy);
  assert.equal(receivedOptions?.requireActiveReviewPolicy, true);
  assert.equal(receivedOptions?.idempotencyScope, 'human_review_cli_completion');
  assert.match(receivedOptions?.idempotencyPayloadHash ?? '', /^[0-9a-f]{64}$/);
  assert.equal('reason' in JSON.parse(result.stdout), false);
});

test('human review CLI derives the same internal identifiers and receipt hash on retry', async () => {
  const pool = { end: async () => undefined } as unknown as Pool;
  const commands: Array<{
    humanReviewId: string;
    reviewInputSnapshotId: string;
    reviewQuorumEvaluationId: string;
    correlationId: string;
    options: CompleteHumanReviewOptions;
  }> = [];
  const dependencies = {
    createPool: () => pool,
    resolveContext: async () => ({
      candidateId: IDS.candidate,
      reviewPolicyRevisionId: IDS.policy,
    }),
    completeReview: async (_pool: Pool, command: Parameters<NonNullable<HumanReviewCliDependencies['completeReview']>>[1], options: CompleteHumanReviewOptions) => {
      commands.push({
        humanReviewId: command.humanReviewId,
        reviewInputSnapshotId: command.reviewInputSnapshotId,
        reviewQuorumEvaluationId: command.reviewQuorumEvaluationId,
        correlationId: command.correlationId,
        options,
      });
      return {
        candidateRevisionId: command.candidateRevisionId,
        humanReviewId: command.humanReviewId,
        inputHash: 'd'.repeat(64),
        quorumEvaluationId: command.reviewQuorumEvaluationId,
        confirmedReviewerCount: 1,
        requiredConfirmedReviews: 2,
        quorumSatisfied: false,
        replayed: false,
      };
    },
  } satisfies HumanReviewCliDependencies;

  await runHumanReviewCli(validArgs(), { DATABASE_URL: 'db' }, dependencies);
  await runHumanReviewCli(validArgs(), { DATABASE_URL: 'db' }, dependencies);
  assert.equal(commands.length, 2);
  assert.deepEqual(commands[0], commands[1]);
  assert.equal(commands[0]?.options.idempotencyScope, 'human_review_cli_completion');
  assert.match(commands[0]?.options.idempotencyPayloadHash ?? '', /^[0-9a-f]{64}$/);
});

test('human review CLI maps stale, duplicate, input, and unavailable failures without raw details', async () => {
  const pool = { end: async () => undefined } as unknown as Pool;
  const dependencies = (error: Error) => ({
    createPool: () => pool,
    resolveContext: async () => {
      throw error;
    },
    completeReview: async () => {
      throw new Error('unreachable');
    },
  });

  const stale = await runHumanReviewCli(validArgs(), { DATABASE_URL: 'db' }, dependencies(new Error('REVIEW_INPUT_STALE')));
  assert.deepEqual(stale, {
    exitCode: 3,
    stdout: '',
    stderr: 'HUMAN_REVIEW_CLI_REVIEW_STALE\n',
  });
  const unavailable = await runHumanReviewCli(validArgs(), { DATABASE_URL: 'db' }, dependencies(new Error('ECONNREFUSED secret')));
  assert.deepEqual(unavailable, {
    exitCode: 5,
    stdout: '',
    stderr: 'HUMAN_REVIEW_CLI_UNAVAILABLE\n',
  });
  assert.equal(unavailable.stderr.includes('secret'), false);
});
