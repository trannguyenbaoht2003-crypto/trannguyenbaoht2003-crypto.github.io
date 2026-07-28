# Evidence v3 and Human Review Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist sealed CandidateRevision claims, Claim-level Evidence v3
decision history, completed Human Reviews, and deterministic multi-reviewer
quorum without adding Moderation, Eligibility, or Publication authority.

**Architecture:** Add an append-only relational trust graph in PostgreSQL 17.
T4 and T5 use narrow application commands, immutable input snapshots, mutable
current pointers, one lock order, command idempotency, and atomic audit/outbox
writes. Redis/BullMQ remains delivery infrastructure and does not receive
trust-layer events in this sprint.

**Tech Stack:** Node.js 22.13, TypeScript 5.9, PostgreSQL 17, `pg` 8.22,
BullMQ 5, Redis 7, Node test runner.

## Global Constraints

- Begin from exact Sprint 3A head
  `aa54b7560cb27e9fbddfcba46073375a25e7e742`.
- Work only on stacked branch
  `feat/3b-evidence-human-review-persistence`.
- Do not edit migrations `0001`–`0006`; add migration `0007`.
- PostgreSQL is the system of record; Redis payloads are not trust input.
- Evidence decisions are Claim-level only:
  `supported | insufficient | contradicted`.
- Human Review outcomes are:
  `confirmed | changes_requested | declined`; never add `approved`.
- Before first evaluation a Claim has no decision; absence is not
  `insufficient`.
- Every Evidence decision pins CandidateRevision, Patch, CatalogRevision,
  input snapshot, and Evidence policy revision.
- A new Patch requires a new Claim and Evidence decision.
- AI provenance is review input and is never Evidence.
- A Review counts only when status is `completed`, outcome is `confirmed`,
  permission used is `reviewer`, and its exact input hash/policy matches.
- Use lock order Candidate → CandidateRevision → Claims in canonical order.
- Audit/outbox payloads must not copy Claim text, review reason, external
  references, or source-governed content.
- Dispatcher allowlist remains only `RawObservationIngested`.
- No Moderation, Eligibility, Publication, AI discovery, auth/UI, external
  fetch, production credentials, infrastructure, merge, or deployment.
- Preserve root `npm run build:pages` and all existing frontend behavior.
- Database RED/GREEN evidence must run on GitHub Actions PostgreSQL 17 and
  Redis 7. Local typecheck/build is supporting evidence only.

---

## File structure

### Create

- `backend/migrations/0007_evidence_v3_human_review.sql` — complete immutable
  trust graph, pointers, triggers, and composite constraints.
- `backend/src/shared/idempotent-command.ts` — reusable command replay and
  completion helper over `idempotency_records`.
- `backend/src/modules/trust/types.ts` — public command/result/value types.
- `backend/src/modules/trust/normalize-trust-input.ts` — closed V1 runtime
  validation and canonical hashing.
- `backend/src/modules/trust/load-trust-authority.ts` — shared Candidate,
  CandidateRevision, Claim-seal, provenance, and current-decision loaders with
  the global lock order.
- `backend/src/modules/trust/register-trust-policy-revision.ts` — immutable,
  idempotent Evidence/Review policy registration.
- `backend/src/modules/trust/define-candidate-claim-set.ts` — sealed
  CandidateRevision Claim set.
- `backend/src/modules/trust/record-claim-evidence-decision.ts` — T4 Evidence
  graph, decision, and current pointer.
- `backend/src/modules/trust/complete-human-review.ts` — T5 review snapshot,
  completion, quorum history, and current pointer.
- `backend/test/helpers/trust.ts` — deterministic IDs, policy/claim/evidence
  commands, and seeded Candidate graphs.
- `backend/test/trust-normalization.test.ts` — pure closed-input and canonical
  hash tests.
- `backend/test/trust-migration.test.ts` — direct-SQL graph and immutability
  contracts.
- `backend/test/trust-policy.test.ts` — policy registration/replay/rollback.
- `backend/test/candidate-claim-set.test.ts` — Claim-set seal behavior.
- `backend/test/evidence-decision.test.ts` — T4, history, cross-patch, and
  stale-pointer behavior.
- `backend/test/human-review.test.ts` — T5, quorum, input staleness, replay,
  and concurrency.

### Modify

- `backend/test/migration.test.ts` — add all migration `0007` tables to the
  exact table contract.
- `backend/README.md` — add Sprint 3B operations, lock order, replay, and
  scope boundary.
- `.github/workflows/backend-production-foundation.yml` — rename the gate to
  Sprint 3B and require the new runbook contracts without changing
  permissions or adding deployment commands.

### Already created

- `docs/superpowers/specs/2026-07-28-evidence-v3-human-review-persistence-design.md`
- `docs/superpowers/plans/2026-07-28-evidence-v3-human-review-persistence.md`

---

### Task 1: Closed trust inputs and canonical hashes

**Files:**

- Create: `backend/src/modules/trust/types.ts`
- Create: `backend/src/modules/trust/normalize-trust-input.ts`
- Test: `backend/test/trust-normalization.test.ts`

**Interfaces:**

- Produces:

```ts
export type ClaimType =
  | 'meta_trend'
  | 'build_effectiveness'
  | 'compatibility'
  | 'patch_change'
  | 'playstyle_hypothesis'
  | 'translation_assertion'
  | 'ocr_extraction'
  | 'community_report';

export type ClaimImportance = 'required' | 'supporting' | 'informational';
export type EvidenceStance = 'supports' | 'contradicts' | 'context_only';
export type EvidenceDecision =
  | 'supported'
  | 'insufficient'
  | 'contradicted';
export type HumanReviewOutcome =
  | 'confirmed'
  | 'changes_requested'
  | 'declined';

export interface CandidateClaimInput {
  claimId: string;
  claimKey: string;
  claimType: ClaimType;
  importance: ClaimImportance;
  statement: string;
}

export interface NormalizedClaimSet {
  claims: Array<CandidateClaimInput & { statementHash: string }>;
  claimSetHash: string;
}

export function normalizeClaimSet(
  candidateId: string,
  candidateRevisionId: string,
  patchId: string,
  catalogRevisionId: string,
  claims: readonly CandidateClaimInput[],
): NormalizedClaimSet;

export function normalizePolicyKey(value: string): string;
export function requireUuid(value: string, field: string): string;
export function requireBoundedText(
  value: string,
  field: string,
  maxBytes: number,
): string;

export function hashUtf8TextV1(value: string): string;
export function hashCanonicalTupleV1(tokens: readonly string[]): string;
```

- [ ] **Step 1: Write pure RED contracts**

Add tests with these exact assertions:

```ts
test('claim set is canonical across input ordering', () => {
  const first = normalizeClaimSet(
    IDS.candidateId,
    IDS.candidateRevisionId,
    IDS.patchId,
    IDS.catalogRevisionId,
    [requiredClaim(), supportingClaim()],
  );
  const second = normalizeClaimSet(
    IDS.candidateId,
    IDS.candidateRevisionId,
    IDS.patchId,
    IDS.catalogRevisionId,
    [supportingClaim(), requiredClaim()],
  );
  assert.equal(first.claimSetHash, second.claimSetHash);
  assert.deepEqual(
    first.claims.map((claim) => claim.claimKey),
    ['build-core', 'context-note'],
  );
});

test('claim identity and content affect the seal', () => {
  const base = normalizedClaimSet();
  assert.notEqual(
    base.claimSetHash,
    normalizedClaimSet({
      claims: [{ ...requiredClaim(), statement: 'changed' }],
    }).claimSetHash,
  );
  assert.notEqual(
    base.claimSetHash,
    normalizedClaimSet({
      claims: [{ ...requiredClaim(), claimId: randomUUID() }],
    }).claimSetHash,
  );
});

test('claim set rejects missing required claim and malformed input', () => {
  assert.throws(
    () => normalizedClaimSet({ claims: [supportingClaim()] }),
    /CLAIM_SET_REQUIRED_CLAIM_MISSING/,
  );
  assert.throws(
    () => normalizedClaimSet({
      claims: [{ ...requiredClaim(), claimKey: 'not canonical' }],
    }),
    /TRUST_IDENTIFIER_INVALID/,
  );
  assert.throws(
    () => normalizedClaimSet({
      claims: [{ ...requiredClaim(), statement: 'x'.repeat(4097) }],
    }),
    /TRUST_TEXT_TOO_LARGE/,
  );
});
```

Also reject:

- an empty array;
- duplicate `claimId` or duplicate canonical `claimKey`;
- unknown Claim type/importance supplied through an `unknown` cast;
- a Claim key with tab, whitespace, non-ASCII, or more than 128 bytes;
- a non-UUID record identity;
- an empty exact statement or a statement over 4096 UTF-8 bytes;
- an object with extra keys when a closed V1 policy or association input is
  normalized.

- [ ] **Step 2: Run RED**

Run:

```bash
npm --prefix backend run typecheck
node --import tsx --test backend/test/trust-normalization.test.ts
```

Expected: the test compile fails only because the trust types/normalizer
modules do not exist.

- [ ] **Step 3: Implement minimal closed validators**

Use printable non-space ASCII for keys:

```ts
const TRUST_IDENTIFIER_V1 = /^[!-~]+$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function compareCanonical(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
```

Do not trim Claim statements. Require exact non-empty UTF-8 text and use
`Buffer.byteLength(value, 'utf8')` for the 4096-byte cap. Hash each exact
statement with SHA-256 over its UTF-8 bytes.

`hashCanonicalTupleV1` must encode every token as:

```ts
const encoded = tokens.map((token) => (
  `${Buffer.byteLength(token, 'utf8')}:${token}`
)).join('|');
return createHash('sha256').update(encoded, 'utf8').digest('hex');
```

The Claim-set tuple is:

```ts
[
  'TrustTupleV1',
  'CandidateClaimSetV1',
  candidateId,
  candidateRevisionId,
  patchId,
  catalogRevisionId,
  String(sortedClaims.length),
  ...sortedClaims.flatMap((claim) => [
    claim.claimId,
    claim.claimKey,
    claim.claimType,
    claim.importance,
    claim.statementHash,
  ]),
]
```

Add one known-vector assertion with the expected literal SHA-256 so later SQL
tests can prove the PostgreSQL function returns the same value.

- [ ] **Step 4: Run GREEN**

Run:

```bash
node --import tsx --test backend/test/trust-normalization.test.ts
npm --prefix backend run typecheck
npm --prefix backend run build
```

Expected: pure tests, typecheck, and build pass.

- [ ] **Step 5: Commit checkpoint**

Commit only the three Task 1 files:

```text
test(3b): lock trust input contracts
feat(3b): add canonical trust inputs
```

Keep the RED and GREEN commits separate on the stacked branch.

---

### Task 2: Migration `0007` and immutable trust graph

**Files:**

- Create: `backend/migrations/0007_evidence_v3_human_review.sql`
- Create: `backend/test/trust-migration.test.ts`
- Modify: `backend/test/migration.test.ts`

