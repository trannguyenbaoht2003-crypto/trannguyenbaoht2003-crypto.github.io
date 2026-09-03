# Candidate Review Evidence Dossier Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement Sprint 9C as a loopback-only, read-only dossier that lets an operator inspect the governed Claims, current Evidence decisions, exact Evidence snapshot members, provenance, review progress, and persisted confidence for one current Sprint 9B queue item.

**Architecture:** Add a separate dossier reader and GET route beside the unchanged Sprint 9B queue. The reader revalidates queue eligibility inside one `REPEATABLE READ READ ONLY` PostgreSQL transaction, loads the header, Claims, current-decision Evidence, and provenance with explicit bounded queries, and maps them into a closed schema-version-1 DTO. The existing self-contained operator page opens the dossier from a queue card without gaining any mutation or deployment authority.

**Tech Stack:** Node.js 22.13+, TypeScript 5.9, Fastify 5, PostgreSQL 17, Node test runner, static HTML/CSS/JavaScript assets, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-09-03-candidate-review-evidence-dossier-design.md`

## Global Constraints

- Base every implementation change on `main@be5a76585467de2cc125147925cac57cf6a17dcd` plus the approved Sprint 9C spec and this plan.
- Keep the operator runtime loopback-only: `127.0.0.1`, `::1`, or `localhost`.
- Add no migration, public Next route, Caddy route, Railway service, secret, cookie, token, CORS rule, Redis/BullMQ dependency, worker, scheduler, audit write, or outbox event.
- Register only `GET /api/operator/v1/candidate-review-dossiers/:candidateRevisionId`; leave POST, PUT, PATCH, and DELETE unregistered.
- Revalidate active catalog, latest CandidateRevision, sealed Claim set, active review policy, and unresolved quorum inside the dossier transaction.
- Read only the Evidence associations belonging to each Claim's current decision input snapshot.
- Never select or return `raw_blob`, `aggregate_metadata`, `content_hash`, evaluator actor IDs, correlation IDs, audit payloads, AI run/proposal IDs, provider output, or AI rationale.
- Read persisted confidence only; never import or invoke `evaluateCandidateConfidence`.
- Never import or invoke HumanReview, Evidence, Claim, Moderation, Eligibility, Publication, rollback, feedback, monitoring, AI materialization, or other mutation commands.
- Map every outward field explicitly; never spread PostgreSQL rows or stored JSON into a response.
- Bound the dossier to 256 Claims, 64 Evidence associations per Claim, and 2,048 Evidence associations total; fail closed instead of truncating.
- Project only absolute HTTPS references allowed by the persisted source policy; render them with `target="_blank"`, `rel="noopener noreferrer"`, and `referrerpolicy="no-referrer"`.
- Preserve the Sprint 9B candidate queue and Sprint 7C publication snapshot contracts unchanged.
- Follow RED → GREEN → REFACTOR and commit after each independently testable task.

---

### Task 1: Closed dossier types and read-only reader

**Files:**

- Modify: `backend/src/modules/operator/types.ts`
- Create: `backend/src/modules/operator/read-candidate-review-dossier.ts`
- Create: `backend/test/operator-candidate-review-dossier.test.ts`

**Interfaces:**

- Consumes: `Pool`, active catalog/review-policy pointers, CandidateRevision/Claim seals, current review quorum, current confidence, current Claim Evidence decisions, immutable Evidence snapshot members, provenance, source policy, and raw-observation reference JSON.
- Produces: `readOperatorCandidateReviewDossier(pool, candidateRevisionId, options): Promise<OperatorCandidateReviewDossier | null>`.
- Produces: `OperatorCandidateReviewDossierOptions = { now?: Date }` and the closed dossier/source/reference/Claim/Evidence/provenance DTO types from the spec.
- `null` means the exact UUID is not a current readable Sprint 9B queue item; active-authority or stored-graph failures throw and are sanitized by the HTTP layer.

- [ ] **Step 1: Add fake-Pool fixtures and the failing happy-path reader test**

Create a fake `Pool` that records `{ sql, values }`, returns five result sets in order, and exposes `released()`. Use stable UUID constants and this outward assertion:

```ts
const dossier = await readOperatorCandidateReviewDossier(
  db.pool,
  IDS.candidateRevision,
  { now: new Date('2026-09-03T01:00:00.000Z') },
);

assert.ok(dossier);
assert.equal(dossier.schemaVersion, 1);
assert.equal(dossier.generatedAt, '2026-09-03T01:00:00.000Z');
assert.equal(dossier.candidate.candidateRevisionId, IDS.candidateRevision);
assert.deepEqual(dossier.review, {
  state: 'in_progress',
  confirmedCount: 1,
  requiredCount: 2,
});
assert.equal(dossier.confidence?.score, 80);
assert.equal(dossier.claimSet.claimCount, 2);
assert.equal(dossier.claims[0]?.claimKey, 'build');
assert.equal(dossier.claims[0]?.decision?.evidence.length, 1);
assert.equal(dossier.claims[1]?.decision, null);
assert.equal(dossier.provenance.length, 2);
assert.deepEqual(transactionBoundaries(db.calls), [
  'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
  'COMMIT',
]);
assert.equal(db.released(), 1);
```

The fixture must include one reference-only HTTPS Evidence row, one aggregate-only provenance row with `external_reference = null`, one scored confidence row, one decided Claim, and one undecided Claim.

- [ ] **Step 2: Run the focused test and capture RED**

Run:

```bash
cd backend
node --import tsx --test test/operator-candidate-review-dossier.test.ts
```

Expected: FAIL because the dossier module and DTO types do not exist.

- [ ] **Step 3: Add the closed DTO types**

Append the exact spec contracts to `backend/src/modules/operator/types.ts`. Define the reader options explicitly:

```ts
export type OperatorCandidateReviewDossierOptions = {
  now?: Date;
};

