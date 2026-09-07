# Sprint 9D — Human Review CLI Design

**Date:** 2026-09-05  
**Status:** Draft — awaiting product-owner approval  
**Base:** Sprint 9C implementation head `b3cecd8`  
**Scope:** Internal CLI completion of one current Human Review

## 1. Goal

Give an authorized reviewer one safe, repeatable command for completing the
Human Review of a current CandidateRevision. The command must use the existing
trust authority, preserve immutable review/quorum history, and make no new
mutation surface available to the operator HTTP runtime or public web app.

The Sprint 9D authority graph remains:

`current review queue -> internal CLI -> completeHumanReview -> audit/outbox/quorum`

The CLI is a write boundary for Human Review only. It cannot edit Evidence,
CandidateRevision, Moderation, Eligibility, Publication, or source data.

## 2. Locked inputs

Sprint 9D preserves the approved baseline and existing Sprint 3B–9C
invariants:

- PostgreSQL is authoritative; Redis/BullMQ is not a trust input.
- `completeHumanReview` is the only Human Review completion authority.
- Valid outcomes are `confirmed`, `changes_requested`, and `declined`.
- `permissionUsed` is always `reviewer`.
- Human Review snapshots, reviews, quorum evaluations, audit events, outbox
  events, and idempotency results are immutable or append-only as already
  implemented.
- CandidateRevision, Claim-set, Evidence, policy, and provenance identities
  are exact and revision-pinned.
- AI-origin candidates still require the existing review policy to permit the
  provenance and the existing confirmed-review quorum to be satisfied.
- The Sprint 9C operator runtime remains read-only and loopback-only.

## 3. Scope

### Included

- `human-review:complete` backend CLI entrypoint and package script;
- bounded argument parsing and canonical UUID/text validation;
- server-side resolution of CandidateRevision ownership and the active
  candidate-revision review policy;
- an active-policy/currentness guard in the Human Review authority path;
- generated review, snapshot, quorum-evaluation, and correlation IDs where
  the caller did not supply them;
- stable JSON success output and sanitized non-zero failures;
- idempotency, duplicate-review, stale-input, concurrency, and authority
  isolation tests;
- a reviewer runbook documenting the command, exit codes, and rollback-free
  retry behavior;
- a deployment-free CI gate for the CLI contract and trust-layer regression.

### Excluded

- HTTP, browser, operator UI, SSO, session, cookie, token, mTLS, or identity
  provider integration;
- reviewer assignment, pending/in-progress review state, comments, or
  reviewer management;
- direct SQL/admin commands that bypass `completeHumanReview`;
- Evidence or Claim mutation, refresh, reassociation, or reevaluation;
- Moderation, Eligibility, Publication, rollback, or retraction actions;
- schema migration, new trust tables, scheduler, worker, or Redis dependency;
- public Railway route, Caddy route, Next.js bundle, or production deployment;
- historical-policy override or historical CandidateRevision review.

## 4. Approach decision

### Selected — private CLI adapter over the existing authority

Add a small adapter at `backend/src/human-review-cli.ts`. It accepts only the
reviewer-facing fields, resolves the candidate and active review policy, then
constructs the exact `CompleteHumanReviewCommand` expected by
`completeHumanReview`. Generated IDs are created in the adapter; callers cannot
choose policy, permission, candidate ownership, or internal record IDs.

`completeHumanReview` must verify that the supplied policy revision is still
the single active policy for `candidate_revision` after it locks the candidate
authority. A policy change between CLI resolution and the write therefore
fails closed instead of recording against a stale policy.

The adapter remains a process-local backend command. It is not imported by the
operator HTTP runtime and is not registered as a web route.

### Rejected — authenticated operator HTTP/UI mutation

This would require an identity/session and CSRF/mTLS design, expand the
operator trust boundary, and mix write authority into a runtime deliberately
kept read-only by Sprint 9C.

### Rejected — direct SQL/admin script

Direct SQL would bypass command normalization, snapshot resolution, quorum
membership, audit, outbox, and idempotency guarantees.

## 5. Command contract

```text
pnpm --filter backend human-review:complete \
  --candidate-revision-id <UUID> \
  --actor-id <reviewer-id> \
  --outcome confirmed|changes_requested|declined \
  --reason "<bounded reason>" \
  --idempotency-key <bounded key> \
  [--correlation-id <UUID-or-bounded-id>]
```

Required values are parsed exactly once. Unknown, duplicated, missing, or
empty flags fail before a database connection is used. `--reason` is bounded
to the same 1,024-character contract as the authority command. Actor and
correlation identifiers use the existing bounded printable-text contract.

The CLI does not accept `candidate-id`, `review-policy-revision-id`,
`review-input-snapshot-id`, `human-review-id`, `review-quorum-evaluation-id`,
or `permission-used`. This prevents a caller from selecting an unrelated
candidate, historical policy, or precomputed trust record.

