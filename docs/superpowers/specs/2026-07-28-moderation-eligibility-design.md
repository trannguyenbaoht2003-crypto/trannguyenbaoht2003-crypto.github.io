# Sprint 4A — Moderation and Eligibility Design

**Status:** Approved for implementation under the project owner's standing
Core-roadmap authorization.

**Base:** `main` exact head
`581cd4ca968f591e14acbf73c27ea11d0e7a20c7`, after the successful post-merge
integration gate.

**Branch:** `feat/4a-moderation-eligibility`.

**Architecture:** Node.js/Fastify modular monolith, PostgreSQL 17 as the
system of record, BullMQ/Redis as delivery infrastructure.

## 1. Goal

Sprint 4A adds the backend authority that decides whether one immutable
`CandidateRevision` has passed Moderation and whether its exact current trust
inputs are eligible for a later Publication command.

The sprint must prove:

- Moderation history is immutable and independent from Evidence and Human
  Review;
- Moderation outcomes are exactly `clear`, `needs_review`, and `blocked`;
- absence of a current, fresh Moderation decision is never interpreted as
  `clear`;
- Eligibility outcomes are exactly `eligible`, `needs_review`, and
  `ineligible`;
- only Claims whose importance is `required` participate in Eligibility;
- a new CandidateRevision does not inherit Moderation or Eligibility from an
  older revision;
- Eligibility pins the exact CandidateRevision, policies, required-Claim
  decisions, Moderation decision, and Human Review quorum used;
- changed inputs make an old Eligibility evaluation stale immediately;
- a stale or missing evaluation reads as `needs_review` while a new evaluation
  is queued;
- automatic re-evaluation requests use PostgreSQL outbox history and BullMQ,
  while an explicit replay command remains available for operations;
- application commands, audit, outbox, current pointers, and idempotency
  results commit atomically;
- direct SQL cannot forge `eligible`.

Sprint 4A creates no Publication version or public-read authority.

## 2. Locked product rules

### 2.1 CandidateRevision boundary

Moderation and Eligibility belong to one `CandidateRevision`, not to the
long-lived Candidate.

- A new revision begins fail-closed as `needs_review`.
- It receives its own Moderation snapshot and decision.
- It receives its own Eligibility snapshots and evaluations.
- No `clear` or `eligible` state is copied from an older revision.
- Old revisions, snapshots, decisions, evaluations, and pointers remain
  available for audit and replay.

### 2.2 Moderation outcomes

- `clear`: the pinned Moderation input has no identified blocking issue.
- `needs_review`: the pinned input is unresolved or requires another
  Moderation pass.
- `blocked`: a confirmed violation blocks later Publication Eligibility.
- No decision: the read result is synthesized as `needs_review`; no default
  `clear` database row is created.

### 2.3 Eligibility outcomes and precedence

Eligibility uses this closed, deterministic precedence:

1. Current, fresh Moderation `blocked` produces `ineligible`.
2. Any current required Claim decision `contradicted` produces `ineligible`.
3. Missing or stale Moderation, or Moderation `needs_review`, produces
   `needs_review`.
4. A required Claim with no current decision, a stale decision, the wrong
   Evidence policy, or `insufficient` produces `needs_review`.
5. Missing, stale, policy-mismatched, or unsatisfied Human Review quorum
   produces `needs_review`.
6. Only fresh Moderation `clear`, every required Claim `supported` under the
   pinned Evidence policy, and a fresh satisfied quorum under the pinned
   Review policy produce `eligible`.

`supporting` and `informational` Claims remain sealed and auditable but do not
directly change the Eligibility outcome.

### 2.4 Staleness

An Eligibility evaluation is current only while every pinned authority input
is still current:

- CandidateRevision identity, Patch, CatalogRevision, and normalized
  signature;
- Candidate claim-set seal and exact required Claim membership;
- each required Claim current Evidence decision;
- Candidate provenance used by the Moderation and Review snapshots;
- current Moderation decision under the pinned policy;
- current Review quorum evaluation under the pinned policy;
- active Eligibility policy revision.

A new Evidence decision, Human Review/quorum evaluation, Moderation decision,
Candidate provenance row, Candidate claim-set seal, CandidateRevision, or
active Eligibility policy makes a mismatching old evaluation stale.

