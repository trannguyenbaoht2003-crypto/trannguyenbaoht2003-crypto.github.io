# Sprint 1B-C Evidence Bundle v2 Implementation Plan

> **For agentic workers:** Execute inline with TDD. Do not change domain invariants, select a backend, merge `main`, or deploy production.

**Goal:** Replace self-declared evidence with independently validated, state-backed evidence for both correctness adapters.

**Architecture:** The common harness owns a platform-neutral recorder and validator. Each platform materializes the deterministic fixture as addressable rows, instruments the existing S1–S24 tests, and generates its bundle only from the JUnit result plus recorded state transitions.

**Tech Stack:** Node.js 22 test runner, D1/Miniflare, Fastify, PostgreSQL 17, BullMQ 5, Redis 7, GitHub Actions.

## Global Constraints

- Both platforms use the same Common Harness v2 commit and fixture checksum.
- Scenario status comes from the JUnit runner, never a static `PASS`.
- Every scenario has a correlated before/after state checksum and test case.
- F01–F12 have timestamps, scenario correlation, and before/after checksums.
- The fixture is materialized as individually countable records.
- AI candidates still require completed and confirmed human review.
- Missing moderation remains `needs_review`.
- Publication cannot bypass Evidence, Moderation, AI review, or publisher authority.
- Publication versions remain immutable.
- No production credentials, migrations, deployment, merge, or platform selection.

### Task 1: Common recorder and validator

**Files:**
- Create: `spikes/backend-correctness/common/evidence-recorder.mjs`
- Create: `spikes/backend-correctness/common/evidence-validator.mjs`
- Create: `spikes/backend-correctness/common/evidence-v2.test.mjs`
- Modify: `spikes/backend-correctness/common/evidence-schema.mjs`
- Modify: `spikes/backend-correctness/common/generate-fixture.mjs`

- [ ] Write tests that reject static scenario PASS rows, repeated uncorrelated checksums, missing materialized fixture counts, and failure rows without timestamps/state.
- [ ] Run the tests and confirm the expected failures.
- [ ] Implement recorder, JUnit parser, bundle validator, and fixture v2 fields.
- [ ] Run the common suite and confirm all tests pass.

### Task 2: Platform A evidence integration

**Files:**
- Modify: `spikes/backend-correctness/platform-a-cloudflare/domain-worker.mjs`
- Modify: `spikes/backend-correctness/platform-a-cloudflare/adapter.mjs`
- Modify: `spikes/backend-correctness/platform-a-cloudflare/platform-a.correctness.test.mjs`
- Replace: `spikes/backend-correctness/platform-a-cloudflare/generate-evidence.mjs`
- Modify: `.github/workflows/spike-1b-cloudflare-correctness.yml`

- [ ] Add regression tests for row-level fixture materialization.
- [ ] Materialize fixture arrays in D1 and expose grouped counts.
- [ ] Record S1–S24 state traces during the JUnit run.
- [ ] Generate and validate bundle v2 from JUnit and trace.
- [ ] Run the full suite three times and upload the validated artifact.

### Task 3: Platform B evidence integration

**Files:**
- Modify: `spikes/backend-correctness/platform-b-postgres-bullmq/domain.mjs`
- Modify: `spikes/backend-correctness/platform-b-postgres-bullmq/adapter.mjs`
- Modify: `spikes/backend-correctness/platform-b-postgres-bullmq/platform-b.correctness.test.mjs`
- Replace: `spikes/backend-correctness/platform-b-postgres-bullmq/generate-evidence.mjs`
- Modify: `.github/workflows/spike-1b-postgres-bullmq-correctness.yml`

- [ ] Apply the same regression assertions and recorder contract.
- [ ] Materialize fixture arrays in PostgreSQL and expose grouped counts.
- [ ] Generate and validate bundle v2 using the same common validator.
- [ ] Run the full suite three times with isolated PostgreSQL/Redis services.

### Task 4: Cross-platform audit

- [ ] Confirm Common Harness SHA and fixture checksum match.
- [ ] Confirm 24 runner-backed scenario rows and 12 state-backed failure rows per bundle.
- [ ] Confirm restore counts/checksum, audit coverage, outbox consistency, duplicate effects, and immutable versions.
- [ ] Report PASS/FAIL per platform without selecting the production backend.
