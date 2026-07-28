# Moderation and Eligibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add revision-scoped immutable Moderation history, deterministic
fail-closed Eligibility, stale-safe reads, and outbox/BullMQ re-evaluation
without adding Publication or UI authority.

**Architecture:** PostgreSQL 17 stores normalized immutable policy, snapshot,
decision, evaluation, and reason history with narrow current pointers.
TypeScript application commands reload authoritative CandidateRevision trust
inputs, while deferred PostgreSQL guards independently recompute seals and
Eligibility outcomes. BullMQ carries only an outbox event identity to an
Eligibility worker that reloads PostgreSQL before evaluation.

**Tech Stack:** Node.js 22.13, TypeScript 5.9, PostgreSQL 17, `pg` 8.22,
BullMQ 5.80, Redis 7, Node test runner.

## Global Constraints

- Begin from `main` exact head
  `581cd4ca968f591e14acbf73c27ea11d0e7a20c7`.
- Work only on branch `feat/4a-moderation-eligibility`.
- Preserve committed design SHA `7fe9175b6ffe332e68803426e3c6caaf99e2589e`.
- Do not edit migrations `0001` through `0007`; add migration `0008`.
- PostgreSQL is the system of record; Redis payloads are never trust input.
- Moderation outcomes are exactly `clear | needs_review | blocked`.
- Eligibility outcomes are exactly `eligible | needs_review | ineligible`.
- No Moderation decision means `needs_review`; never create a default `clear`.
- Only `required` Claims directly determine Eligibility.
- A new CandidateRevision inherits no Moderation or Eligibility state.
- A stale or missing Eligibility evaluation reads as `needs_review`.
- Eligibility policy pins exact Evidence, Review, and Moderation revisions.
- Use lock order Candidate → CandidateRevision → Claims in C order → current
  Evidence → current Review → current Moderation → active Eligibility policy
  → current Eligibility.
- Every successful command atomically writes domain history, pointer when
  applicable, audit, outbox, and idempotency completion.
- Direct SQL must not be able to forge `eligible`.
- Existing frontend behavior, Pages output, and `/review/` remain unchanged.
- No Publication, UI, auth, external fetch, production credentials,
  infrastructure provisioning, merge, or deployment.
- Database RED/GREEN evidence must run on GitHub Actions PostgreSQL 17 and
  Redis 7. Local parse/type checks are supporting evidence only.
- Keep the pull request draft and unmerged.

---

## File structure

### Create

- `backend/migrations/0008_moderation_eligibility.sql` — policy, snapshots,
  decisions, evaluations, reasons, pointers, queue effects, and guards.
- `backend/src/modules/moderation/types.ts` — closed Moderation commands and
  results.
- `backend/src/modules/moderation/register-moderation-policy-revision.ts` —
  immutable policy registration.
- `backend/src/modules/moderation/record-candidate-moderation-decision.ts` —
  snapshot, decision history, pointer, audit/outbox/idempotency.
- `backend/src/modules/eligibility/types.ts` — policy, evaluation, read, and
  computation types.
- `backend/src/modules/eligibility/compute-eligibility.ts` — pure precedence
  and reason calculation.
- `backend/src/modules/eligibility/register-eligibility-policy-revision.ts` —
  immutable policy bundle registration.
- `backend/src/modules/eligibility/activate-eligibility-policy-revision.ts` —
  compare-and-swap active pointer.
- `backend/src/modules/eligibility/load-eligibility-authority.ts` — exact
  current Evidence, Review, Moderation, policy, and staleness loader.
- `backend/src/modules/eligibility/evaluate-candidate-eligibility.ts` —
  immutable snapshot/evaluation command.
- `backend/src/modules/eligibility/read-candidate-eligibility-status.ts` —
  fail-closed stale-safe read.
- `backend/src/queue/eligibility-worker.ts` — authoritative outbox reload and
  idempotent evaluation.
- `backend/test/helpers/gate.ts` — deterministic IDs and complete gate
  fixtures.
- `backend/test/eligibility-computation.test.ts` — pure precedence matrix.
- `backend/test/gate-migration.test.ts` — schema, immutability, direct-SQL,
  pointer, and deferred-currentness contracts.
- `backend/test/gate-policy.test.ts` — registration, activation, replay, and
  rollback.
- `backend/test/moderation.test.ts` — Moderation history and stale snapshot.
- `backend/test/eligibility.test.ts` — evaluation, read, history, precedence,
  revision isolation, and concurrency.
- `backend/test/eligibility-worker.test.ts` — routing, PostgreSQL authority,
  duplicate delivery, retry, and manual replay.

### Modify

- `backend/src/queue/names.ts` — add the Eligibility queue and routed-event
  type.
- `backend/src/queue/outbox-dispatcher.ts` — route each event to an explicit
  queue without changing lease/retry semantics.
- `backend/src/worker.ts` — start and stop the normalization and Eligibility
  workers.
- `backend/test/helpers/trust.ts` — expose the existing complete Evidence and
  Review fixtures needed by gate tests.
- `backend/test/migration.test.ts` — append migration `0008` tables to the exact
  schema/checksum contract.
