# Sprint 9C — Candidate Review Evidence Dossier Design

**Date:** 2026-09-03
**Status:** Approved for implementation
**Base:** `main@be5a76585467de2cc125147925cac57cf6a17dcd`
**Scope:** Loopback-only, read-only dossier for one current Sprint 9B queue item

## 1. Goal

Give a reviewer enough governed context to inspect one current
CandidateRevision from the Sprint 9B queue: its immutable selection, current
Claims, current Claim Evidence decisions, exact Evidence associations, source
and provenance context, review progress, and persisted Sprint 9A confidence.

The dossier is evidence presentation only. It must not create, update, or
complete HumanReview and must not change Evidence, Moderation, Eligibility,
Publication, confidence, audit, or outbox state.

The authority graph remains:

`CandidateRevision -> Evidence/Claim decisions -> HumanReview -> Moderation -> Eligibility -> Publication`

Sprint 9C adds only:

`current Sprint 9B queue item -> read-only Evidence dossier -> human inspection`

There is no edge from the dossier to a mutation authority.

## 2. Existing boundaries

Sprint 7C provides a self-contained operator runtime that:

- binds only to loopback;
- is absent from the public Next application, Caddy, and Railway;
- uses restrictive headers, no cache, no browser storage, and no external
  assets;
- depends on PostgreSQL but not Redis or BullMQ.

Sprint 9A provides immutable, advisory confidence scores. Sprint 9B provides a
deterministic queue of latest sealed CandidateRevisions that still need review.
Its queue route is GET-only and its UI has no mutation controls.

Evidence v3 already persists:

- immutable Candidate Claims and a Claim-set seal;
- immutable Evidence records and associations;
- immutable Evidence input snapshots and Claim Evidence decisions;
- a guarded current-decision pointer per Claim;
- immutable candidate provenance linked to normalized and raw observations;
- source-policy storage permissions that prevent prohibited material from being
  retained.

Sprint 9C reads these existing structures. It introduces no migration, new
authority table, identity system, scheduler, worker, or deployment.

## 3. Approach decision

### Selected: one independent dossier endpoint in the existing operator runtime

Add a route keyed by exact `candidateRevisionId`. The reader opens one
`REPEATABLE READ READ ONLY` transaction, revalidates the Sprint 9B queue
eligibility predicate, then loads the dossier through explicit bounded queries.
The UI opens the dossier from a queue card and renders it as a separate detail
view.

This keeps the Sprint 9B queue response small and preserves independent failure
and versioning boundaries for the list and detail contracts.

### Rejected: embed every dossier in the Sprint 9B queue response

Embedding Claims, Evidence, and provenance in every queue item creates a large
cross-product response, repeats source facts, and makes one corrupt detail row
break the whole queue. It also changes the already-merged queue contract.

### Rejected: add HumanReview submission controls with the dossier

Writing HumanReview requires reviewer identity, permission verification,
idempotency, stale-input handling, CSRF/session design, and a separately
approved mutation boundary. Mixing that authority into a read-only evidence
inspection sprint would weaken the established fail-closed operator model.

## 4. Scope

Sprint 9C includes:

- one read-only CandidateReview Evidence dossier module;
- one versioned GET endpoint in the existing loopback operator runtime;
- one dossier detail view opened from the Sprint 9B queue;
- current Claim, Evidence-decision, Evidence-association, source, and provenance
  presentation;
- persisted confidence and active-policy review progress copied from governed
  state;
- strict outward DTO validation, safe reference parsing, response bounds, and
  sanitized failures;
- reader, HTTP, UI-contract, authority-isolation, and repository-contract tests;
- an updated operator runbook and dedicated deployment-free CI gate.

Sprint 9C does not include:

- HumanReview creation/completion, reviewer assignment, reviewer identity, or
  permission management;