The authoritative read boundary compares the stored snapshot with current
PostgreSQL inputs. It returns `needs_review` with `stale = true` before any
asynchronous worker finishes. It never continues serving stale `eligible`.

## 3. Scope

### Included

- immutable Moderation-policy revisions;
- immutable Eligibility-policy revisions that pin exact Evidence, Review, and
  Moderation policy revisions;
- an explicitly activated Eligibility-policy pointer;
- immutable Moderation input snapshots and provenance membership;
- append-only Moderation decision history and a narrow current pointer;
- immutable Eligibility input snapshots and required-Claim membership;
- append-only Eligibility evaluations, normalized reason membership, and a
  narrow current pointer;
- deterministic Eligibility computation in TypeScript and PostgreSQL;
- a fail-closed Eligibility read boundary;
- automatic re-evaluation queue routing for authoritative outbox events;
- an Eligibility worker that reloads every input from PostgreSQL;
- explicit manual evaluation/replay;
- idempotency, audit, outbox, locking, direct-SQL guards, integration tests,
  runbook, and CI contracts.

### Excluded

- reviewer or moderator UI;
- API authentication, permissions provider, or account administration;
- pending reviewer assignment, threaded comments, or moderation appeals;
- content classifiers, external safety services, or external source fetches;
- AI discovery or AI-generated decisions;
- confidence scores, weights, or probabilistic eligibility;
- PublicationVersion, activation, rollback, public read model, or deploy;
- production credentials or infrastructure provisioning;
- merging the Sprint 4A pull request.

## 4. Options considered

### Option A — Immutable histories with exact relational snapshots

Moderation and Eligibility each receive append-only history, normalized input
membership, and a narrow current pointer. PostgreSQL recomputes snapshot seals
and the Eligibility outcome at commit.

This is selected. It follows the Evidence v3/Human Review architecture and
lets direct-SQL constraints enforce the trust graph.

### Option B — Calculate Eligibility only when read

This removes Eligibility tables but loses the actor, policy, exact input,
reason, audit, and replay history used for a decision. It cannot demonstrate
which trust graph authorized a future PublicationVersion. Rejected.

### Option C — Mutable status columns on CandidateRevision

This is small but overwrites decision history, cannot distinguish stale input,
and encourages later Publication code to trust an unsealed status. Rejected.

## 5. Module boundaries

Sprint 4A creates two domain modules.

### 5.1 `modules/moderation`

Owns:

- Moderation policy revisions;
- Moderation input snapshots;
- Moderation decision history;
- the current Moderation pointer;
- `registerModerationPolicyRevision`;
- `recordCandidateModerationDecision`.

It may read Candidate, CandidateRevision, sealed Claims, and provenance. It
does not modify Evidence, Human Review, Eligibility, or Publication.

### 5.2 `modules/eligibility`

Owns:

- Eligibility policy revisions and activation;
- Eligibility input snapshots;
- Eligibility evaluation history and reason membership;
- the current Eligibility pointer;
- `registerEligibilityPolicyRevision`;
- `activateEligibilityPolicyRevision`;
- `evaluateCandidateEligibility`;
- `readCandidateEligibilityStatus`.

It reads Moderation, required Claim Evidence decisions, and Review quorum. It
does not modify any of them and does not create Publication authority.

### 5.3 Queue boundary

The outbox dispatcher routes:

- `RawObservationIngested` to the existing normalization queue;
- `CandidateRegistered`;
- `CandidateRevisionRegistered`;
- `CandidateProvenanceAdded`;
- `CandidateClaimSetDefined`;
- `ClaimEvidenceDecisionRecorded`;
- `HumanReviewCompleted`;
- `ModerationDecisionRecorded`

to the Eligibility re-evaluation queue when the event contains an exact
CandidateRevision identity.

Events that occur before a claim-set seal exists complete as
`not_evaluable_yet`; they do not invent an Eligibility snapshot. A later
`CandidateClaimSetDefined` event retries the lifecycle naturally.

## 6. Policy model

### 6.1 `moderation_policy_revisions`

Each immutable row stores:

- `moderation_policy_revision_id`;
- canonical printable-ASCII `policy_key`;
- positive `revision`;
- `schema_version = 1`;
- bounded reason, creator, and creation time;
- uniqueness by policy key plus revision.

Sprint 4A stores the exact policy identity and schema version. It does not add
a classifier rules language.