export type OperatorDossierReference = {
  url: string;
  platform: string | null;
  author: string | null;
  publishedAt: string | null;
  sourceContentId: string | null;
};

export type OperatorDossierSource = {
  sourceId: string;
  sourceKey: string;
  displayName: string;
  status: 'active' | 'suspended' | 'retired';
  sourcePolicyRevisionId: string;
  storagePermission: 'blob_allowed' | 'reference_only' | 'aggregate_only';
};
```

Add `OperatorCandidateReviewProvenance`, `OperatorCandidateReviewEvidence`, `OperatorCandidateReviewClaim`, and `OperatorCandidateReviewDossier` with property names and unions exactly matching section 6 of the spec. Reuse `OperatorCandidateConfidence`; do not create a second confidence shape.

- [ ] **Step 4: Add strict scalar, selection, confidence, source, and reference mapping**

In `read-candidate-review-dossier.ts`, define constants and validation helpers:

```ts
const MAX_CLAIMS = 256;
const MAX_EVIDENCE_PER_CLAIM = 64;
const MAX_TOTAL_EVIDENCE = 2_048;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function invalidRow(): never {
  throw new Error('OPERATOR_CANDIDATE_DOSSIER_ROW_INVALID');
}

function requireUuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) invalidRow();
  return value;
}

function requireIsoTimestamp(value: unknown): string {
  const parsed = value instanceof Date
    ? value
    : typeof value === 'string' ? new Date(value) : null;
  if (parsed === null || Number.isNaN(parsed.getTime())) invalidRow();
  const iso = parsed.toISOString();
  if (typeof value === 'string' && value !== iso) invalidRow();
  return iso;
}
```

Copy the closed candidate-selection and confidence validation semantics from `read-candidate-review-queue.ts`, including component-sum and score-band verification. Do not export or alter the queue's private helpers in this task.

Project references with an allowlist rather than object spread:

```ts
function mapReference(
  externalReference: unknown,
  storagePermission: OperatorDossierSource['storagePermission'],
  origin?: OperatorCandidateReviewProvenance['origin'],
): OperatorDossierReference | null {
  if (
    storagePermission === 'aggregate_only'
    || origin === 'ai_generated'
    || externalReference === null
    || typeof externalReference !== 'object'
    || Array.isArray(externalReference)
  ) return null;

  const value = externalReference as Record<string, unknown>;
  const url = boundedText(value.url, 2_048);
  if (url === null) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    return null;
  }
  const platform = optionalBoundedText(value.platform, 128);
  const author = optionalBoundedText(value.author, 256);
  const publishedAt = optionalPublishedAt(value.publishedAt);
  const sourceContentId = optionalBoundedText(value.sourceContentId, 256);
  if ([platform, author, publishedAt, sourceContentId].includes(INVALID)) {
    return null;
  }
  return { url: parsed.href, platform, author, publishedAt, sourceContentId };
}
```

Implement `boundedText` and `optionalBoundedText` with `Buffer.byteLength(value, 'utf8')`, not JavaScript character count. Use an internal sentinel so an absent optional value maps to `null` while a present invalid value invalidates the complete reference. `optionalPublishedAt` accepts only canonical ISO timestamps or exact `YYYY-MM-DD`. Require a 1–128-byte printable ASCII `sourceKey`, a 1–256-byte `displayName`, and exact source/status/storage-permission unions.

- [ ] **Step 5: Implement the transaction and active-policy query**

Use this public signature and transaction skeleton:

```ts
export async function readOperatorCandidateReviewDossier(
  pool: Pool,
  candidateRevisionId: string,
  options: OperatorCandidateReviewDossierOptions = {},
): Promise<OperatorCandidateReviewDossier | null> {
  if (!UUID_PATTERN.test(candidateRevisionId)) {
    throw new Error('OPERATOR_CANDIDATE_DOSSIER_ID_INVALID');
  }
  const now = options.now ?? new Date();
  if (!Number.isFinite(now.getTime())) {
    throw new Error('OPERATOR_CANDIDATE_DOSSIER_NOW_INVALID');
  }
  const client = await pool.connect();
  try {
    await client.query(
      'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
    );
    // Load exactly one active review policy, then dossier rows.
    await client.query('COMMIT');
    return dossier;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    throw error;
  } finally {
    client.release();
  }
}
```

Load the active policy with the existing Sprint 9B query:

```sql
select policy.review_policy_revision_id,
       review_policy.minimum_confirmed_reviews
  from active_eligibility_policy_revision active
  join eligibility_policy_revisions policy
    on policy.eligibility_policy_revision_id =
       active.eligibility_policy_revision_id
  join review_policy_revisions review_policy
    on review_policy.review_policy_revision_id =
       policy.review_policy_revision_id
 where active.scope = 'candidate_revision'
