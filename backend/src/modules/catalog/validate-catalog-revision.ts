import { randomUUID } from 'node:crypto';

import type { Pool, PoolClient } from 'pg';

import { withTransaction } from '../../database/transaction.js';
import { normalizeCatalogSnapshot } from './normalize-catalog-snapshot.js';
import type {
  CatalogEntityInput,
  CatalogEntityType,
  CatalogMembershipRuleDefinition,
  CatalogLimitRuleDefinition,
  CatalogRuleInput,
  CatalogSnapshotV1,
  CatalogValidationReasonCode,
  SelectableCatalogEntityType,
} from './types.js';

interface RevisionIdentityRow {
  patch_id: string;
}

interface CatalogAuthorityRow {
  adapter_version: string;
  content_hash: string;
  entity_count: number;
  game_mode_external_id: string;
  patch_key: string;
  patch_lifecycle_state: string | null;
  rule_count: number;
  source_digest: string;
}

interface CatalogEntityRow {
  active: boolean;
  attributes: Record<string, unknown>;
  canonical_external_id: string;
  display_name: string;
  entity_type: CatalogEntityType;
}

interface CatalogRuleRow {
  constraint_type: string;
  definition: unknown;
  rule_key: string;
}

export interface ValidateCatalogRevisionCommand {
  actorId: string;
  catalogRevisionId: string;
  catalogValidationResultId: string;
  correlationId: string;
  reason: string;
  validatorRulesetVersion: 'catalog-rules-v1';
}