### 6.2 `eligibility_policy_revisions`

Each immutable row stores:

- `eligibility_policy_revision_id`;
- canonical policy key and positive revision;
- `schema_version = 1`;
- exact `evidence_policy_revision_id`;
- exact `review_policy_revision_id`;
- exact `moderation_policy_revision_id`;
- rule flags fixed true:
  `require_all_required_claims_supported`,
  `require_review_quorum_satisfied`, and
  `fail_closed_on_stale_input`;
- bounded reason, creator, and creation time.

This bundle prevents a worker from choosing a latest or hidden policy.

### 6.3 `active_eligibility_policy_revision`

One mutable row exists for scope `candidate_revision`.

Activation:

- uses compare-and-swap against the caller's expected current policy ID or
  explicit absence;
- moves only to a registered immutable Eligibility policy revision;
- is audited, written to outbox, and idempotent;
- never edits policy history;
- makes evaluations under another policy stale at read time.

Policy activation does not bulk-create evaluations in the activation
transaction. Existing revisions remain fail-closed until replayed or touched
by an authoritative re-evaluation event.

## 7. Moderation persistence

Migration `0008_moderation_eligibility.sql` adds the Sprint 4A records. It does
not edit migrations `0001` through `0007`.

### 7.1 Moderation input snapshot

`moderation_input_snapshots` pins:

- Candidate and CandidateRevision;
- Patch and CatalogRevision;
- normalized signature;
- Candidate claim-set seal, hash, and claim count;
- exact provenance count and provenance-set hash;
- Moderation policy revision;
- canonical `ModerationInputSnapshotV1` hash;
- creator and snapshot time.

`moderation_input_snapshot_provenance` contains the exact ordered provenance
IDs and origins. The claim-set seal already commits to every Claim identity,
importance, and statement hash, so Claims are not duplicated in a second
membership table.

The snapshot is reusable by multiple later Moderation decisions only while its
sealed contents remain exact. A new provenance row creates a new snapshot hash.

### 7.2 Moderation decisions

`moderation_decisions` stores:

- opaque decision ID and database-generated sequence;
- Candidate, CandidateRevision, Patch, and CatalogRevision;
- exact Moderation input snapshot and policy revision;
- outcome `clear | needs_review | blocked`;
- evaluator actor, bounded reason, correlation ID, and evaluation time;
- immutable creation metadata.

`current_candidate_moderation_decisions` contains one mutable pointer per
CandidateRevision and Moderation policy revision.

Pointer movement must satisfy both:

- `evaluated_at` never decreases;
- decision sequence strictly increases when the pointer changes.

This permits two evaluations at the same timestamp while preventing rollback
to an older decision.

### 7.3 Moderation command

`recordCandidateModerationDecision`:

1. validates a closed V1 command;
2. locks Candidate then CandidateRevision;
3. locks sealed Claim rows in canonical Claim-key order;
4. locks the current Moderation pointer;
5. reloads provenance in deterministic ID order;
6. builds or reuses the exact Moderation snapshot;
7. appends the decision and advances the pointer;
8. writes `moderation.decision_recorded` audit and
   `ModerationDecisionRecorded` outbox rows;
9. completes idempotency in the same transaction.

The command never accepts Claim, provenance, Patch, CatalogRevision, or input
hash values as authority from the caller.

## 8. Eligibility persistence

### 8.1 Eligibility input snapshot

`eligibility_input_snapshots` pins:

- Candidate and CandidateRevision;
- Patch, CatalogRevision, and normalized signature;
- active Eligibility policy revision;
- exact policy-pinned Evidence, Review, and Moderation revisions;
- Candidate claim-set seal and hash;
- current Moderation decision ID or explicit absence;
- whether the Moderation decision's input is fresh;
- current Review quorum evaluation ID or explicit absence;
- whether the Review snapshot and quorum are fresh;
- required Claim count;
- canonical required-Claim decision-set hash;
- canonical overall `EligibilityInputSnapshotV1` hash;
- creator and evaluation time.

`eligibility_input_snapshot_required_claims` stores every required Claim in
canonical Claim-key order with:

- Claim ID and statement hash;
- current Claim Evidence decision ID or explicit absence;
- decision value or explicit absence;
- Evidence policy revision or explicit absence;
- whether that decision is current and policy-matched;
- deterministic ordinal.