## 6. Transaction and currentness flow

1. Parse/validate arguments and normalize the outcome.
2. Resolve `candidate_id` from the requested CandidateRevision and resolve the
   single active `review_policy_revision_id` for scope `candidate_revision`.
3. Derive UUIDs for the Human Review, review input snapshot, quorum evaluation,
   and default correlation ID from the idempotency key; set the canonical UTC
   completion timestamp. The identifiers are internal and are never caller
   supplied.
4. Call `completeHumanReview` with `permissionUsed: 'reviewer'`.
5. Inside its existing write transaction, reserve/replay the CLI idempotency
   receipt before currentness checks. For a new receipt, lock the catalog patch
   and active catalog/policy pointers through commit, lock CandidateRevision
   authority, verify candidate ownership, and re-check that the policy ID is
   still the active candidate-revision policy. Any mismatch returns
   `REVIEW_INPUT_STALE`.
6. Reuse the existing snapshot resolver, idempotency replay, duplicate
   reviewer constraint, quorum count, current quorum pointer, audit, and
   `HumanReviewCompleted` outbox behavior.
7. Return a closed JSON result; never return raw database errors.

The idempotency key is evaluated by the existing command payload hash. A retry
with the same key and payload is exit-code 0 with `replayed: true`; a different
payload using the same key remains rejected by the existing idempotency guard.

## 7. Output and errors

Successful output is one JSON object containing only:

```json
{
  "candidateRevisionId": "<UUID>",
  "humanReviewId": "<UUID>",
  "outcome": "confirmed",
  "confirmedReviewerCount": 1,
  "requiredConfirmedReviews": 1,
  "quorumSatisfied": true,
  "replayed": false
}
```

`inputHash` and `quorumEvaluationId` may remain internal unless the final CLI
contract test demonstrates a concrete operator need for them. Actor ID,
reason, correlation ID, SQL, connection details, raw constraint text, and
stack traces are never printed.

Stable exit codes:

| Condition | Code |
| --- | ---: |
| Completed or idempotent replay | 0 |
| Invalid command arguments | 2 |
| Stale revision, inactive policy, invalid authority graph, or stale input | 3 |
| Same reviewer already completed this revision | 4 |
| Database/service unavailable | 5 |

The CLI writes machine-readable JSON to stdout on success and a sanitized,
stable error code/message to stderr on failure.

## 8. Security and authority boundaries

- The CLI requires the existing backend database credential and is intended
  for an authorized operator host/process; this is the explicit Sprint 9D
  trust boundary until an identity provider is approved.
- `actorId` is audit identity, not an authorization mechanism. Operational
  access to the binary and database remains restricted outside the repository.
- No public route, CORS allowance, browser storage, cookie, token, or network
  listener is introduced.
- The operator authority isolation test must continue to reject imports of
  `complete-human-review` and all write routes.
- The CLI must not be included in the frontend build or public deployment
  artifact.
- Logs and errors must not reveal secrets or raw PostgreSQL diagnostics.

## 9. Test matrix

### CLI contract

- required/optional flags, duplicate/unknown flags, invalid UUIDs, invalid
  outcome, bounded text, and empty values;
- canonical JSON output and each stable exit code;
- sanitized errors with no stack trace or secret.

### Trust integration

- successful completion for each outcome;
- active policy resolution and policy-change race rejected;
- candidate/revision mismatch rejected;
- stale/superseded/inactive revision rejected;
- same idempotency key replayed without duplicate rows;
- same reviewer duplicate rejected;
- second distinct reviewer updates quorum correctly;
- concurrent completions preserve both reviews and a valid quorum;
- audit, outbox, idempotency, review snapshot, and quorum rows commit
  atomically;
- Human Review does not mutate Evidence, CandidateRevision, Publication, or
  operator read state.

### Boundary and repository contracts

- operator-authority isolation remains green;
- no new HTTP mutation route or public bundle reference;
- package script invokes only the CLI adapter;
- backend trust and full repository quality gates pass.

## 10. Acceptance criteria

Sprint 9D is complete only when:

1. An authorized reviewer can complete a current review with one CLI command.
2. The command delegates to `completeHumanReview`; no alternate write path
   exists.
3. Current policy/revision checks fail closed under a race.
4. Retry is idempotent and duplicate reviewer completion is rejected.
5. Audit, outbox, snapshot, quorum, and idempotency invariants remain intact.
6. The operator HTTP surface and public web app remain read-only.
7. Tests, runbook, stable exit codes, and sanitized output are present.

## 11. Operational notes

The runbook will show how to obtain a current CandidateRevision from the
read-only review queue/dossier, execute the command, interpret the JSON result,
retry safely, and escalate exit codes 3–5. There is no rollback command:
Human Review history is append-only; a correction is a new valid review under
the current policy and a new idempotency key.

No production deployment is part of Sprint 9D. Release remains a separate
approval after the implementation branch passes its verification gate.