```

Require exactly one row, a canonical UUID, and `minimum_confirmed_reviews` from 1 through 16. Zero or multiple policy rows throw `OPERATOR_ACTIVE_REVIEW_POLICY_UNAVAILABLE`.

- [ ] **Step 6: Implement the exact current-item header query**

Use the Sprint 9B currentness predicate and filter the ranked result by `$2` only after calculating the latest revision:

```sql
with latest_active_revisions as (
  select revision.*,
         row_number() over (
           partition by revision.candidate_id
           order by revision.revision desc,
                    revision.candidate_revision_id::text collate "C" desc
         ) as candidate_rank
    from candidate_revisions revision
    join candidates candidate
      on candidate.candidate_id = revision.candidate_id
    join active_catalog_revisions active_catalog
      on active_catalog.patch_id = revision.patch_id
     and active_catalog.game_mode_external_id = candidate.game_mode_external_id
     and active_catalog.catalog_revision_id = revision.catalog_revision_id
)
select revision.candidate_id,
       revision.candidate_revision_id,
       revision.revision,
       revision.patch_id,
       patch.patch_key,
       revision.catalog_revision_id,
       revision.canonical_payload,
       revision.created_at,
       subject.canonical_external_id as subject_external_id,
       seal.candidate_claim_set_seal_id,
       seal.claim_set_hash,
       seal.claim_count,
       current_review.review_quorum_evaluation_id,
       review.counted_review_count,
       review.required_confirmed_count,
       confidence.candidate_confidence_score_id,
       confidence.scoring_version,
       confidence.provenance_quality_score,
       confidence.evidence_diversity_score,
       confidence.patch_alignment_score,
       confidence.freshness_score,
       confidence.score,
       confidence.band,
       confidence.evaluated_at,
       confidence.created_at as confidence_created_at
  from latest_active_revisions revision
  join candidate_claim_set_seals seal
    on seal.candidate_revision_id = revision.candidate_revision_id
  join candidates candidate on candidate.candidate_id = revision.candidate_id
  join game_entities subject
    on subject.game_entity_id = candidate.subject_game_entity_id
  join patches patch on patch.patch_id = revision.patch_id
  left join current_review_quorum_evaluations current_review
    on current_review.candidate_revision_id = revision.candidate_revision_id
   and current_review.review_policy_revision_id = $1
  left join review_quorum_evaluations review
    on review.review_quorum_evaluation_id =
       current_review.review_quorum_evaluation_id
  left join current_candidate_confidence_scores current_confidence
    on current_confidence.candidate_revision_id = revision.candidate_revision_id
  left join candidate_confidence_scores confidence
    on confidence.candidate_confidence_score_id =
       current_confidence.candidate_confidence_score_id
   and confidence.candidate_id = revision.candidate_id
   and confidence.candidate_revision_id = revision.candidate_revision_id
   and confidence.patch_id = revision.patch_id
   and confidence.catalog_revision_id = revision.catalog_revision_id
 where revision.candidate_rank = 1
   and revision.candidate_revision_id = $2
   and coalesce(review.quorum_satisfied, false) = false
```

Pass `[reviewPolicyRevisionId, candidateRevisionId]`. Return `null` only when this query returns zero rows. More than one row or any invalid header, review-count, selection, Claim-seal, or confidence field fails closed.

- [ ] **Step 7: Implement ordered Claim and current-decision loading**

Load every Claim and only its guarded current decision:

```sql
select claim.claim_id,
       claim.candidate_id,
       claim.candidate_revision_id,
       claim.patch_id,
       claim.catalog_revision_id,
       claim.claim_key,
       claim.claim_type,
       claim.importance,
       claim.statement,
       claim.statement_hash,
       current.claim_evidence_decision_id,
       decision.evidence_input_snapshot_id,
       decision.evidence_policy_revision_id,
       decision.candidate_id as decision_candidate_id,
       decision.candidate_revision_id as decision_candidate_revision_id,
       decision.patch_id as decision_patch_id,
       decision.catalog_revision_id as decision_catalog_revision_id,
       decision.decision,
       decision.reason,
       decision.evaluated_at,
       snapshot.candidate_claim_set_seal_id,
       snapshot.claim_set_hash,
       snapshot.claim_statement_hash,
       snapshot.association_count
  from candidate_claims claim
  left join current_claim_evidence_decisions current
    on current.claim_id = claim.claim_id
   and current.candidate_id = claim.candidate_id
   and current.candidate_revision_id = claim.candidate_revision_id
   and current.patch_id = claim.patch_id
   and current.catalog_revision_id = claim.catalog_revision_id
  left join claim_evidence_decisions decision
    on decision.claim_evidence_decision_id =
       current.claim_evidence_decision_id
   and decision.claim_id = claim.claim_id
   and decision.candidate_id = claim.candidate_id
   and decision.candidate_revision_id = claim.candidate_revision_id
   and decision.patch_id = claim.patch_id
   and decision.catalog_revision_id = claim.catalog_revision_id
   and decision.evidence_policy_revision_id =
       current.evidence_policy_revision_id
  left join evidence_input_snapshots snapshot
    on snapshot.evidence_input_snapshot_id =
       decision.evidence_input_snapshot_id
   and snapshot.claim_id = claim.claim_id
   and snapshot.candidate_id = claim.candidate_id
   and snapshot.candidate_revision_id = claim.candidate_revision_id
   and snapshot.patch_id = claim.patch_id
   and snapshot.catalog_revision_id = claim.catalog_revision_id
   and snapshot.evidence_policy_revision_id =
       decision.evidence_policy_revision_id
 where claim.candidate_revision_id = $1
 order by claim.claim_key collate "C"
