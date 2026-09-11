# Autonomous AI review and publication

This runbook covers the private autonomous worker that reviews source-backed
CandidateRevisions and, only when every existing trust gate passes, publishes
through the existing publication authority. It does not add a public AI route,
frontend key, or direct database publication path.

## Authority and evidence

The worker asks one narrow factual question: whether the exact champion,
augment, and item selection appears in the supplied normalized community
reports. It does not establish win rate, effectiveness, or official
endorsement. The model receives bounded structured observations, not original
page HTML, transcripts, private metadata, or a browsing tool.

Preparation requires a current active patch and catalog, the latest matching
CandidateRevision, an exact champion and selection, and current public reports
from at least two permitted site groups. Bilibili, Douyin, Zhihu, Baidu Tieba,
and lolhaidou.cn are permitted; subdomains of one site count as one group.
URLs are HTTPS, have no credentials or custom ports, and are normalized to
remove fragments and tracking parameters. AI-generated provenance is not
evidence.

The worker holds missing, stale, malformed, unsupported, or contradictory
inputs. It may seal only the narrow `ai-community-report-v1` claim when the
CandidateRevision has no claim set; it never overwrites a contradicted owned
decision or fabricates evidence. A model score alone cannot authorize a
publication.

AI reviews are written to `ai_reviews` with immutable input, policy, model,
prompt, request, response, provider-response, and outcome bindings. They are
never inserted into `human_reviews`; the human policy remains separate. The
existing moderation, eligibility, evidence, publication, audit, and rollback
services remain authoritative.

## Modes and inert production defaults

Discovery and autonomous publication are independent modes:

```text
AI_DISCOVERY_SCHEDULER_ENABLED=false
AI_AUTONOMOUS_PUBLICATION_ENABLED=false
```

The production reference environment intentionally contains no provider key,
model, or endpoint. Autonomous activation additionally requires the private
`ai-automation` service to receive `OPENAI_API_KEY` and
`AI_AUTONOMOUS_OPENAI_MODEL` through deployment-platform secret controls. The
OpenAI endpoint is fixed; there is no autonomous endpoint override. Never put
these values in the repository, frontend, logs, PR evidence, or command-line
arguments.

When autonomous mode is disabled, startup creates no AI policy, reserves no
provider request, and cannot publish. The private worker may still reconcile
the disabled scheduler and reject injected jobs. The disabled marker is emitted
only when both discovery and autonomous modes are disabled.

## Queue, limits, and journal

The private BullMQ queue is `hai-dau-ai-review-v1`, with scheduler
`ai-review-hourly-v1`, job name `scheduled-ai-review`, and exact data
`{"schemaVersion":1}`. It uses one attempt and worker concurrency one.
PostgreSQL reservations enforce at most one new provider request per UTC hour
and four per UTC day across workers and restarts. Requests and responses remain
bounded by the provider adapter.

`autonomous_ai_review_runs` persists the UUID-v4 run identity, UTC slot,
budget day, candidate/policy identity, input and request hashes, request,
publication head, response, provider response identifier/hash, terminal state,
failure code, and publication version. SQL guards reject identity mutation,
illegal transitions, response replacement, and deletion. A rotating bounded
scan advances past unpreparable candidates so one bad prefix cannot starve the
queue.

## Recovery semantics

The request reservation and immutable request are persisted before network I/O.
Only the process that atomically claims `reserved -> in_flight` calls the
provider. Authentication/rate-limit errors are recorded with sanitized failure
codes; network, timeout, and 5xx uncertainty is not automatically replayed.
The in-flight timeout is measured from the persisted ownership timestamp and is
longer than the provider's 60-second maximum.

A crash with a stored `responded` result resumes from that result without a
second paid call. Downstream command IDs and timestamps derive from the run;
receipts are replayed before currentness checks. A completed publication receipt
is verified against its candidate and immutable publication version before the
journal is marked published. Changed policy, evidence, moderation, eligibility,
candidate input, or publication head causes a hold rather than inventing a new
expected state. Database failures leave the stored response resumable.