export interface ValidateCatalogRevisionResult {
  catalogRevisionId: string;
  contentHash: string;
  reasonCodes: CatalogValidationReasonCode[];
  result: 'passed' | 'failed';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function parseSubjects(
  definition: Record<string, unknown>,
): { subjectExternalIds?: string[] } | null {
  const subjects = definition.subjectExternalIds;
  if (subjects === undefined) {
    return {};
  }
  if (!isStringArray(subjects)) {
    return null;
  }
  return { subjectExternalIds: subjects };
}

function parseRule(row: CatalogRuleRow): CatalogRuleInput | null {
  if (!isRecord(row.definition)) {
    return null;
  }
  const modeExternalId = row.definition.modeExternalId;
  const entityType = row.definition.entityType;
  const subjects = parseSubjects(row.definition);
  if (
    typeof modeExternalId !== 'string'
    || subjects === null
  ) {
    return null;
  }

  if (row.constraint_type === 'limit') {
    const maxSelections = row.definition.maxSelections;
    if (
      (entityType !== 'item' && entityType !== 'augment')
      || typeof maxSelections !== 'number'
      || !Number.isInteger(maxSelections)
    ) {
      return null;
    }
    const definition: CatalogLimitRuleDefinition = {
      modeExternalId,
      entityType,
      maxSelections,
      ...subjects,
    };
    return {
      constraintType: 'limit',
      definition,
      ruleKey: row.rule_key,
    };
  }

  if (row.constraint_type !== 'allow' && row.constraint_type !== 'deny') {
    return null;
  }
  if (
    entityType !== 'champion'
    && entityType !== 'item'
    && entityType !== 'augment'
  ) {
    return null;
  }
  const entityExternalIds = row.definition.entityExternalIds;
  if (!isStringArray(entityExternalIds)) {
    return null;
  }
  const definition: CatalogMembershipRuleDefinition = {
    entityExternalIds,
    entityType: entityType as SelectableCatalogEntityType,
    modeExternalId,
    ...subjects,
  };
  return {
    constraintType: row.constraint_type,
    definition,
    ruleKey: row.rule_key,
  };
}

function addReferenceReasons(
  reasonCodes: Set<CatalogValidationReasonCode>,
  entities: CatalogEntityInput[],
  rules: CatalogRuleInput[],
  gameModeExternalId: string,
): void {
  const byIdentity = new Map(
    entities.map((entity) => [
      entity.entityType + ':' + entity.externalId,
      entity,
    ]),
  );
  const activeMode = byIdentity.get('mode:' + gameModeExternalId);
  if (!activeMode?.active) {
    reasonCodes.add('CATALOG_MODE_MISSING');
  }

  const checkReference = (
    entityType: CatalogEntityType,
    externalId: string,
  ): void => {
    const entity = byIdentity.get(entityType + ':' + externalId);
    if (!entity) {
      reasonCodes.add('CATALOG_RULE_REFERENCE_MISSING');
    } else if (!entity.active) {
      reasonCodes.add('CATALOG_ENTITY_INACTIVE');
    }
  };

  for (const rule of rules) {
    if (rule.definition.modeExternalId !== gameModeExternalId) {
      reasonCodes.add('CATALOG_RULE_REFERENCE_MISSING');
    } else {
      checkReference('mode', rule.definition.modeExternalId);
    }

    for (const subjectId of rule.definition.subjectExternalIds ?? []) {
      checkReference('champion', subjectId);
    }
    if (rule.constraintType !== 'limit') {
      for (const externalId of rule.definition.entityExternalIds) {
        checkReference(rule.definition.entityType, externalId);
      }
    }
  }
}

async function loadCatalogAuthority(
  client: PoolClient,
  catalogRevisionId: string,
): Promise<CatalogAuthorityRow> {
  const identity = await client.query<RevisionIdentityRow>(
    `select patch_id
       from catalog_revisions
      where catalog_revision_id = $1`,
    [catalogRevisionId],
  );
  const patchId = identity.rows[0]?.patch_id;
  if (!patchId) {
    throw new Error('CATALOG_REVISION_NOT_FOUND');
  }

  const authority = await client.query<CatalogAuthorityRow>(
    `select seal.adapter_version,
            seal.content_hash,
            seal.entity_count,
            seal.game_mode_external_id,
            p.patch_key,
            seal.rule_count,
            seal.source_digest,
            (
              select ple.lifecycle_state
                from patch_lifecycle_events ple
               where ple.patch_id = p.patch_id
               order by ple.occurred_at desc,
                        ple.created_at desc,
                        ple.patch_lifecycle_event_id desc
               limit 1
            ) as patch_lifecycle_state
       from patches p
       join catalog_revisions cr
         on cr.patch_id = p.patch_id
       join catalog_revision_seals seal
         on seal.catalog_revision_id = cr.catalog_revision_id
      where p.patch_id = $1
        and cr.catalog_revision_id = $2
      for update of p`,
    [patchId, catalogRevisionId],
  );
  const row = authority.rows[0];
  if (!row) {
    throw new Error('CATALOG_REVISION_NOT_SEALED');
  }
  return row;
}

export async function validateCatalogRevision(
  pool: Pool,
  command: ValidateCatalogRevisionCommand,
): Promise<ValidateCatalogRevisionResult> {
  return withTransaction(pool, async (client) => {
    const authority = await loadCatalogAuthority(
      client,
      command.catalogRevisionId,
    );
    const entityResult = await client.query<CatalogEntityRow>(
      `select ger.active,
              ger.attributes,
              ge.canonical_external_id,
              ger.display_name,
              ge.entity_type
         from game_entity_revisions ger
         join game_entities ge
           on ge.game_entity_id = ger.game_entity_id
        where ger.catalog_revision_id = $1
        order by ge.entity_type, ge.canonical_external_id`,
      [command.catalogRevisionId],
    );
    const ruleResult = await client.query<CatalogRuleRow>(
      `select constraint_type, definition, rule_key
         from compatibility_rules
        where catalog_revision_id = $1
        order by rule_key`,
      [command.catalogRevisionId],
    );

    const reasonCodes = new Set<CatalogValidationReasonCode>();
    if (authority.patch_lifecycle_state !== 'active') {
      reasonCodes.add('CATALOG_PATCH_NOT_ACTIVE');
    }
    if (
      entityResult.rows.length !== authority.entity_count
      || ruleResult.rows.length !== authority.rule_count
    ) {
      reasonCodes.add('CATALOG_CONTENT_HASH_MISMATCH');
    }

    const entities: CatalogEntityInput[] = entityResult.rows.map((row) => ({
      active: row.active,
      attributes: row.attributes,
      displayName: row.display_name,
      entityType: row.entity_type,
      externalId: row.canonical_external_id,
    }));
    const rules: CatalogRuleInput[] = [];
    let rulesHaveValidShape = true;
    for (const row of ruleResult.rows) {
      const rule = parseRule(row);
      if (!rule) {
        rulesHaveValidShape = false;
        reasonCodes.add('CATALOG_RULE_SHAPE_INVALID');
      } else {
        rules.push(rule);
        if (
          rule.constraintType === 'limit'
          && rule.definition.maxSelections <= 0
        ) {
          reasonCodes.add('CATALOG_SELECTION_LIMIT_INVALID');
        }
      }
    }

    if (authority.game_mode_external_id !== 'aram_mayhem') {
      reasonCodes.add('CATALOG_MODE_MISSING');
    } else {
      addReferenceReasons(
        reasonCodes,
        entities,
        rules,
        authority.game_mode_external_id,
      );

      if (rulesHaveValidShape) {
        const snapshot: CatalogSnapshotV1 = {
          entities,
          gameModeExternalId: 'aram_mayhem',
          patchKey: authority.patch_key,
          rules,
          schemaVersion: 1,
          source: {
            adapterVersion: authority.adapter_version,
            sourceDigest: authority.source_digest,
          },
        };
        try {
          const normalized = normalizeCatalogSnapshot(snapshot);
          if (normalized.contentHash !== authority.content_hash) {
            reasonCodes.add('CATALOG_CONTENT_HASH_MISMATCH');
          }
        } catch (error) {
          const code = error instanceof Error ? error.message : '';
          if (code === 'CATALOG_MODE_REQUIRED') {
            reasonCodes.add('CATALOG_MODE_MISSING');
          } else if (code === 'CATALOG_LIMIT_INVALID') {
            reasonCodes.add('CATALOG_SELECTION_LIMIT_INVALID');
          } else {
            reasonCodes.add('CATALOG_RULE_SHAPE_INVALID');
          }
        }
      }
    }

    const sortedReasonCodes = [...reasonCodes].sort((left, right) => (
      left.localeCompare(right)
    ));
    const result: ValidateCatalogRevisionResult['result'] = (
      sortedReasonCodes.length === 0 ? 'passed' : 'failed'
    );
    await client.query(
      `insert into catalog_validation_results
        (catalog_validation_result_id, catalog_revision_id,
         sealed_content_hash, validator_ruleset_version, result,
         reason_codes, validated_by)
       values ($1, $2, $3, $4, $5, $6::text[], $7)`,
      [
        command.catalogValidationResultId,
        command.catalogRevisionId,
        authority.content_hash,
        command.validatorRulesetVersion,
        result,
        sortedReasonCodes,
        command.actorId,
      ],
    );
    await client.query(
      `insert into catalog_lifecycle_events
        (catalog_lifecycle_event_id, catalog_revision_id,
         lifecycle_state, reason, actor_id, correlation_id)
       values ($1, $2, 'validated', $3, $4, $5)`,
      [
        randomUUID(),
        command.catalogRevisionId,
        command.reason,
        command.actorId,
        command.correlationId,
      ],
    );

    const eventPayload = {
      catalogRevisionId: command.catalogRevisionId,
      contentHash: authority.content_hash,
      reasonCodes: sortedReasonCodes,
      result,
      validatorRulesetVersion: command.validatorRulesetVersion,
    };
    await client.query(
      `insert into audit_events
        (audit_event_id, actor_id, action, reason, correlation_id,
         policy_version, payload)
       values ($1, $2, 'catalog.revision_validated', $3, $4, $5,
               $6::jsonb)`,
      [
        randomUUID(),
        command.actorId,
        command.reason,
        command.correlationId,
        command.validatorRulesetVersion,
        JSON.stringify(eventPayload),
      ],
    );
    await client.query(
      `insert into outbox_events
        (outbox_event_id, aggregate_type, aggregate_id, event_type,
         payload, correlation_id)
       values ($1, 'catalog_revision', $2,
               'CatalogRevisionValidated', $3::jsonb, $4)`,
      [
        randomUUID(),
        command.catalogRevisionId,
        JSON.stringify(eventPayload),
        command.correlationId,
      ],
    );

    return {
      catalogRevisionId: command.catalogRevisionId,
      contentHash: authority.content_hash,
      reasonCodes: sortedReasonCodes,
      result,
    };
  });
}