**Interfaces:**

- Produces all tables named in the design and these required composite
  identities:

```sql
alter table candidate_revisions
  add constraint candidate_revisions_trust_identity_unique
  unique (
    candidate_revision_id,
    candidate_id,
    patch_id,
    catalog_revision_id
  );

alter table candidate_provenance
  add constraint candidate_provenance_revision_identity_unique
  unique (candidate_provenance_id, candidate_revision_id);
```

- [ ] **Step 1: Add migration-table RED**

Append these exact names to `expectedTables` in
`backend/test/migration.test.ts`:

```ts
'candidate_claim_set_seals',
'candidate_claims',
'claim_evidence_decisions',
'current_claim_evidence_decisions',
'current_review_quorum_evaluations',
'evidence_associations',
'evidence_input_snapshot_associations',
'evidence_input_snapshots',
'evidence_policy_revisions',
'evidence_records',
'human_reviews',
'review_input_snapshot_claims',
'review_input_snapshot_provenance',
'review_input_snapshots',
'review_policy_revisions',
'review_quorum_evaluation_reviews',
'review_quorum_evaluations',
```

Create RED tests that:

- query for all 17 tables;
- update/delete every history table and expect `immutable`;
- try a Claim with mismatched CandidateRevision/Patch/Catalog;
- try an Evidence record whose observation/source/content graph differs;
- hide a cross-patch Evidence relationship;
- attach another Claim's association to a snapshot;
- point one Claim at another Claim's decision;
- attach another CandidateRevision's Claim/provenance/decision to a review
  snapshot;
- count an unconfirmed or duplicate-reviewer review in quorum;
- commit header count/hash/result values that disagree with child rows.

- [ ] **Step 2: Run durable RED**

Push the RED test commit and open the stacked draft PR with:

```text
base: feat/3a-deterministic-candidate-registry
head: feat/3b-evidence-human-review-persistence
title: feat(backend): persist Evidence v3 and Human Review
status: implementation in progress
```

Run the pull-request workflow. Expected:

- frontend gate remains green;
- backend typecheck remains green;
- migration test fails because `0007` and its tables do not exist;
- direct-SQL tests fail only at the first missing table/constraint.

- [ ] **Step 3: Add table DDL**

Use exact enums/checks from the design. At minimum:

```sql
create table evidence_policy_revisions (
  evidence_policy_revision_id uuid primary key,
  policy_key text not null collate "C"
    check (
      octet_length(policy_key) between 1 and 128
      and policy_key ~ '^[!-~]+$'
    ),
  revision integer not null check (revision > 0),
  schema_version integer not null check (schema_version = 1),
  reason text not null check (octet_length(reason) between 1 and 1024),
  created_by text not null,
  created_at timestamptz not null default clock_timestamp(),
  unique (policy_key, revision),
  unique (evidence_policy_revision_id, policy_key)
);

create table review_policy_revisions (
  review_policy_revision_id uuid primary key,
  policy_key text not null collate "C"
    check (
      octet_length(policy_key) between 1 and 128
      and policy_key ~ '^[!-~]+$'
    ),
  revision integer not null check (revision > 0),
  minimum_confirmed_reviews integer not null
    check (minimum_confirmed_reviews between 1 and 16),
  require_distinct_reviewers boolean not null
    check (require_distinct_reviewers),
  required_permission text not null check (required_permission = 'reviewer'),
  applies_to_ai_provenance boolean not null,
  reason text not null check (octet_length(reason) between 1 and 1024),
  created_by text not null,
  created_at timestamptz not null default clock_timestamp(),
  unique (policy_key, revision),
  unique (review_policy_revision_id, policy_key)
);
```

Create the remaining 15 tables with all fields and foreign keys specified in
the design. Include explicit header counts on:

- `candidate_claim_set_seals.claim_count`;
- `evidence_input_snapshots.association_count`;
- `review_input_snapshots.claim_count`;
- `review_input_snapshots.provenance_count`;
- `review_quorum_evaluations.counted_review_count`.

Use `octet_length(statement) between 1 and 4096`, SHA-256 checks
`~ '^[a-f0-9]{64}$'`, positive deterministic ordinals, and unique
`(parent_id, ordinal)` plus unique membership constraints.

- [ ] **Step 4: Add graph and deferred membership guards**

Create focused trigger functions:

```sql
enforce_candidate_claim_graph()
enforce_candidate_claim_set_seal()
enforce_evidence_source_graph()
enforce_evidence_association_graph()
enforce_evidence_snapshot_association_graph()
enforce_claim_evidence_decision_graph()
enforce_current_claim_evidence_decision_graph()
enforce_review_snapshot_provenance_graph()
enforce_review_snapshot_claim_graph()
enforce_human_review_graph()
enforce_review_quorum_membership_graph()
enforce_current_review_quorum_graph()
```

Use `constraint trigger ... deferrable initially deferred` for complete-set
checks. At commit they must recompute:

```sql
count(*)
sha256_text_tuple_v1(ordered_text_tokens)
distinct reviewer_actor_id count
quorum_satisfied =
  distinct_confirmed_reviewer_count >= minimum_confirmed_reviews
```

Implement:

```sql
create function sha256_text_v1(value text)
returns text language sql immutable strict as $$
  select encode(digest(convert_to(value, 'UTF8'), 'sha256'), 'hex')
$$;

create function sha256_text_tuple_v1(tokens text[])
returns text language sql immutable strict as $$
  select encode(
    digest(
      convert_to(
        (
          select string_agg(
                   octet_length(token)::text || ':' || token,
                   '|' order by ordinality
                 )
            from unnest(tokens) with ordinality as entry(token, ordinality)
        ),
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  )
$$;
```

