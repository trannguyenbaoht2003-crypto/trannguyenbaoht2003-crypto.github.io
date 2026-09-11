# Autonomous AI Publication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically review source-backed build candidates and publish eligible updates.

**Architecture:** Add explicit AI review authority to the existing trust graph, plus a bounded provider adapter and durable hourly coordinator. Keep all publication and rollback checks.

**Tech Stack:** Node 22+, TypeScript, PostgreSQL, BullMQ, existing OpenAI Responses transport.

**Spec:** docs/superpowers/specs/2026-09-08-autonomous-ai-publication-design.md

## Global Constraints

- No AI receipt is inserted into human_reviews.
- Existing human policies and publication checks remain effective.
- AI_AUTONOMOUS_PUBLICATION_ENABLED defaults to false.
- Source text is untrusted data, never instructions.
- At most one candidate per hourly tick, four model reservations per UTC day, 4096 output tokens.
- No public mutation route or frontend secret is introduced.
- OpenAI Platform connection is blocked; tests may use deterministic transport fixtures, never claim these are live AI runs.

### Task 1: Explicit AI review authority

**Files:** migration 0019_ai_review_authority.sql; modules/ai-review/review-authority.ts; trust human review guards; test/ai-review-authority.test.ts.

**Interfaces:** registerAiReviewPolicy(pool, command) creates an immutable review policy with review_authority='ai', permission='ai_reviewer', one required confirmation, and model/prompt metadata. loadAiReviewContext(pool,candidateId,candidateRevisionId) returns the current reviewPolicyRevisionId and canonical inputHash. completeAiReview(pool,command) records a distinct AI receipt and generic quorum for that exact snapshot.

- [ ] Write integration tests for AI approval followed by existing eligibility/publication; assert human_reviews has zero rows.
- [ ] Run the tests and observe the missing-authority failure.
- [ ] Add policy discrimination, immutable receipts, exact snapshot membership and SQL quorum guards. Human completion rejects AI policies. A receipt binds model, promptVersion, requestHash, responseHash and providerResponseId.
- [ ] Verify held/rejected review, wrong policy, stale evidence/provenance, direct SQL forgery, retries and existing human publication tests.

### Task 2: Bounded provider and source-backed inputs

**Files:** modules/ai-review/ai-review-provider.ts; modules/ai-review/prepare-candidate-review.ts; test/ai-review-provider.test.ts; test/ai-review-preparation.test.ts.

**Interfaces:** AiReviewRequest has schemaVersion=1, candidateRevisionId, patchKey, championExternalId, selection, requiredClaims and evidence observations. The provider returns outcome confirmed|changes_requested|declined, reason, claim decisions and exact observation citations.

- [ ] Write failing parser/transport tests for invented citations, missing claims, refusal, invalid schema, contradiction and missing source support.
- [ ] Use the existing Responses API pattern with store=false, strict JSON schema, bounded input, timeout, no tools and max_output_tokens=4096.
- [ ] Load current catalog candidates with public observations from two distinct hosts. Seal only a factual community_report claim if no claim set exists; reuse existing evidence commands with deterministic IDs.
- [ ] Verify no model call occurs for stale, unsupported or AI-only candidates.

### Task 3: Durable coordinator and private runtime

**Files:** migration 0020_autonomous_ai_runs.sql; modules/ai-review/run-autonomous-review.ts; queue/ai-review-worker.ts; ai-automation-config.ts; ai-automation-worker.ts; test/ai-review-runtime.test.ts.

**Interfaces:** processAutonomousReviewTick(pool,{provider,model,now}) reserves one current candidate, persists provider outcome, completes review, evaluates eligibility and calls publishCandidateRevision.

- [ ] Write tests for concurrent reservations, four daily calls, unchanged input replay, interrupted publication resumption, and uncertain provider calls.
- [ ] Persist request/reservation before network I/O. Persist validated response before review/publication. Reuse run-derived IDs and timestamps on retries.
- [ ] Add separate hourly scheduler, disabled by default; remove it when disabled. Enabled runtime requires provider configuration and activates versioned AI policy.
- [ ] Confirm no stale or held review can become a public version.

### Task 4: Release and operating instructions

**Files:** docs/runbooks/autonomous-ai-publication.md; deployment environment example; relevant delivery contract tests.

- [ ] Document activation, daily bounds, status queries, uncertain calls, disable and rollback.
- [ ] Run backend typecheck and database suites, frontend contracts/build and diff checks.
- [ ] Review the full diff, create a PR, verify required checks, and release the disabled capability under the owner's delegation.
- [ ] Activate only after OpenAI connection succeeds, then verify a real scheduler run and public API result.