- Evidence/Claim creation, reassociation, reevaluation, or refresh;
- confidence evaluation or refresh on read;
- Moderation, Eligibility, Publication, rollback, or retraction actions;
- historical dossier browsing or access to completed/superseded queue items;
- raw blobs, raw page text, screenshots, subtitles, comments, prompts, provider
  responses, AI rationale, credentials, actor IDs, correlation IDs, or audit
  payloads;
- browser-side source fetching, previews, scraping, telemetry, storage,
  automatic polling, WebSocket, SSE, or notification delivery;
- remote access, SSO, cookies, tokens, CORS, public routes, Caddy routes,
  Railway services, Redis/BullMQ, workers, migrations, or outbox events.

## 5. Dossier eligibility and currentness

The requested CandidateRevision is readable only when it satisfies the same
current-work predicate as Sprint 9B at the transaction snapshot:

1. the path identifier is a canonical lowercase UUID;
2. the revision belongs to the exact active catalog for its patch and game
   mode;
3. it is the highest numeric revision for its Candidate inside that active
   catalog;
4. it has an immutable Claim-set seal;
5. exactly one active eligibility policy exists for scope
   `candidate_revision`, resolving the active HumanReview policy;
6. the active-policy review quorum is absent or not satisfied.

If the revision is superseded, its catalog is inactive, its Claim set is not
sealed, or its current active-policy quorum is satisfied, the dossier is not
available. The reader does not serve a stale snapshot merely because the item
appeared in an earlier queue response.

Historical Evidence decisions never substitute for a missing current decision.
For each Claim, only the row referenced by
`current_claim_evidence_decisions` is current. Evidence associations are loaded
only through that decision's immutable `evidence_input_snapshot_id` and
`evidence_input_snapshot_associations`; they are never loaded by joining every
historical association for the Claim.

## 6. Read model

Create `backend/src/modules/operator/read-candidate-review-dossier.ts`.

The outward contract is closed and versioned:

```ts
type OperatorCandidateReviewDossier = {
  schemaVersion: 1;
  generatedAt: string;
  activeReviewPolicyRevisionId: string;
  candidate: {
    candidateId: string;
    candidateRevisionId: string;
    revision: number;
    patchId: string;
    patchKey: string;
    catalogRevisionId: string;
    subjectExternalId: string;
    selection: {
      augmentExternalIds: string[];
      itemExternalIds: string[];
    };
    createdAt: string;
  };
  review: {
    state: 'unreviewed' | 'in_progress';
    confirmedCount: number;
    requiredCount: number;
  };
  confidence: OperatorCandidateConfidence | null;
  claimSet: {
    claimSetSealId: string;
    claimSetHash: string;
    claimCount: number;
  };
  provenance: OperatorCandidateReviewProvenance[];
  claims: OperatorCandidateReviewClaim[];
};

type OperatorCandidateReviewProvenance = {
  candidateProvenanceId: string;
  origin: 'collector_detected' | 'community_submitted' | 'editorial' | 'ai_generated';
  source: OperatorDossierSource;
  reference: OperatorDossierReference | null;
  observedAt: string | null;
  collectedAt: string;
};

type OperatorCandidateReviewClaim = {
  claimId: string;
  claimKey: string;
  claimType: ClaimType;
  importance: ClaimImportance;
  statement: string;
  statementHash: string;
  decision: null | {
    decisionId: string;
    evidencePolicyRevisionId: string;
    outcome: 'supported' | 'insufficient' | 'contradicted';
    reason: string;
    evaluatedAt: string;
    evidence: OperatorCandidateReviewEvidence[];
  };
};

type OperatorCandidateReviewEvidence = {
  evidenceAssociationId: string;
  evidenceId: string;
  stance: 'supports' | 'contradicts' | 'context_only';
  crossPatchRevalidated: boolean;
  revalidationReason: string | null;
  evidencePatchId: string;
  evidencePatchKey: string;
  source: OperatorDossierSource;
  reference: OperatorDossierReference | null;
  observedAt: string | null;
  collectedAt: string;
  evidenceCreatedAt: string;
};

type OperatorDossierSource = {
  sourceId: string;
  sourceKey: string;
  displayName: string;
  status: 'active' | 'suspended' | 'retired';
  sourcePolicyRevisionId: string;
  storagePermission: 'blob_allowed' | 'reference_only' | 'aggregate_only';
};

type OperatorDossierReference = {
  url: string;
  platform: string | null;
  author: string | null;
  publishedAt: string | null;
  sourceContentId: string | null;
};
```