No `supporting` or `informational` Claim is added to the decision membership.
They remain committed through the Candidate claim-set seal.

### 8.2 Eligibility evaluations and reasons

`candidate_eligibility_evaluations` stores:

- opaque evaluation ID and database-generated sequence;
- exact Eligibility input snapshot;
- Candidate and CandidateRevision identity;
- Eligibility policy revision;
- outcome `eligible | needs_review | ineligible`;
- evaluator actor, correlation ID, and evaluation time;
- immutable creation metadata.

`candidate_eligibility_evaluation_reasons` stores the exact ordered set of
closed reason codes:

- `moderation_blocked`;
- `required_claim_contradicted`;
- `moderation_missing`;
- `moderation_stale`;
- `moderation_needs_review`;
- `required_claim_decision_missing`;
- `required_claim_decision_stale`;
- `required_claim_policy_mismatch`;
- `required_claim_insufficient`;
- `review_quorum_missing`;
- `review_quorum_stale`;
- `review_policy_mismatch`;
- `review_quorum_unsatisfied`;
- `all_requirements_satisfied`.

`current_candidate_eligibility_evaluations` contains one mutable pointer per
CandidateRevision and Eligibility policy revision. Pointer ordering uses
evaluation time plus database sequence, matching the Moderation and Sprint 3B
pointer protections.

### 8.3 Deterministic result

TypeScript computes the result from the loaded snapshot. A deferred PostgreSQL
constraint trigger independently recomputes:

- exact required Claim membership;
- current decision identities;
- policy matches;
- current Moderation identity and freshness;
- current Review quorum identity and freshness;
- reason membership;
- final outcome.

The transaction cannot commit a forged header, reason set, or `eligible`.

### 8.4 Evaluation command

`evaluateCandidateEligibility` accepts only:

- Candidate and CandidateRevision IDs;
- Eligibility evaluation and snapshot IDs;
- actor, correlation ID, evaluation time, and idempotency key.

It does not accept a requested outcome or trust input payload.

The command:

1. locks Candidate, CandidateRevision, and Claims in the shared order;
2. locks the active Eligibility policy pointer;
3. loads the exact immutable policy bundle;
4. loads current required Claim Evidence decisions in Claim order;
5. checks freshness of the current Moderation snapshot;
6. checks freshness of the current Review snapshot and quorum;
7. builds the snapshot and deterministic reasons/outcome;
8. appends the evaluation and advances the pointer;
9. writes audit, outbox, and idempotency completion atomically.

If no claim-set seal exists, the command returns the stable
`ELIGIBILITY_NOT_EVALUABLE_YET` error with no domain side effect.

### 8.5 Read boundary

`readCandidateEligibilityStatus` is read-only and returns:

- `outcome`;
- `stale`;
- `candidateRevisionId`;
- active Eligibility policy revision ID or null;
- current evaluation ID or null;
- normalized reason codes.

If the active policy is absent, the current evaluation is absent, the pointer
uses another policy, or any current input differs from the pinned snapshot,
the returned outcome is `needs_review`. The boundary does not mutate history
and never returns stale `eligible` or stale `ineligible`.

## 9. Automatic re-evaluation

### 9.1 Queue

Add `hai-dau-eligibility-v1` beside the normalization queue. The dispatcher
routes each supported event to exactly one queue and keeps the outbox event ID
as the BullMQ job ID.

The dispatcher retains:

- lease and `FOR UPDATE SKIP LOCKED` semantics;
- retryable failure state;
- exponential backoff;
- deterministic BullMQ job identity;
- no event payload as trust authority.

### 9.2 Worker

The Eligibility worker:

1. validates job name, ID, and envelope;
2. reloads the authoritative outbox row from PostgreSQL;
3. validates the aggregate/event graph;
4. resolves CandidateRevision from the authoritative event payload;
5. reserves one `eligibility_recalculation_effect` per outbox event;
6. calls `evaluateCandidateEligibility` with deterministic IDs and idempotency;
7. records `succeeded`, `duplicate_noop`, `not_evaluable_yet`, or a retryable
   failure;
8. ignores mutable trust values in the Redis payload.

A lost acknowledgement produces one logical evaluation. A changed current
input that arrives while another event is queued is handled by the later
evaluation and the fail-closed read boundary.

### 9.3 Manual replay

