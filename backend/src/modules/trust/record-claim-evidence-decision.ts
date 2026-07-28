import { randomUUID } from 'node:crypto';

import type { Pool, PoolClient } from 'pg';

import { withTransaction } from '../../database/transaction.js';
import {
  beginIdempotentCommand,
  completeIdempotentCommand,
} from '../../shared/idempotent-command.js';
import { lockCandidateRevisionAuthority } from './load-trust-authority.js';
import {
  hashCanonicalTupleV1,
  requireBoundedText,
  requireUuid,
} from './normalize-trust-input.js';
import type {
  EvidenceAssociationInput,
  EvidenceDecision,
  EvidenceStance,
  RecordClaimEvidenceDecisionCommand,
  RecordClaimEvidenceDecisionResult,
} from './types.js';

export type {
  EvidenceAssociationInput,
  RecordClaimEvidenceDecisionCommand,
  RecordClaimEvidenceDecisionResult,
} from './types.js';

const COMMAND_KEYS = [
  'actorId',
  'associations',
  'candidateId',
  'candidateRevisionId',
  'claimId',
  'correlationId',
  'decision',
  'decisionId',
  'evaluatedAt',
  'evidenceInputSnapshotId',
  'evidencePolicyRevisionId',
  'idempotencyKey',
  'reason',
] as const;

const ASSOCIATION_KEYS = [
  'associationId',
  'crossPatchRevalidated',
  'evidenceId',
  'normalizedObservationId',
  'revalidationReason',
  'stance',
] as const;

const DECISIONS = new Set<EvidenceDecision>([
  'supported',
  'insufficient',
  'contradicted',
]);

const STANCES = new Set<EvidenceStance>([
  'supports',
  'contradicts',
  'context_only',
]);

interface ClaimAuthorityRow {
  candidate_claim_set_seal_id: string;
  claim_set_hash: string;
  statement_hash: string;
}

interface EvidenceSourceRow {
  normalized_observation_id: string;
  raw_observation_id: string;
  evidence_patch_id: string;
  source_id: string;
  source_policy_revision_id: string;
  content_hash: string;
}

interface EvidenceRow extends EvidenceSourceRow {
  evidence_id: string;
}

interface AssociationRow {
  evidence_association_id: string;
  evidence_id: string;
  stance: EvidenceStance;
  cross_patch_revalidated: boolean;
  revalidation_reason: string | null;
}

interface SnapshotRow {
  evidence_input_snapshot_id: string;
  input_hash: string;
}

interface ExistingDecisionRow {
  claim_evidence_decision_id: string;
  decision: EvidenceDecision;
}

interface CurrentDecisionRow {
  claim_evidence_decision_id: string;
}

interface ResolvedAssociation {
  associationId: string;
  evidenceId: string;
  stance: EvidenceStance;
}

function compareCanonical(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function requireExactKeys(
  value: unknown,
  expectedKeys: readonly string[],
  field: string,
): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`TRUST_OBJECT_KEYS_INVALID:${field}`);
  }
  const actual = Object.keys(value).sort(compareCanonical);
  const expected = [...expectedKeys].sort(compareCanonical);
  if (
    actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])
  ) {
    throw new Error(`TRUST_OBJECT_KEYS_INVALID:${field}`);
  }
}

function requireIsoTimestamp(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error('EVIDENCE_DECISION_INPUT_INVALID');
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new Error('EVIDENCE_DECISION_INPUT_INVALID');
  }
  return value;
}

function normalizeAssociation(value: unknown): EvidenceAssociationInput {
  requireExactKeys(value, ASSOCIATION_KEYS, 'evidenceAssociation');
  if (
    typeof value.stance !== 'string'
    || !STANCES.has(value.stance as EvidenceStance)
    || typeof value.crossPatchRevalidated !== 'boolean'
    || (
      value.revalidationReason !== null
      && typeof value.revalidationReason !== 'string'
    )
  ) {
    throw new Error('EVIDENCE_DECISION_INPUT_INVALID');
  }
  return {
    associationId: requireUuid(
      value.associationId as string,
      'associationId',
    ),
    crossPatchRevalidated: value.crossPatchRevalidated,
    evidenceId: requireUuid(value.evidenceId as string, 'evidenceId'),
    normalizedObservationId: requireUuid(
      value.normalizedObservationId as string,
      'normalizedObservationId',
    ),
    revalidationReason: value.revalidationReason === null
      ? null
      : requireBoundedText(
          value.revalidationReason as string,
          'revalidationReason',
          1024,
        ),
    stance: value.stance as EvidenceStance,
  };
}

