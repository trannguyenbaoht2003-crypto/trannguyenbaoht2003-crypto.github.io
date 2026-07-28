import assert from 'node:assert/strict';
import test from 'node:test';

import {
  defineCandidateClaimSet,
} from '../src/modules/trust/define-candidate-claim-set.js';
import {
  CANDIDATE_IDS,
} from './helpers/candidate.js';
import { resetDatabase, tableCount } from './helpers/database.js';
import {
  TRUST_IDS,
  claimSetCommand,
  requiredClaim,
  seedSecondTrustCandidate,
  seedTrustCandidate,
  supportingClaim,
} from './helpers/trust.js';

async function claimReliabilityCounts(
  pool: Awaited<ReturnType<typeof resetDatabase>>,
) {
  const audit = await pool.query<{ count: string }>(
    `select count(*)
       from audit_events
      where action = 'candidate.claim_set_defined'`,
  );
  const outbox = await pool.query<{ count: string }>(
    `select count(*)
       from outbox_events
      where event_type = 'CandidateClaimSetDefined'`,
  );
  const idempotency = await pool.query<{ count: string }>(
    `select count(*)
       from idempotency_records
      where scope = 'candidate_claim_set_definition'`,
  );
  return {
    audit: Number(audit.rows[0]?.count ?? 0),
    claims: await tableCount(pool, 'candidate_claims'),
    idempotency: Number(idempotency.rows[0]?.count ?? 0),
    outbox: Number(outbox.rows[0]?.count ?? 0),
    seals: await tableCount(pool, 'candidate_claim_set_seals'),
  };
}