Operators can call `evaluateCandidateEligibility` with an explicit
idempotency key after:

- queue outage;
- policy activation;
- recovery from a fixed data issue;
- an event that completed `not_evaluable_yet`.

Manual replay uses the same transaction and deterministic rule engine as the
worker. There is no privileged shortcut.

## 10. Database integrity

PostgreSQL must reject direct SQL that attempts to:

- bind a Moderation or Eligibility record to another CandidateRevision,
  Patch, or CatalogRevision;
- seal a Moderation snapshot with incorrect provenance membership or hash;
- create a Moderation decision with a mismatched snapshot or policy;
- move a Moderation pointer backward in time or sequence;
- register an Eligibility policy with mismatched pinned policy identities;
- activate an unregistered Eligibility policy revision;
- omit or add a required Claim in an Eligibility snapshot;
- use another Claim's Evidence decision;
- mark a missing, stale, or wrong-policy input as current;
- bind another CandidateRevision's Moderation or Review result;
- store reason codes inconsistent with the exact snapshot;
- store `eligible` without all requirements;
- move an Eligibility pointer backward;
- update or delete immutable policy, snapshot, membership, decision,
  evaluation, or reason history.

Deferred seals re-check currentness at transaction commit. This closes the
case where an input is valid during member insertion but changes before
commit.

## 11. Concurrency and lock order

All Sprint 4A commands preserve the shared order:

1. Candidate;
2. CandidateRevision;
3. Claims in Claim-key C-collation order;
4. current Evidence decision rows in the same Claim order;
5. current Review quorum pointer and evaluation;
6. current Moderation pointer and decision;
7. active Eligibility policy pointer;
8. current Eligibility pointer.

Policy registration never locks Candidate rows. Policy activation locks only
the active Eligibility policy pointer, so it cannot form a reverse cycle with
Candidate transactions.

Evidence, Review, Moderation, and Eligibility commands serialize through the
same Candidate/CandidateRevision prefix. Queue concurrency must not create a
deadlock, lost pointer advance, or impossible snapshot.

## 12. Idempotency, audit, and outbox

New idempotency scopes:

- `moderation_policy_registration`;
- `eligibility_policy_registration`;
- `eligibility_policy_activation`;
- `moderation_decision`;
- `candidate_eligibility_evaluation`.

Same scope/key/payload returns the completed logical result. Same scope/key
with a changed payload fails with `IDEMPOTENCY_PAYLOAD_CONFLICT`. A retry after
commit creates no duplicate policy, snapshot, membership, decision,
evaluation, pointer effect, audit, outbox, or queue effect.

Successful commands emit:

- `ModerationPolicyRevisionRegistered`;
- `EligibilityPolicyRevisionRegistered`;
- `EligibilityPolicyRevisionActivated`;
- `ModerationDecisionRecorded`;
- `CandidateEligibilityEvaluated`.

Audit/outbox payloads contain stable IDs, outcomes, reason codes, counts,
hashes, and policy revision IDs. They do not contain Claim statements,
moderation reasons, source text, external references, or credentials.

## 13. Stable failure semantics

Application errors use stable codes:

- `GATE_POLICY_INVALID`;
- `GATE_POLICY_REVISION_CONFLICT`;
- `ELIGIBILITY_POLICY_ACTIVE_POINTER_CONFLICT`;
- `CANDIDATE_REVISION_NOT_FOUND`;
- `CLAIM_SET_NOT_SEALED`;
- `MODERATION_INPUT_STALE`;
- `MODERATION_DECISION_CONFLICT`;
- `ELIGIBILITY_NOT_EVALUABLE_YET`;
- `ELIGIBILITY_INPUT_STALE`;
- `ELIGIBILITY_EVALUATION_CONFLICT`;
- `IDEMPOTENCY_PAYLOAD_CONFLICT`;
- `IDEMPOTENCY_OPERATION_IN_PROGRESS`;
- `INVALID_ELIGIBILITY_SOURCE_EVENT`;
- `UNSUPPORTED_ELIGIBILITY_EVENT`.

No error exposes source content, credentials, raw SQL, or hidden external
references.

## 14. Migration and compatibility

- Add only `backend/migrations/0008_moderation_eligibility.sql`.
- Do not edit migration `0007` or its checksum.
- Existing CandidateRevisions remain historical and read as `needs_review`
  until they have a sealed Claim set, active policy, and evaluation.
