# Sprint 3B — Evidence v3 and Human Review Persistence Design

**Status:** Approved for implementation under the project owner's standing
Core-roadmap authorization.

**Base:** Sprint 3A exact head
`aa54b7560cb27e9fbddfcba46073375a25e7e742`.

**Architecture:** Node.js/Fastify modular monolith, PostgreSQL 17 as the
system of record, BullMQ/Redis as delivery infrastructure.

## 1. Goal

Sprint 3B implements the persistence and transaction boundaries needed to
move an immutable `CandidateRevision` through claim-level Evidence v3 and
Human Review.

The sprint must prove:

- a CandidateRevision has one immutable, sealed set of claims;
- Evidence is source-governed and can be associated with an individual Claim;
- each Claim Evidence decision pins the CandidateRevision, Patch,
  CatalogRevision, Evidence input snapshot, and Evidence policy revision;
- re-evaluation appends a new decision and moves a current pointer without
  changing prior decisions;
- a decision from another patch can never become current implicitly;
- each completed Human Review pins the exact candidate, claim, provenance, and
  current Evidence-decision input visible to that reviewer;
- review quorum counts distinct eligible reviewers deterministically;
- concurrent reviews cannot lose a completion or compute an impossible quorum;
- every successful business mutation commits its audit, outbox, and
  idempotency result in the same PostgreSQL transaction.

This sprint creates no Publication authority. Persisted decisions and quorum
results are inputs for later Moderation and Eligibility work; they are not an
authorization to publish.

## 2. Locked inputs

This design preserves the approved Architecture Baseline v0.2, Data Model
Domain Spec v0.2, Common Correctness Harness, and Sprint 3A invariants:

- Evidence decisions are at Claim level.
- Evidence states are `supported`, `insufficient`, and `contradicted`.
- Before first evaluation, a Claim has no Evidence decision; absence is not
  `insufficient`.
- Re-evaluation creates immutable history.
- All required claims must later be aggregated by Eligibility; there is no
  Candidate-level Evidence shortcut.
- Evidence decisions are patch-pinned and are not reused across patches.
- Human Review is independent of Evidence and does not modify an Evidence
  decision.
- Human Review outcomes are `confirmed`, `changes_requested`, and `declined`;
  no shared `approved` state is introduced.
- AI-origin content requires at least one `completed + confirmed` review in
  MVP/v1.0, and the schema supports a higher policy quorum.
- AI provenance is not Evidence.
- PostgreSQL remains authoritative; Redis payloads never become trust inputs.
- Existing Candidate, CandidateRevision, normalized-observation, provenance,
  audit, outbox, and idempotency history remains immutable or append-only.

## 3. Scope

### Included

- immutable Evidence-policy and Review-policy revisions;
- immutable CandidateRevision claim sets and claim-set seals;
- Evidence records backed by an authoritative NormalizedObservation;
- Claim–Evidence associations with stance and explicit patch revalidation;
- immutable Evidence input snapshots;
- append-only Claim Evidence decisions and current Claim decision pointers;
- immutable Human Review input snapshots;
- immutable completed Human Reviews;
- append-only Review quorum evaluations, their exact counted-review set, and
  current quorum pointers;
- idempotent T4 and T5 application commands;
- audit and outbox records;
- database graph constraints, concurrency tests, runbook, and CI contracts.

### Excluded

- moderation decisions or a default moderation state;
- Publication Eligibility computation;
- Publication, rollback, or public API/read-path changes;
- AI discovery or candidate generation;
- confidence weights or a scoring formula;
- reviewer assignment UI, pending/in-progress workflow, comments, or auth
  provider integration;
- external source fetching, parsing, or blob copying;
- routing trust-layer outbox events to BullMQ;
- production credentials, infrastructure, merge, or deployment.

## 4. Options considered

### Option A — Relational immutable history with current pointers

Use normalized relational records for claims, evidence, associations,
snapshots, decisions, reviews, and quorum membership. History is immutable;
only narrow current-pointer tables are mutable.

This is the selected option. PostgreSQL can enforce the Claim–Candidate–
Patch–Catalog graph, exact snapshot membership, distinct-reviewer quorum, and
cross-patch rules instead of trusting opaque application payloads.

### Option B — JSON decision and review blobs