function normalizeCommand(
  input: RecordClaimEvidenceDecisionCommand,
): RecordClaimEvidenceDecisionCommand {
  requireExactKeys(input, COMMAND_KEYS, 'evidenceDecisionCommand');
  if (
    typeof input.decision !== 'string'
    || !DECISIONS.has(input.decision as EvidenceDecision)
    || !Array.isArray(input.associations)
    || input.associations.length > 64
  ) {
    throw new Error('EVIDENCE_DECISION_INPUT_INVALID');
  }
  const associations: EvidenceAssociationInput[] = [];
  for (let index = 0; index < input.associations.length; index += 1) {
    if (!(index in input.associations)) {
      throw new Error('EVIDENCE_DECISION_INPUT_INVALID');
    }
    associations.push(normalizeAssociation(input.associations[index]));
  }
  const associationIds = new Set<string>();
  const normalizedObservationIds = new Set<string>();
  for (const association of associations) {
    if (
      associationIds.has(association.associationId)
      || normalizedObservationIds.has(
        association.normalizedObservationId,
      )
    ) {
      throw new Error('EVIDENCE_DECISION_INPUT_INVALID');
    }
    associationIds.add(association.associationId);
    normalizedObservationIds.add(association.normalizedObservationId);
  }
  associations.sort((left, right) => (
    compareCanonical(left.associationId, right.associationId)
  ));

  const decision = input.decision as EvidenceDecision;
  if (
    (
      decision === 'supported'
      && !associations.some((entry) => entry.stance === 'supports')
    )
    || (
      decision === 'contradicted'
      && !associations.some((entry) => entry.stance === 'contradicts')
    )
  ) {
    throw new Error('EVIDENCE_DECISION_INPUT_INVALID');
  }
  return {
    actorId: requireBoundedText(input.actorId, 'actorId', 256),
    associations,
    candidateId: requireUuid(input.candidateId, 'candidateId'),
    candidateRevisionId: requireUuid(
      input.candidateRevisionId,
      'candidateRevisionId',
    ),
    claimId: requireUuid(input.claimId, 'claimId'),
    correlationId: requireBoundedText(
      input.correlationId,
      'correlationId',
      256,
    ),
    decision,
    decisionId: requireUuid(input.decisionId, 'decisionId'),
    evaluatedAt: requireIsoTimestamp(input.evaluatedAt),
    evidenceInputSnapshotId: requireUuid(
      input.evidenceInputSnapshotId,
      'evidenceInputSnapshotId',
    ),
    evidencePolicyRevisionId: requireUuid(
      input.evidencePolicyRevisionId,
      'evidencePolicyRevisionId',
    ),
    idempotencyKey: requireBoundedText(
      input.idempotencyKey,
      'idempotencyKey',
      256,
    ),
    reason: requireBoundedText(input.reason, 'reason', 1024),
  };
}

function commandPayloadHash(
  command: RecordClaimEvidenceDecisionCommand,
): string {
  return hashCanonicalTupleV1([
    'TrustTupleV1',
    'ClaimEvidenceDecisionCommandV1',
    command.candidateId,
    command.candidateRevisionId,
    command.claimId,
    command.decisionId,
    command.evidenceInputSnapshotId,
    command.evidencePolicyRevisionId,
    command.decision,
    command.evaluatedAt,
    command.actorId,
    command.reason,
    String(command.associations.length),
    ...command.associations.flatMap((association) => [
      association.associationId,
      association.evidenceId,
      association.normalizedObservationId,
      association.stance,
      String(association.crossPatchRevalidated),
      association.revalidationReason ?? '@null',
    ]),
  ]);
}

async function lockClaimAuthority(
  client: PoolClient,
  candidateId: string,
  candidateRevisionId: string,
  claimId: string,
): Promise<ClaimAuthorityRow> {
  const claim = await client.query<ClaimAuthorityRow>(
    `select seal.candidate_claim_set_seal_id,
            seal.claim_set_hash,
            claim.statement_hash
       from candidate_claims claim
       join candidate_claim_set_seals seal
         on seal.candidate_revision_id =
            claim.candidate_revision_id
      where claim.claim_id = $1
        and claim.candidate_id = $2
        and claim.candidate_revision_id = $3
      for update of claim`,
    [claimId, candidateId, candidateRevisionId],
  );
  const row = claim.rows[0];
  if (!row) {
    throw new Error('CLAIM_NOT_FOUND');
  }
  return row;
}

