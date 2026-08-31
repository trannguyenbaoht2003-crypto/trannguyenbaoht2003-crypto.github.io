# Sprint 9B — Candidate Review Confidence Queue Design

**Date:** 2026-08-28
**Status:** Approved for implementation
**Base:** `main@e141f62f0b69f0e5ad51a999e7dfec6918009024`
**Scope:** Loopback-only, read-only operator presentation of Sprint 9A confidence

## 1. Goal

Give reviewers a deterministic queue of current CandidateRevisions, enriched with the immutable confidence result from Sprint 9A, without granting the operator surface any review, trust, moderation, eligibility, or publication authority.

The authority graph remains:

`CandidateRevision -> Evidence/Claim decisions -> HumanReview -> Moderation -> Eligibility -> Publication`

Sprint 9B adds only:

`CandidateRevision + persisted ConfidenceScore -> read-only operator queue -> human prioritization`

There is no edge from the queue or confidence score to any mutation authority.

## 2. Existing boundaries

Sprint 7C already provides a dedicated Fastify operator runtime that:

- binds only to `127.0.0.1`, `::1`, or `localhost`;
- is absent from Caddy, Railway, and the public static application;
- exposes GET-only monitoring and feedback presentation;
- depends on PostgreSQL but not Redis or BullMQ;
- uses restrictive headers, no cache, no browser storage, and no external assets.

Sprint 9A already provides:

- deterministic CandidateRevision confidence scoring;
- immutable input snapshots and score rows;
- a guarded current-score pointer;
- a read-only confidence contract;
- no HTTP route and no AI scoring path.

Sprint 9B composes those proven boundaries. It does not introduce a new runtime, authentication system, network exposure, database migration, scorer, queue, or worker.

## 3. Approach decision

### Selected: separate candidate queue endpoint in the existing operator runtime

Add a candidate-review queue alongside the existing publication signal snapshot. Each endpoint keeps an independent versioned response contract and failure boundary. The console presents them as separate views.

This approach is preferred because it preserves the existing `/api/operator/v1/snapshot` contract and reuses the established loopback-only security model.

### Rejected: expand the publication snapshot to schema version 2

Candidate review work and post-publication monitoring have different identities, filters, ranking rules, and failure semantics. Combining them would couple unrelated read models and force an unnecessary breaking response change.

### Rejected: remotely accessible authenticated operator service

Remote access requires identity, session, CSRF, secret provisioning, network routing, deployment, and incident-response design. Those concerns do not improve the Sprint 9B read model and remain out of scope.

## 4. Scope

Sprint 9B includes:

- one read-only candidate-review queue module;
- one GET endpoint in the existing operator runtime;
- one candidate queue view in the existing self-contained operator console;
- deterministic filtering, ranking, and bounded result size;
- sanitized failure behavior;
- reader, HTTP, UI-contract, authority-isolation, and repository-contract tests;
- an updated operator runbook and dedicated CI gate.

Sprint 9B does not include:

- HumanReview completion or reviewer identity management;
- Evidence or Claim mutation;
- confidence evaluation or refresh on read;
- Moderation, Eligibility, Publication, rollback, or retraction actions;
- remote access, SSO, browser tokens, cookies, CORS, or public routes;
- automatic polling, WebSocket, SSE, notification delivery, or queue jobs;
- a database migration or outbox event;
- raw observations, raw Evidence content, model prompts, provider payloads, credentials, or feedback details in the candidate queue.

## 5. Queue eligibility

The queue is computed from one PostgreSQL `REPEATABLE READ READ ONLY` transaction.

A CandidateRevision is eligible only when all conditions hold:

1. its `catalog_revision_id` is the exact active catalog revision for its patch and game mode;
2. it is the highest numeric revision for its `candidate_id` inside that active catalog;
3. it has an immutable `candidate_claim_set_seals` row;
4. an active eligibility policy exists for scope `candidate_revision`, providing the active HumanReview policy revision;
5. its current review quorum for that active review policy is absent or has `quorum_satisfied = false`.

A current quorum with `quorum_satisfied = true` excludes the revision from the queue. Historical catalog revisions, superseded CandidateRevisions, and review results from non-active review policies do not satisfy or suppress the active queue.

