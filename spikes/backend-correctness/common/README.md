# Sprint 1B.0 — Common Correctness Harness

Platform-independent harness for Backend Platform Correctness Spike.

## Locked semantics

- Evidence decisions are claim-level.
- Missing moderation decision maps to `needs_review`; there is no implicit `clear`.
- AI-generated candidates require a completed, confirmed human review.
- Candidate fingerprint excludes origin.
- Evidence decisions are not reused across patches.
- Publication versions are immutable.
- Candidate `monitoring` is a projection of `PublicationPublished`.
- T7 emits `EligibilityChanged` only when current eligibility changes.

## Scope

This directory contains deterministic fixture generation, semantic scenario definitions, canonical checksums, failure-point names, and evidence schemas. It contains no D1, PostgreSQL, queue, public API, migration, or production deployment implementation.

## Commands

```bash
node spikes/backend-correctness/common/generate-fixture.mjs
node --test spikes/backend-correctness/common/common-harness.test.mjs
```

Generated artifacts are written to `spikes/backend-correctness/common/generated/` and are ignored by the test contract as source files.