```

Require the Claim row count to equal the sealed count and remain at or below 256. Enforce closed Claim type/importance/decision unions, UUIDs, 64-character lowercase hashes, reason/statement bounds, canonical timestamps, and all-or-null current-decision fields. For every Claim and non-null decision, compare the repeated Candidate, CandidateRevision, patch, catalog, Claim-set seal/hash, Claim statement hash, and Evidence-policy fields against the header and parent Claim; any mismatch fails the whole dossier.

- [ ] **Step 8: Implement exact Evidence snapshot-member loading**

Collect non-null current `evidence_input_snapshot_id` values and query only immutable snapshot members:

```sql
select decision.claim_id,
       decision.claim_evidence_decision_id,
       member.evidence_input_snapshot_id,
       member.ordinal,
       association.evidence_association_id,
       association.evidence_id,
       association.candidate_id as association_candidate_id,
       association.candidate_revision_id as association_candidate_revision_id,
       association.decision_patch_id,
       association.catalog_revision_id as association_catalog_revision_id,
       association.evidence_patch_id as association_evidence_patch_id,
       association.stance,
       association.cross_patch_revalidated,
       association.revalidation_reason,
       evidence.evidence_patch_id,
       patch.patch_key as evidence_patch_key,
       evidence.created_at as evidence_created_at,
       source.source_id,
       source.source_key,
       source.display_name,
       source.status as source_status,
       policy.source_policy_revision_id,
       policy.storage_permission,
       raw.external_reference,
       raw.observed_at,
       raw.collected_at
  from evidence_input_snapshot_associations member
  join evidence_input_snapshots snapshot
    on snapshot.evidence_input_snapshot_id = member.evidence_input_snapshot_id
  join claim_evidence_decisions decision
    on decision.evidence_input_snapshot_id = snapshot.evidence_input_snapshot_id
   and decision.claim_id = snapshot.claim_id
   and decision.candidate_id = snapshot.candidate_id
   and decision.candidate_revision_id = snapshot.candidate_revision_id
   and decision.patch_id = snapshot.patch_id
   and decision.catalog_revision_id = snapshot.catalog_revision_id
   and decision.evidence_policy_revision_id =
       snapshot.evidence_policy_revision_id
  join evidence_associations association
    on association.evidence_association_id = member.evidence_association_id
   and association.claim_id = decision.claim_id
   and association.candidate_id = decision.candidate_id
   and association.candidate_revision_id = decision.candidate_revision_id
   and association.decision_patch_id = decision.patch_id
   and association.catalog_revision_id = decision.catalog_revision_id
  join evidence_records evidence
    on evidence.evidence_id = association.evidence_id
   and evidence.evidence_patch_id = association.evidence_patch_id
  join normalized_observations normalized
    on normalized.normalized_observation_id =
       evidence.normalized_observation_id
   and normalized.raw_observation_id = evidence.raw_observation_id
   and normalized.patch_id = evidence.evidence_patch_id
  join raw_observations raw
    on raw.raw_observation_id = evidence.raw_observation_id
   and raw.source_id = evidence.source_id
   and raw.source_policy_revision_id = evidence.source_policy_revision_id
  join sources source on source.source_id = evidence.source_id
  join source_policy_revisions policy
    on policy.source_policy_revision_id = evidence.source_policy_revision_id
   and policy.source_id = evidence.source_id
  join patches patch on patch.patch_id = evidence.evidence_patch_id
 where member.evidence_input_snapshot_id = any($1::uuid[])
 order by decision.claim_id::text collate "C", member.ordinal
```

Do not add `raw_blob`, `aggregate_metadata`, or `content_hash` to the SELECT. Group rows by input snapshot. Require ordinal continuity from 1, exact persisted `association_count`, no duplicate snapshot/association/Evidence IDs, at most 64 rows per Claim, and at most 2,048 total rows. Compare every repeated Claim, Candidate, CandidateRevision, decision patch, catalog, Evidence patch, current decision ID, and snapshot ID to its expected parent before mapping. A snapshot with `association_count = 0` must have no returned members.

- [ ] **Step 9: Implement complete provenance loading**

Load all CandidateRevision provenance separately:

```sql
select provenance.candidate_provenance_id,
       provenance.origin,
       normalized.patch_id as provenance_patch_id,
       normalized.catalog_revision_id as provenance_catalog_revision_id,
       source.source_id,
       source.source_key,
       source.display_name,
       source.status as source_status,
       policy.source_policy_revision_id,
       policy.storage_permission,
       raw.external_reference,
       raw.observed_at,
       raw.collected_at
  from candidate_provenance provenance
  join normalized_observations normalized
    on normalized.normalized_observation_id =
       provenance.normalized_observation_id
  join raw_observations raw
    on raw.raw_observation_id = normalized.raw_observation_id
  join sources source on source.source_id = raw.source_id
  join source_policy_revisions policy
    on policy.source_policy_revision_id = raw.source_policy_revision_id
   and policy.source_id = raw.source_id
 where provenance.candidate_revision_id = $1
 order by provenance.candidate_provenance_id::text collate "C"
```

Validate the closed origin union and require every provenance patch/catalog pair to match the dossier header. Always map AI-origin reference to `null`. Build the final DTO field-by-field, commit once, and return it.

- [ ] **Step 10: Add failing closed-row, bound, currentness, rollback, and reference tests**

Extend the fake-Pool suite with cases for:

```ts
await assert.rejects(
  readOperatorCandidateReviewDossier(fakeWithClaimCountMismatch.pool, IDS.revision),
  /OPERATOR_CANDIDATE_DOSSIER_ROW_INVALID/,
);
await assert.rejects(
  readOperatorCandidateReviewDossier(fakeWithHistoricalAssociation.pool, IDS.revision),
  /OPERATOR_CANDIDATE_DOSSIER_ROW_INVALID/,
);
assert.equal(
  (await readOperatorCandidateReviewDossier(notCurrent.pool, IDS.revision)),
  null,
);
```

Also cover partial confidence, invalid component sum/band, unsafe `javascript:`, malformed, and credential-bearing URLs, invalid optional reference values, aggregate-only/AI null references, non-contiguous ordinals, repeated graph-identity mismatches, per-Claim/total bound overflow, invalid `now`, query failure, rollback failure preserving the original error, and exactly one client release. Unsafe or invalid stored references must still return HTTP-independent reader success with `reference: null`; they must not reject the dossier.

- [ ] **Step 11: Run focused GREEN tests and typecheck**

Run:

```bash
cd backend
node --import tsx --test test/operator-candidate-review-dossier.test.ts
npm run typecheck
```

Expected: all fake-Pool dossier tests PASS; database-marked tests skip only when `TEST_DATABASE_URL` is absent; TypeScript exits 0.

- [ ] **Step 12: Refactor only duplicated code inside the new module and commit**

Keep each helper focused on one validation or mapping responsibility. Do not change the Sprint 9B reader contract during refactoring.

```bash
git add backend/src/modules/operator/types.ts \
  backend/src/modules/operator/read-candidate-review-dossier.ts \
  backend/test/operator-candidate-review-dossier.test.ts