async function requireEvidencePolicy(
  client: PoolClient,
  evidencePolicyRevisionId: string,
): Promise<void> {
  const policy = await client.query(
    `select evidence_policy_revision_id
       from evidence_policy_revisions
      where evidence_policy_revision_id = $1`,
    [evidencePolicyRevisionId],
  );
  if (policy.rowCount !== 1) {
    throw new Error('EVIDENCE_DECISION_INPUT_INVALID');
  }
}

async function resolveAssociation(
  client: PoolClient,
  command: RecordClaimEvidenceDecisionCommand,
  patchId: string,
  catalogRevisionId: string,
  input: EvidenceAssociationInput,
): Promise<ResolvedAssociation> {
  const source = await client.query<EvidenceSourceRow>(
    `select no.normalized_observation_id,
            no.raw_observation_id,
            no.patch_id as evidence_patch_id,
            ro.source_id,
            ro.source_policy_revision_id,
            ro.content_hash
       from normalized_observations no
       join raw_observations ro
         on ro.raw_observation_id = no.raw_observation_id
      where no.normalized_observation_id = $1
      for share of no, ro`,
    [input.normalizedObservationId],
  );
  const authority = source.rows[0];
  if (!authority) {
    throw new Error('EVIDENCE_OBSERVATION_NOT_FOUND');
  }
  const isCrossPatch = authority.evidence_patch_id !== patchId;
  if (
    isCrossPatch
    && (
      !input.crossPatchRevalidated
      || input.revalidationReason === null
    )
  ) {
    throw new Error(
      'EVIDENCE_ASSOCIATION_PATCH_REVALIDATION_REQUIRED',
    );
  }
  if (
    !isCrossPatch
    && (
      input.crossPatchRevalidated
      || input.revalidationReason !== null
    )
  ) {
    throw new Error('EVIDENCE_DECISION_INPUT_INVALID');
  }

  await client.query(
    `insert into evidence_records
      (evidence_id, normalized_observation_id, raw_observation_id,
       source_id, source_policy_revision_id, evidence_patch_id,
       content_hash, evidence_kind, created_by)
     values (
       $1, $2, $3, $4, $5, $6, $7,
       'normalized_observation', $8
     )
     on conflict (normalized_observation_id) do nothing`,
    [
      input.evidenceId,
      authority.normalized_observation_id,
      authority.raw_observation_id,
      authority.source_id,
      authority.source_policy_revision_id,
      authority.evidence_patch_id,
      authority.content_hash,
      command.actorId,
    ],
  );
  const evidenceResult = await client.query<EvidenceRow>(
    `select evidence_id,
            normalized_observation_id,
            raw_observation_id,
            source_id,
            source_policy_revision_id,
            evidence_patch_id,
            content_hash
       from evidence_records
      where normalized_observation_id = $1`,
    [authority.normalized_observation_id],
  );
  const evidence = evidenceResult.rows[0];
  if (
    !evidence
    || evidence.raw_observation_id !== authority.raw_observation_id
    || evidence.source_id !== authority.source_id
    || evidence.source_policy_revision_id !==
       authority.source_policy_revision_id
    || evidence.evidence_patch_id !== authority.evidence_patch_id
    || evidence.content_hash !== authority.content_hash
  ) {
    throw new Error('EVIDENCE_SOURCE_GRAPH_MISMATCH');
  }

  await client.query(
    `insert into evidence_associations
      (evidence_association_id, claim_id, evidence_id, candidate_id,
       candidate_revision_id, decision_patch_id, catalog_revision_id,
       evidence_patch_id, stance, cross_patch_revalidated,
       revalidation_reason, created_by)
     values (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12
     )
     on conflict (claim_id, evidence_id) do nothing`,
    [
      input.associationId,
      command.claimId,
      evidence.evidence_id,
      command.candidateId,
      command.candidateRevisionId,
      patchId,
      catalogRevisionId,
      evidence.evidence_patch_id,
      input.stance,
      input.crossPatchRevalidated,
      input.revalidationReason,
      command.actorId,
    ],
  );
  const associationResult = await client.query<AssociationRow>(
    `select evidence_association_id,
            evidence_id,
            stance,
            cross_patch_revalidated,
            revalidation_reason
       from evidence_associations
      where claim_id = $1
        and evidence_id = $2`,
    [command.claimId, evidence.evidence_id],
  );
  const association = associationResult.rows[0];
  if (
    !association
    || association.stance !== input.stance
    || association.cross_patch_revalidated !==
       input.crossPatchRevalidated
    || association.revalidation_reason !== input.revalidationReason
  ) {
    throw new Error('EVIDENCE_DECISION_INPUT_INVALID');
  }
  return {
    associationId: association.evidence_association_id,
    evidenceId: association.evidence_id,
    stance: association.stance,
  };
}