test('CandidateRevision receives one complete canonical Claim-set seal', async () => {
  const pool = await resetDatabase();
  await seedTrustCandidate(pool);

  const result = await defineCandidateClaimSet(pool, claimSetCommand());

  assert.equal(result.replayed, false);
  assert.equal(result.candidateId, CANDIDATE_IDS.candidateId);
  assert.equal(
    result.candidateRevisionId,
    CANDIDATE_IDS.candidateRevisionId,
  );
  assert.deepEqual(result.claimIds, [
    TRUST_IDS.requiredClaimId,
    TRUST_IDS.supportingClaimId,
  ]);
  assert.match(result.claimSetHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(await claimReliabilityCounts(pool), {
    audit: 1,
    claims: 2,
    idempotency: 1,
    outbox: 1,
    seals: 1,
  });

  const stored = await pool.query<{
    claim_count: number;
    claim_key: string;
    claim_set_hash: string;
  }>(
    `select claim.claim_key,
            seal.claim_count,
            seal.claim_set_hash
       from candidate_claims claim
       join candidate_claim_set_seals seal
         on seal.candidate_revision_id =
            claim.candidate_revision_id
      order by claim.claim_key collate "C"`,
  );
  assert.deepEqual(
    stored.rows.map((row) => row.claim_key),
    ['build-core', 'context-note'],
  );
  assert.equal(stored.rows[0]?.claim_count, 2);
  assert.equal(stored.rows[0]?.claim_set_hash, result.claimSetHash);
  await pool.end();
});

test('reordered exact command replays the canonical result', async () => {
  const pool = await resetDatabase();
  await seedTrustCandidate(pool);
  const first = await defineCandidateClaimSet(pool, claimSetCommand());
  const before = await claimReliabilityCounts(pool);

  const replay = await defineCandidateClaimSet(pool, claimSetCommand({
    claims: [supportingClaim(), requiredClaim()],
  }));

  assert.equal(replay.replayed, true);
  assert.equal(replay.claimSetHash, first.claimSetHash);
  assert.deepEqual(replay.claimIds, first.claimIds);
  assert.deepEqual(await claimReliabilityCounts(pool), before);
  await pool.end();
});

test('a sealed CandidateRevision cannot receive a replacement set', async () => {
  const pool = await resetDatabase();
  await seedTrustCandidate(pool);
  await defineCandidateClaimSet(pool, claimSetCommand());
  const before = await claimReliabilityCounts(pool);

  await assert.rejects(
    defineCandidateClaimSet(pool, claimSetCommand({
      claims: [requiredClaim({ statement: 'Replacement is forbidden.' })],
      correlationId: 'candidate-claim-set-replacement',
      idempotencyKey: 'candidate-claim-set-replacement',
    })),
    /CLAIM_SET_ALREADY_DEFINED/,
  );
  assert.deepEqual(await claimReliabilityCounts(pool), before);
  await pool.end();
});

test('invalid Claim sets and authority mismatches leave no partial rows', async () => {
  const pool = await resetDatabase();
  await seedTrustCandidate(pool);

  for (const command of [
    claimSetCommand({ claims: [supportingClaim()] }),
    claimSetCommand({
      claims: [
        requiredClaim(),
        supportingClaim({ claimKey: 'build-core' }),
      ],
    }),
    claimSetCommand({
      candidateId: '73000000-0000-4000-8000-000000000099',
    }),
    claimSetCommand({
      candidateRevisionId: '73000000-0000-4000-8000-000000000098',
    }),
  ]) {
    await assert.rejects(
      defineCandidateClaimSet(pool, command),
      /CLAIM_SET_REQUIRED_CLAIM_MISSING|CLAIM_KEY_DUPLICATE|CANDIDATE_REVISION_NOT_FOUND/,
    );
  }
  assert.deepEqual(await claimReliabilityCounts(pool), {
    audit: 0,
    claims: 0,
    idempotency: 0,
    outbox: 0,
    seals: 0,
  });
  await pool.end();
});

test('concurrent definitions serialize to one immutable seal', async () => {
  const pool = await resetDatabase();
  await seedTrustCandidate(pool);

  const settled = await Promise.allSettled([
    defineCandidateClaimSet(pool, claimSetCommand({
      correlationId: 'candidate-claim-concurrent-a',
      idempotencyKey: 'candidate-claim-concurrent-a',
    })),
    defineCandidateClaimSet(pool, claimSetCommand({
      correlationId: 'candidate-claim-concurrent-b',
      idempotencyKey: 'candidate-claim-concurrent-b',
    })),
  ]);

  assert.equal(
    settled.filter((entry) => entry.status === 'fulfilled').length,
    1,
  );
  const rejected = settled.find((entry) => entry.status === 'rejected');
  assert.ok(rejected && rejected.status === 'rejected');
  assert.match(String(rejected.reason), /CLAIM_SET_ALREADY_DEFINED/);
  assert.deepEqual(await claimReliabilityCounts(pool), {
    audit: 1,
    claims: 2,
    idempotency: 1,
    outbox: 1,
    seals: 1,
  });
  await pool.end();
});

test('late Claim identity conflict rolls back earlier canonical inserts', async () => {
  const pool = await resetDatabase();
  await seedTrustCandidate(pool);
  await seedSecondTrustCandidate(pool);
  await defineCandidateClaimSet(pool, claimSetCommand({
    candidateId: TRUST_IDS.secondCandidateId,
    candidateRevisionId: TRUST_IDS.secondCandidateRevisionId,
    claims: [
      requiredClaim({
        claimId: TRUST_IDS.supportingClaimId,
        claimKey: 'reserved-claim',
      }),
    ],
    correlationId: 'candidate-claim-second',
    idempotencyKey: 'candidate-claim-second',
  }));
  const before = await claimReliabilityCounts(pool);

  await assert.rejects(
    defineCandidateClaimSet(pool, claimSetCommand({
      claims: [
        requiredClaim(),
        supportingClaim(),
      ],
    })),
    /candidate_claims_pkey/,
  );
  assert.deepEqual(await claimReliabilityCounts(pool), before);
  const firstCandidateClaims = await pool.query<{ count: string }>(
    `select count(*)
       from candidate_claims
      where candidate_revision_id = $1`,
    [CANDIDATE_IDS.candidateRevisionId],
  );
  assert.equal(firstCandidateClaims.rows[0]?.count, '0');
  await pool.end();
});