git commit -m "feat: add candidate review evidence dossier reader"
```

---

### Task 2: PostgreSQL currentness and authority-isolation coverage

**Files:**

- Modify: `backend/test/operator-candidate-review-dossier.test.ts`
- Modify: `backend/test/operator-authority-isolation.test.ts`

**Interfaces:**

- Consumes: the Task 1 reader and existing `resetDatabase`, `seedActivatedGateContext`, `evaluateCandidateConfidence`, `recordClaimEvidenceDecision`, `completeHumanReview`, catalog activation, and Candidate registration helpers.
- Produces: database-backed proof that the dossier reads only a current queue item/current Evidence snapshot and leaves all mutation authorities unchanged.

- [ ] **Step 1: Add the database-backed complete dossier test**

Use the standard skip condition and always close the pool:

```ts
test('PostgreSQL dossier returns the complete current governed graph', {
  skip: process.env.TEST_DATABASE_URL === undefined,
}, async () => {
  const pool = await resetDatabase();
  try {
    await seedActivatedGateContext(pool);
    await evaluateCandidateConfidence(pool, {
      actorId: 'confidence-evaluator',
      candidateRevisionId: CANDIDATE_IDS.candidateRevisionId,
      correlationId: 'operator-dossier-confidence',
      evaluatedAt: new Date('2026-09-03T00:30:00.000Z'),
      reason: 'Persist confidence before read-only dossier verification.',
    });

    const dossier = await readOperatorCandidateReviewDossier(
      pool,
      CANDIDATE_IDS.candidateRevisionId,
      { now: new Date('2026-09-03T01:00:00.000Z') },
    );

    assert.ok(dossier);
    assert.equal(dossier.candidate.candidateRevisionId, CANDIDATE_IDS.candidateRevisionId);
    assert.equal(dossier.claims.length, dossier.claimSet.claimCount);
    assert.equal(dossier.confidence?.score, 65);
    assert.ok(dossier.provenance.length > 0);
  } finally {
    await pool.end();
  }
});
```

Use the existing trust fixtures' exact expected Claim IDs, current decision IDs, Evidence association IDs, source policy, and stable order rather than asserting only non-empty arrays.

- [ ] **Step 2: Prove current Evidence snapshot isolation**

Create an older decision/snapshot, advance the guarded current pointer with a newer decision, then read the dossier. Assert that only the newer decision ID and its exact snapshot-member Evidence IDs appear. Query the database afterward to prove the historical rows still exist and were merely excluded from presentation.

- [ ] **Step 3: Prove active-catalog/latest-revision and review-policy currentness**

Add separate cases that:

- activate a second catalog revision and assert the old revision returns `null` while the new latest sealed revision is readable;
- complete active-policy quorum and assert the same revision then returns `null`;
- complete quorum under a historical review policy, activate policy revision 2, and assert the dossier is readable with `state: 'unreviewed'`, count 0, and the revision-2 required count.

- [ ] **Step 4: Prove read-only authority isolation with exact table counts**

Use this fixed table list before and after a successful dossier read:

```ts
const authorityTables = [
  'candidate_claims',
  'candidate_claim_set_seals',
  'evidence_records',
  'evidence_associations',
  'evidence_input_snapshots',
  'evidence_input_snapshot_associations',
  'claim_evidence_decisions',
  'current_claim_evidence_decisions',
  'human_reviews',
  'review_input_snapshots',
  'review_quorum_evaluations',
  'current_review_quorum_evaluations',
  'candidate_confidence_input_snapshots',
  'candidate_confidence_scores',
  'current_candidate_confidence_scores',
  'moderation_decisions',
  'current_candidate_moderation_decisions',
  'candidate_eligibility_evaluations',
  'current_candidate_eligibility_evaluations',
  'publications',
  'publication_versions',
  'publication_activation_history',
  'audit_events',
  'idempotency_records',
  'outbox_events',
] as const;
```

Assert `after` deeply equals `before`. In `operator-authority-isolation.test.ts`, add `read-candidate-review-dossier` to the allowed read module set and keep every mutation-module pattern prohibited.

- [ ] **Step 5: Run PostgreSQL GREEN tests in the CI-equivalent environment**

Run with PostgreSQL 17 available:

```bash
cd backend
TEST_DATABASE_URL='postgres://postgres:postgres@127.0.0.1:5432/hai_dau_test' \
  node --import tsx --test --test-concurrency=1 \
  test/operator-candidate-review-dossier.test.ts \
  test/operator-authority-isolation.test.ts
npm run typecheck
```

Expected: all database and static authority-isolation tests PASS with zero skips.

- [ ] **Step 6: Commit the database proof slice**

```bash
git add backend/test/operator-candidate-review-dossier.test.ts \
  backend/test/operator-authority-isolation.test.ts
git commit -m "test: prove dossier currentness and authority isolation"
```

---

### Task 3: Additive GET-only operator HTTP boundary

**Files:**

- Modify: `backend/src/operator/http.ts`
- Modify: `backend/src/operator-server.ts`
- Modify: `backend/test/operator-http.test.ts`

**Interfaces:**

- Consumes: `readOperatorCandidateReviewDossier(pool, candidateRevisionId, { now })` from Task 1.
- Extends `BuildOperatorAppOptions` with `readCandidateDossier(options)` returning `OperatorCandidateReviewDossier | null`.
- Produces: `GET /api/operator/v1/candidate-review-dossiers/:candidateRevisionId` with closed HTTP 400, HTTP 404, and HTTP 503 responses.

- [ ] **Step 1: Add failing HTTP contract tests**

Define a complete `DOSSIER` fixture and observed options array. Assert:

```ts
const response = await app.inject({
  method: 'GET',
  url: `/api/operator/v1/candidate-review-dossiers/${IDS.candidateRevision}`,
});

