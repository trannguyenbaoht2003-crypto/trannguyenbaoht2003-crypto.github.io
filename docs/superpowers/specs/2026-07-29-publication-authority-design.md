# Sprint 4B — Publication Authority and Public Read Design

**Status:** Approved for specification under the project owner's standing
Core-roadmap authorization.

**Base:** Sprint 4A exact head
`7aa079babef0b16c06b58255f66ec18d1fa14421`.

**Branch:** `feat/4b-publication-authority`.

**Architecture:** Node.js/Fastify modular monolith, PostgreSQL 17 as the
system of record, BullMQ/Redis as delivery infrastructure.

## 1. Goal

Sprint 4B adds the last backend authority in the approved Core path:
publishing an immutable `CandidateRevision` only when its exact current trust
graph is eligible, selecting one active immutable version per publication
item, rolling an item back without changing history, and serving active
published content without depending on workers or unpublished Candidate data.

The sprint proves:

- Publication, Eligibility, Moderation, Evidence, and Human Review remain
  separate authorities;
- only an application authorization context containing `publisher` may publish
  or roll back;
- the command rechecks the exact active Eligibility policy and live trust graph
  inside the publication transaction;
- a stale, missing, `needs_review`, or `ineligible` evaluation creates no
  PublicationVersion;
- a PublicationVersion is immutable and pins the exact CandidateRevision,
  Eligibility evaluation, Moderation decision, policies, catalog, patch, mode,
  and canonical public payload used;
- publication activation and rollback are compare-and-swap operations with
  immutable history;
- rollback changes only one publication item's active pointer;
- public reads return only active PublicationVersions and remain available
  when BullMQ/Redis workers are stopped;
- `PublicationPublished` projection delivery is replay-safe and never owns
  public truth;
- command state, pointer history, audit, outbox, and idempotency commit
  atomically;
- direct SQL cannot forge a publishable version or bypass stale authority.

Sprint 4B does not add automatic publication, a publisher UI, HTTP mutation
routes, an identity provider, production scheduling, or deployment.

## 2. Locked product rules

### 2.1 Publication aggregate

One `Publication` belongs to one long-lived `Candidate`. The Candidate is
already patch-scoped and identified by a source-independent semantic
fingerprint. A new `CandidateRevision` under a refreshed catalog can create a
new immutable version of the same Publication. A semantically different
champion/augment/item selection is a different Candidate and therefore a
different Publication item.

The first successful publish creates the Publication and version 1. Later
publishes append monotonically numbered versions. No command edits or deletes
an old version.

### 2.2 Publication input

The caller supplies identity and concurrency expectations, not public content
or trust values:

- CandidateRevision ID;
- expected active Eligibility policy revision ID;
- expected current Eligibility evaluation ID;
- expected current Moderation decision ID;
- expected current active PublicationVersion ID or explicit absence;
- authorization context;
- command, audit, outbox, and correlation IDs;
- idempotency key.

The application reconstructs the public payload from PostgreSQL authority.
The caller cannot submit arbitrary title, guide text, source text, HTML,
transcript, comments, image bytes, Eligibility outcome, or policy links.

### 2.3 Authorization boundary

The command accepts a closed application authorization context:

```ts
export interface PublicationAuthorizationContext {
  actorId: string;
  permissions: readonly ('publisher')[];
}
```

Absence of `publisher` fails with `PUBLISHER_PERMISSION_REQUIRED` before any
Publication, audit, outbox, or idempotency completion effect. Sprint 4B does
not claim this context is produced by an HTTP identity provider and exposes no
mutation route. Authentication and account administration remain a later
boundary.

### 2.4 Publish gate

Within one transaction, the command:

1. locks Candidate, CandidateRevision, sealed Claim rows, current trust
   pointers, Publication aggregate, and active Publication pointer in the
   shared order;
2. loads the active Eligibility policy;
3. reloads Eligibility authority from PostgreSQL using the Sprint 4A loader;
4. requires the caller's expected policy, evaluation, and Moderation IDs to
   match current authority;
5. requires the persisted current evaluation to be `eligible`;
6. requires its stored input hash to equal the live authority hash;
7. requires current Moderation to remain `clear`;
8. constructs and seals the canonical public payload;
9. appends a PublicationVersion and activates it atomically.

Any mismatch fails closed. The transaction rechecks the authority at COMMIT,
so a concurrent Evidence, Review, Moderation, provenance, claim-set, policy,
or Eligibility change cannot race into a published version.

### 2.5 Canonical public payload

`PublicationPayloadV1` is a closed structured object:

