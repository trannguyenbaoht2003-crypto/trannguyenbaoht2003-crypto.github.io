# Guarded AI Discovery — Sprint 8A Runbook

## Purpose

Sprint 8A provides a provider-independent authority boundary for recording AI discovery runs, storing immutable candidate proposals, and materializing an explicitly selected proposal into the existing Candidate Registry.

**AI output is not Evidence.** A model/provider result is advisory input only. It never satisfies Evidence, HumanReview, Moderation, Eligibility, or Publication authority by itself.

**Materialization is not approval.** Materialization only places a proposal into the governed Candidate Registry with provenance origin `ai_generated`. The normal trust pipeline remains mandatory afterwards.

## Authority flow

```text
governed input fingerprint
  -> AI discovery run
  -> immutable AI candidate proposal
  -> explicit materialization
  -> existing Candidate Registry (ai_generated)
  -> existing Evidence
  -> existing HumanReview
  -> existing Moderation
  -> existing Eligibility
  -> existing Publication authority
```

There is no shortcut around these stages.

## Provider boundary

**No live provider is connected in Sprint 8A.** The repository contains no OpenAI, Anthropic, Gemini, or other model-provider SDK, no provider HTTP invocation, and no API-key configuration for AI discovery.

The command `recordAiDiscoveryRun()` records already-produced, provider-neutral metadata:

- provider key and model identity;
- model revision;
- prompt-template key and version;
- SHA-256 input and output hashes;
- completed/failed status and timestamps;
- bounded candidate proposals.

Raw provider output is not stored by the 8A authority and is never copied into audit or outbox events. A later sprint may connect a live provider only through a separately reviewed execution boundary.

## Proposal identity

`proposal_hash` is computed server-side from the canonical candidate selection only:

```json
{
  "schemaVersion": 1,
  "patchKey": "...",
  "gameModeExternalId": "aram_mayhem",
  "subjectExternalId": "...",
  "augmentExternalIds": ["..."],
  "itemExternalIds": ["..."]
}
```

Proposal UUID, ordinal, rationale, provider/model metadata, and timestamps are excluded. Therefore explanatory text cannot change candidate identity, while any selection change changes the hash.

## Reserved AI source

Materialization uses the reserved source `ai-discovery` only. Its active policy must remain exactly:

- source status: `active`;
- storage permission: `aggregate_only`;
- `collector_enabled=false`;
- source-policy revision 1 created for synthetic AI proposal materialization.

If that source or policy becomes missing, replaced, or unsafe, materialization fails closed. The reserved source is not a network collector.

## Materialization and convergence

`materializeAiCandidateProposal()` performs one PostgreSQL transaction.

It:

1. validates and claims its idempotency key;
2. locks the proposal and requires a completed parent run;
3. locks the canonical `proposal_hash` to prevent duplicate concurrent AI graphs;
4. verifies the reserved source policy;
5. reuses an existing exact AI-generated graph for the same proposal hash and normalization snapshot when present;
6. otherwise creates one synthetic raw observation and calls the existing `registerNormalizedObservationInTransaction()` Candidate Registry boundary;
7. verifies provenance is `ai_generated`;
8. stores one immutable materialization proof for the selected proposal;
9. emits sanitized audit/outbox records.

AI-specific code does not insert/update/delete `candidates`, `candidate_revisions`, `normalized_observations`, or `candidate_provenance` directly.

Two proposals with identical canonical selections converge to the same AI-generated authority graph while preserving separate immutable proposal materialization proofs.

## Replay and conflict behavior

- same idempotency key + same canonical command -> replay / duplicate-noop;
- same idempotency key + different payload -> fail closed;
- duplicate/conflicting run key -> fail closed;
- invalid patch/catalog/entity selection -> Candidate Registry rejects and the entire materialization transaction rolls back;
- failed discovery runs cannot own proposals;
- a proposal can be materialized at most once;
- database failure leaves no partial AI run/proposal/materialization graph.

## Reading proposals

`readAiDiscoveryProposals()` is an internal PostgreSQL read boundary only. It supports:

- `pending` proposals (default);
- `materialized` proposals;
- `all` proposals;
- bounded limit `1..100`.

Sprint 8A adds no public Fastify/Next route and does not expose rationale or proposal data through the public gateway.

## Trust and publication safety

After materialization, the CandidateRevision is still only a candidate. Existing authorities remain mandatory:

- Claims must be defined and sealed.
- Evidence decisions must come from the existing Evidence authority.
- HumanReview must reach its current quorum and confirmation requirements.
- Moderation must be current and non-blocking.
- Eligibility must be current and eligible.
- Publication mutations remain exclusive to Publication authority.

AI run/proposal/materialization rows do not activate an Eligibility policy and cannot make a CandidateRevision eligible by themselves.

## Runtime/dependency boundary

Sprint 8A deliberately has:

- no provider SDK;
- no provider HTTP/fetch call;
- no AI API secret;
- no AI Redis/BullMQ queue or worker;
- no browser credential;
- no public AI endpoint;
- no CORS expansion;
- no Caddy AI route;
- no Railway AI service.

AI discovery failure therefore does not affect public read availability.

## Verification

Repository contract:

```bash
npm run test:guarded-ai-discovery
```

Backend verification:

```bash
npm --prefix backend run typecheck
npm --prefix backend test
npm --prefix backend run build
```

The dedicated Sprint 8A CI gate must additionally preserve repository cleanliness and the existing deployment guard.

## Production boundary

**Production deployment is out of scope for Sprint 8A.** This sprint does not provision a provider credential, enable production AI execution, create a Railway service, or change Issue #23 production bootstrap status.

A future provider integration must be separately designed and verified before any live model invocation is allowed.