The existing `OperatorCandidateConfidence` type is reused without changing its
meaning. `confidence: null` remains `unscored`; no score is computed during a
dossier read.

## 7. Evidence and provenance projection

### Claims

Claims are ordered by `claim_key` under `C` collation. The returned number must
equal the sealed `claim_count`; a mismatch fails closed. Claim statements and
decision/revalidation reasons are already bounded by database constraints and
are rendered as untrusted text.

A missing current Evidence decision is represented by `decision: null`. It is
not an error and is important review information. A current decision with zero
associations is valid only when the persisted snapshot says
`association_count = 0`.

### Evidence

Evidence inside a decision is ordered by immutable snapshot ordinal. The reader
selects source and timestamp fields explicitly. It never selects `raw_blob`,
`aggregate_metadata`, `content_hash`, evaluator identity, or correlation data.

The reader verifies that association count, identity, Claim, CandidateRevision,
patch/catalog graph, and current decision all agree. Partial confidence rows,
partial Evidence graphs, impossible enum values, invalid dates, or count
mismatches fail the complete dossier closed.

### Provenance

All current CandidateRevision provenance rows are returned in stable
`candidate_provenance_id` order. Provenance is informational and does not become
Evidence merely because it is displayed. AI provenance shows `origin:
'ai_generated'` but never returns an AI run ID, proposal ID, provider payload,
or rationale.

### External references

`raw_observations.external_reference` remains untrusted JSON. The reader never
spreads it into the DTO. A reference is returned only when all of these hold:

- the persisted source policy permits references (`blob_allowed` or
  `reference_only`);
- `url` is an absolute `https:` URL no longer than 2,048 UTF-8 bytes;
- optional `platform`, `author`, `publishedAt`, and `sourceContentId` values are
  strings bounded respectively to 128, 256, 64, and 256 UTF-8 bytes;
- `publishedAt`, when present, is a canonical ISO timestamp or `YYYY-MM-DD`.

Unknown reference keys are ignored because the outward contract is an
allowlisted projection, not a validation claim about historical storage. An
invalid URL or optional field produces `reference: null` for that observation;
it does not expose the raw value. `aggregate_only` sources and `ai_generated`
provenance always produce `reference: null`.

The browser renders a returned HTTPS URL as an explicit link with
`target="_blank"`, `rel="noopener noreferrer"`, and
`referrerpolicy="no-referrer"`. It performs no automatic request, preview,
metadata expansion, or favicon fetch.

The outward source projection also requires a 1–128-byte printable ASCII
`sourceKey` and a non-empty `displayName` no longer than 256 UTF-8 bytes. A
source field outside these bounds is a stored-graph violation and fails the
complete dossier closed.

## 8. Transaction and query structure

The reader uses one client and exactly one:

`BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`

Within that snapshot it performs separate explicit queries for:

1. the active review policy and required confirmed-review count;
2. the eligible CandidateRevision header, active catalog, Claim seal, current
   quorum, and current persisted confidence;
3. ordered Candidate Claims and their current decision headers;
4. ordered snapshot-member Evidence associations for current decisions;
5. ordered CandidateRevision provenance.

Separate queries avoid the Claim × Evidence × provenance cross product. Every
query is parameterized. The implementation commits once on success, rolls back
on every error, and releases the client exactly once.