Reject null array elements; callers use literal `@null`. Canonical aggregation
must order Claim keys with `collate "C"` and ordinals numerically. Add a
migration test using Task 1's known vector.

- [ ] **Step 5: Attach immutability guards**

Attach `reject_immutable_change()` to every history table. Do not attach it to:

- `current_claim_evidence_decisions`;
- `current_review_quorum_evaluations`.

Pointer tables must still reject deletes and graph-changing identity updates
through their own trigger; only the referenced current decision/evaluation and
`updated_at` may change.

- [ ] **Step 6: Run GREEN**

Run:

```bash
npm --prefix backend run typecheck
npm --prefix backend run build
```

Then push migration GREEN and wait for Actions PostgreSQL 17:

```bash
npm run backend:test
```

Expected: all prior 78 tests plus migration/direct-SQL contracts pass.

- [ ] **Step 7: Commit checkpoint**

Use:

```text
test(3b): specify immutable trust graph
feat(3b): add Evidence and Human Review schema
```

---

### Task 3: Shared idempotency and policy registration

**Files:**

- Create: `backend/src/shared/idempotent-command.ts`
- Create: `backend/src/modules/trust/register-trust-policy-revision.ts`
- Create: `backend/test/trust-policy.test.ts`
- Modify: `backend/src/modules/trust/types.ts`

**Interfaces:**

```ts
export async function beginIdempotentCommand<T>(
  client: PoolClient,
  scope: string,
  idempotencyKey: string,
  payloadHash: string,
): Promise<T | null>;

export async function completeIdempotentCommand<T>(
  client: PoolClient,
  scope: string,
  idempotencyKey: string,
  result: T,
): Promise<void>;

export type RegisterTrustPolicyRevisionCommand =
  | {
      policyKind: 'evidence';
      policyRevisionId: string;
      policyKey: string;
      revision: number;
      schemaVersion: 1;
      actorId: string;
      reason: string;
      correlationId: string;
      idempotencyKey: string;
    }
  | {
      policyKind: 'human_review';
      policyRevisionId: string;
      policyKey: string;
      revision: number;
      minimumConfirmedReviews: number;
      requireDistinctReviewers: true;
      requiredPermission: 'reviewer';
      appliesToAiProvenance: boolean;
      actorId: string;
      reason: string;
      correlationId: string;
      idempotencyKey: string;
    };

export interface RegisterTrustPolicyRevisionResult {
  policyKind: 'evidence' | 'human_review';
  policyRevisionId: string;
  replayed: boolean;
}
```

- [ ] **Step 1: Write policy RED**

Tests must assert:

- Evidence policy creates one immutable row, audit, outbox, and completed
  idempotency record;
- Review policy persists quorum `1` and quorum `2`;
- same key/payload returns `replayed: true` with no duplicate rows;
- same key with changed policy configuration fails
  `IDEMPOTENCY_PAYLOAD_CONFLICT`;
- duplicate `(policy_key, revision)` with another UUID fails
  `TRUST_POLICY_REVISION_CONFLICT`;
- minimum reviews `0` or `17`, permission other than `reviewer`,
  `requireDistinctReviewers=false`, extra input keys, or malformed policy key
  fail before storage;
- a duplicate policy key/revision detected after the idempotency reservation
  rolls back the reservation and every reliability write.

- [ ] **Step 2: Run RED**

Run typecheck and push the RED commit. Expected: missing shared helper and
policy module are the only failures.

- [ ] **Step 3: Implement the shared helper**

Use:

```sql
insert into idempotency_records
  (scope, idempotency_key, payload_hash, state)
values ($1, $2, $3, 'in_progress')
on conflict (scope, idempotency_key) do nothing
returning idempotency_record_id
```

When no row is returned, load the existing row `FOR UPDATE` and:

- reject a changed hash;
- reject any non-completed row;
- return its JSON result.

Completion updates only the matching `in_progress` row to `completed`, stores
the exact JSON result, and sets `completed_at`.

- [ ] **Step 4: Implement policy registration**

Normalize the discriminated command, hash all semantic inputs except
correlation ID, then in one `withTransaction` callback:

1. begin idempotency scope `trust_policy_registration`;
2. insert the correct policy row;
3. insert audit action `trust.policy_revision_registered`;
4. insert outbox event `TrustPolicyRevisionRegistered`;
5. complete idempotency;
6. return the typed result.

Outbox payload:

```ts
{
  policyKind,
  policyRevisionId,
  policyKey,
  revision,
}
```

- [ ] **Step 5: Run GREEN**

Run local typecheck/build, then Actions. Expected: policy tests and the full
backend suite pass.

- [ ] **Step 6: Commit checkpoint**

Use:

```text
test(3b): specify trust policy persistence
feat(3b): register immutable trust policies
```

---

### Task 4: Seal CandidateRevision Claim sets

**Files:**

- Create: `backend/src/modules/trust/load-trust-authority.ts`
- Create: `backend/src/modules/trust/define-candidate-claim-set.ts`
- Create: `backend/test/helpers/trust.ts`
- Create: `backend/test/candidate-claim-set.test.ts`
- Modify: `backend/src/modules/trust/types.ts`

**Interfaces:**