Store one JSON snapshot per decision/review and validate it only in
TypeScript. This reduces table count but cannot protect association ownership,
current-decision identity, or quorum membership with foreign keys and
constraints. It also makes direct-SQL corruption and stale-input reuse harder
to detect. Rejected.

### Option C — Full event sourcing

Persist commands/events only and rebuild all trust projections. This gives a
strong audit model but adds event reducers, projection rebuild, and operational
recovery before the Moderation and Publication aggregates exist. It is beyond
Sprint 3B and rejected under YAGNI.

## 5. Module boundaries

The new backend module is `modules/trust`.

It exposes four application boundaries:

1. `registerTrustPolicyRevision`
2. `defineCandidateClaimSet`
3. `recordClaimEvidenceDecision`
4. `completeHumanReview`

The Candidate Registry continues to own Candidate and CandidateRevision.
`defineCandidateClaimSet` is a narrow Candidate-owned extension implemented in
the trust package because it is the prerequisite boundary for T4/T5; it cannot
edit a CandidateRevision or create a second claim set.

Evidence v3 owns Evidence, associations, snapshots, decision history, and the
current Evidence-decision pointer.

Human Review owns review snapshots, completed review history, quorum
evaluations, and the current quorum pointer. It cannot mutate Evidence.

## 6. Persistence model

Migration `0007_evidence_v3_human_review.sql` adds the following records.

All Sprint 3B cross-layer hashes use one `TrustTupleV1` grammar. Each token is
encoded as its UTF-8 byte length, `:`, then the exact token; tokens are joined
with `|` and the result is SHA-256 hashed. Null uses the reserved token
`@null`; collection headers include the exact item count before ordered
members. Claim statements are hashed as their exact UTF-8 bytes, and only
their hex hash enters a tuple. TypeScript and PostgreSQL implement the same
grammar, so deferred database guards can recompute every header hash without
depending on JSON whitespace, JavaScript UTF-16 length, or locale collation.

### 6.1 Policy revisions

`evidence_policy_revisions`

- opaque UUID identity;
- policy key and positive revision;
- schema version;
- reason, creator, and creation time;
- immutable and unique by policy key plus revision.

The Evidence policy stores identity/version only in Sprint 3B. It deliberately
does not lock confidence factors or weights.

`review_policy_revisions`

- opaque UUID identity;
- policy key and positive revision;
- minimum confirmed-review count, at least one;
- `require_distinct_reviewers = true`;
- required permission fixed to `reviewer`;
- applicability to AI provenance;
- reason, creator, and creation time;
- immutable and unique by policy key plus revision.

Policy registration is idempotent, audited, and produces an outbox record, but
there is no active-policy pointer in this sprint. Every downstream command
must name the exact immutable revision it pins.

### 6.2 Candidate claim set

`candidate_claims`

- Claim ID;
- Candidate, CandidateRevision, Patch, and CatalogRevision IDs;
- stable printable non-space ASCII `claim_key` of at most 128 characters;
- Claim type from the Domain Spec;
- importance: `required`, `supporting`, or `informational`;
- exact UTF-8 statement, at most 4 KiB;
- SHA-256 statement hash;
- immutable creation metadata.

`candidate_claim_set_seals`

- one row per CandidateRevision;
- exact claim count and canonical claim-set hash;
- actor and creation time;
- immutable.

The canonical claim-set hash includes each Claim ID, key, type, importance,
statement hash, CandidateRevision, Patch, and CatalogRevision, sorted by
`claim_key` using the same printable-ASCII/C-collation contract as Sprint 3A.

`defineCandidateClaimSet` locks the Candidate then CandidateRevision, validates
the complete set, inserts every Claim, and inserts the seal in one transaction.
At least one Claim is required and at least one must be `required`. A second
command with the same idempotency key and payload returns the recorded result.
A different key cannot add to, remove from, or replace a sealed set.

### 6.3 Evidence and associations

`evidence_records`

- Evidence ID;
- one authoritative NormalizedObservation;
- the linked RawObservation, Source, and SourcePolicyRevision;
- the Evidence source Patch and content hash;
- evidence kind fixed to `normalized_observation` in Sprint 3B;
- immutable creation metadata;
- unique by NormalizedObservation.

No source text, comment, HTML, transcript, image, or blob is copied into
Evidence. The record points to source-governed observation history.

`evidence_associations`

