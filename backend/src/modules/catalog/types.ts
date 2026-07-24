export type CatalogEntityType = 'champion' | 'item' | 'augment' | 'mode';
export type SelectableCatalogEntityType = Exclude<CatalogEntityType, 'mode'>;
export type CatalogConstraintType = 'allow' | 'deny' | 'limit';

export interface CatalogEntityInput {
  entityType: CatalogEntityType;
  externalId: string;
  displayName: string;
  active: boolean;
  attributes: Record<string, unknown>;
}

export interface CatalogMembershipRuleDefinition {
  modeExternalId: string;
  entityType: SelectableCatalogEntityType;
  entityExternalIds: string[];
  subjectExternalIds?: string[];
}

export interface CatalogLimitRuleDefinition {
  modeExternalId: string;
  entityType: 'item' | 'augment';
  maxSelections: number;
  subjectExternalIds?: string[];
}

export type CatalogRuleInput =
  | {
      ruleKey: string;
      constraintType: 'allow' | 'deny';
      definition: CatalogMembershipRuleDefinition;
    }
  | {
      ruleKey: string;
      constraintType: 'limit';
      definition: CatalogLimitRuleDefinition;
    };

export interface CatalogSnapshotV1 {
  schemaVersion: 1;
  patchKey: string;
  gameModeExternalId: 'aram_mayhem';
  source: {
    adapterVersion: string;
    sourceDigest: string;
  };
  entities: CatalogEntityInput[];
  rules: CatalogRuleInput[];
}

export interface NormalizedCatalogSnapshot {
  contentHash: string;
  snapshot: CatalogSnapshotV1;
}

export type CatalogValidationReasonCode =
  | 'CATALOG_CONTENT_HASH_MISMATCH'
  | 'CATALOG_PATCH_NOT_ACTIVE'
  | 'CATALOG_PATCH_MISMATCH'
  | 'CATALOG_MODE_MISSING'
  | 'CATALOG_ENTITY_REFERENCE_MISSING'
  | 'CATALOG_ENTITY_INACTIVE'
  | 'CATALOG_RULE_SHAPE_INVALID'
  | 'CATALOG_RULE_REFERENCE_MISSING'
  | 'CATALOG_SELECTION_LIMIT_INVALID';

export type CatalogSelectionReasonCode =
  | 'CATALOG_REVISION_NOT_ACTIVE'
  | 'CATALOG_SELECTION_DUPLICATE_ID'
  | 'CATALOG_ENTITY_MISSING'
  | 'CATALOG_ENTITY_INACTIVE'
  | 'CATALOG_SELECTION_DENIED'
  | 'CATALOG_SELECTION_NOT_ALLOWED'
  | 'CATALOG_SELECTION_LIMIT_EXCEEDED';