assert.equal(response.statusCode, 200);
assert.deepEqual(response.json(), DOSSIER);
assert.deepEqual(observedDossierOptions, [{
  candidateRevisionId: IDS.candidateRevision,
  now: new Date('2026-09-03T01:00:00.000Z'),
}]);
expectedSecurityHeaders(response.headers);
```

Add cases for uppercase/non-versioned/malformed UUIDs, any query key, duplicate query keys, `null` reader result, thrown reader error, and POST/PUT/PATCH/DELETE. Assert the exact spec bodies and that invalid requests never call the reader.

- [ ] **Step 2: Run HTTP tests and capture RED**

```bash
cd backend
node --import tsx --test test/operator-http.test.ts
```

Expected: FAIL because `readCandidateDossier` and the route do not exist.

- [ ] **Step 3: Add the HTTP request interface and closed responses**

In `http.ts`, add:

```ts
export type OperatorCandidateDossierRequestOptions = {
  candidateRevisionId: string;
  now: Date;
};

const INVALID_CANDIDATE_DOSSIER_REQUEST = {
  error: {
    code: 'INVALID_OPERATOR_CANDIDATE_DOSSIER_REQUEST',
    message: 'Invalid operator candidate dossier request',
  },
} as const;

const CANDIDATE_DOSSIER_NOT_FOUND = {
  error: {
    code: 'OPERATOR_CANDIDATE_DOSSIER_NOT_FOUND',
    message: 'Operator candidate dossier not found',
  },
} as const;

const CANDIDATE_DOSSIER_UNAVAILABLE = {
  error: {
    code: 'OPERATOR_CANDIDATE_DOSSIER_UNAVAILABLE',
    message: 'Operator candidate dossier is temporarily unavailable',
  },
} as const;
```

Extend `BuildOperatorAppOptions`:

```ts
readCandidateDossier(
  options: OperatorCandidateDossierRequestOptions,
): Promise<OperatorCandidateReviewDossier | null>;
```

- [ ] **Step 4: Register the strict GET route**

Use a lowercase UUID path pattern check and reject every query key before invoking the reader:

```ts
app.get<{
  Params: { candidateRevisionId: string };
  Querystring: Record<string, unknown>;
}>(
  '/api/operator/v1/candidate-review-dossiers/:candidateRevisionId',
  async (request, reply) => {
    if (
      !UUID_PATTERN.test(request.params.candidateRevisionId)
      || Object.keys(request.query).length !== 0
    ) {
      return reply.code(400).send(INVALID_CANDIDATE_DOSSIER_REQUEST);
    }
    try {
      const dossier = await options.readCandidateDossier({
        candidateRevisionId: request.params.candidateRevisionId,
        now: (options.now ?? (() => new Date()))(),
      });
      return dossier ?? reply.code(404).send(CANDIDATE_DOSSIER_NOT_FOUND);
    } catch {
      app.log.error(
        { code: 'OPERATOR_CANDIDATE_DOSSIER_READ_FAILED' },
        'operator candidate dossier read failed',
      );
      return reply.code(503).send(CANDIDATE_DOSSIER_UNAVAILABLE);
    }
  },
);
```

Do not include Candidate IDs or error objects in logs.

- [ ] **Step 5: Wire the operator server**

Import the reader and inject only this adapter:

```ts
readCandidateDossier: ({ candidateRevisionId, now }) =>
  readOperatorCandidateReviewDossier(
    pool,
    candidateRevisionId,
    { now },
  ),
```

Keep the existing `readCandidateQueue`, `readSnapshot`, readiness, and loopback config unchanged.

- [ ] **Step 6: Run HTTP, config, existing queue, and reader tests**

```bash
cd backend
node --import tsx --test \
  test/operator-http.test.ts \
  test/operator-config.test.ts \
  test/operator-candidate-review-queue.test.ts \
  test/operator-candidate-review-dossier.test.ts \
  test/operator-signal-reader.test.ts
npm run typecheck
```

Expected: all non-database tests PASS; database cases skip only when the local database variable is absent; TypeScript exits 0.

- [ ] **Step 7: Commit the HTTP slice**

```bash
git add backend/src/operator/http.ts backend/src/operator-server.ts \
  backend/test/operator-http.test.ts
git commit -m "feat: expose read-only candidate dossier endpoint"
```

---

### Task 4: Candidate dossier operator presentation

**Files:**

- Modify: `backend/src/operator/assets.ts`
- Modify: `backend/test/operator-http.test.ts`

**Interfaces:**

- Consumes: Sprint 9B queue schema version 1 and the Task 3 dossier endpoint/schema version 1.
- Produces: a manual detail view opened by `Xem hồ sơ`, plus `Quay lại hàng đợi` and manual refresh controls.
- Preserves: Monitoring & feedback view, candidate queue filters/search/refresh, all existing endpoints, and self-contained assets.

- [ ] **Step 1: Add failing static asset assertions**

Extend `operator-http.test.ts` to assert:

```ts
assert.match(OPERATOR_JS, /candidate-review-dossiers/);
assert.match(OPERATOR_JS, /Xem hồ sơ/);
assert.match(OPERATOR_HTML, /Quay lại hàng đợi/);
assert.match(OPERATOR_HTML, /Làm mới hồ sơ/);
assert.match(OPERATOR_JS, /createTextNode|textContent/);
assert.doesNotMatch(OPERATOR_JS, /innerHTML|localStorage|sessionStorage/);
assert.doesNotMatch(OPERATOR_JS, /setInterval|EventSource|WebSocket/);
assert.doesNotMatch(OPERATOR_HTML, /Phê duyệt|Từ chối|Xuất bản/);
```

Also assert that external anchors receive `target`, `rel`, and `referrerPolicy` properties and that the script never fetches the returned source URL.

- [ ] **Step 2: Run the asset test and capture RED**

```bash
cd backend
node --import tsx --test test/operator-http.test.ts
```

Expected: FAIL because the dossier view and loader are absent.

- [ ] **Step 3: Add the dossier view shell**

In `OPERATOR_HTML`, add a hidden detail section inside the candidate view with fixed IDs:

```html
<section id="candidate-dossier" hidden aria-label="Candidate evidence dossier">
  <div class="toolbar">
    <button id="dossier-back" type="button">Quay lại hàng đợi</button>
    <button id="dossier-refresh" type="button">Làm mới hồ sơ</button>
  </div>
  <p id="dossier-status" role="status"></p>
  <section id="dossier-summary" aria-label="Dossier summary"></section>
  <section id="dossier-provenance" aria-label="Candidate provenance"></section>
  <section id="dossier-claims" aria-label="Claims and evidence"></section>
