# Sprint 5D Domain Clarification — Publication Version Rehearsal

## Why this clarification exists

Implementation discovery confirmed an existing domain invariant that the original Sprint 5D design did not account for: Candidate identity includes the normalized build signature. Changing augment or item selections therefore creates a different Candidate identity. Publication identity is bound to one Candidate, and the existing publication command rejects a Candidate mismatch.

This clarification narrows Sprint 5D without changing the product/domain architecture. It supersedes only the original requirement that PublicationVersion 1 and PublicationVersion 2 of one Publication should contain visibly different build payloads.

## Correct rehearsal model

The release rehearsal keeps one deterministic Candidate and one deterministic CandidateRevision with a frontend-mappable Samira build:

- champion: `samira`;
- augment: `1194`;
- items: `3006`, `6672`.

The sequence is:

1. publish PublicationVersion 1 from the eligible CandidateRevision;
2. publish PublicationVersion 2 from the same authoritative CandidateRevision using a new immutable version ID and activation;
3. verify that the public reader exposes `versionNumber: 2` while the authority-derived payload remains identical to V1;
4. rollback the active pointer to PublicationVersion 1;
5. verify that the public reader exposes `versionNumber: 1` again while both immutable versions remain stored.

The browser E2E distinguishes V1 and V2 by the existing public metadata (`Phiên bản 1` / `Phiên bản 2`) rather than by changing the build.

## Invariants preserved

- No Candidate fingerprint or Publication identity rule is changed for a staging test.
- No caller-authored Publication payload is introduced.
- V2 is created only by `publishCandidateRevision`.
- Rollback is performed only by `rollbackPublication`.
- Publication payload remains derived from CandidateRevision authority.
- No direct Publication SQL is permitted in rehearsal code.
- The public HTTP surface remains read-only.

## Updated acceptance evidence

Sprint 5D must prove:

- V1 active and visible through API/browser;
- V2 active and visible as `versionNumber: 2` through API/browser;
- V1 and V2 have the same canonical authority-derived payload;
- rollback changes the active version back to V1 immediately;
- exactly two immutable PublicationVersions remain after rollback;
- outage/recovery preserves the rolled-back V1 active state.

All other Sprint 5D release-hardening requirements remain unchanged.