```ts
export interface PublicationPayloadV1 {
  schemaVersion: 1;
  mode: 'aram_mayhem';
  patchKey: string;
  catalogRevisionId: string;
  championExternalId: string;
  augmentExternalIds: readonly string[];
  itemExternalIds: readonly string[];
}
```

It is reconstructed from the immutable CandidateRevision and normalized
selection. Arrays retain the canonical CandidateRevision order. The payload
contains no source text, free-form copy, raw observation, private reference,
reviewer identity, moderation reason, credential, or unapproved image.

The version also stores relational pins and a canonical SHA-256 payload hash.
PostgreSQL recomputes the payload and hash at COMMIT.

### 2.6 Activation

The active pointer is narrow and mutable, but every change has immutable
activation history.

- First publish expects no active version.
- Later publish requires `expectedActiveVersionId` to equal the current
  pointer.
- Publishing a new version can move only to the newly appended version.
- Replaying the same command is side-effect-free.
- Reusing the idempotency key with another payload fails.
- Equal-time writes are ordered by database sequence, not timestamp alone.

### 2.7 Rollback

Rollback:

- requires `publisher`;
- targets an existing immutable version of the same Publication;
- requires the caller's expected current active version;
- changes only that Publication's pointer;
- appends `PublicationRolledBack` activation history, audit, and outbox;
- does not create, modify, or delete a PublicationVersion;
- does not change another Publication item;
- is atomic and idempotent.

Rolling back to the already active version is a deterministic replay/no-op only
when the same idempotency command already completed. A new command whose
target already equals current fails with `PUBLICATION_VERSION_ALREADY_ACTIVE`
to preserve meaningful history.

### 2.8 Public read

The public read boundary queries PostgreSQL directly:

```ts
export interface ActivePublicationRead {
  publicationId: string;
  candidateId: string;
  candidateRevisionId: string;
  publicationVersionId: string;
  versionNumber: number;
  publishedAt: string;
  payload: PublicationPayloadV1;
}
```

It returns only rows reachable through the active Publication pointer.
Unpublished Candidates, inactive versions, trust snapshots, reviewer IDs,
moderation reasons, audit payloads, and private provenance are never returned.

Reads require PostgreSQL but not Redis, BullMQ, the normalization worker,
Eligibility worker, or projection worker. The asynchronous Candidate
monitoring projection is operational metadata and cannot authorize or hide
public content.

### 2.9 Post-publication trust changes

Sprint 4B prevents stale authority from being used at publish time. It does
not automatically retract an already active immutable version when later
Evidence or policy changes. Automatic retraction and a public
`needs_verification` lifecycle require a separate product rule and are
excluded. Operators may publish a later eligible version or explicitly roll
back an item.

## 3. Scope

### Included

- immutable Publication aggregate and PublicationVersion history;
- canonical `PublicationPayloadV1`;
- immutable version input pins and seals;
- append-only activation/rollback history;
- one active pointer per Publication;
- `publishCandidateRevision`;
- `rollbackPublication`;
- `readActivePublications` and `readActivePublicationById`;
- publisher permission check at the application boundary;
- fail-closed live Eligibility/Moderation recheck;
- audit, outbox, idempotency, and stable failures;
- publication projection worker consuming PostgreSQL outbox authority;
- direct-SQL, replay, concurrency, worker-isolation, and item-level rollback
  tests;
- runbook and CI contract.

### Excluded

- automatic or AI-triggered publication;
- mutation HTTP endpoints;
- identity provider, sessions, accounts, or permission administration;
- publisher, rollback, reviewer, or moderator UI;
- frontend/static-site integration;
- free-form public guide authoring;
- automatic retraction or `needs_verification` lifecycle after publication;
- external source collection;
- production scheduler, credentials, infrastructure, merge, or deployment;
- merging PR #13.

## 4. Options considered

### Option A — Immutable versions plus active pointer

Append immutable versions, keep a narrow active pointer, record every
activation, and reconstruct public reads from the active version. Publication
rechecks live Eligibility in the same transaction.

This is selected. It matches the approved Common Harness T8/T9 contract,
supports exact rollback, and keeps the public read path independent from
workers.

### Option B — Mutable published row

One mutable row is simpler but destroys history, cannot prove which
Eligibility graph authorized content, and makes rollback an overwrite.
Rejected.

### Option C — Generate public data directly from current Eligibility

This avoids PublicationVersion but exposes trust-pipeline churn to readers,
cannot support an intentional editorial activation or item-level rollback,
and risks unpublished Candidates appearing. Rejected.

## 5. Module boundaries

Create `backend/src/modules/publication/`.

It owns:

- payload types and canonicalization;
- publication authority loading;
- publish and rollback commands;
- public read queries.