- Association ID;
- Claim ID;
- Evidence ID;
- stance: `supports`, `contradicts`, or `context_only`;
- decision Patch inherited from the Claim;
- whether this is explicit cross-patch revalidation;
- non-empty revalidation reason when Evidence source Patch differs;
- immutable creation metadata;
- unique by Claim and Evidence.

When the Evidence source Patch and Claim Patch differ, the association must
explicitly set cross-patch revalidation and give a reason. This association can
be input to a new decision for the new Claim/Patch, but it never carries an old
decision state forward.

### 6.4 Evidence input and decisions

`evidence_input_snapshots`

- Snapshot ID;
- Claim, Candidate, CandidateRevision, Patch, and CatalogRevision;
- Claim-set seal and Claim statement hash;
- Evidence policy revision;
- exact association count;
- canonical input hash;
- actor and evaluation time;
- immutable.

`evidence_input_snapshot_associations`

- Snapshot ID plus exact EvidenceAssociation IDs;
- deterministic ordinal;
- immutable.

`claim_evidence_decisions`

- Decision ID;
- the exact Claim and EvidenceInputSnapshot;
- Candidate, CandidateRevision, Patch, and CatalogRevision;
- Evidence policy revision;
- decision: `supported`, `insufficient`, or `contradicted`;
- evaluator actor, reason, correlation, and evaluated time;
- immutable.

`current_claim_evidence_decisions`

- one mutable pointer per Claim;
- references a decision for that same Claim;
- pointer update time.

`recordClaimEvidenceDecision` locks Candidate, CandidateRevision, then Claim.
It verifies the claim-set seal, resolves or creates Evidence and associations,
builds the exact snapshot, writes the decision, moves the pointer, writes
audit/outbox, and completes idempotency atomically.

Decision validity rules:

- `supported` requires at least one `supports` association;
- `contradicted` requires at least one `contradicts` association;
- `insufficient` may use an empty input set;
- a snapshot cannot contain an association belonging to another Claim;
- a semantic replay is allowed only while that decision is still current;
- an older input cannot move the pointer backward;
- a new Patch requires a new Claim, snapshot, and decision.

These are structural minimums, not a confidence formula.

### 6.5 Human Review and quorum

`review_input_snapshots`

- Snapshot ID;
- Candidate and CandidateRevision;
- Patch and CatalogRevision;
- Candidate normalized signature, which seals the canonical selection payload;
- Claim-set seal and hash;
- exact provenance and Claim counts;
- exact provenance-set hash;
- exact Claim/current-Evidence-decision-set hash;
- Review policy revision;
- canonical review-input hash;
- creation time;
- immutable.

`review_input_snapshot_provenance`

- the exact CandidateProvenance IDs and origins visible to the reviewer;
- deterministic ordinal;
- immutable.

`review_input_snapshot_claims`

- every Claim in the sealed set;
- its importance;
- its current EvidenceDecision ID or explicit absence;
- deterministic ordinal;
- immutable.

`human_reviews`

- Review ID;
- Candidate and CandidateRevision;
- ReviewInputSnapshot and Review policy revision;
- reviewer actor;
- status fixed to `completed` for this sprint;
- outcome: `confirmed`, `changes_requested`, or `declined`;
- permission used fixed to `reviewer`;
- bounded reason, correlation, and completion time;
- immutable;
- at most one completion per reviewer, CandidateRevision, policy, and exact
  review-input hash.

`review_quorum_evaluations`

- Evaluation ID;
- Candidate and CandidateRevision;
- ReviewInputSnapshot hash and Review policy revision;
- required confirmed count;
- distinct eligible confirmed count;
- whether quorum is satisfied;
- evaluation time;
- immutable.

`review_quorum_evaluation_reviews`

- exact confirmed Review IDs counted by the evaluation;
- reviewer actor;
- deterministic ordinal;
- immutable.

`current_review_quorum_evaluations`

- one mutable pointer per CandidateRevision and Review policy revision;
- references a quorum evaluation for that same CandidateRevision/policy;
- pointer update time.

`completeHumanReview` locks Candidate, CandidateRevision, and every Claim in
claim-key order. This stabilizes Candidate provenance and current Evidence
decision pointers while the ReviewInputSnapshot is built. It inserts the
completed review, counts distinct `completed + confirmed + reviewer`
submissions with the same CandidateRevision, policy, and exact review-input
hash, records the exact counted set, stores the quorum evaluation, advances
the current pointer, writes audit/outbox, and completes idempotency atomically.