</section>
```

Keep the existing queue controls and list in their own container so they can be hidden and restored without reloading monitoring state.

- [ ] **Step 4: Add safe DOM construction helpers**

Create elements with `document.createElement`, assign all untrusted values through `textContent`, and construct references only from the server DTO:

```js
function externalReference(reference) {
  if (!reference) return document.createTextNode('Không có liên kết nguồn');
  const link = document.createElement('a');
  link.href = reference.url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.referrerPolicy = 'no-referrer';
  link.textContent = 'Mở nguồn';
  return link;
}
```

Do not use `innerHTML`, template interpolation into markup, `insertAdjacentHTML`, DOM storage, or external asset URLs.

- [ ] **Step 5: Add the manual dossier loader and stale-item behavior**

Track only the in-memory `activeDossierCandidateRevisionId`. In `candidateCard(item)`, append one `button` created through `node(...)`, set `type = 'button'`, set its text to `Xem hồ sơ`, and attach a click handler that calls `loadCandidateDossier(item.candidateRevisionId)`. This is the only new control on a queue card and it performs no mutation.

Load with an encoded path and one GET:

```js
async function loadCandidateDossier(candidateRevisionId) {
  activeDossierCandidateRevisionId = candidateRevisionId;
  showDossierLoading();
  const response = await fetch(
    '/api/operator/v1/candidate-review-dossiers/'
      + encodeURIComponent(candidateRevisionId),
    { method: 'GET', cache: 'no-store' },
  );
  if (response.status === 404) {
    showDossierStale();
    return;
  }
  if (!response.ok) {
    showDossierUnavailable();
    return;
  }
  renderCandidateDossier(await response.json());
}
```

`Xem hồ sơ` calls the loader. `Làm mới hồ sơ` calls it only for the active ID. `Quay lại hàng đợi` clears the in-memory ID, restores the queue view, and triggers one manual queue refresh after a 404 stale state. Add no automatic timer or background retry.

- [ ] **Step 6: Render all dossier sections with explicit empty states**

Render:

- header selection, patch/catalog, review progress, and confidence components;
- provenance origin, source name/status/policy, timestamps, and optional reference;
- Claims in server order with importance/type badges, statement, current decision outcome/reason/time;
- Evidence in snapshot ordinal order with stance, patch, revalidation, source, timestamps, and optional reference;
- `Chưa có quyết định Evidence hiện hành` for `decision: null`;
- `Quyết định hiện hành không gắn Evidence` for a valid empty Evidence list.

Do not infer verification from confidence, provenance, source status, or Evidence count. Display the DTO's separate meanings verbatim.

- [ ] **Step 7: Add CSS without changing public assets**

Add local classes for dossier grid, Claim cards, Evidence rows, badges, source status, responsive stacking, focus-visible controls, and long-ID wrapping. Keep all CSS in `OPERATOR_CSS`; do not touch `app/`, `public/`, exported Pages files, or external fonts.

- [ ] **Step 8: Run operator and root presentation contracts**

```bash
cd backend
node --import tsx --test test/operator-http.test.ts
cd ..
npm run test:operator-surface
npm run test:operator-candidate-review-queue
npm run lint
```

Expected: HTTP/assets, existing operator surface, and Sprint 9B queue contracts PASS; lint reports zero errors.

- [ ] **Step 9: Commit the UI slice**

```bash
git add backend/src/operator/assets.ts backend/test/operator-http.test.ts
git commit -m "feat: render candidate evidence dossiers"
```

---

### Task 5: Repository contract, runbook, CI gate, and full verification

**Files:**

- Create: `tests/operator-candidate-review-dossier-contract.test.mjs`
- Create: `.github/workflows/sprint-9c-candidate-review-dossier.yml`
- Modify: `tests/operator-surface-contract.test.mjs`
- Modify: `docs/runbooks/operator-surface.md`
- Modify: `package.json`

**Interfaces:**

- Consumes: completed Tasks 1–4.
- Produces: root `test:operator-candidate-review-dossier`, deployment-free Sprint 9C CI, operator instructions, and repository-level proof of authority/public-surface isolation.

- [ ] **Step 1: Add the failing repository contract**

Create `tests/operator-candidate-review-dossier-contract.test.mjs` with three tests:

```js
test('candidate dossier has one closed GET-only read boundary', async () => {
  const [reader, http, server] = await Promise.all([
    text('backend/src/modules/operator/read-candidate-review-dossier.ts'),
    text('backend/src/operator/http.ts'),
    text('backend/src/operator-server.ts'),
  ]);
  assert.match(reader, /REPEATABLE READ READ ONLY/);
  assert.doesNotMatch(reader, /\b(?:insert\s+into|update\s+\S+\s+set|delete\s+from)\b/i);
  assert.match(http, /app\.get<[\s\S]*candidate-review-dossiers\/.*candidateRevisionId/);
  assert.doesNotMatch(http, /(?:post|put|patch|delete)[\s\S]*candidate-review-dossiers/i);
  assert.match(server, /readOperatorCandidateReviewDossier/);
});
```

The second test scans production/staging Caddy, Railway/Docker/shell/env deployment files, and `app/` for `candidate-review-dossiers`, `operator-server`, and `operator:dev`. It must find no public/deployment exposure.

The third test asserts the runbook contains the exact currentness, current-decision snapshot, safe-reference, bounds, read-only, sanitized-failure, and no-HumanReview rules; it also validates workflow permissions and root script wiring.

- [ ] **Step 2: Run the new contract and capture RED**

```bash
node --test tests/operator-candidate-review-dossier-contract.test.mjs
```

Expected: FAIL because the root script, runbook section, and dedicated workflow are absent.

- [ ] **Step 3: Wire the root test script**

Add:

```json
"test:operator-candidate-review-dossier": "node --test tests/operator-candidate-review-dossier-contract.test.mjs"
```

Insert it in the root `test` chain immediately after `test:operator-candidate-review-queue` so every root regression runs 9B before 9C.

- [ ] **Step 4: Update the operator runbook**

Add a `Candidate Evidence dossier` subsection documenting:

- exact GET endpoint and no-query/canonical-UUID contract;
- current queue-item revalidation and 404 behavior;
- current Claim Evidence decision and immutable input-snapshot membership;
- source status and policy-aware HTTPS reference projection;
- 256/64/2,048 response bounds;
- manual open/back/refresh behavior and explicit empty states;
- sanitized 400/404/503 responses;
- raw/provider/actor/correlation exclusions;
- no HumanReview, Evidence, confidence, moderation, eligibility, publication, audit, idempotency, or outbox mutation;
- continued loopback-only and deployment-free boundary.

- [ ] **Step 5: Add the dedicated Sprint 9C workflow**

Copy the Sprint 9B workflow structure into `.github/workflows/sprint-9c-candidate-review-dossier.yml`, then use:

```yaml
name: Sprint 9C candidate review dossier gate