The queue does not invent readiness beyond these facts. Missing current Evidence decisions may still be visible because the reviewer must be able to inspect incomplete trust inputs; confidence already gives such inputs no unsupported credit.

## 6. Read model

Create `backend/src/modules/operator/read-candidate-review-queue.ts`.

The outward contract is:

```ts
type OperatorCandidateReviewState = 'unreviewed' | 'in_progress';
type OperatorCandidateConfidenceBand =
  | 'unscored'
  | 'low'
  | 'medium'
  | 'high'
  | 'very_high';

type OperatorCandidateReviewQueueItem = {
  candidateId: string;
  candidateRevisionId: string;
  revision: number;
  patchId: string;
  catalogRevisionId: string;
  subjectExternalId: string;
  selection: {
    augmentExternalIds: string[];
    itemExternalIds: string[];
  };
  createdAt: string;
  review: {
    state: OperatorCandidateReviewState;
    confirmedCount: number;
    requiredCount: number;
  };
  confidence: null | {
    scoreId: string;
    scoringVersion: 'candidate-confidence-v1';
    score: number;
    band: Exclude<OperatorCandidateConfidenceBand, 'unscored'>;
    components: {
      provenanceQualityScore: 0 | 20 | 30;
      evidenceDiversityScore: 0 | 10 | 25;
      patchAlignmentScore: 0 | 10 | 20;
      freshnessScore: 0 | 5 | 15;
    };
    evaluatedAt: string;
    createdAt: string;
  };
};

type OperatorCandidateReviewQueue = {
  schemaVersion: 1;
  generatedAt: string;
  activeReviewPolicyRevisionId: string;
  limit: number;
  summary: {
    returned: number;
    unreviewed: number;
    inProgress: number;
    unscored: number;
    low: number;
    medium: number;
    high: number;
    veryHigh: number;
  };
  items: OperatorCandidateReviewQueueItem[];
};
```

The reader selects fields explicitly. It validates the closed candidate selection payload and never spreads database rows or arbitrary JSON into the response.

## 7. Confidence semantics

The queue left-joins `current_candidate_confidence_scores` to its immutable score row.

- A current score is presented exactly as persisted.
- A missing current score is `confidence: null` and the presentation band is `unscored`.
- Opening or refreshing the queue never invokes `evaluateCandidateConfidence`.
- Confidence does not satisfy review quorum and does not alter queue eligibility.
- AI provenance receives only the score already governed by Sprint 9A; no AI call participates in presentation.

## 8. Deterministic ranking

The default order is:

1. `in_progress` before `unreviewed`, so partially completed quorum work is finished first;
2. confidence band: `very_high`, `high`, `medium`, `low`, then `unscored`;
3. confidence score descending, with unscored treated below zero;
4. CandidateRevision creation time ascending, preventing indefinite starvation inside a band;
5. `candidate_id` ascending under `C` collation;
6. `candidate_revision_id` ascending under `C` collation.

This is presentation ordering only. It is not a trust or eligibility decision.

## 9. Bounds and endpoint

Add:

`GET /api/operator/v1/candidate-review-queue?limit=<integer>`

`limit` is an exact base-10 integer from `1` through `100`, default `50`. Unknown query keys, arrays, signs, whitespace, decimals, zero, and out-of-range values return HTTP 400 with:

```json
{
  "error": {
    "code": "INVALID_OPERATOR_CANDIDATE_QUEUE_QUERY",
    "message": "Invalid operator candidate queue query"
  }
}
```

The route captures `now` once and passes it to the reader as `generatedAt`. All existing operator security headers and `Cache-Control: no-store` apply.

## 10. Failure behavior

- PostgreSQL unavailable: HTTP 503 with sanitized code `OPERATOR_CANDIDATE_QUEUE_UNAVAILABLE`.
- No active eligibility policy: fail closed with the same sanitized 503 response.
- No active catalog candidates: HTTP 200 with zero summary counts and `items: []`.
- Invalid stored candidate payload or impossible confidence component: fail closed to sanitized 503; do not omit the invalid row and pretend the queue is healthy.
- Existing publication snapshot failure remains isolated from the candidate queue, and vice versa.
- Server logs contain a stable error code only, never SQL, connection strings, payloads, stack traces, or candidate content.

## 11. Operator UI

The existing local page gains two views:

- `Candidate review` — the default view for the Sprint 9B queue;
- `Monitoring & feedback` — the unchanged Sprint 7C publication snapshot.

The candidate view shows:

- summary counts for review progress and confidence bands;
- local filters for review state and confidence band;
- local search across candidate, revision, subject, patch, catalog, augment, and item IDs;
- one card per queue item with review progress, confidence total/band/components, selection IDs, and timestamps;
- a manual refresh button.

No card contains approve, decline, moderate, publish, rollback, retry-score, or other mutation controls. Candidate strings are rendered with DOM `textContent`; there is no `innerHTML`, browser storage, telemetry, external asset, or automatic refresh timer.

The monitoring/feedback view retains its current filters, content, endpoint, and response schema.

## 12. Authority isolation

Sprint 9B production code must not import or call:

- `evaluate-candidate-confidence`;
- `complete-human-review`;
- Evidence or Claim mutation commands;
- moderation commands;
- eligibility evaluation commands;
- publication or rollback commands;
- AI provider, AI materialization, Redis, BullMQ, collector, or worker modules.

The candidate queue reader executes only `BEGIN ... READ ONLY`, `SELECT`, `COMMIT`, and error-path `ROLLBACK`. Tests must prove that reading the queue leaves HumanReview, Evidence, moderation, eligibility, publication, confidence, audit, and outbox tables unchanged.

Repository contracts must continue proving that operator routes are not exposed by Caddy, Railway, or the public Next application and that the operator runtime registers no POST, PUT, PATCH, or DELETE route.

## 13. Files

Create:

- `backend/src/modules/operator/read-candidate-review-queue.ts`
- `backend/test/operator-candidate-review-queue.test.ts`
- `tests/operator-candidate-review-queue-contract.test.mjs`
- `.github/workflows/sprint-9b-candidate-review-queue.yml`
- `docs/superpowers/plans/2026-08-28-candidate-review-confidence-queue.md`

Modify:

- `backend/src/modules/operator/types.ts`
- `backend/src/operator/http.ts`
- `backend/src/operator/assets.ts`
- `backend/src/operator-server.ts`
- `backend/test/operator-http.test.ts`
- `backend/test/operator-authority-isolation.test.ts`
- `tests/operator-surface-contract.test.mjs`
- `docs/runbooks/operator-surface.md`
- root `package.json`

No migration, public application file, deployment file, Caddy route, or Railway service is added.

## 14. Required tests

1. Reader selects only the latest sealed revision in the active catalog.
2. Active-policy completed quorum excludes a revision.
3. Partial quorum produces `in_progress` with exact counts.
4. Historical review policy does not suppress active-policy work.
5. Current confidence is mapped exactly and missing confidence is `unscored`.
6. Deterministic ranking follows progress, band, score, age, and ID tie-breakers.
7. Result limit is enforced after deterministic ordering.
8. Invalid payload or confidence facts fail closed.
9. Reader transaction is repeatable-read and read-only, commits once, and rolls back on error.
10. Queue read leaves every mutation authority and audit/outbox count unchanged.
11. HTTP accepts only GET with the closed `limit` query and sanitizes failures.
12. Existing publication snapshot route and schema remain unchanged.
13. Browser assets use `textContent`, manual refresh, no storage, no external fetch, and no mutation controls.
14. Repository contracts prove loopback-only, deployment-free, public-route-free authority isolation.

## 15. Verification gate

Before merge:

- focused Sprint 9B tests pass;
- existing Sprint 7C operator tests pass unchanged or with additive assertions only;
- Sprint 9A confidence tests pass;
- full backend typecheck, tests, and build pass;
- root regression and static build pass;
- lint and `git diff --check` pass;
- dedicated Sprint 9B CI passes without production secrets or deployment authority;
- required `rc-ready` check passes;
- independent code review reports no unresolved Critical or Important findings.

## 16. Definition of done

Sprint 9B is complete only when:

- reviewers can inspect a deterministic, bounded queue of current unresolved CandidateRevisions;
- persisted confidence is visible but remains advisory;
- the existing publication snapshot contract is preserved;
- the operator runtime remains loopback-only and deployment-free;
- no read path can evaluate confidence or mutate HumanReview, Evidence, Moderation, Eligibility, Publication, audit, or outbox state;
- all focused and inherited gates pass.