- `backend/test/outbox.test.ts` — prove per-event routing and retry.
- `backend/test/worker.test.ts` — preserve normalization worker contracts after
  multi-queue runtime wiring.
- `backend/README.md` — Sprint 4A operation, stale read, replay, and safety
  boundary.
- `.github/workflows/backend-production-foundation.yml` — rename the gate and
  assert Sprint 4A runbook contracts; retain read-only permissions and
  deployment guard.

---

### Task 1: Pure Eligibility rule engine

**Files:**

- Create: `backend/src/modules/eligibility/types.ts`
- Create: `backend/src/modules/eligibility/compute-eligibility.ts`
- Test: `backend/test/eligibility-computation.test.ts`

**Interfaces:**

- Produces:

```ts
export type ModerationOutcome = 'clear' | 'needs_review' | 'blocked';
export type EligibilityOutcome =
  | 'eligible'
  | 'needs_review'
  | 'ineligible';

export type EligibilityReasonCode =
  | 'moderation_blocked'
  | 'required_claim_contradicted'
  | 'moderation_missing'
  | 'moderation_stale'
  | 'moderation_needs_review'
  | 'required_claim_decision_missing'
  | 'required_claim_decision_stale'
  | 'required_claim_policy_mismatch'
  | 'required_claim_insufficient'
  | 'review_quorum_missing'
  | 'review_quorum_stale'
  | 'review_policy_mismatch'
  | 'review_quorum_unsatisfied'
  | 'all_requirements_satisfied';

export interface RequiredClaimEligibilityInput {
  claimId: string;
  claimKey: string;
  decision:
    | 'supported'
    | 'insufficient'
    | 'contradicted'
    | null;
  current: boolean;
  policyMatches: boolean;
}

export interface EligibilityComputationInput {
  moderation: {
    outcome: ModerationOutcome | null;
    current: boolean;
  };
  requiredClaims: readonly RequiredClaimEligibilityInput[];
  review: {
    present: boolean;
    current: boolean;
    policyMatches: boolean;
    quorumSatisfied: boolean;
  };
}

export interface EligibilityComputation {
  outcome: EligibilityOutcome;
  reasons: EligibilityReasonCode[];
}

export function computeEligibility(
  input: EligibilityComputationInput,
): EligibilityComputation;
```

- Consumes no database or queue dependency.

- [ ] **Step 1: Write the first RED precedence contracts**

Create `backend/test/eligibility-computation.test.ts` with the canonical
eligible fixture and these assertions:

```ts
test('complete fresh trust graph is eligible', () => {
  assert.deepEqual(computeEligibility(eligibleInput()), {
    outcome: 'eligible',
    reasons: ['all_requirements_satisfied'],
  });
});

test('blocked Moderation outranks missing lower-layer inputs', () => {
  const input = eligibleInput();
  input.moderation.outcome = 'blocked';
  input.requiredClaims[0]!.decision = null;
  input.review.present = false;
  assert.deepEqual(computeEligibility(input), {
    outcome: 'ineligible',
    reasons: ['moderation_blocked'],
  });
});

test('contradicted required Claim is ineligible', () => {
  const input = eligibleInput();
  input.requiredClaims[0]!.decision = 'contradicted';
  assert.deepEqual(computeEligibility(input), {
    outcome: 'ineligible',
    reasons: ['required_claim_contradicted'],
  });
});
```

The production mutation that must make each test fail is the absence of the
closed precedence evaluator.

- [ ] **Step 2: Run RED**

Run:

```bash
npm --prefix backend test -- --test-name-pattern='eligible|ineligible'
```

Expected: module resolution or exported-function failure only. Commit the RED
tests as:

```text
test(4a): define eligibility precedence
```

- [ ] **Step 3: Implement minimal closed evaluator**

Implement `computeEligibility` with this exact branch order:

```ts
const unique = (values: EligibilityReasonCode[]) =>
  [...new Set(values)].sort();

export function computeEligibility(
  input: EligibilityComputationInput,
): EligibilityComputation {
  const contradicted = input.requiredClaims.some(
    (claim) => claim.current && claim.decision === 'contradicted',
  );
  if (input.moderation.outcome === 'blocked' && input.moderation.current) {
    return { outcome: 'ineligible', reasons: ['moderation_blocked'] };
  }
  if (contradicted) {
    return {
      outcome: 'ineligible',
      reasons: ['required_claim_contradicted'],
    };
  }

  const reasons: EligibilityReasonCode[] = [];
  if (input.moderation.outcome === null) reasons.push('moderation_missing');
  else if (!input.moderation.current) reasons.push('moderation_stale');
  else if (input.moderation.outcome === 'needs_review') {
    reasons.push('moderation_needs_review');
  }
  for (const claim of input.requiredClaims) {
    if (claim.decision === null) reasons.push('required_claim_decision_missing');
    else if (!claim.current) reasons.push('required_claim_decision_stale');
    else if (!claim.policyMatches) {
      reasons.push('required_claim_policy_mismatch');
    } else if (claim.decision === 'insufficient') {
      reasons.push('required_claim_insufficient');
    }
  }
  if (!input.review.present) reasons.push('review_quorum_missing');
  else if (!input.review.current) reasons.push('review_quorum_stale');
  else if (!input.review.policyMatches) reasons.push('review_policy_mismatch');
  else if (!input.review.quorumSatisfied) {
    reasons.push('review_quorum_unsatisfied');
  }
  if (reasons.length > 0) {
    return { outcome: 'needs_review', reasons: unique(reasons) };
  }
  return {
    outcome: 'eligible',
    reasons: ['all_requirements_satisfied'],
  };
}
```

