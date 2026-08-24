# Sprint 9A — Candidate Confidence Scoring Design

Date: 2026-08-24
Status: Proposed for implementation

## Goal

Add a deterministic, append-only confidence layer for candidate revisions so review tooling can rank work without changing trust, moderation, eligibility, or publication authority.

Confidence is advisory only. It MUST NOT create, activate, approve, moderate, mark eligible, publish, roll back, or otherwise mutate Publication authority.

## Existing authority boundaries

The implementation must preserve the current graph:

`Observation -> CandidateRevision -> Evidence/Claim decisions -> HumanReview -> Moderation -> Eligibility -> Publication`

Candidate confidence is inserted as an independent read-side signal:

`CandidateRevision -> ConfidenceSnapshot/Score -> reviewer prioritization`

There is no edge from confidence to Publication.

## Scope

Sprint 9A includes:

- one PostgreSQL migration for immutable confidence snapshots and scores;
- a deterministic scoring function with explicit `evaluatedAt` input;
- persistence of an immutable score plus an auditable current pointer;
- one read module for current confidence by candidate revision;
- audit events for score creation;
- migration, unit, integration, concurrency/idempotency, and authority-isolation tests.

Sprint 9A does NOT include:

- automatic publication or automatic HumanReview completion;
- eligibility or moderation changes;
- an AI/LLM scoring path;
- a new public HTTP endpoint;
- an unauthenticated `/internal/*` route. The current Fastify app has no internal-auth boundary, so exposing an internal route here would create a new security surface. HTTP/operator presentation belongs to Sprint 9B after the read model is proven.

## Candidate revision is the scoring identity

Confidence is attached to `candidate_revision_id`, not merely `candidate_id`.

Evidence, claims, review snapshots, moderation, and eligibility already operate against candidate revisions. Scoring only the candidate identity would let a newer revision accidentally inherit an older revision's confidence.

Every stored confidence record therefore carries:

- `candidate_id`
- `candidate_revision_id`
- `patch_id`
- `catalog_revision_id`
- `scoring_version`
- immutable input hash
- explicit evaluation timestamp

## Deterministic input model

Version 1 uses only existing authoritative database facts. It does not introduce a separate subjective source-reputation registry.

### Provenance quality: 0–30

Candidate provenance is already immutable and records origin.

- any `editorial` provenance: 30
- otherwise any `collector_detected` or `community_submitted` provenance: 20
- AI-only provenance: 0

This deliberately gives `ai_generated` no trust credit. AI output is not Evidence.

### Evidence diversity: 0–25

Count distinct source IDs from supporting evidence associated with the candidate revision's claims.

- 2 or more distinct supporting sources: 25
- exactly 1 distinct supporting source: 10
- no supporting source: 0

`context_only` and `contradicts` associations do not add evidence-diversity points.

### Patch alignment: 0–20

Evaluate supporting evidence only.

- at least one supporting evidence record on the exact candidate patch: 20
- otherwise supporting cross-patch evidence exists and every counted association is explicitly `cross_patch_revalidated = true`: 10
- otherwise: 0

The design does not infer an "adjacent patch" from lexical patch names because the current schema does not define a total patch ordering. Revalidated cross-patch evidence is the existing governed substitute.

### Freshness: 0–15

Use the newest supporting evidence source timestamp, computed as `coalesce(raw_observations.observed_at, raw_observations.collected_at)`.

Age is measured against the command's explicit `evaluatedAt`, not `clock_timestamp()` inside the scoring function.

- age < 7 days: 15
- age >= 7 days and <= 30 days: 5
- older than 30 days or no supporting evidence: 0

Future timestamps are rejected as invalid scoring input rather than silently receiving freshness credit.

## Score and bands

`score = provenanceQuality + evidenceDiversity + patchAlignment + freshness`

Maximum score: 90.

Bands:

- `low`: 0–39
- `medium`: 40–69
- `high`: 70–89
- `very_high`: 90

The design intentionally avoids the name `verified_candidate`. A confidence score is not verification and must not be confused with HumanReview or Evidence decisions.

## Persistence model

Migration `0018_candidate_confidence_scoring.sql` will add three structures.

### `candidate_confidence_input_snapshots`

Append-only snapshot of the normalized inputs used by the scorer.

Required fields:

- `candidate_confidence_input_snapshot_id uuid primary key`
- candidate/candidate-revision/patch/catalog identity
- `scoring_version text` constrained to `candidate-confidence-v1`
- `provenance_quality integer`
- `supporting_source_count integer`
- `has_exact_patch_support boolean`
- `has_revalidated_cross_patch_support boolean`
- `newest_supporting_evidence_at timestamptz null`
- `evaluated_at timestamptz`
- `input_hash text` SHA-256
- `created_by text`
- `created_at timestamptz`