The dossier is bounded to at most 256 Claims, at most 64 Evidence associations
per Claim (matching the existing Evidence command limit), and at most 2,048
Evidence associations in total. Crossing a response bound fails closed rather
than silently truncating governed context.

## 9. HTTP boundary

Add:

`GET /api/operator/v1/candidate-review-dossiers/:candidateRevisionId`

The route accepts no query keys. The path ID must match the canonical lowercase
UUID format already used by backend trust commands.

Invalid path or any query parameter returns HTTP 400:

```json
{
  "error": {
    "code": "INVALID_OPERATOR_CANDIDATE_DOSSIER_REQUEST",
    "message": "Invalid operator candidate dossier request"
  }
}
```

A valid UUID that does not satisfy the current dossier eligibility predicate
returns HTTP 404:

```json
{
  "error": {
    "code": "OPERATOR_CANDIDATE_DOSSIER_NOT_FOUND",
    "message": "Operator candidate dossier not found"
  }
}
```

Database unavailability, missing active authority, invalid persisted graph, or
response-bound failure returns HTTP 503:

```json
{
  "error": {
    "code": "OPERATOR_CANDIDATE_DOSSIER_UNAVAILABLE",
    "message": "Operator candidate dossier is temporarily unavailable"
  }
}
```

The route captures `now` once, applies existing security headers and
`Cache-Control: no-store`, and logs only a stable error code. It never logs SQL,
stack traces, Candidate content, Claim text, decision reasons, references, or
identifiers.

POST, PUT, PATCH, and DELETE remain unregistered and return 404.

## 10. Operator UI

Each Sprint 9B queue card gains one non-mutating `Xem hồ sơ` control. Activating
it loads the exact CandidateRevision dossier and replaces the queue cards with
a detail view containing:

- Candidate, patch, catalog, selection, review-progress, and confidence
  summary;
- provenance rows grouped by origin;
- Claims in stable `claim_key` order with explicit importance badges;
- the current decision outcome and reason for each Claim;
- Evidence rows showing stance, patch alignment/revalidation, source identity,
  timestamps, and a safe optional external reference;
- a `Quay lại hàng đợi` control and a manual dossier refresh control.

The browser displays explicit states for loading, not found/stale, unavailable,
and empty Evidence. A 404 explains that the item may have completed review or
left the active catalog and directs the operator back to a freshly loaded
queue.

All untrusted strings use DOM `textContent`. Links receive only a server-validated
HTTPS URL. There is no `innerHTML`, browser storage, telemetry, external asset,
automatic refresh, mutation form, approve/decline button, Evidence-edit button,
or review-completion shortcut.

The existing Monitoring & feedback view and Sprint 9B queue endpoint/contract
remain unchanged.

## 11. Authority and privacy isolation

Sprint 9C production code must not import or call:

- `complete-human-review` or any reviewer-identity/permission mutation;
- `record-claim-evidence-decision`, Claim-set definition, or Evidence mutation;
- `evaluate-candidate-confidence`;
- moderation, eligibility, publication, rollback, or retraction commands;
- AI provider/materialization commands;
- feedback/monitoring mutations;
- Redis, BullMQ, collector, scheduler, worker, outbox, or audit writers.

Tests must prove that a successful dossier read leaves HumanReview, Evidence,
Claims, confidence, moderation, eligibility, publication, audit, idempotency,
and outbox table counts unchanged.

Repository contracts must keep the operator runtime loopback-only and prove the
new route string is absent from the public Next application, Caddy, Railway,
and deployment manifests.

## 12. Failure behavior

- No active eligibility/review policy: sanitized 503, fail closed.
- CandidateRevision absent or no longer a current queue item: sanitized 404.
- Missing current Evidence decision: HTTP 200 with `decision: null`.
- Current decision with a valid zero-association snapshot: HTTP 200 with
  `evidence: []`.
- Source is suspended or retired: return the status so the reviewer can see it;
  do not hide or reactivate the source.
- Source policy is `aggregate_only`: return source facts and `reference: null`.
- Invalid stored reference: return `reference: null`; never reflect the raw
  value.