It may read Candidate, CandidateRevision, Catalog, Moderation, Eligibility,
and idempotency authority. It must not write Evidence, Review, Moderation, or
Eligibility history and must not call external sources.

Create `backend/src/queue/publication-projection-worker.ts`.

It consumes only `PublicationPublished` and `PublicationRolledBack` outbox
events. Redis carries the outbox event ID only. The worker reloads the event
and version identity from PostgreSQL, records one consumer effect, and updates
the Candidate monitoring projection idempotently. The projection never owns
the active public pointer or public payload.

## 6. Persistence model

Migration `backend/migrations/0009_publication_authority.sql` adds:

- `publications`;
- `publication_versions`;
- `publication_version_input_required_claims`;
- `publication_activation_history`;
- `active_publication_versions`;
- `publication_projection_effects`.

`publications` has one row per Candidate and an immutable identity.

`publication_versions` pins:

- Publication and Candidate;
- CandidateRevision;
- Patch, mode, CatalogRevision, normalized signature;
- active Eligibility policy;
- current Eligibility evaluation and input hash;
- current Moderation decision;
- canonical payload and hash;
- version number;
- actor, correlation, and creation sequence/time.

The required-Claim membership copies only stable IDs, decision IDs, and
decision states needed to prove the publish gate. It contains no Claim
statement or source content.

`publication_activation_history` records `published` or `rolled_back`, from
version, to version, actor, audit/outbox correlation, timestamp, and database
sequence. It is append-only.

`active_publication_versions` contains only Publication ID, active version ID,
activation history ID, and update sequence/time.

All history and membership tables reject update/delete. Deferred constraints
recompute:

- Publication/Candidate/CandidateRevision ownership;
- CandidateRevision payload;
- required-Claim membership;
- policy pins;
- live Eligibility input hash and outcome;
- Moderation decision and `clear` state;
- version number;
- payload hash;
- activation transition legality.

## 7. Locking and transactions

The shared lock order is:

1. Candidate;
2. CandidateRevision;
3. Claims in PostgreSQL C order;
4. current Evidence pointers/decisions;
5. current Review and Moderation pointers;
6. active Eligibility policy and current Eligibility pointer/evaluation;
7. Publication;
8. active Publication pointer;
9. idempotency;
10. append version/history/audit/outbox rows.

First publication creation uses an advisory transaction lock derived from
Candidate ID before checking absence, preventing two transactions from
creating different aggregates for one Candidate.

Rollback locks Publication and its active pointer, then validates the target
version. It does not lock another item.

## 8. Command contracts

```ts
export interface PublishCandidateRevisionCommand {
  publicationId: string;
  publicationVersionId: string;
  activationId: string;
  candidateRevisionId: string;
  expectedActiveEligibilityPolicyRevisionId: string;
  expectedEligibilityEvaluationId: string;
  expectedModerationDecisionId: string;
  expectedActivePublicationVersionId: string | null;
  authorization: PublicationAuthorizationContext;
  auditId: string;
  outboxEventId: string;
  correlationId: string;
  idempotencyKey: string;
  occurredAt: string;
}

export interface RollbackPublicationCommand {
  publicationId: string;
  targetPublicationVersionId: string;
  activationId: string;
  expectedActivePublicationVersionId: string;
  authorization: PublicationAuthorizationContext;
  auditId: string;
  outboxEventId: string;
  correlationId: string;
  idempotencyKey: string;
  occurredAt: string;
}
```

Command result objects return stable IDs, version numbers, active version, and
`replayed`. They return no private trust or source content.

## 9. Audit, outbox, and idempotency

Idempotency scopes:

- `publication_publish`;
- `publication_rollback`.

Successful publish emits:

- audit action `publication.version_published`;
- outbox event `PublicationPublished`.

Successful rollback emits:

- audit action `publication.version_rolled_back`;
- outbox event `PublicationRolledBack`.

Payloads contain stable aggregate/version/Candidate IDs, version number,
activation ID, policy/evaluation IDs, payload hash, actor ID, and correlation
ID. They contain no arbitrary public content, Claim statement, source text,
moderation reason, reviewer identity, external private reference, or
credential.

## 10. Stable failure semantics

