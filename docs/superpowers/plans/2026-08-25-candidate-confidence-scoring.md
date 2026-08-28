# Candidate Confidence Scoring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement Sprint 9A as a deterministic, append-only candidate-revision confidence signal that helps review prioritization without changing HumanReview, Moderation, Eligibility, or Publication authority.

**Architecture:** Add a pure scorer, an immutable PostgreSQL input/result history with a mutable current pointer, a transactional evaluator that loads only authoritative current Evidence facts, and a read-only current confidence reader. The evaluator writes one audit event only when a genuinely new immutable score is persisted. No queue, AI, moderation, eligibility, review-completion, publication, or HTTP mutation path is introduced.

**Tech Stack:** TypeScript 5.9, Node.js 22.13+, PostgreSQL, `pg`, Node test runner, existing migration runner and transaction helpers.

**Spec:** `docs/superpowers/specs/2026-08-24-candidate-confidence-scoring-design.md`

## Global Constraints

- Scoring identity is `candidate_revision_id`.
- Scoring version is exactly `candidate-confidence-v1`.
- Confidence is advisory only and MUST NOT satisfy or mutate HumanReview, Moderation, Eligibility, or Publication.
- AI-generated provenance receives zero provenance-quality points.
- Score maximum is 90; bands are `low`, `medium`, `high`, `very_high`.
- Evaluation time is explicit input; scoring code MUST NOT call the system clock.
- Historical input snapshots and score rows are immutable.
- Replays of the same candidate revision + scoring version + input hash must return the existing score without duplicate audit effects.

---

### Task 1: Pure confidence scorer

**Files:**
- Create: `backend/src/modules/confidence/types.ts`
- Create: `backend/src/modules/confidence/compute-candidate-confidence.ts`
- Test: `backend/test/candidate-confidence-compute.test.ts`

**Interfaces:**
- Consumes normalized authoritative facts: provenance quality, distinct supporting source count, exact-patch support, governed revalidated cross-patch support, newest supporting Evidence time, explicit evaluation time.
- Produces `computeCandidateConfidence(input)` and `confidenceBandForScore(score)`.

- [ ] Write tests for deterministic output, AI-only/no-evidence low score, source-diversity boundaries, exact versus revalidated cross-patch scoring, 7/30-day freshness boundaries, future timestamp rejection, and band thresholds.
- [ ] Implement strict input validation and pure component calculation.
- [ ] Verify focused tests and typecheck.

### Task 2: Immutable persistence contract

**Files:**
- Create: `backend/migrations/0018_candidate_confidence_scoring.sql`
- Test: `backend/test/candidate-confidence-migration.test.ts`

**Interfaces:**
- Produces append-only `candidate_confidence_input_snapshots`, append-only `candidate_confidence_scores`, and mutable `current_candidate_confidence_scores`.
- Full composite foreign keys preserve candidate/candidate-revision/patch/catalog/scoring identity across the three structures.

- [ ] Create migration tests that assert tables/constraints exist after migrations 0001-0018.
- [ ] Implement immutable triggers for snapshots and scores using existing `reject_immutable_change()`.
- [ ] Add database checks for component domains, score sum, band mapping, hash format, evaluation timestamp ordering, and graph identity.
- [ ] Verify migration tests against a reset database.

### Task 3: Transactional evaluator and audit

**Files:**
- Create: `backend/src/modules/confidence/evaluate-candidate-confidence.ts`
- Test: `backend/test/candidate-confidence-evaluation.test.ts`

**Interfaces:**
- `evaluateCandidateConfidence(pool, command)` loads candidate revision identity, immutable provenance, and only Evidence associations belonging to each Claim's current `supported` Evidence decision snapshot.
- Persists one input snapshot and one score per logical input, writes `audit_events.action = 'candidate_confidence.created'` only for a newly inserted score, and advances the current pointer only when `(evaluated_at, score_sequence)` is newer.

- [ ] Seed an authoritative candidate + Evidence graph and assert the expected score.
- [ ] Add replay test proving no duplicate snapshot/score/audit rows.
- [ ] Add newer-evaluation pointer advancement and stale-evaluation non-regression tests.
- [ ] Implement concurrency-safe `INSERT ... ON CONFLICT DO NOTHING` convergence for snapshot and score rows.
- [ ] Implement audit payload containing identifiers, components, total, band, scoring version, and input hash only.

### Task 4: Current confidence reader and authority isolation

**Files:**
- Create: `backend/src/modules/confidence/read-candidate-confidence.ts`
- Test: `backend/test/candidate-confidence-reader.test.ts`
- Test: `backend/test/candidate-confidence-authority-isolation.test.ts`

**Interfaces:**
- `readCandidateConfidence(queryable, candidateRevisionId)` returns the current immutable score projection or `null`.

- [ ] Verify missing current score returns `null` and a persisted score returns candidate identity, components, score, band, version, evaluation time, and creation time.
- [ ] Verify confidence evaluation leaves `human_reviews`, `moderation_decisions`, `candidate_eligibility_evaluations`, and `publication_versions` unchanged.
- [ ] Verify confidence source files do not import publication, moderation, eligibility, or HumanReview mutation modules.

### Task 5: Full quality gate and PR

**Files:**
- No additional production files unless verification finds a defect.

- [ ] Run focused Sprint 9A tests.
- [ ] Run `npm run typecheck` in `backend`.
- [ ] Run full `npm test` in `backend`.
- [ ] Run `npm run build` in `backend`.
- [ ] Open PR from `sprint-9a-candidate-confidence` to `main`.
- [ ] Require the repository `rc-ready` PR gate to pass before merge.
