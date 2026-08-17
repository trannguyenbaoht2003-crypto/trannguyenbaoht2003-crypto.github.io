# Sprint 8A — Materialization Convergence Amendment

**Status:** self-approved under standing project delegation  
**Applies to:** `2026-08-17-guarded-ai-discovery-design.md` §5.3 and §7

## Reason

The existing Candidate Registry intentionally converges identical semantic signatures to one Candidate/CandidateRevision while allowing multiple provenance observations. The initial 8A draft made `raw_observation_id`, `normalized_observation_id`, and `candidate_provenance_id` unique in `ai_candidate_materializations` and exposed caller-supplied graph IDs. That would force duplicate AI proposals with the same canonical selection to manufacture parallel authority graphs or require callers to predict internal registry IDs.

## Revised invariant

`ai_candidate_proposal_id` remains unique: one proposal can be materialized at most once.

The following materialization columns are **not unique**:

- `raw_observation_id`;
- `normalized_observation_id`;
- `candidate_provenance_id`.

Multiple proposal materialization proofs may reference the same exact AI-generated authority graph when their canonical `proposal_hash` and normalization snapshot are identical.

## Revised command

```ts
{
  actorId: string;
  aiCandidateMaterializationId: string;
  aiCandidateProposalId: string;
  correlationId: string;
  idempotencyKey: string;
  reason: string;
  materializedAt: string;
}
```

Graph UUIDs are internal implementation details and are generated only when no canonical AI graph exists.

## Convergence algorithm

Inside one PostgreSQL transaction:

1. claim idempotency scope `ai.candidate.proposal.materialize`;
2. lock the proposal and completed parent run;
3. acquire transaction advisory lock keyed by `proposal_hash`;
4. validate the reserved `ai-discovery` source and active policy are exactly `aggregate_only` + `collector_enabled=false`;
5. search for an existing AI synthetic raw observation with:
   - reserved source and active safe policy;
   - `adapter_version='ai-discovery-proposal-v1'`;
   - `content_hash=proposal_hash`;
   - exact canonical normalization snapshot in aggregate metadata;
   - linked normalized observation + `candidate_provenance.origin='ai_generated'`;
6. if found, reuse that exact graph;
7. otherwise generate internal UUIDs, insert one synthetic raw observation and invoke `registerNormalizedObservationInTransaction()`;
8. insert one immutable materialization proof for the current proposal referencing the resolved graph;
9. emit sanitized AI materialization audit/outbox records and complete idempotency.

The advisory lock prevents concurrent identical proposal materializations from creating duplicate AI synthetic graphs.

## Graph integrity

The database materialization trigger must additionally verify:

- linked raw observation belongs to `source_key='ai-discovery'`;
- linked source policy is `aggregate_only` and collector-disabled;
- raw adapter is `ai-discovery-proposal-v1`;
- raw `content_hash` equals the linked proposal `proposal_hash`;
- normalized observation points to that raw observation;
- provenance points to that normalized observation and candidate revision;
- provenance origin is `ai_generated`;
- candidate revision points to the linked candidate.

## Safety consequence

This amendment does not broaden AI authority. It removes caller control over Candidate Registry graph IDs and strengthens deterministic convergence. Evidence, HumanReview, Moderation, Eligibility and Publication gates remain unchanged.