Validate closed object keys and enums at the command boundaries, not inside
this pure already-typed function.

- [ ] **Step 4: Add RED edge cases**

Add individual tests for:

```ts
[
  ['missing Moderation', { outcome: null, current: false }, 'moderation_missing'],
  ['stale Moderation', { outcome: 'clear', current: false }, 'moderation_stale'],
  ['unresolved Moderation', { outcome: 'needs_review', current: true }, 'moderation_needs_review'],
]
```

Also assert missing, stale, wrong-policy, and `insufficient` required Claims;
missing, stale, wrong-policy, and unsatisfied Review quorum; deterministic
deduped lexical reason order; and rejection of an empty required-Claim set by
the calling normalizer.

- [ ] **Step 5: Run GREEN and commit**

Run:

```bash
npm --prefix backend test -- --test-name-pattern='Eligibility|eligible|Moderation|required Claim|Review quorum'
npm --prefix backend run typecheck
```

Expected: all new pure tests PASS and typecheck PASS. Commit:

```text
feat(4a): add deterministic eligibility rules
```

---

### Task 2: Gate policy and migration foundation

**Files:**

- Create: `backend/migrations/0008_moderation_eligibility.sql`
- Create: `backend/src/modules/moderation/types.ts`
- Create: `backend/src/modules/moderation/register-moderation-policy-revision.ts`
- Create: `backend/src/modules/eligibility/register-eligibility-policy-revision.ts`
- Create: `backend/src/modules/eligibility/activate-eligibility-policy-revision.ts`
- Create: `backend/test/helpers/gate.ts`
- Create: `backend/test/gate-migration.test.ts`
- Create: `backend/test/gate-policy.test.ts`
- Modify: `backend/test/migration.test.ts`

**Interfaces:**

```ts
export interface RegisterModerationPolicyRevisionCommand {
  actorId: string;
  correlationId: string;
  idempotencyKey: string;
  moderationPolicyRevisionId: string;
  policyKey: string;
  reason: string;
  revision: number;
  schemaVersion: 1;
}

export interface RegisterEligibilityPolicyRevisionCommand {
  actorId: string;
  correlationId: string;
  eligibilityPolicyRevisionId: string;
  evidencePolicyRevisionId: string;
  idempotencyKey: string;
  moderationPolicyRevisionId: string;
  policyKey: string;
  reason: string;
  reviewPolicyRevisionId: string;
  revision: number;
  schemaVersion: 1;
}

export interface ActivateEligibilityPolicyRevisionCommand {
  actorId: string;
  correlationId: string;
  eligibilityPolicyRevisionId: string;
  expectedCurrentEligibilityPolicyRevisionId: string | null;
  idempotencyKey: string;
  reason: string;
}
```

- [ ] **Step 1: Write migration RED contracts**

Define `GATE_TABLES` exactly as:

```ts
const GATE_TABLES = [
  'active_eligibility_policy_revision',
  'candidate_eligibility_evaluation_reasons',
  'candidate_eligibility_evaluations',
  'current_candidate_eligibility_evaluations',
  'current_candidate_moderation_decisions',
  'eligibility_input_snapshot_required_claims',
  'eligibility_input_snapshots',
  'eligibility_policy_revisions',
  'eligibility_recalculation_effects',
  'moderation_decisions',
  'moderation_input_snapshot_provenance',
  'moderation_input_snapshots',
  'moderation_policy_revisions',
] as const;
```

Assert all tables exist, all history tables have `reject_immutable_change`
triggers, current/active pointer tables remain narrow mutable state, and
migration `0008_moderation_eligibility.sql` appears after `0007` with a stable
SHA-256 checksum.

- [ ] **Step 2: Run and preserve RED**

Run:

```bash
npm --prefix backend test -- --test-name-pattern='Sprint 4A gate schema'
```

Expected: only the missing `0008` schema contract fails. Commit:

```text
test(4a): require gate policy schema
```

- [ ] **Step 3: Add the minimal policy schema**

Create these policy/pointer keys in migration `0008`:

```sql
create table moderation_policy_revisions (
  moderation_policy_revision_id uuid primary key,
  policy_key text not null collate "C",
  revision integer not null check (revision > 0),
  schema_version integer not null check (schema_version = 1),
  reason text not null check (octet_length(reason) between 1 and 1024),
  created_by text not null check (octet_length(created_by) between 1 and 256),
  created_at timestamptz not null default clock_timestamp(),
  unique (policy_key, revision)
);

create table eligibility_policy_revisions (
  eligibility_policy_revision_id uuid primary key,
  policy_key text not null collate "C",
  revision integer not null check (revision > 0),
  schema_version integer not null check (schema_version = 1),
  evidence_policy_revision_id uuid not null
    references evidence_policy_revisions(evidence_policy_revision_id),
  review_policy_revision_id uuid not null
    references review_policy_revisions(review_policy_revision_id),
  moderation_policy_revision_id uuid not null
    references moderation_policy_revisions(moderation_policy_revision_id),
  require_all_required_claims_supported boolean not null check (
    require_all_required_claims_supported
  ),
  require_review_quorum_satisfied boolean not null check (
    require_review_quorum_satisfied
  ),
  fail_closed_on_stale_input boolean not null check (
    fail_closed_on_stale_input
  ),
  reason text not null check (octet_length(reason) between 1 and 1024),
  created_by text not null check (octet_length(created_by) between 1 and 256),
  created_at timestamptz not null default clock_timestamp(),
  unique (policy_key, revision)
);

create table active_eligibility_policy_revision (
  scope text primary key check (scope = 'candidate_revision'),
  eligibility_policy_revision_id uuid not null
    references eligibility_policy_revisions(eligibility_policy_revision_id),
  updated_at timestamptz not null default clock_timestamp()
);
```

Add printable-ASCII/length checks matching existing trust policies, composite
unique identities for later foreign keys, and immutable triggers for both
policy history tables.

- [ ] **Step 4: Write policy command RED contracts**

Assert:

```ts
const moderation = await registerModerationPolicyRevision(
  pool,
  moderationPolicyCommand(),
);
assert.equal(moderation.replayed, false);

const policy = await registerEligibilityPolicyRevision(
  pool,
  eligibilityPolicyCommand(),
);
assert.equal(policy.replayed, false);

const activation = await activateEligibilityPolicyRevision(
  pool,
  activationCommand({ expectedCurrentEligibilityPolicyRevisionId: null }),
);
assert.equal(activation.previousEligibilityPolicyRevisionId, null);
assert.equal(
  activation.currentEligibilityPolicyRevisionId,
  GATE_IDS.eligibilityPolicyId,
);
```

Also test same-key replay, changed-payload conflict, duplicate key/revision
conflict, invalid subordinate policy IDs, stale activation compare-and-swap,
and an injected late failure that leaves no policy/audit/outbox/completed
idempotency side effect.

- [ ] **Step 5: Implement policy commands**

Use `beginIdempotentCommand`, `completeIdempotentCommand`,
`hashCanonicalTupleV1`, `requireUuid`, `requireBoundedText`, and
`withTransaction`. Each command must write:

```ts
{
  audit: 'gate.policy_revision_registered' | 'gate.eligibility_policy_activated',
  outbox:
    | 'ModerationPolicyRevisionRegistered'
    | 'EligibilityPolicyRevisionRegistered'
    | 'EligibilityPolicyRevisionActivated',
}
```

Activation must use:

```sql
select eligibility_policy_revision_id
  from active_eligibility_policy_revision
 where scope = 'candidate_revision'
 for update;
```

Then compare null-safely with the expected pointer before insert/upsert.

- [ ] **Step 6: Run GREEN and commit**

Run:

```bash
npm --prefix backend test -- --test-name-pattern='gate schema|gate policy|Eligibility policy'
npm --prefix backend run typecheck
```

Expected: migration and policy suites PASS. Commit:

```text
feat(4a): persist gate policy revisions
```

---

### Task 3: Moderation history and current pointer

**Files:**

- Expand: `backend/migrations/0008_moderation_eligibility.sql`
- Create: `backend/src/modules/moderation/record-candidate-moderation-decision.ts`
- Create: `backend/test/moderation.test.ts`
- Expand: `backend/test/helpers/gate.ts`
- Expand: `backend/test/gate-migration.test.ts`

**Interfaces:**

```ts
export interface RecordCandidateModerationDecisionCommand {
  actorId: string;
  candidateId: string;
  candidateRevisionId: string;
  correlationId: string;
  decisionId: string;
  evaluatedAt: string;
  idempotencyKey: string;
  inputSnapshotId: string;
  moderationPolicyRevisionId: string;
  outcome: ModerationOutcome;
  reason: string;
}

export interface RecordCandidateModerationDecisionResult {
  candidateRevisionId: string;
  decisionId: string;
  inputHash: string;
  outcome: ModerationOutcome;
  replayed: boolean;
}
```

- [ ] **Step 1: Write application RED tests**

After `seedTrustReviewContext`, assert one command creates one snapshot,
provenance membership, decision, current pointer, audit, outbox, and completed
idempotency record. Assert the result:

```ts
assert.deepEqual(result, {
  candidateRevisionId: CANDIDATE_IDS.candidateRevisionId,
  decisionId: GATE_IDS.moderationDecisionId,
  inputHash: result.inputHash,
  outcome: 'clear',
  replayed: false,
});
assert.match(result.inputHash, /^[a-f0-9]{64}$/);
```

Add separate tests for `needs_review`, `blocked`, replay without duplicate
effects, payload conflict, another CandidateRevision isolation, equal-time
forward pointer, equal-time rollback rejection, and rollback after an injected
late failure.

- [ ] **Step 2: Run RED**

Run:

```bash
npm --prefix backend test -- --test-name-pattern='Moderation'
```

Expected: missing Moderation command/schema failure only. Commit:

```text
test(4a): define immutable moderation history
```