## Policy bootstrap and publication path

Only explicitly enabled startup calls `ensureAutonomousReviewPolicy`. It
registers deterministic versioned AI review and eligibility policies, reuses
active evidence/moderation policies when available, and activates the AI
eligibility policy with compare-and-swap while preserving prior history. A
model change creates a new policy identity; an ordinary tick never silently
reactivates a manually changed policy.

For a confirmed response the worker records AI moderation, evaluates existing
eligibility, and calls `publishCandidateRevision` only with
`actorId: system:ai-reviewer` and the existing publisher permission. Held,
changed-request, declined, stale, and contradicted outcomes never publish.
There are zero human reviews in this path. Publication versions remain
immutable and the public read path continues to read PostgreSQL directly.

## Private status

After building the backend, run the read-only status command in the private
service environment:

```sh
npm --prefix backend run ai-autonomous:status
```

It requires `DATABASE_URL`; `AI_AUTONOMOUS_PUBLICATION_ENABLED`, when supplied,
must be exactly `true` or `false`. It does not require a provider key or Redis.
The output contains enabled state, `inputState`, active-catalog and current
CandidateRevision counts, UTC budget usage, and recent run IDs/times/outcomes,
safe failure codes, and publication version IDs. It never prints prompts,
responses, keys, or connection strings.

`inputState` is `MISSING_ACTIVE_CATALOG`, `EMPTY_CANDIDATE_INPUT`, or
`STRUCTURAL_INPUT_PRESENT`. Catalog counts are restricted to active patch
lifecycle rows, and candidates to current revisions under the active catalog.
These structural counts do not prove source eligibility or a live publication.

## Production input prerequisites

The latest read-only production preflight recorded 140 raw observations at the
repository baseline patch `16.14`, zero normalized observations, zero
CandidateRevisions, zero publication versions, no patch/catalog/entity rows,
and 420 failed normalization attempts. This is an input blocker, not a reason
to seed a publication.

Create a genuine versioned `CatalogSnapshotV1` containing the actual
champion/item/augment/mode entities and selection rules. Use the existing
authorities in this order: `registerPatchEvent`, `importCatalogRevision`,
`validateCatalogRevision` with `validatorRulesetVersion: catalog-rules-v1`,
then `activateCatalogRevision` with the exact
`expectedCurrentCatalogRevisionId`. Keep source policy, source digest, and
patch provenance intact. Do not use rehearsal fixtures, directly insert a
Publication, or relabel old observations as a newer patch. A real first run
may correctly hold with no current sources; that is not successful AI
publication.

OpenAI Platform key creation and target discovery were rejected during the
implementation preflight, so no key or real model call exists. The current
Neon AI Gateway project/region is not a ready substitute. Re-verify both
dependencies before activation.

## Disable, restart, and rollback

Set `AI_AUTONOMOUS_PUBLICATION_ENABLED=false` and redeploy the private service
to stop new autonomous reservations and remove its scheduler. Graceful
shutdown closes workers before queues and connections and may wait for a call
already in progress; forced termination leaves journal rows for the recovery
rules above. Do not delete journal history or automatically retry uncertain
calls.

To reverse authority, use the existing compare-and-swap policy activation
service with its exact expected-current policy. To roll back a publication, use
the existing `rollbackPublication` authority and immutable activation history.
Never edit a Publication row directly or invent a CLI command. A changed
authority causes interrupted autonomous work to hold; it does not silently
reactivate on every tick.

## Delivery boundary

Repository CI can establish `AI_AUTOMATION_PRODUCTION_REPO_READY` for the
versioned, private, disabled package. A real deployment must still use the
exact-SHA production release gate, exact Railway deployment IDs, the existing
disabled marker, and public smoke checks. Those checks do not create an OpenAI
credential and do not prove a provider completion.

