import type { Pool } from 'pg';

import type {
  CatalogSelectionReasonCode,
  SelectableCatalogEntityType,
} from './types.js';

interface ActiveCatalogRow {
  catalog_revision_id: string;
}

interface SelectedEntityRow {
  active: boolean;
  canonical_external_id: string;
  entity_type: SelectableCatalogEntityType;
}

interface CatalogRuleRow {
  constraint_type: string;
  definition: unknown;
}

export interface CatalogSelectionInput {
  augmentExternalIds: string[];
  catalogRevisionId: string;
  championExternalId: string;
  gameModeExternalId: 'aram_mayhem';
  itemExternalIds: string[];
  patchId: string;
}

export interface CatalogSelectionResult {
  reasonCodes: CatalogSelectionReasonCode[];
  valid: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasDuplicates(values: string[]): boolean {
  return new Set(values).size !== values.length;
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    return null;
  }
  return value;
}

function selectedByType(
  input: CatalogSelectionInput,
): Record<SelectableCatalogEntityType, string[]> {
  return {
    augment: input.augmentExternalIds,
    champion: [input.championExternalId],
    item: input.itemExternalIds,
  };
}

export async function validateCatalogSelection(
  pool: Pool,
  input: CatalogSelectionInput,
): Promise<CatalogSelectionResult> {
  const activeResult = await pool.query<ActiveCatalogRow>(
    `select catalog_revision_id
       from active_catalog_revisions
      where patch_id = $1
        and game_mode_external_id = $2
        and catalog_revision_id = $3`,
    [
      input.patchId,
      input.gameModeExternalId,
      input.catalogRevisionId,
    ],
  );
  if (activeResult.rowCount !== 1) {
    return {
      reasonCodes: ['CATALOG_REVISION_NOT_ACTIVE'],
      valid: false,
    };
  }

  const reasonCodes = new Set<CatalogSelectionReasonCode>();
  if (
    hasDuplicates(input.augmentExternalIds)
    || hasDuplicates(input.itemExternalIds)
  ) {
    reasonCodes.add('CATALOG_SELECTION_DUPLICATE_ID');
  }

  const selections = selectedByType(input);
  const entityResult = await pool.query<SelectedEntityRow>(
    `select ger.active,
            ge.canonical_external_id,
            ge.entity_type
       from game_entity_revisions ger
       join game_entities ge
         on ge.game_entity_id = ger.game_entity_id
      where ger.catalog_revision_id = $1
        and (
          (ge.entity_type = 'champion'
            and ge.canonical_external_id = $2)
          or
          (ge.entity_type = 'augment'
            and ge.canonical_external_id = any($3::text[]))
          or
          (ge.entity_type = 'item'
            and ge.canonical_external_id = any($4::text[]))
        )`,
    [
      input.catalogRevisionId,
      input.championExternalId,
      input.augmentExternalIds,
      input.itemExternalIds,
    ],
  );
  const entities = new Map(
    entityResult.rows.map((row) => [
      row.entity_type + ':' + row.canonical_external_id,
      row,
    ]),
  );
  for (const [entityType, externalIds] of Object.entries(selections) as [
    SelectableCatalogEntityType,
    string[],
  ][]) {
    for (const externalId of new Set(externalIds)) {
      const entity = entities.get(entityType + ':' + externalId);
      if (!entity) {
        reasonCodes.add('CATALOG_ENTITY_MISSING');
      } else if (!entity.active) {
        reasonCodes.add('CATALOG_ENTITY_INACTIVE');
      }
    }
  }

  const ruleResult = await pool.query<CatalogRuleRow>(
    `select constraint_type, definition
       from compatibility_rules
      where catalog_revision_id = $1
      order by rule_key`,
    [input.catalogRevisionId],
  );
  const allowedByType = new Map<
    SelectableCatalogEntityType,
    Set<string>
  >();

  for (const row of ruleResult.rows) {
    if (!isRecord(row.definition)) {
      continue;
    }
    const modeExternalId = row.definition.modeExternalId;
    const entityType = row.definition.entityType;
    if (
      modeExternalId !== input.gameModeExternalId
      || (
        entityType !== 'champion'
        && entityType !== 'augment'
        && entityType !== 'item'
      )
    ) {
      continue;
    }

    const subjectValue = row.definition.subjectExternalIds;
    if (subjectValue !== undefined) {
      const subjects = stringArray(subjectValue);
      if (!subjects?.includes(input.championExternalId)) {
        continue;
      }
    }

    const selectedIds = selections[entityType];
    if (row.constraint_type === 'limit') {
      const maxSelections = row.definition.maxSelections;
      if (
        typeof maxSelections === 'number'
        && Number.isInteger(maxSelections)
        && selectedIds.length > maxSelections
      ) {
        reasonCodes.add('CATALOG_SELECTION_LIMIT_EXCEEDED');
      }
      continue;
    }

    const memberIds = stringArray(row.definition.entityExternalIds);
    if (memberIds === null) {
      continue;
    }
    if (row.constraint_type === 'deny') {
      if (selectedIds.some((externalId) => memberIds.includes(externalId))) {
        reasonCodes.add('CATALOG_SELECTION_DENIED');
      }
      continue;
    }
    if (row.constraint_type === 'allow') {
      let allowed = allowedByType.get(entityType);
      if (!allowed) {
        allowed = new Set<string>();
        allowedByType.set(entityType, allowed);
      }
      for (const externalId of memberIds) {
        allowed.add(externalId);
      }
    }
  }

  for (const [entityType, allowedIds] of allowedByType) {
    if (
      selections[entityType].some(
        (externalId) => !allowedIds.has(externalId),
      )
    ) {
      reasonCodes.add('CATALOG_SELECTION_NOT_ALLOWED');
    }
  }

  const sortedReasonCodes = [...reasonCodes].sort((left, right) => (
    left.localeCompare(right)
  ));
  return {
    reasonCodes: sortedReasonCodes,
    valid: sortedReasonCodes.length === 0,
  };
}