```ts
export interface DefineCandidateClaimSetCommand {
  actorId: string;
  candidateId: string;
  candidateRevisionId: string;
  claims: CandidateClaimInput[];
  correlationId: string;
  idempotencyKey: string;
}

export interface DefineCandidateClaimSetResult {
  candidateId: string;
  candidateRevisionId: string;
  claimIds: string[];
  claimSetHash: string;
  replayed: boolean;
}

export async function lockCandidateRevisionAuthority(
  client: PoolClient,
  candidateId: string,
  candidateRevisionId: string,
): Promise<{
  candidateId: string;
  candidateRevisionId: string;
  patchId: string;
  catalogRevisionId: string;
  canonicalPayload: unknown;
  normalizedSignature: string;
}>;
```

- [ ] **Step 1: Write Claim-set RED**

Cover:

- two Claims commit with one seal, audit, outbox, idempotency;
- Claim order does not change the canonical result;
- exact replay creates no new row;
- same CandidateRevision cannot receive a second set under another key;
- missing required Claim, duplicate key, mismatched Candidate ID/revision, or
  malformed statement fails without partial rows;
- two concurrent definitions yield one success and one deterministic replay or
  `CLAIM_SET_ALREADY_DEFINED`, never two seals;
- injected late conflict rolls back every Claim and reliability row;
- direct update/delete remains rejected.

- [ ] **Step 2: Run durable RED**

Expected: missing `define-candidate-claim-set` module only; migration remains
green.

- [ ] **Step 3: Implement authority lock**

Lock:

```sql
select c.candidate_id
  from candidates c
 where c.candidate_id = $1
 for update;

select cr.candidate_revision_id,
       cr.candidate_id,
       cr.patch_id,
       cr.catalog_revision_id,
       cr.canonical_payload
  from candidate_revisions cr
 where cr.candidate_revision_id = $1
   and cr.candidate_id = $2
 for update;
```

Return `CANDIDATE_REVISION_NOT_FOUND` on any mismatch. Do not load or lock
Patch/Catalog active pointers.

- [ ] **Step 4: Implement the atomic seal**

After authority and normalization:

1. begin idempotency scope `candidate_claim_set_definition`;
2. fail if a seal already exists, except exact completed replay;
3. insert Claims in canonical key order;
4. insert the seal with claim count/hash;
5. insert audit `candidate.claim_set_defined`;
6. insert outbox `CandidateClaimSetDefined`;
7. complete idempotency.

Event payload contains only Candidate/Revision IDs, Claim IDs, count, and seal
hash.

- [ ] **Step 5: Run GREEN**

Run local typecheck/build and the Actions database gate. Require zero
regression in Candidate registration.

- [ ] **Step 6: Commit checkpoint**

Use:

```text
test(3b): specify sealed Candidate claims
feat(3b): define immutable Candidate claim sets
```

---

### Task 5: T4 Claim-level Evidence decisions

**Files:**

- Create: `backend/src/modules/trust/record-claim-evidence-decision.ts`
- Create: `backend/test/evidence-decision.test.ts`
- Modify: `backend/src/modules/trust/types.ts`
- Modify: `backend/src/modules/trust/load-trust-authority.ts`
- Modify: `backend/test/helpers/trust.ts`

**Interfaces:**

```ts
export interface EvidenceAssociationInput {
  associationId: string;
  evidenceId: string;
  normalizedObservationId: string;
  stance: EvidenceStance;
  crossPatchRevalidated: boolean;
  revalidationReason: string | null;
}

export interface RecordClaimEvidenceDecisionCommand {
  actorId: string;
  candidateId: string;
  candidateRevisionId: string;
  claimId: string;
  correlationId: string;
  decision: EvidenceDecision;
  decisionId: string;
  evaluatedAt: string;
  evidenceInputSnapshotId: string;
  evidencePolicyRevisionId: string;
  idempotencyKey: string;
  reason: string;
  associations: EvidenceAssociationInput[];
}

export interface RecordClaimEvidenceDecisionResult {
  claimId: string;
  decisionId: string;
  decision: EvidenceDecision;
  evidenceInputSnapshotId: string;
  inputHash: string;
  replayed: boolean;
}
```

- [ ] **Step 1: Write T4 RED**

Add focused tests:

```ts
test('supported decision writes one complete Claim-level graph', async () => {
  const result = await recordClaimEvidenceDecision(pool, supportedCommand());
  assert.equal(result.decision, 'supported');
  assert.equal(await tableCount(pool, 'evidence_records'), 1);
  assert.equal(await tableCount(pool, 'evidence_associations'), 1);
  assert.equal(await tableCount(pool, 'evidence_input_snapshots'), 1);
  assert.equal(await tableCount(pool, 'claim_evidence_decisions'), 1);
  assert.equal(await tableCount(pool, 'current_claim_evidence_decisions'), 1);
});

test('two required Claims keep independent current decisions', async () => {
  await recordClaimEvidenceDecision(pool, supportedFirstClaim());
  await recordClaimEvidenceDecision(pool, insufficientSecondClaim());
  const current = await loadCurrentDecisions(pool);
  assert.deepEqual(current, [
    ['build-core', 'supported'],
    ['patch-context', 'insufficient'],
  ]);
});
```

Also prove:

- `supported` without `supports` fails;
- `contradicted` without `contradicts` fails;
- empty `insufficient` succeeds without creating Evidence;
- exact replay creates zero duplicate graph/audit/outbox rows;
- changed payload under one key fails;
- re-evaluation appends a second immutable decision and moves only that Claim's
  pointer;