- [ ] **Step 3: Add Moderation snapshot and decision schema**

Add:

```sql
create table moderation_input_snapshots (...);
create table moderation_input_snapshot_provenance (...);
create table moderation_decisions (
  moderation_decision_id uuid primary key,
  decision_sequence bigint generated always as identity unique,
  ...
  outcome text not null check (
    outcome in ('clear', 'needs_review', 'blocked')
  ),
  evaluated_at timestamptz not null
);
create table current_candidate_moderation_decisions (...);
```

The header unique identity must include Candidate, CandidateRevision, Patch,
CatalogRevision, policy, and input hash. Membership must include exact
CandidateRevision provenance identity and origin.

Add deferred `enforce_moderation_input_snapshot_seal`, immediate
`enforce_moderation_decision_graph`, and
`enforce_current_candidate_moderation_graph`. The pointer guard must compare
both `evaluated_at` and `decision_sequence`.

- [ ] **Step 4: Implement the command**

Normalize exact command keys and enum values. Reuse
`lockCandidateRevisionAuthority`; lock sealed Claims by:

```sql
select claim_id, claim_key
  from candidate_claims
 where candidate_revision_id = $1
 order by claim_key collate "C"
 for update;
```

Load provenance in UUID order, calculate `ModerationProvenanceSetV1` and
`ModerationInputSnapshotV1` with `TrustTupleV1`, insert or reuse the immutable
snapshot, append the decision, advance the pointer, and write:

```ts
const eventPayload = {
  candidateId,
  candidateRevisionId,
  decisionId,
  inputHash,
  moderationPolicyRevisionId,
  outcome,
};
```

Do not include `reason`, Claims, or source content in audit/outbox payloads.

- [ ] **Step 5: Add stale-input direct-SQL RED**

In one PostgreSQL transaction:

1. insert a valid Moderation snapshot header/member;
2. append a new Candidate provenance row before commit;
3. insert the decision/current pointer;
4. expect commit rejection with `moderation input snapshot is not current`.

This proves deferred currentness, not merely insert-time validation.

- [ ] **Step 6: Run GREEN and commit**

Run:

```bash
npm --prefix backend test -- --test-name-pattern='Moderation|gate schema'
npm --prefix backend run typecheck
```

Expected: all Moderation and direct-SQL contracts PASS. Commit:

```text
feat(4a): persist moderation decision history
```

---

### Task 4: Eligibility snapshot, evaluation, and fail-closed read

**Files:**

- Expand: `backend/migrations/0008_moderation_eligibility.sql`
- Create: `backend/src/modules/eligibility/load-eligibility-authority.ts`
- Create: `backend/src/modules/eligibility/evaluate-candidate-eligibility.ts`
- Create: `backend/src/modules/eligibility/read-candidate-eligibility-status.ts`
- Create: `backend/test/eligibility.test.ts`
- Expand: `backend/test/helpers/gate.ts`
- Expand: `backend/test/gate-migration.test.ts`

**Interfaces:**

```ts
export interface EvaluateCandidateEligibilityCommand {
  actorId: string;
  candidateId: string;
  candidateRevisionId: string;
  correlationId: string;
  evaluatedAt: string;
  evaluationId: string;
  idempotencyKey: string;
  inputSnapshotId: string;
}

export interface EvaluateCandidateEligibilityResult {
  candidateRevisionId: string;
  eligibilityPolicyRevisionId: string;
  evaluationId: string;
  inputHash: string;
  outcome: EligibilityOutcome;
  reasons: EligibilityReasonCode[];
  replayed: boolean;
}

export interface CandidateEligibilityStatus {
  activeEligibilityPolicyRevisionId: string | null;
  candidateRevisionId: string;
  currentEvaluationId: string | null;
  outcome: EligibilityOutcome;
  reasons: EligibilityReasonCode[];
  stale: boolean;
}
```

- [ ] **Step 1: Write the missing/stale read RED tests**

Assert:

```ts
assert.deepEqual(
  await readCandidateEligibilityStatus(
    pool,
    CANDIDATE_IDS.candidateId,
    CANDIDATE_IDS.candidateRevisionId,
  ),
  {
    activeEligibilityPolicyRevisionId: GATE_IDS.eligibilityPolicyId,
    candidateRevisionId: CANDIDATE_IDS.candidateRevisionId,
    currentEvaluationId: null,
    outcome: 'needs_review',
    reasons: ['moderation_missing'],
    stale: true,
  },
);
```

Before an active policy exists, expect `activeEligibilityPolicyRevisionId:
null`, `needs_review`, `currentEvaluationId: null`, reason
`moderation_missing`, and `stale: true`.

- [ ] **Step 2: Write full evaluation RED matrix**

Create separate database-backed tests for:

- clear + all required supported + fresh satisfied quorum → `eligible`;
- blocked → `ineligible`;
- required contradicted → `ineligible`;
- missing/stale/needs-review Moderation → `needs_review`;
- missing/stale/wrong-policy/insufficient required Evidence →
  `needs_review`;
- missing/stale/wrong-policy/unsatisfied Review → `needs_review`;
- supporting or informational contradiction does not change `eligible`;
- a second revision has no inherited current pointer;
- same-key replay is side-effect-free;
- changed payload conflicts;
- injected late failure rolls back all effects.