The input hash is built from canonical scalar tokens, including `evaluatedAt`, so the same authoritative facts at the same evaluation time yield the same identity.

### `candidate_confidence_scores`

Append-only result row:

- `candidate_confidence_score_id uuid primary key`
- `candidate_confidence_input_snapshot_id uuid unique`
- candidate/candidate-revision identity
- `scoring_version text`
- component scores
- `score integer check (score between 0 and 90)`
- `band text check (band in ('low','medium','high','very_high'))`
- `reason text`
- `actor_id text`
- `correlation_id text`
- `created_at timestamptz`

Database checks enforce that total score equals the component sum and the band matches score thresholds.

### `current_candidate_confidence_scores`

Mutable pointer only; score rows remain immutable.

Primary key: `candidate_revision_id`.

The pointer references the full candidate/candidate-revision identity and current immutable score row. Updating this pointer never rewrites historical scores.

## Idempotency and concurrency

A scoring command is idempotent for the tuple:

`candidate_revision_id + scoring_version + input_hash`.

If the exact input snapshot already has a score, the command returns the existing result and does not create duplicate audit events.

Concurrent attempts for the same logical input must converge on one immutable score. The database uniqueness constraints are the final authority; application code handles the losing insert by loading the existing row.

A newer successful score may advance `current_candidate_confidence_scores`. An older score must not replace a newer current pointer. Pointer advancement is ordered by `evaluated_at`, then immutable score creation order as a deterministic tie-breaker.

## Application modules

Create `backend/src/modules/confidence/` with focused units:

- `types.ts` — input/result contracts and band type;
- `compute-candidate-confidence.ts` — pure deterministic component/band calculation;
- `evaluate-candidate-confidence.ts` — transaction, authoritative input load, snapshot persistence, score persistence, audit, current-pointer advancement;
- `read-candidate-confidence.ts` — read-only current score by candidate revision.

The pure compute module has no database, clock, queue, AI, moderation, eligibility, or publication dependencies.

## Audit contract

On a newly persisted score, write one immutable `audit_events` row:

- `action = 'candidate_confidence.created'`
- `policy_version = 'candidate-confidence-v1'`
- actor/reason/correlation copied from the command
- payload contains only structured identifiers, component scores, total score, band, and input hash

Do not put raw source content, model prompts, free-form Evidence text, secrets, or credentials in the audit payload.

No outbox event is required in Sprint 9A. Confidence is a reviewer-assistance read model and does not need queue-driven side effects yet.

## Read contract

`readCandidateConfidence(queryable, candidateRevisionId)` returns either `null` or:

- candidate/candidate-revision identity
- score
- band
- component scores
- scoring version
- evaluated timestamp
- score creation timestamp

No HTTP route is added in 9A.

## Authority isolation

Sprint 9A code must not import or call:

- `publish-candidate-revision`
- `record-candidate-moderation-decision`
- `evaluate-candidate-eligibility`
- `complete-human-review`

Regression tests must prove that evaluating confidence leaves publication, moderation, eligibility, and HumanReview tables unchanged.

Confidence cannot satisfy or substitute any trust gate.

## TDD and verification

Implementation follows RED -> GREEN -> REFACTOR.

Required tests:

1. Pure scoring unit tests
   - identical input is identical output;
   - AI-only + no evidence stays low;
   - evidence diversity boundaries;
   - exact patch versus revalidated cross-patch;
   - freshness boundaries at 7 and 30 days;
   - future evidence timestamp rejected;
   - score-to-band boundaries.

2. Migration tests
   - migration applies cleanly after migrations 0001–0017;
   - append-only score/snapshot guards reject update/delete;
   - score/component/band database checks reject invalid rows;
   - foreign keys prevent cross-candidate revision graph mismatch.

3. Integration tests
   - authoritative candidate/evidence graph produces expected score;
   - new score creates exactly one audit event;
   - replay with identical input is a no-op returning the same score;
   - newer evaluated input advances the current pointer;
   - stale evaluation cannot move current pointer backwards.

4. Concurrency test
   - two simultaneous identical scoring commands converge to one score.

5. Authority-isolation test
   - confidence evaluation does not create/modify HumanReview, moderation, eligibility, or publication state.

Final gate before PR merge:

- focused Sprint 9A tests;
- full backend typecheck;
- full backend test suite;
- backend build;
- root production/source contracts that cover trust/publication isolation;
- required PR `rc-ready` check.

## Definition of done

Sprint 9A is complete only when:

- scoring is deterministic for explicit inputs;
- history is immutable and current state is a pointer;
- scoring is idempotent and concurrency-safe;
- audit is created only for a genuinely new score;
- no AI call participates in scoring;
- no confidence path can mutate HumanReview, Moderation, Eligibility, or Publication;
- all focused and inherited gates pass.
