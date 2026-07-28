import { hashCanonicalJson } from '../../shared/hash.js';
import type {
  CatalogEntityType,
  CatalogLimitRuleDefinition,
  CatalogMembershipRuleDefinition,
  CatalogRuleInput,
  CatalogSnapshotV1,
  NormalizedCatalogSnapshot,
  SelectableCatalogEntityType,
} from './types.js';

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const ENTITY_TYPES = new Set<CatalogEntityType>([
  'champion',
  'item',
  'augment',
  'mode',
]);
const SELECTABLE_ENTITY_TYPES = new Set<SelectableCatalogEntityType>([
  'champion',
  'item',
  'augment',
]);

function requiredText(value: unknown, code: string): string {
  if (typeof value !== 'string') {
    throw new Error(code);
  }
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(code);
  }
  return normalized;
}

function sortedUnique(values: unknown, code: string): string[] {
  if (!Array.isArray(values)) {
    throw new Error(code);
  }
  const normalized = values
    .map((value) => requiredText(value, code))
    .sort((left, right) => left.localeCompare(right));
  if (new Set(normalized).size !== normalized.length) {
    throw new Error(code);
  }
  return normalized;
}

function normalizeSubjects(
  value: string[] | undefined,
): { subjectExternalIds?: string[] } {
  if (value === undefined) {
    return {};
  }
  return {
    subjectExternalIds: sortedUnique(
      value,
      'CATALOG_DUPLICATE_RULE_REFERENCE',
    ),
  };
}

function normalizeRule(rule: CatalogRuleInput): CatalogRuleInput {
  const ruleKey = requiredText(rule.ruleKey, 'CATALOG_RULE_KEY_REQUIRED');
  const modeExternalId = requiredText(
    rule.definition.modeExternalId,
    'CATALOG_RULE_MODE_REQUIRED',
  );

  if (rule.constraintType === 'limit') {
    const definition: CatalogLimitRuleDefinition = rule.definition;
    if (
      !Number.isInteger(definition.maxSelections)
      || definition.maxSelections <= 0
      || !['item', 'augment'].includes(definition.entityType)
    ) {
      throw new Error('CATALOG_LIMIT_INVALID');
    }
    return {
      ruleKey,
      constraintType: 'limit',
      definition: {
        modeExternalId,
        entityType: definition.entityType,
        maxSelections: definition.maxSelections,
        ...normalizeSubjects(definition.subjectExternalIds),
      },
    };
  }

  const definition: CatalogMembershipRuleDefinition = rule.definition;
  if (!SELECTABLE_ENTITY_TYPES.has(definition.entityType)) {
    throw new Error('CATALOG_RULE_ENTITY_TYPE_INVALID');
  }
  return {
    ruleKey,
    constraintType: rule.constraintType,
    definition: {
      modeExternalId,
      entityType: definition.entityType,
      entityExternalIds: sortedUnique(
        definition.entityExternalIds,
        'CATALOG_DUPLICATE_RULE_REFERENCE',
      ),
      ...normalizeSubjects(definition.subjectExternalIds),
    },
  };
}

export function normalizeCatalogSnapshot(
  input: CatalogSnapshotV1,
): NormalizedCatalogSnapshot {
  if (input.schemaVersion !== 1) {
    throw new Error('CATALOG_SCHEMA_UNSUPPORTED');
  }
  if (input.gameModeExternalId !== 'aram_mayhem') {
    throw new Error('CATALOG_MODE_UNSUPPORTED');
  }
  if (!SHA256_PATTERN.test(input.source.sourceDigest)) {
    throw new Error('CATALOG_SOURCE_DIGEST_INVALID');
  }

  const identities = new Set<string>();
  const entities = input.entities
    .map((entity) => {
      if (!ENTITY_TYPES.has(entity.entityType)) {
        throw new Error('CATALOG_ENTITY_TYPE_INVALID');
      }
      const externalId = requiredText(
        entity.externalId,
        'CATALOG_ENTITY_ID_REQUIRED',
      );
      const identity = entity.entityType + ':' + externalId;
      if (identities.has(identity)) {
        throw new Error('CATALOG_DUPLICATE_ENTITY');
      }
      identities.add(identity);
      if (
        entity.attributes === null
        || typeof entity.attributes !== 'object'
        || Array.isArray(entity.attributes)
      ) {
        throw new Error('CATALOG_ENTITY_ATTRIBUTES_INVALID');
      }
      return {
        entityType: entity.entityType,
        externalId,
        displayName: requiredText(
          entity.displayName,
          'CATALOG_ENTITY_NAME_REQUIRED',
        ),
        active: entity.active,
        attributes: entity.attributes,
      };
    })
    .sort((left, right) => (
      left.entityType.localeCompare(right.entityType)
      || left.externalId.localeCompare(right.externalId)
    ));

  const activeModes = entities.filter((entity) => (
    entity.entityType === 'mode'
    && entity.externalId === 'aram_mayhem'
    && entity.active
  ));
  if (activeModes.length !== 1) {
    throw new Error('CATALOG_MODE_REQUIRED');
  }

  const rules = input.rules.map(normalizeRule);
  const ruleKeys = rules.map((rule) => rule.ruleKey);
  if (new Set(ruleKeys).size !== ruleKeys.length) {
    throw new Error('CATALOG_DUPLICATE_RULE_KEY');
  }
  rules.sort((left, right) => left.ruleKey.localeCompare(right.ruleKey));

  const snapshot: CatalogSnapshotV1 = {
    schemaVersion: 1,
    patchKey: requiredText(input.patchKey, 'CATALOG_PATCH_KEY_REQUIRED'),
    gameModeExternalId: 'aram_mayhem',
    source: {
      adapterVersion: requiredText(
        input.source.adapterVersion,
        'CATALOG_ADAPTER_VERSION_REQUIRED',
      ),
      sourceDigest: input.source.sourceDigest,
    },
    entities,
    rules,
  };

  return {
    snapshot,
    contentHash: hashCanonicalJson(snapshot),
  };
}