- Existing Evidence and Human Review history remains unchanged.
- Frontend data, Pages build, `/review/`, and public behavior remain
  unchanged.
- Existing outbox rows remain valid; only the dispatch routing allowlist is
  extended.
- No data backfill invents Moderation or Eligibility decisions.

## 15. Verification strategy

### 15.1 Pure contracts

- closed input objects and enum validation;
- deterministic tuple hashes and reason ordering;
- full Eligibility precedence table;
- only required Claims affect the result.

### 15.2 Migration and direct SQL

- exact table/index/trigger contract;
- immutable history rejects update/delete;
- graph mismatches fail;
- snapshot membership and seals are recomputed;
- pointer rollback at equal timestamps fails;
- a forged `eligible` or reason set fails;
- currentness is rechecked at commit.

### 15.3 Moderation

- no Moderation reads as `needs_review` without an invented row;
- all three decisions append history;
- a new decision advances only the matching revision/policy pointer;
- another revision cannot inherit the pointer;
- new provenance makes the old snapshot stale;
- replay is side-effect-free and payload conflict fails;
- an injected late failure rolls back domain, pointer, audit, outbox, and
  idempotency.

### 15.4 Eligibility

- `blocked` and required `contradicted` produce `ineligible`;
- missing/stale/needs-review Moderation produces `needs_review`;
- missing/stale/wrong-policy/insufficient required Evidence produces
  `needs_review`;
- missing/stale/wrong-policy/unsatisfied Review quorum produces
  `needs_review`;
- only the complete fresh graph produces `eligible`;
- supporting/informational decisions do not affect the result;
- a new CandidateRevision starts `needs_review`;
- an input change makes a previous `eligible` read stale immediately;
- re-evaluation appends history and advances the pointer;
- concurrent input updates and evaluation have no deadlock or lost update.

### 15.5 Queue and replay

- each source event routes to the correct queue;
- Redis payload tampering cannot change CandidateRevision authority;
- lost acknowledgement produces one effect;
- duplicate delivery is `duplicate_noop`;
- queue failure preserves the PostgreSQL outbox row for retry;
- pre-claim events finish `not_evaluable_yet`;
- manual replay uses the same evaluator.

### 15.6 Regression gate

- PostgreSQL 17 and Redis 7 integration;
- all existing backend tests plus Sprint 4A tests;
- all existing frontend tests;
- root Pages build;
- backend typecheck and build;
- migration checksum append-only contract;
- repository cleanliness;
- workflow write-permission and deployment guard;
- deployment dry-run only.

## 16. Definition of Done

- Moderation has immutable revision-scoped history and no default `clear`.
- Eligibility has immutable revision-scoped history and no inherited state.
- Required Claims alone determine Evidence aggregation.
- Every `eligible` result pins a fresh `clear` Moderation decision, fresh
  supported required Claims, and a fresh satisfied Review quorum under exact
  policy revisions.
- A stale or missing result reads as `needs_review` immediately.
- PostgreSQL independently rejects forged trust graphs and outcomes.
- Re-evaluation is requested through outbox/BullMQ and can be replayed
  manually.
- Every successful mutation is atomic with idempotency, audit, and outbox.
- Existing frontend and backend gates remain green.
- Independent review has no unresolved Critical or Important finding.
- The pull request remains draft and unmerged.
- No Publication, UI, auth, external fetch, production credential,
  infrastructure, merge, or deployment is introduced.

## 17. Self-review

- **No placeholders:** no unresolved marker or deferred implementation choice
  remains inside Sprint 4A.
- **Vocabulary:** Moderation, Evidence, Human Review, Eligibility, and
  Publication remain separate authorities.
- **Fail-closed:** absence and staleness always read as `needs_review`.
- **Revision isolation:** no pointer or snapshot can cross CandidateRevision.
- **Policy selection:** the active Eligibility pointer is explicit; the
  Eligibility policy pins all subordinate policy revisions.
- **Direct SQL:** snapshots, currentness, reason sets, and outcome are
  database-enforced.
- **Queue safety:** Redis carries delivery envelopes only; PostgreSQL is
  reloaded before evaluation.
- **Scope:** backend-only Moderation and Eligibility; Publication, UI, auth,
  external collection, merge, and deploy are excluded.