async function semanticReplay(
  client: PoolClient,
  command: RecordClaimEvidenceDecisionCommand,
  snapshot: SnapshotRow,
  current: CurrentDecisionRow | undefined,
): Promise<RecordClaimEvidenceDecisionResult> {
  const existing = await client.query<ExistingDecisionRow>(
    `select claim_evidence_decision_id,
            decision
       from claim_evidence_decisions
      where evidence_input_snapshot_id = $1`,
    [snapshot.evidence_input_snapshot_id],
  );
  const decision = existing.rows[0];
  if (!decision) {
    throw new Error('EVIDENCE_DECISION_INPUT_INVALID');
  }
  if (decision.decision !== command.decision) {
    throw new Error('EVIDENCE_DECISION_CONFLICT');
  }
  if (
    !current
    || current.claim_evidence_decision_id !==
       decision.claim_evidence_decision_id
  ) {
    throw new Error('EVIDENCE_DECISION_INPUT_SUPERSEDED');
  }
  return {
    claimId: command.claimId,
    decisionId: decision.claim_evidence_decision_id,
    decision: decision.decision,
    evidenceInputSnapshotId: snapshot.evidence_input_snapshot_id,
    inputHash: snapshot.input_hash,
    replayed: false,
  };
}

export async function recordClaimEvidenceDecision(
  pool: Pool,
  input: RecordClaimEvidenceDecisionCommand,
): Promise<RecordClaimEvidenceDecisionResult> {
  const command = normalizeCommand(input);
  const payloadHash = commandPayloadHash(command);
  return withTransaction(pool, async (client) => {
    const authority = await lockCandidateRevisionAuthority(
      client,
      command.candidateId,
      command.candidateRevisionId,
    );
    const claim = await lockClaimAuthority(
      client,
      authority.candidateId,
      authority.candidateRevisionId,
      command.claimId,
    );
    await requireEvidencePolicy(
      client,
      command.evidencePolicyRevisionId,
    );
    const replay = await beginIdempotentCommand<
      RecordClaimEvidenceDecisionResult
    >(
      client,
      'claim_evidence_decision',
      command.idempotencyKey,
      payloadHash,
    );
    if (replay) {
      return {
        ...replay,
        replayed: true,
      };
    }

    const currentResult = await client.query<CurrentDecisionRow>(
      `select claim_evidence_decision_id
         from current_claim_evidence_decisions
        where claim_id = $1
        for update`,
      [command.claimId],
    );
    const current = currentResult.rows[0];
    const resolved: ResolvedAssociation[] = [];
    for (const association of command.associations) {
      resolved.push(await resolveAssociation(
        client,
        command,
        authority.patchId,
        authority.catalogRevisionId,
        association,
      ));
    }
    resolved.sort((left, right) => (
      compareCanonical(left.associationId, right.associationId)
    ));

    const inputHash = hashCanonicalTupleV1([
      'TrustTupleV1',
      'EvidenceInputSnapshotV1',
      authority.candidateRevisionId,
      authority.patchId,
      authority.catalogRevisionId,
      command.claimId,
      claim.claim_set_hash,
      claim.statement_hash,
      command.evidencePolicyRevisionId,
      String(resolved.length),
      ...resolved.flatMap((association) => [
        association.associationId,
        association.evidenceId,
        association.stance,
      ]),
    ]);
    const existingSnapshot = await client.query<SnapshotRow>(
      `select evidence_input_snapshot_id,
              input_hash
         from evidence_input_snapshots
        where claim_id = $1
          and evidence_policy_revision_id = $2
          and input_hash = $3`,
      [
        command.claimId,
        command.evidencePolicyRevisionId,
        inputHash,
      ],
    );
    const snapshot = existingSnapshot.rows[0];
    if (snapshot) {
      const semantic = await semanticReplay(
        client,
        command,
        snapshot,
        current,
      );
      await completeIdempotentCommand(
        client,
        'claim_evidence_decision',
        command.idempotencyKey,
        semantic,
      );
      return {
        ...semantic,
        replayed: true,
      };
    }

    await client.query(
      `insert into evidence_input_snapshots
        (evidence_input_snapshot_id, claim_id, candidate_id,
         candidate_revision_id, patch_id, catalog_revision_id,
         candidate_claim_set_seal_id, claim_set_hash,
         claim_statement_hash, evidence_policy_revision_id,
         association_count, input_hash, created_by, evaluated_at)
       values (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
         $14
       )`,
      [
        command.evidenceInputSnapshotId,
        command.claimId,
        authority.candidateId,
        authority.candidateRevisionId,
        authority.patchId,
        authority.catalogRevisionId,
        claim.candidate_claim_set_seal_id,
        claim.claim_set_hash,
        claim.statement_hash,
        command.evidencePolicyRevisionId,
        resolved.length,
        inputHash,
        command.actorId,
        command.evaluatedAt,
      ],
    );
    for (let index = 0; index < resolved.length; index += 1) {
      await client.query(
        `insert into evidence_input_snapshot_associations
          (evidence_input_snapshot_id, evidence_association_id, ordinal)
         values ($1, $2, $3)`,
        [
          command.evidenceInputSnapshotId,
          resolved[index]!.associationId,
          index + 1,
        ],
      );
    }
    await client.query(
      `insert into claim_evidence_decisions
        (claim_evidence_decision_id, claim_id,
         evidence_input_snapshot_id, candidate_id,
         candidate_revision_id, patch_id, catalog_revision_id,
         evidence_policy_revision_id, decision, evaluator_actor_id,
         reason, correlation_id, evaluated_at)
       values (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13
       )`,
      [
        command.decisionId,
        command.claimId,
        command.evidenceInputSnapshotId,
        authority.candidateId,
        authority.candidateRevisionId,
        authority.patchId,
        authority.catalogRevisionId,
        command.evidencePolicyRevisionId,
        command.decision,
        command.actorId,
        command.reason,
        command.correlationId,
        command.evaluatedAt,
      ],
    );
    await client.query(
      `insert into current_claim_evidence_decisions
        (claim_id, candidate_id, candidate_revision_id, patch_id,
         catalog_revision_id, evidence_policy_revision_id,
         claim_evidence_decision_id)
       values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (claim_id) do update
       set evidence_policy_revision_id =
             excluded.evidence_policy_revision_id,
           claim_evidence_decision_id =
             excluded.claim_evidence_decision_id,
           updated_at = clock_timestamp()`,
      [
        command.claimId,
        authority.candidateId,
        authority.candidateRevisionId,
        authority.patchId,
        authority.catalogRevisionId,
        command.evidencePolicyRevisionId,
        command.decisionId,
      ],
    );

    const eventPayload = {
      associationCount: resolved.length,
      candidateId: authority.candidateId,
      candidateRevisionId: authority.candidateRevisionId,
      claimId: command.claimId,
      decision: command.decision,
      decisionId: command.decisionId,
      evidenceInputSnapshotId: command.evidenceInputSnapshotId,
      evidencePolicyRevisionId: command.evidencePolicyRevisionId,
      inputHash,
    };
    await client.query(
      `insert into audit_events
        (audit_event_id, actor_id, action, reason, correlation_id,
         policy_version, payload)
       values (
         $1, $2, 'evidence.claim_decision_recorded', $3, $4, $5,
         $6::jsonb
       )`,
      [
        randomUUID(),
        command.actorId,
        command.reason,
        command.correlationId,
        command.evidencePolicyRevisionId,
        JSON.stringify(eventPayload),
      ],
    );
    await client.query(
      `insert into outbox_events
        (outbox_event_id, aggregate_type, aggregate_id, event_type,
         payload, correlation_id)
       values (
         $1, 'candidate_claim', $2,
         'ClaimEvidenceDecisionRecorded', $3::jsonb, $4
       )`,
      [
        randomUUID(),
        command.claimId,
        JSON.stringify(eventPayload),
        command.correlationId,
      ],
    );

    const result: RecordClaimEvidenceDecisionResult = {
      claimId: command.claimId,
      decisionId: command.decisionId,
      decision: command.decision,
      evidenceInputSnapshotId: command.evidenceInputSnapshotId,
      inputHash,
      replayed: false,
    };
    await completeIdempotentCommand(
      client,
      'claim_evidence_decision',
      command.idempotencyKey,
      result,
    );
    return result;
  });
}