Name each test after the production mutation it would catch, for example:

```ts
test('Eligibility rejects the mutation that treats a stale Review quorum as current', async () => {
  // Seed a satisfied quorum, append provenance, evaluate, assert needs_review.
});
```

- [ ] **Step 3: Run and commit RED**

Run:

```bash
npm --prefix backend test -- --test-name-pattern='Eligibility'
```

Expected: only missing Eligibility persistence/read implementation fails.
Commit:

```text
test(4a): define fail-closed eligibility
```

- [ ] **Step 4: Add Eligibility schema**

Add the six remaining history/pointer tables:

```sql
create table eligibility_input_snapshots (...);
create table eligibility_input_snapshot_required_claims (...);
create table candidate_eligibility_evaluations (...);
create table candidate_eligibility_evaluation_reasons (...);
create table current_candidate_eligibility_evaluations (...);
create table eligibility_recalculation_effects (...);
```

Required-Claim membership uses a nullable current decision ID and nullable
decision enum as explicit absence. Add checks that both are null together or
both non-null. Header identity pins the active Eligibility policy and the
three subordinate policy IDs.

Add:

- `enforce_eligibility_required_claim_graph`;
- `enforce_eligibility_input_snapshot_seal`;
- `enforce_candidate_eligibility_result`;
- `enforce_current_candidate_eligibility_graph`;
- immutable triggers on all history/membership/reason tables.

The deferred result guard must independently recompute reason membership and
outcome using the precedence in Task 1.

- [ ] **Step 5: Implement authority loading**

`loadEligibilityAuthority` must:

1. call `lockCandidateRevisionAuthority`;
2. lock all Claims in C order;
3. require one claim-set seal and at least one required Claim;
4. load each required current Evidence pointer/decision and compare the
   policy with the active Eligibility policy;
5. load the current Moderation pointer for the pinned policy and verify its
   snapshot provenance membership against live provenance;
6. load the current Review quorum for the pinned policy and verify its Review
   snapshot Claim/current-decision and provenance membership against live
   rows;
7. return only typed IDs, enums, freshness booleans, counts, and hashes.

Use null-safe comparisons. Never accept Redis or caller-provided trust values.

- [ ] **Step 6: Implement evaluation and read**

`evaluateCandidateEligibility` computes `inputHash`, calls
`computeEligibility`, inserts the exact required-Claim membership and ordered
reason rows, appends the evaluation, advances the pointer, writes
`gate.candidate_eligibility_evaluated` audit and
`CandidateEligibilityEvaluated` outbox, and completes idempotency.

`readCandidateEligibilityStatus` reloads the active policy and current inputs
without mutation. It returns the persisted outcome only when the stored input
hash matches the newly calculated authority hash; otherwise:

```ts
return {
  activeEligibilityPolicyRevisionId,
  candidateRevisionId,
  currentEvaluationId,
  outcome: 'needs_review',
  reasons: currentFailureReasons.length > 0
    ? currentFailureReasons
    : ['moderation_missing'],
  stale: true,
};
```

- [ ] **Step 7: Add immediate-staleness regression**

Create an `eligible` evaluation, append a new current Evidence decision or
Candidate provenance row, do not run the worker, and assert the read boundary
immediately returns `needs_review` with `stale: true`.

- [ ] **Step 8: Run GREEN and commit**

Run:

```bash
npm --prefix backend test -- --test-name-pattern='Eligibility|gate schema'
npm --prefix backend run typecheck
```

Expected: full evaluation matrix and stale read PASS. Commit:

```text
feat(4a): evaluate revision eligibility fail closed
```

---

### Task 5: Queue routing and Eligibility worker

**Files:**

- Modify: `backend/src/queue/names.ts`
- Modify: `backend/src/queue/outbox-dispatcher.ts`
- Create: `backend/src/queue/eligibility-worker.ts`
- Modify: `backend/src/worker.ts`
- Modify: `backend/test/outbox.test.ts`
- Create: `backend/test/eligibility-worker.test.ts`
- Modify: `backend/test/worker.test.ts`

**Interfaces:**

```ts
export const ELIGIBILITY_QUEUE_NAME = 'hai-dau-eligibility-v1';

export interface RoutedOutboxQueues {
  eligibility: OutboxQueue;
  normalization: OutboxQueue;
}

export interface EligibilityWorkerResult {
  candidateRevisionId: string;
  outcome:
    | 'evaluated'
    | 'duplicate_noop'
    | 'not_evaluable_yet';
}
```

- [ ] **Step 1: Write dispatch routing RED**

Seed one `RawObservationIngested` and one
`ClaimEvidenceDecisionRecorded` outbox row. Call:

```ts
const result = await dispatchOutbox({
  pool,
  queues: { normalization, eligibility },
});
```

Assert the raw event is added only to normalization, the trust event only to
Eligibility, both use the outbox ID as `jobId`, and the result is:

```ts
{ claimed: 2, delivered: 2, failed: 0 }
```

Also assert unsupported events remain pending and a failure in one routed
queue does not alter the other event's immutable payload.

- [ ] **Step 2: Run and commit routing RED**

Run:

```bash
npm --prefix backend test -- --test-name-pattern='routes outbox'
```

Expected: current single-queue dispatcher API fails. Commit:

```text
test(4a): require eligibility queue routing
```

- [ ] **Step 3: Implement explicit routing**

Add:

```ts
const NORMALIZATION_EVENTS = new Set(['RawObservationIngested']);
const ELIGIBILITY_EVENTS = new Set([
  'CandidateRegistered',
  'CandidateRevisionRegistered',
  'CandidateProvenanceAdded',
  'CandidateClaimSetDefined',
  'ClaimEvidenceDecisionRecorded',
  'HumanReviewCompleted',
  'ModerationDecisionRecorded',
]);
```

Resolve the queue from `event_type` after claiming. Preserve lease, retry,
backoff, delivery state, and immutable payload behavior.

- [ ] **Step 4: Write Eligibility worker RED contracts**

Use real BullMQ/Redis and PostgreSQL. Prove:

- a `ModerationDecisionRecorded` job evaluates the authoritative revision;
- tampered Redis Candidate IDs/policy IDs are ignored;
- duplicate delivery creates one `eligibility_recalculation_effect`;
- lost acknowledgement retries to `duplicate_noop`;
- missing claim seal returns `not_evaluable_yet`;
- malformed authoritative source event fails with
  `INVALID_ELIGIBILITY_SOURCE_EVENT`;
- queue retry records `ELIGIBILITY_EVALUATION_FAILED`, not a raw error.

- [ ] **Step 5: Implement worker**

`validateJobEnvelope` accepts only the closed Eligibility event set and
requires `job.data.outboxEventId === job.id`.

`loadEligibilitySource` must query `outbox_events` by job ID, validate
aggregate/event/payload consistency, and return only CandidateRevision and
correlation IDs from PostgreSQL.

Reserve:

```sql
insert into eligibility_recalculation_effects
  (outbox_event_id, candidate_revision_id, effect_state)
values ($1, $2, 'evaluated')
on conflict do nothing
returning outbox_event_id;
```

Use deterministic UUIDv5-equivalent SHA-derived UUIDs or stored generated IDs
inside the reserved effect row so retry calls the same evaluation identities.
Do not derive authority from Redis payload fields.

- [ ] **Step 6: Wire runtime lifecycle**

Start both workers with separate Redis connections in `backend/src/worker.ts`.
Shutdown closes both workers, both connections, and PostgreSQL exactly once.
Do not add a production dispatcher scheduler in this sprint.

- [ ] **Step 7: Run GREEN and commit**

Run:

```bash
npm --prefix backend test -- --test-name-pattern='outbox|Eligibility worker|normalization worker'
npm --prefix backend run typecheck
```

Expected: routing and both workers PASS. Commit:

```text
feat(4a): queue eligibility reevaluation
```

---

### Task 6: Direct-SQL, concurrency, and replay hardening

**Files:**

- Expand: `backend/test/gate-migration.test.ts`
- Expand: `backend/test/moderation.test.ts`
- Expand: `backend/test/eligibility.test.ts`
- Expand: `backend/test/eligibility-worker.test.ts`
- Modify only when a RED proves a gap:
  `backend/migrations/0008_moderation_eligibility.sql`,
  `backend/src/modules/moderation/record-candidate-moderation-decision.ts`,
  `backend/src/modules/eligibility/evaluate-candidate-eligibility.ts`,
  `backend/src/queue/eligibility-worker.ts`

**Interfaces:** No new public interface.

- [ ] **Step 1: Add one RED per direct-SQL mutation**

Each test must name the production mutation it catches and use PostgreSQL,
without test hooks:

```ts
test('PostgreSQL rejects Eligibility when a required Claim member is omitted', ...);
test('PostgreSQL rejects Eligibility using another revision Moderation decision', ...);
test('PostgreSQL rejects eligible with an unsatisfied Review quorum', ...);
test('PostgreSQL rejects a forged all_requirements_satisfied reason', ...);
test('PostgreSQL rejects equal-time Moderation pointer rollback', ...);
test('PostgreSQL rejects equal-time Eligibility pointer rollback', ...);
test('PostgreSQL rechecks Eligibility currentness at commit', ...);
```

Run each test before its production fix and preserve the exact RED SHA.

- [ ] **Step 2: Harden only proven gaps**

For every correct RED:

1. add the smallest trigger/guard/order fix;
2. run the isolated test to GREEN;
3. run all `gate-migration`, `moderation`, and `eligibility` tests;
4. commit one fix with one root cause.

Use commit prefixes:

```text
fix(4a): seal required eligibility membership
fix(4a): enforce eligibility decision result
fix(4a): keep moderation pointer monotonic
fix(4a): recheck eligibility currentness at commit
```

- [ ] **Step 3: Add real concurrency schedules**

Use two `pg` clients and real transactions to prove:

- concurrent Moderation decisions complete without deadlock and the later
  sequence is current;
- an Evidence decision and Eligibility evaluation sharing a revision complete
  without deadlock;
- a Human Review completion and Eligibility evaluation complete without
  deadlock;
- two Eligibility workers for different source events create two immutable
  evaluations but one monotonic current pointer;