- Invalid Candidate/Claim/Evidence/confidence graph or bound overflow:
  sanitized 503; do not return a partial dossier.
- PostgreSQL unavailable: sanitized 503; Sprint 9B queue and public Publication
  paths retain independent failure boundaries.

## 13. Files

Create during implementation:

- `backend/src/modules/operator/read-candidate-review-dossier.ts`
- `backend/test/operator-candidate-review-dossier.test.ts`
- `tests/operator-candidate-review-dossier-contract.test.mjs`
- `.github/workflows/sprint-9c-candidate-review-dossier.yml`
- `docs/superpowers/plans/2026-09-03-candidate-review-evidence-dossier.md`

Modify during implementation:

- `backend/src/modules/operator/types.ts`
- `backend/src/operator/http.ts`
- `backend/src/operator/assets.ts`
- `backend/src/operator-server.ts`
- `backend/test/operator-http.test.ts`
- `backend/test/operator-authority-isolation.test.ts`
- `tests/operator-surface-contract.test.mjs`
- `docs/runbooks/operator-surface.md`
- root `package.json`

No migration, public application file, deployment file, Caddy route, Railway
service, secret, queue, or worker is added.

## 14. Required tests

1. Reader returns only an exact latest sealed revision in the active catalog.
2. Completed active-policy quorum and superseded revisions are not readable.
3. Historical review policy cannot make a dossier current.
4. Claim count must equal the Claim-set seal and Claim ordering is stable.
5. Only each Claim's current Evidence decision is returned.
6. Evidence comes only from the current decision's immutable input snapshot,
   ordered by snapshot ordinal.
7. Missing decision maps to `null`; valid zero association maps to an empty
   list.
8. Provenance is complete, stable, and never promoted to Evidence.
9. Persisted confidence maps exactly and missing confidence remains `null`.
10. Reference projection accepts bounded HTTPS facts, rejects unsafe URLs,
    returns null for aggregate-only/AI inputs, and never returns raw JSON.
11. Graph/count/date/enum/response-bound violations fail the complete dossier
    closed.
12. Transaction is repeatable-read/read-only, commits once, rolls back on
    error, and releases once.
13. Dossier read leaves every mutation authority, audit, idempotency, and
    outbox count unchanged.
14. HTTP accepts only canonical UUID GET requests with no query and returns the
    closed 400/404/503 bodies.
15. Existing queue and publication snapshot contracts remain unchanged.
16. Browser assets use `textContent`, safe explicit links, manual refresh, no
    storage/external preview/polling, and no mutation controls.
17. Repository contracts prove loopback-only, deployment-free, public-route-free
    authority isolation.

## 15. Verification gate

Before merge:

- focused Sprint 9C reader, HTTP, UI, and contract tests pass;
- existing Sprint 9B candidate queue and Sprint 7C operator tests pass;
- Sprint 9A confidence tests pass;
- full backend typecheck, test suite, migrations, and build pass;
- root regression and static Pages build pass;
- lint and `git diff --check` pass;
- dedicated Sprint 9C CI passes with PostgreSQL 17, no production secrets, no
  provider call, and no deployment authority;
- all inherited required workflows and `rc-ready` pass;
- independent review reports no unresolved Critical or Important finding.

## 16. Definition of done

Sprint 9C is complete only when:

- a reviewer can open one current Sprint 9B queue item and inspect its complete
  governed dossier;
- only current Evidence-decision snapshot membership is shown;
- provenance, Claims, Evidence, source status, reference, confidence, and review
  progress retain their distinct meanings;
- unsafe or disallowed source material is never returned;
- the dossier cannot mutate or satisfy any review/trust/publication authority;
- the operator runtime remains loopback-only, read-only, and deployment-free;
- the Sprint 9B queue and existing publication snapshot contracts remain
  unchanged;
- all focused and inherited gates pass.
