# Human Review CLI Runbook

Sprint 9D provides a private backend command for completing one current
CandidateRevision review. It is an adapter over the existing
`completeHumanReview` trust authority. It is not an HTTP endpoint, browser
control, operator-console action, direct SQL script, or public Railway route.

## Trust boundary

Run the command only from an authorized private backend host/process that is
already permitted to use the backend `DATABASE_URL`. `--actor-id` identifies
the reviewer in the immutable audit event; it is not an authentication or
authorization mechanism. Do not expose the command through Caddy, Railway,
the public Next application, or the Sprint 9C loopback-only operator server.

The command cannot edit Evidence, CandidateRevision, Moderation, Eligibility,
Publication, or source data. Successful completion writes the existing Human
Review snapshot, review, quorum evaluation, audit event, outbox event, and
idempotency result in one PostgreSQL transaction.

## Before running

1. Open the read-only candidate review queue or dossier and copy the current
   canonical `candidateRevisionId`.
2. Confirm that the item is still current: active catalog, latest revision,
   sealed Claim set, and unresolved active review policy.
3. Choose a unique idempotency key for this review attempt. Keep it unchanged
   if the command must be retried.
4. Record the reviewer identity and a concise reason. Do not put secrets,
   credentials, raw source content, or provider output in the reason.

## Command

From the backend package directory:

```bash
DATABASE_URL='postgres://...' \
  pnpm human-review:complete \
  --candidate-revision-id '<UUID>' \
  --actor-id '<reviewer-id>' \
  --outcome confirmed \
  --reason 'Evidence reviewed against the current dossier' \
  --idempotency-key 'human-review-<unique-key>' \
  [--correlation-id '<bounded-id>']
```

The required outcomes are `confirmed`, `changes_requested`, and `declined`.
The command resolves candidate ownership and the active review policy itself;
do not pass candidate ID, policy ID, permission, snapshot ID, review ID, or
quorum-evaluation ID. `permissionUsed` is fixed to `reviewer`.

## Successful output

Success writes one JSON object to stdout and no diagnostic text:

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

`replayed: true` means the same idempotency key and exact command payload had
already committed. It does not create another review, quorum evaluation,
audit event, or outbox event.

The adapter derives its internal review, snapshot, and quorum identifiers from
the idempotency key. This makes an acknowledgement retry address the same
receipt even when the current catalog or policy pointer has moved. The trust
authority still checks those pointers for a new write and rejects a stale
revision before any review row is committed.

## Exit codes and response

| Exit code | Meaning | Action |
| ---: | --- | --- |
| 0 | Completed or idempotent replay | Record the JSON result. |
| 2 | Invalid flags, value bounds, outcome, UUID, or `DATABASE_URL` | Correct the command; do not retry unchanged. |
| 3 | Revision/policy is stale or the authority graph is invalid | Refresh the queue/dossier and inspect the current policy before starting a new review. |
| 4 | This reviewer already completed the same current input | Do not retry with the same reviewer; inspect the existing review history. |
| 5 | Database or service unavailable | Verify private connectivity and retry with the same idempotency key after service recovery. |

Errors are sanitized stable codes on stderr. They never include SQL, stack
traces, connection strings, actor IDs, reasons, correlation IDs, or secrets.

## Retry and correction

Retry an uncertain acknowledgement with the exact same flags and idempotency
key. A different payload under the same key remains rejected by the existing
idempotency guard. If the policy or revision is stale, obtain a new current
revision context before retrying. There is no rollback command: Human Review
history is append-only, and a correction requires a new valid review under the
current policy and a new idempotency key, normally by another authorized
reviewer when the duplicate-review constraint applies.

## Prohibited operations

- Do not insert or update Human Review tables with `psql` or an ad-hoc script.
- Do not add a POST/PUT/PATCH/DELETE operator route or browser mutation button.
- Do not expose `human-review:complete` as a Railway service, Caddy route, or
  public Next bundle.
- Do not paste raw page text, credentials, provider responses, or secrets into
  the command reason or shell history.