- active policy change concurrent with evaluation cannot commit a falsely
  current evaluation.

Set a bounded `lock_timeout`/`statement_timeout` and assert no `40P01`
deadlock.

- [ ] **Step 4: Run hardening gate**

Run:

```bash
npm --prefix backend test -- --test-name-pattern='PostgreSQL|concurrent|replay|rollback'
npm --prefix backend test
npm --prefix backend run typecheck
npm --prefix backend run build
```

Expected: all backend tests PASS with no warnings or unhandled handles.

---

### Task 7: Runbook, workflow, and complete regression gate

**Files:**

- Modify: `backend/README.md`
- Modify: `.github/workflows/backend-production-foundation.yml`
- Modify: `backend/test/migration.test.ts`

**Interfaces:** CI/runbook contracts only.

- [ ] **Step 1: Write workflow/runbook RED contract**

Update the workflow contract list before the runbook so Actions fails only for
these absent strings:

```text
Moderation decision history
No default clear
Eligibility input snapshot
Only required Claims determine Eligibility
Stale Eligibility reads needs_review
Eligibility re-evaluation queue
PostgreSQL remains Eligibility authority
No Publication
No UI
No auth
No merge
```

Rename the workflow and concurrency group to Sprint 4A, keep:

```yaml
permissions:
  contents: read
```

and retain the deployment-command scan.

- [ ] **Step 2: Run and commit RED**

Run the workflow's inline runbook contract locally with Node. Expected:
missing runbook contract only. Commit:

```text
test(4a): require moderation eligibility runbook
```

- [ ] **Step 3: Document operations and scope**

Add Sprint 4A sections explaining:

- policy registration and activation;
- Moderation outcomes and no default;
- Eligibility precedence;
- stale-safe read behavior;
- outbox event routing and Redis authority boundary;
- worker retry/duplicate recovery;
- manual replay;
- no Publication/UI/auth/deploy.

Remove obsolete claims that all trust events remain undispatched; state
exactly which events enter the Eligibility queue.

- [ ] **Step 4: Run the full exact-head gate**

Run or trigger on the same SHA:

```bash
npm run validate:community
npm run lint
npm test
npm run build:pages
npm run backend:typecheck
npm run backend:test
npm run backend:build
git diff --check
```

Require PostgreSQL 17 and Redis 7 service-backed CI. Also run the deployment
dry-run and confirm no write permission, deploy command, merge, or production
credential.

- [ ] **Step 5: Commit GREEN**

Commit:

```text
docs(4a): document moderation eligibility operations
```

Do not amend prior RED/GREEN evidence commits.

---

### Task 8: Final review and draft PR checkpoint

**Files:** No production changes unless review identifies a proven issue.

**Interfaces:** GitHub draft PR and evidence handoff.

- [ ] **Step 1: Verify exact range**

Confirm:

```text
base: 581cd4ca968f591e14acbf73c27ea11d0e7a20c7
head: <exact final Sprint 4A SHA>
branch: feat/4a-moderation-eligibility
```

List changed files and ensure none touch Publication, frontend behavior, auth,
external fetch, production credentials, or deployment.

- [ ] **Step 2: Perform independent review**

Review migration, policy, Moderation, Eligibility, queue, and tests against the
design. Findings are classified Critical, Important, or Minor.

For every Critical/Important finding:

1. reproduce with a focused RED test;
2. verify the RED reason;
3. implement the minimal GREEN fix;
4. rerun the focused and full gate;
5. request re-review on the exact new head.

- [ ] **Step 3: Apply verification-before-completion**

Record exact:

- frontend pass counts;
- backend pass count;
- PostgreSQL and Redis versions;
- typecheck/build status;
- cleanliness/deployment-guard status;
- dry-run URL and result;
- review verdict.

Do not claim complete from an earlier SHA.

- [ ] **Step 4: Open/update a draft PR**

Use:

```text
Title: Sprint 4A: persist Moderation and Eligibility
Base: main
Head: feat/4a-moderation-eligibility
State: draft
```

The PR body must state:

- immutable revision-scoped Moderation;
- deterministic fail-closed Eligibility;
- only required Claims determine Eligibility;
- stale reads return `needs_review`;
- outbox/BullMQ re-evaluation reloads PostgreSQL;
- all exact-head checks and review results;
- no Publication, UI, auth, merge, or deploy.

- [ ] **Step 5: Stop at the approved boundary**

Leave the PR `open + draft + unmerged`. Do not deploy. Report the exact head,
test evidence, review result, and PR URL.

---

## Plan self-review

- **Spec coverage:** Tasks 1–8 cover every requirement in design sections
  1–16.
- **No placeholders:** every task names files, interfaces, tests, expected RED,
  implementation boundary, verification command, and commit.
- **Type consistency:** `ModerationOutcome`, `EligibilityOutcome`,
  `EligibilityReasonCode`, command/result names, and policy IDs are consistent
  across tasks.
- **Scope:** one backend subsystem with policy, Moderation, Eligibility, queue,
  and gate; Publication/UI/auth remain excluded.
- **TDD:** no production task precedes an observed failing test.
- **Safety:** all writes remain on the Sprint 4A branch; final state is draft,
  unmerged, and undeployed.