- a new key for an old snapshot cannot move the pointer backward;
- same NormalizedObservation converges to one Evidence record;
- a Claim cannot use another Claim's association;
- source/observation content hash and policy graph are authoritative;
- a late Decision-ID conflict rolls back new Evidence, association, snapshot,
  pointer, audit, outbox, and idempotency rows.

- [ ] **Step 2: Add S20 cross-patch RED**

Create a second Patch/Catalog/CandidateRevision/Claim. Use one old-Patch
NormalizedObservation as Evidence.

Assert:

- without `crossPatchRevalidated=true` and a non-empty reason, T4 fails;
- with explicit revalidation, a new association and a new decision are
  created for the new Claim/Patch;
- the old Claim decision remains current only for the old Claim;
- direct SQL cannot point the new Claim at the old decision.

- [ ] **Step 3: Run durable RED**

Push tests before implementation. Expected: missing T4 module is the only
compile failure.

- [ ] **Step 4: Implement T4 lock and prerequisites**

Inside one transaction:

1. lock Candidate;
2. lock CandidateRevision;
3. lock the target Claim `FOR UPDATE`;
4. require the Claim-set seal;
5. load the immutable Evidence policy revision;
6. begin idempotency scope `claim_evidence_decision`;
7. load the current Claim pointer `FOR UPDATE`.

Reject any authority mismatch before an Evidence insert.

- [ ] **Step 5: Resolve source-governed Evidence**

For each association, sorted by Association ID:

```sql
select no.normalized_observation_id,
       no.raw_observation_id,
       no.patch_id as evidence_patch_id,
       ro.source_id,
       ro.source_policy_revision_id,
       ro.content_hash
  from normalized_observations no
  join raw_observations ro
    on ro.raw_observation_id = no.raw_observation_id
 where no.normalized_observation_id = $1
 for share of no, ro;
```

Insert Evidence with `on conflict (normalized_observation_id) do nothing`,
then reload and compare the complete immutable identity. Insert/reuse one
Claim/Evidence association; a stance or patch-revalidation mismatch fails
closed.

- [ ] **Step 6: Persist snapshot, decision, and pointer**

Canonical input hash uses `hashCanonicalTupleV1`:

```ts
hashCanonicalTupleV1([
  'TrustTupleV1',
  'EvidenceInputSnapshotV1',
  candidateRevisionId,
  patchId,
  catalogRevisionId,
  claimId,
  claimSetHash,
  statementHash,
  evidencePolicyRevisionId,
  String(resolvedAssociations.length),
  ...resolvedAssociations
    .sort(byAssociationId)
    .flatMap(({ associationId, evidenceId, stance }) => [
      associationId,
      evidenceId,
      stance,
    ]),
])
```

Insert snapshot/header and ordered membership, then decision and current
pointer. If the same semantic input/policy already has a decision:

- same outcome and still current → return replay;
- different outcome → `EVIDENCE_DECISION_CONFLICT`;
- no longer current → `EVIDENCE_DECISION_INPUT_SUPERSEDED`.

Write audit `evidence.claim_decision_recorded`, outbox
`ClaimEvidenceDecisionRecorded`, and complete idempotency.

- [ ] **Step 7: Run GREEN**

Run local typecheck/build, then Actions. Require all T4, direct-SQL,
cross-patch, and baseline tests green.

- [ ] **Step 8: Commit checkpoint**

Use:

```text
test(3b): specify Claim Evidence decisions
feat(3b): persist Claim-level Evidence history
```

---

### Task 6: T5 completed Human Review and deterministic quorum

**Files:**

- Create: `backend/src/modules/trust/complete-human-review.ts`
- Create: `backend/test/human-review.test.ts`
- Modify: `backend/src/modules/trust/types.ts`
- Modify: `backend/src/modules/trust/load-trust-authority.ts`
- Modify: `backend/test/helpers/trust.ts`

**Interfaces:**

```ts
export interface CompleteHumanReviewCommand {
  actorId: string;
  candidateId: string;
  candidateRevisionId: string;
  completedAt: string;
  correlationId: string;
  humanReviewId: string;
  idempotencyKey: string;
  outcome: HumanReviewOutcome;
  permissionUsed: 'reviewer';
  reason: string;
  reviewInputSnapshotId: string;
  reviewPolicyRevisionId: string;
  reviewQuorumEvaluationId: string;
}

export interface CompleteHumanReviewResult {
  candidateRevisionId: string;
  humanReviewId: string;
  inputHash: string;
  quorumEvaluationId: string;
  confirmedReviewerCount: number;
  requiredConfirmedReviews: number;
  quorumSatisfied: boolean;
  replayed: boolean;
}
```

- [ ] **Step 1: Write T5/quorum RED**

Create tests for:

- one `confirmed` completion under quorum two → count one, unsatisfied;
- second distinct `confirmed` reviewer → count two, satisfied;
- current quorum pointer references the second immutable evaluation;
- the first unsatisfied evaluation remains unchanged;
- `changes_requested` and `declined` persist but do not count;
- permission other than `reviewer` fails before storage;
- a second Review by the same reviewer/policy/input fails
  `REVIEW_ALREADY_COMPLETED` and count remains one;
- exact lost-ack replay creates no duplicate review, snapshot, evaluation,
  audit, outbox, or idempotency effect;
- changed payload under the same key fails;
- direct update/delete of completed Review/evaluation fails.

- [ ] **Step 2: Write concurrent S5/S23 RED**

Use two pool clients and `Promise.all` to complete two distinct confirmed
reviews at one barrier under quorum two.

Expected final state:

```ts
{
  reviews: 2,
  quorumEvaluations: 2,
  currentConfirmedReviewerCount: 2,
  currentQuorumSatisfied: true,
  distinctReviewers: 2,
  auditEvents: 2,
  outboxEvents: 2,
}
```

The test must fail on timeout, deadlock, unique violation, or a final count of
one.

- [ ] **Step 3: Write review-input staleness RED**

Prove:

- Review snapshot includes every sealed Claim and explicit absence for a Claim
  with no current Evidence decision;
- Review snapshot includes every CandidateProvenance row and origin;
- after a new current Evidence decision, a new review gets a different input
  hash and cannot combine with old reviews;
- after appending AI provenance to the same CandidateRevision, a new review
  gets a different input hash and cannot combine with old reviews;
- AI provenance appears only in review snapshot membership and never creates
  an Evidence record or association.

- [ ] **Step 4: Run durable RED**

Push tests. Expected: missing T5 module only.

- [ ] **Step 5: Build the exact ReviewInputSnapshot**

After locking Candidate and CandidateRevision, lock all Claims:

```sql
select cc.claim_id,
       cc.claim_key,
       cc.importance,
       cced.claim_evidence_decision_id
  from candidate_claims cc
  left join current_claim_evidence_decisions cced
    on cced.claim_id = cc.claim_id
 where cc.candidate_revision_id = $1
 order by cc.claim_key collate "C"
 for update of cc;
```

Load Candidate provenance in UUID order while the Candidate lock is held.
Hash with `hashCanonicalTupleV1`:

```ts
[
  'TrustTupleV1',
  'ReviewInputSnapshotV1',
  candidateId,
  candidateRevisionId,
  patchId,
  catalogRevisionId,
  candidateNormalizedSignature,
  claimSetHash,
  reviewPolicyRevisionId,
  String(claims.length),
  ...claims.flatMap(({ claimId, importance, evidenceDecisionId }) => [
    claimId,
    importance,
    evidenceDecisionId ?? '@null',
  ]),
  String(provenance.length),
  ...provenance.flatMap(({ candidateProvenanceId, origin }) => [
    candidateProvenanceId,
    origin,
  ]),
]
```

Resolve/reuse a snapshot only when every immutable field and child membership
matches.

- [ ] **Step 6: Insert Review and compute quorum**

In the same transaction:

1. begin `human_review_completion` idempotency;
2. insert one immutable completed Review;
3. load all `completed + confirmed + reviewer` Reviews with the same
   CandidateRevision, policy, and input hash;
4. select at most one Review per reviewer actor, ordered by completion time
   then Review ID;
5. insert the quorum evaluation header;
6. insert its exact counted-review membership;
7. update the current quorum pointer;
8. insert audit `review.human_review_completed`;
9. insert outbox `HumanReviewCompleted`;
10. complete idempotency.

The database deferred trigger independently recomputes distinct count and
`satisfied`.

- [ ] **Step 7: Run GREEN**

Run local typecheck/build and Actions. Require concurrent S5/S23, staleness,
direct-SQL, and all prior tests green.

- [ ] **Step 8: Commit checkpoint**

Use:

```text
test(3b): specify Human Review quorum
feat(3b): persist completed reviews and quorum history
```

---

### Task 7: Race, replay, and graph hardening

**Files:**

- Modify: `backend/test/evidence-decision.test.ts`
- Modify: `backend/test/human-review.test.ts`
- Modify: `backend/test/trust-migration.test.ts`
- Modify production files only when a new RED contract proves a defect.

**Interfaces:**

- No new public API.
- Confirms the global lock order and exact persisted graph.

- [ ] **Step 1: Add T4/T5 overlap RED**

Hold T4 after CandidateRevision lock and start T5 for the same revision. Then
release T4.

Assert either serial order is acceptable, but the committed Review snapshot
must be internally exact:

- if T4 commits first, Review snapshot pins the new decision;
- if T5 commits first, Review snapshot records the old decision/absence;
- no mixed parent/child hash;
- no deadlock;
- both transactions keep complete audit/outbox/idempotency effects.

Use real PostgreSQL locks and `pg_stat_activity`; do not add production
test-only hooks.

- [ ] **Step 2: Add Candidate provenance overlap RED**

Race a Sprint 3A provenance append against T5. The Candidate lock must
serialize them. Review snapshot contains either the complete pre-append set or
the complete post-append set, never a count/hash mismatch.

- [ ] **Step 3: Add replay and rollback RED**

Inject real late failures by reusing:

- an EvidenceAssociation primary key;
- a ClaimEvidenceDecision primary key after new Evidence/snapshot inserts;
- a ReviewQuorumEvaluation primary key.

After each failure, compare all domain/audit/outbox/idempotency table counts to
the pre-command snapshot. Retry with fresh IDs must succeed once.

Do not add `beforeCommit` or another production hook solely for tests.

- [ ] **Step 4: Add direct-SQL adversarial cases**

Attempt:

- wrong statement hash or Claim-set hash;
- header count one with two children;
- same Evidence record with another Source Policy;
- a cross-patch association marked false;
- decision Patch/Catalog mismatch;
- Review snapshot omitting one sealed Claim;
- Review snapshot omitting one provenance row;
- quorum header satisfied with too few distinct reviewers;
- duplicate reviewer actor in counted membership;
- pointer rollback to a superseded Evidence decision.

Every invalid transaction must fail at statement or deferred commit.

- [ ] **Step 5: Run RED→GREEN per finding**

For each failure:

1. commit only the failing test;
2. capture the exact Actions failure;
3. implement the smallest production fix;
4. rerun local typecheck/build;
5. rerun the PostgreSQL/Redis gate;
6. keep unrelated RED tests failing until their own fix.

- [ ] **Step 6: Commit checkpoint**

Use focused messages naming the invariant, such as:

```text
test(3b): expose review snapshot provenance race
fix(3b): serialize provenance and review snapshots
```

---

### Task 8: Runbook, workflow contract, and final gate

**Files:**

- Modify: `backend/README.md`
- Modify: `.github/workflows/backend-production-foundation.yml`
- Modify:
  `docs/superpowers/plans/2026-07-28-evidence-v3-human-review-persistence.md`
  only to record verified review-driven hardening, not to rewrite the approved
  plan.

**Interfaces:**

- No runtime API or deployment behavior.

- [ ] **Step 1: Create documentation RED**

Change workflow display/concurrency/job labels from Sprint 3A to Sprint 3B and
add runbook contract checks for these literal phrases:

```text
Claim-level Evidence
Candidate claim-set seal
Evidence input snapshot
Evidence decision history
Cross-patch revalidation
Human Review input snapshot
completed + confirmed
Review quorum
Candidate → CandidateRevision → Claim
AI provenance is not Evidence
Trust-layer outbox events are not dispatched in Sprint 3B
No Moderation
No Eligibility
No Publication
No merge
No deployment
```

Before README changes, the workflow must fail only at the first missing
runbook phrase.

- [ ] **Step 2: Update the runbook**

Document:

- policy registration prerequisites;
- Claim-set definition and one-seal rule;
- source-governed Evidence storage;
- T4 decision states, pointer/history, stance minimums;
- cross-patch association revalidation and new-decision rule;
- T5 exact snapshot inputs and distinct-reviewer quorum;
- lock order and concurrency outcome;
- replay/rollback behavior;
- audit/outbox content minimization;
- no trust event dispatch;
- full Sprint 2A–3B gate and scope boundary.

- [ ] **Step 3: Run full local non-database checks**

Run:

```bash
npm --prefix backend run typecheck
npm --prefix backend run build
```

If a local PostgreSQL/Redis disposable environment is available, also run:

```bash
TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/hai_dau_test \
TEST_REDIS_URL=redis://127.0.0.1:6379 \
npm --prefix backend test
```

- [ ] **Step 4: Run exact-head durable gates**

Push the final documentation head and require:

- root orchestration/runbook contract success;
- frontend validation, lint, 46/46 tests, and Pages build success;
- backend typecheck success;
- every backend test passes on PostgreSQL 17 and Redis 7;
- backend build success;
- repository cleanliness and `git diff --check` success;
- deployment guard success;
- deploy workflow dry-run success with no publication.

Read raw logs. Record exact test counts and exact PostgreSQL/Redis versions from
the final head; do not infer them from an earlier run.

- [ ] **Step 5: Independent review**

Invoke `superpowers:requesting-code-review` for a read-only review from base
`aa54b7560cb27e9fbddfcba46073375a25e7e742` to the exact final head.

Reviewer focus:

- Claim/Patch/Catalog graph;
- deferred count/hash membership checks;
- lock-order cycles with Sprint 3A provenance append;
- stale Evidence pointer replay;
- cross-patch Evidence reuse;
- review-input completeness;
- same-reviewer quorum inflation;
- audit/outbox source-content leakage;
- accidental Moderation/Eligibility/Publication authority.

Verify each finding before changing code. For every valid Critical/Important
finding, invoke `superpowers:receiving-code-review`, add a focused RED,
implement the smallest fix, and repeat the exact-head full gate plus review.

- [ ] **Step 6: Update the draft PR**

Replace “implementation in progress” with:

- exact head SHA;
- delivered boundaries;
- review verdict;
- frontend/backend test counts;
- PostgreSQL/Redis versions;
- quality-gate and deploy-dry-run links;
- safety boundary.

Keep:

- PR state `draft`;
- base `feat/3a-deterministic-candidate-registry`;
- branch intact;
- no merge;
- no deployment.

- [ ] **Step 7: Finish**

Invoke `superpowers:verification-before-completion`, then
`superpowers:finishing-a-development-branch`. Choose the already-approved
project boundary: leave the stacked branch and draft PR open for the next
sprint.

Expected next task:

```text
Sprint 3C — Moderation and Eligibility persistence
```

---

## Plan self-review

- **Spec coverage:** Tasks 1–2 establish closed inputs and DB integrity; Task 3
  persists policy revisions; Task 4 seals Claims; Task 5 implements T4; Task 6
  implements T5/quorum; Task 7 covers races/replay/direct SQL; Task 8 covers
  operations, review, and final evidence.
- **No placeholder actions:** every code task names exact files, interfaces,
  failure mode, commands, and expected RED/GREEN result.
- **Type consistency:** `CandidateClaimInput`, `EvidenceAssociationInput`,
  `RecordClaimEvidenceDecisionCommand`, and
  `CompleteHumanReviewCommand` are defined once and reused by later tasks.
- **Scope consistency:** no task creates Moderation, Eligibility, Publication,
  AI discovery, public API, source adapter, production infrastructure, merge,
  or deployment behavior.
- **Concurrency consistency:** Tasks 4–7 all use Candidate →
  CandidateRevision → Claim ordering; T5 locks Candidate before reading
  provenance, matching Sprint 3A's provenance append coordination.
- **Authority consistency:** policy revisions are immutable explicit inputs;
  this sprint intentionally has no active trust-policy pointer and therefore
  cannot claim a decision is publish-current.