Two reviews of different input hashes never combine. New provenance or a new
current Evidence decision therefore makes the previous review snapshot stale
for a later quorum computation.

## 7. Database integrity

The migration adds composite unique keys needed for foreign keys from the
trust graph. PostgreSQL must reject direct SQL that attempts to:

- bind a Claim to a CandidateRevision owned by another Candidate, Patch, or
  CatalogRevision;
- seal a Claim count/hash that does not match its immutable rows;
- register Evidence with Source/Patch/content hash inconsistent with its
  authoritative observation chain;
- associate Evidence to a Claim while hiding a cross-patch relationship;
- put another Claim's association into an EvidenceInputSnapshot;
- bind an Evidence decision to mismatched Claim/Candidate/Patch/Catalog/policy
  records;
- point a current Claim pointer at another Claim's decision;
- put another CandidateRevision's Claim, decision, or provenance into a Review
  snapshot;
- count a non-confirmed, wrong-permission, wrong-policy, wrong-input, duplicate
  reviewer, or wrong-Candidate review in quorum;
- store a quorum count or `satisfied` value inconsistent with the pinned
  counted-review set.

All history tables receive immutable update/delete guards. Only the two
current-pointer tables are mutable, and their graph identity is protected by
composite foreign keys and insert/update guards.

Deferred constraint triggers recompute Claim-set, Evidence-snapshot,
Review-snapshot, and quorum membership at transaction commit. A transaction
cannot commit a header count/hash/result that disagrees with its immutable
child rows.

## 8. Concurrency and lock order

All trust-layer commands use this lock order:

1. Candidate row;
2. CandidateRevision row;
3. Claim rows in printable-ASCII/C order;
4. Evidence/association rows in UUID order when needed;
5. current pointer row.

Sprint 3A Candidate registration already locks Candidate before appending
provenance. `completeHumanReview` therefore stabilizes the provenance set by
taking the same Candidate lock first.

T4 and T5 both take Candidate → CandidateRevision → Claim, so Evidence
re-evaluation cannot deadlock with Human Review snapshot creation. Concurrent
Human Reviews serialize at the Candidate lock. The first completion may record
an unsatisfied quorum; the second sees it and records a later satisfied
evaluation. Neither history row is overwritten.

## 9. Idempotency and replay

New scopes:

- `trust_policy_registration`;
- `candidate_claim_set_definition`;
- `claim_evidence_decision`;
- `human_review_completion`.

The canonical payload hash includes all actor-visible command inputs except
correlation IDs and generated timestamps. The exact policy revision and all
caller-provided record identities are included.

- Same scope/key/payload returns the completed logical result.
- Same scope/key with changed payload fails with
  `IDEMPOTENCY_PAYLOAD_CONFLICT`.
- Retry after commit creates no duplicate Claim, Evidence, association,
  snapshot, decision, review, quorum, audit, or outbox row.
- Failure before commit rolls back every domain and reliability write.
- A replay never moves a current pointer backward.

## 10. Audit and outbox

Successful commands emit:

- `TrustPolicyRevisionRegistered`;
- `CandidateClaimSetDefined`;
- `ClaimEvidenceDecisionRecorded`;
- `HumanReviewCompleted`.

Audit/outbox payloads contain stable IDs, enum outcomes, counts, hashes, and
policy revision IDs only. They do not copy Claim statements, review reasons,
external references, or source-governed content.

The dispatcher allowlist remains limited to `RawObservationIngested`. Sprint
3B persists trust events in PostgreSQL but does not enqueue them.

## 11. Stable failure semantics

Application errors use stable codes, including:

- `TRUST_POLICY_INVALID`;
- `CANDIDATE_REVISION_NOT_FOUND`;
- `CLAIM_SET_ALREADY_DEFINED`;
- `CLAIM_SET_REQUIRED_CLAIM_MISSING`;
- `CLAIM_NOT_FOUND`;
- `CLAIM_SET_NOT_SEALED`;
- `EVIDENCE_OBSERVATION_NOT_FOUND`;
- `EVIDENCE_SOURCE_GRAPH_MISMATCH`;
- `EVIDENCE_ASSOCIATION_PATCH_REVALIDATION_REQUIRED`;
- `EVIDENCE_DECISION_INPUT_INVALID`;
- `EVIDENCE_DECISION_INPUT_SUPERSEDED`;
- `EVIDENCE_DECISION_CONFLICT`;
- `REVIEW_PERMISSION_REQUIRED`;
- `REVIEW_INPUT_STALE`;
- `REVIEW_ALREADY_COMPLETED`;
- `IDEMPOTENCY_PAYLOAD_CONFLICT`;
- `IDEMPOTENCY_OPERATION_IN_PROGRESS`.