- `PUBLISHER_PERMISSION_REQUIRED`;
- `PUBLICATION_COMMAND_INVALID`;
- `PUBLICATION_NOT_FOUND`;
- `PUBLICATION_CANDIDATE_CONFLICT`;
- `PUBLICATION_ACTIVE_POINTER_CONFLICT`;
- `PUBLICATION_VERSION_ALREADY_ACTIVE`;
- `PUBLICATION_ROLLBACK_TARGET_NOT_FOUND`;
- `PUBLICATION_ROLLBACK_TARGET_CONFLICT`;
- `ACTIVE_ELIGIBILITY_POLICY_MISMATCH`;
- `CANDIDATE_NOT_ELIGIBLE`;
- `STALE_ELIGIBILITY_EVALUATION`;
- `MODERATION_NOT_CLEAR`;
- `STALE_MODERATION_DECISION`;
- `PUBLICATION_INPUT_STALE`;
- `PUBLICATION_PAYLOAD_INVALID`;
- `IDEMPOTENCY_PAYLOAD_CONFLICT`;
- `IDEMPOTENCY_OPERATION_IN_PROGRESS`;
- `INVALID_PUBLICATION_SOURCE_EVENT`;
- `UNSUPPORTED_PUBLICATION_EVENT`.

Errors expose no source content, public payload body, raw SQL, credentials, or
private identifiers beyond command-owned UUIDs.

## 11. Migration and compatibility

- Add migration `0009`; never edit migrations `0001`–`0008`.
- Existing Candidates and eligible evaluations remain unpublished.
- No backfill invents Publication or active pointers.
- Existing frontend data and GitHub Pages behavior remain unchanged.
- Existing normalization and Eligibility queues remain unchanged.
- Add a separate publication projection queue; it does not delay public reads.
- PR #13 remains open, draft, and unmerged.

## 12. Verification strategy

### Pure contracts

- closed command and payload objects;
- deterministic payload/hash construction;
- permission rejection;
- literal failure-code mapping.

### PostgreSQL and direct SQL

- exact table/index/trigger contract;
- immutable history rejects update/delete;
- Candidate/CandidateRevision/Publication cross-links cannot be forged;
- required-Claim membership cannot be omitted or substituted;
- payload cannot be altered or forged;
- non-current or non-eligible input fails at COMMIT;
- pointer rollback is allowed only through valid rollback history;
- publish activation can target only the newly appended version;
- version numbers remain monotonic under concurrency.

### Publish

- first eligible publish creates version 1 and active pointer;
- no permission creates no effect;
- missing/stale/ineligible authority creates no version;
- superseding Moderation between evaluation and COMMIT rejects publish;
- superseding Evidence/Review/provenance/policy between load and COMMIT rejects
  publish;
- caller-supplied trust or content fields are rejected;
- same command replay has zero duplicate side effects;
- changed payload conflicts;
- late failure rolls back all effects.

### Rollback

- v1, then v2, then rollback to v1 preserves both immutable versions;
- replay creates one rollback history/outbox effect;
- wrong expected active version rejects;
- target from another Publication rejects;
- rolling one item does not change another;
- concurrent rollback/publish has one valid winner and no lost update.

### Public read and projection

- active content is readable with Redis and workers stopped;
- unpublished Candidate is hidden;
- inactive versions are hidden;
- projection delay does not delay public read;
- duplicate/lost-ack event delivery creates one monitoring transition;
- forged Redis payload cannot change projected Candidate.

### Regression gate

- PostgreSQL 17 and Redis 7 integration;
- all existing backend and frontend tests;
- root Pages build;
- backend typecheck/build;
- checksum-locked migration contract;
- repository cleanliness and deployment guard;
- deployment dry-run only.

## 13. Definition of Done

- Every PublicationVersion is immutable and sealed to one exact
  CandidateRevision and fresh eligible trust graph.
- Publication cannot proceed without `publisher`, current `eligible`, and
  current `clear` Moderation.
- A race that changes trust authority before COMMIT fails closed.
- Activation and rollback have immutable history and compare-and-swap safety.
- Item-level rollback changes only the target pointer.
- Public reads expose only active structured payloads and remain independent
  from workers.
- Projection replay has zero duplicate monitoring effects.
- Every mutation is atomic with audit, outbox, and idempotency.
- PostgreSQL rejects forged versions, payloads, authority, and transitions.
- Existing gates remain green and review has no unresolved Critical or
  Important finding.
- PRs remain draft and unmerged; no frontend behavior, auth provider,
  production credential, infrastructure, or deployment is introduced.

## 14. Self-review

- **No placeholders:** no unresolved product or implementation choice remains.
- **Scope:** one backend subsystem; UI, auth provider, automatic publication,
  automatic retraction, frontend integration, and deployment remain excluded.
- **Authority:** PostgreSQL owns versions, active pointers, and public reads;
  Redis owns delivery only.
- **Fail-closed:** live Eligibility and Moderation are rechecked at COMMIT.
- **Immutability:** versions and activation history are append-only.
- **Rollback:** pointer-only, item-scoped, CAS-protected, and audited.
- **Privacy:** payload and events contain structured game IDs, not governed
  source content.
- **Compatibility:** migration-only extension from Sprint 4A exact head.