on:
  workflow_dispatch:
  pull_request:
    paths:
      - "backend/src/modules/operator/**"
      - "backend/src/operator/**"
      - "backend/src/operator-server.ts"
      - "backend/test/operator-*.test.ts"
      - "backend/test/helpers/**"
      - "tests/operator-surface-contract.test.mjs"
      - "tests/operator-candidate-review-queue-contract.test.mjs"
      - "tests/operator-candidate-review-dossier-contract.test.mjs"
      - "docs/runbooks/operator-surface.md"
      - "docs/superpowers/specs/2026-09-03-candidate-review-evidence-dossier-design.md"
      - "docs/superpowers/plans/2026-09-03-candidate-review-evidence-dossier.md"
      - "package.json"
      - "package-lock.json"
      - ".github/workflows/sprint-9c-candidate-review-dossier.yml"

permissions:
  contents: read
```

Use Node 22.13.0 and PostgreSQL 17. Do not add Redis because the dossier runtime and tests have no Redis dependency. Install root/backend with `npm ci`, then run the new root contract, existing operator/9B contracts, lint, backend typecheck, full backend tests, backend build, and a repository-cleanliness guard.

End with a deployment guard that scans the executable workflow prefix and rejects write permissions, deployment commands, production secret names, private keys, provider calls, and Git pushes.

- [ ] **Step 6: Extend the existing operator surface contract additively**

Require the dossier route string, detail controls, safe-link attributes, and text-only rendering. Preserve all Sprint 7C/9B assertions. Add negative assertions for mutation methods and public/deployment exposure without changing the existing snapshot or queue response checks.

- [ ] **Step 7: Run focused GREEN contracts**

```bash
npm run test:operator-candidate-review-dossier
npm run test:operator-candidate-review-queue
npm run test:operator-surface
```

Expected: all three root contracts PASS.

- [ ] **Step 8: Run the full local quality gate**

```bash
npm run lint
npm test
npm --prefix backend run typecheck
npm --prefix backend run build
git diff --check main...HEAD
git status --short
```

Expected: lint has zero errors; root regression/static Pages build, backend typecheck, and backend build exit 0; diff check is clean; status contains only intended tracked changes before the final commit.

This root/backend gate preserves the Sprint 9A persisted-confidence contract as well as the Sprint 9B queue and Sprint 7C operator contracts; the dossier may display an existing score but may not recompute one.

- [ ] **Step 9: Run the full PostgreSQL backend suite**

In PostgreSQL 17 CI or an equivalent local service:

```bash
TEST_DATABASE_URL='postgres://postgres:postgres@127.0.0.1:5432/hai_dau_test' \
  npm --prefix backend test
```

Expected: every backend test passes with zero failures and every dossier database test executes without skipping.

Confirm the output includes the complete Sprint 9A candidate-confidence migration, compute, evaluation, reader, and authority-isolation tests; none may be skipped in this PostgreSQL-backed run.

- [ ] **Step 10: Commit the repository-readiness slice**

```bash
git add tests/operator-candidate-review-dossier-contract.test.mjs \
  tests/operator-surface-contract.test.mjs \
  .github/workflows/sprint-9c-candidate-review-dossier.yml \
  docs/runbooks/operator-surface.md package.json
git commit -m "ci: gate Sprint 9C candidate dossier"
```

- [ ] **Step 11: Push the implementation branch and open a draft PR**

Push `sprint-9c-candidate-review-evidence-dossier` and open a draft PR against `main`. State the exact base/head SHAs, read-only scope, absence of migration/deployment/public routes, local verification results, and any local PostgreSQL skips. Do not merge or deploy.

- [ ] **Step 12: Require exact-head CI and independent review before readiness**

Wait for the dedicated Sprint 9C gate, inherited operator/backend/staging/release workflows, and `rc-ready`. Review `main...head` for Critical/Important findings in currentness, snapshot membership, raw-data leakage, unsafe URLs, authority imports, public/deployment exposure, error sanitization, and response bounds. Resolve every Critical or Important finding, rerun affected gates, and report exact evidence before requesting merge approval.