No error includes source content, credentials, raw SQL, or hidden external
references.

## 12. Migration and compatibility

The repository is pre-production and the stacked PR is unmerged. Migration
`0007` is additive and does not rewrite migrations `0001`–`0006`.

Existing CandidateRevisions remain valid Candidate Registry history. They
cannot enter T4 or T5 until `defineCandidateClaimSet` creates their immutable
seal. There is no automatic backfill and no invented Claim content.

Frontend data, the static Pages build, Public Web, and `/review/` behavior are
unchanged.

## 13. Verification strategy

### Migration and direct-SQL contracts

- exact expected table/index/constraint set;
- every history table rejects update/delete;
- invalid Claim/Evidence/decision/review/quorum graphs fail;
- pointer graph mismatches fail;
- checksums remain append-only.

### Claim-set contracts

- complete set and seal commit atomically;
- at least one required Claim;
- duplicate keys and malformed identifiers fail;
- replay is side-effect-free;
- second or concurrent definitions cannot alter the seal;
- injected late failure rolls back Claims, seal, audit, outbox, and
  idempotency.

### T4 contracts

- one Claim-level decision creates the complete graph and current pointer;
- `supported`/`contradicted` stance minimums;
- `insufficient` with no Evidence;
- multiple required Claims retain independent current decisions;
- re-evaluation appends history and moves only that Claim's pointer;
- stale semantic replay cannot move a pointer backward;
- explicit cross-patch Evidence association creates a new Patch decision;
- a previous-Patch decision cannot become current for the new Claim;
- concurrent T4/T5 work is deadlock-free;
- rollback and lost-ack replay create zero duplicate effects.

### T5 and quorum contracts

- one confirmed review under quorum two is unsatisfied;
- two concurrent distinct confirmed reviewers produce two immutable reviews,
  no lost completion, and a deterministic satisfied current evaluation;
- two reviews by one actor count once;
- `changes_requested` and `declined` do not count;
- wrong permission fails without side effects;
- reviews with different input hashes do not combine;
- new Evidence decision or Candidate provenance makes the old review input
  stale for a new quorum;
- exact counted membership, count, and satisfaction are database-enforced;
- replay is side-effect-free and payload conflicts fail.

### Regression gate

- all existing frontend tests and Pages build;
- all 78 Sprint 2A–3A backend tests;
- PostgreSQL 17 and Redis 7 integration;
- backend typecheck and build;
- runbook contract, repository cleanliness, and deployment guard;
- dry-run workflow only, with no production publication.

## 14. Definition of Done

- Claim set is immutable and sealed per CandidateRevision.
- Evidence remains traceable to SourcePolicy-governed observation history.
- Evidence decisions are Claim-level and patch/catalog/policy/input pinned.
- Re-evaluation preserves immutable history.
- Cross-patch reuse requires explicit association revalidation and a new
  decision.
- Completed Human Reviews are immutable and do not modify Evidence.
- Quorum uses distinct confirmed reviewers for one exact input snapshot.
- T4/T5 concurrency has no lost update or deadlock.
- Direct SQL cannot forge trust-graph consistency.
- Every successful mutation is atomic with idempotency, audit, and outbox.
- Existing frontend/backend gates remain green.
- No Moderation, Eligibility, Publication, external fetch, production
  credential, merge, or deployment is introduced.

## 15. Self-review

- **Complete design:** no unresolved marker or implementation choice remains.
- **Vocabulary:** Claim, Evidence, Evidence decision, Human Review, quorum, and
  Publication authority remain separate.
- **Patch semantics:** Claim and decision inherit an exact
  CandidateRevision/Patch/Catalog graph; cross-patch Evidence requires an
  explicit new association and decision.
- **AI boundary:** provenance is review input but never Evidence.
- **Atomicity:** T4/T5 include domain, pointer, audit, outbox, and idempotency
  writes in one transaction.
- **Concurrency:** all trust commands share one lock order and snapshots pin
  exact relational membership.
- **Scope:** the design stops before Moderation, Eligibility, Publication,
  queue consumers, auth/UI, and external collection.
