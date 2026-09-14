import type { RegisterPatchEventCommand } from '../patch/register-patch-event.js';
import type { ActivateCatalogRevisionCommand } from './activate-catalog-revision.js';
import type { ImportCatalogRevisionCommand } from './import-catalog-revision.js';
import { normalizeCatalogSnapshot } from './normalize-catalog-snapshot.js';
import type { CatalogEntityInput, CatalogRuleInput, CatalogSnapshotV1 } from './types.js';
import type { ValidateCatalogRevisionCommand } from './validate-catalog-revision.js';

export const MAX_CATALOG_INPUT_BYTES = 8 * 1024 * 1024;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[45][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
const ENTITY_TYPES = ['champion', 'item', 'augment', 'mode'] as const;

export type CatalogOperationsInput =
  | { action: 'inspect'; snapshot: CatalogSnapshotV1 }
  | ({ action: 'register-patch' } & RegisterPatchEventCommand)
  | ({ action: 'import' } & ImportCatalogRevisionCommand)
  | ({ action: 'validate' } & ValidateCatalogRevisionCommand)
  | ({ action: 'activate' } & ActivateCatalogRevisionCommand);

function invalid(): never {
  throw new Error('CATALOG_OPERATIONS_INPUT_INVALID');
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, required: string[], optional: string[] = []): void {
  if (required.some(key => !Object.hasOwn(value, key))
    || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) invalid();
}

function text(value: unknown, max = 256): string {
  if (typeof value !== 'string' || !value || value !== value.trim()
    || Buffer.byteLength(value, 'utf8') > max || /[\u0000-\u001f\u007f]/u.test(value)) return invalid();
  return value;
}

function id(value: unknown): string {
  const result = text(value, 128);
  if (!/^[!-~]+$/u.test(result)) return invalid();
  return result;
}

function uuid(value: unknown): string {
  const result = text(value, 36);
  if (!UUID.test(result)) return invalid();
  return result.toLowerCase();
}

function integer(value: unknown, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > max) return invalid();
  return value as number;
}

function list(value: unknown, max = 20_000): unknown[] {
  if (!Array.isArray(value) || value.length > max) return invalid();
  return value;
}

function ids(value: unknown): string[] {
  return list(value).map(id);
}

function entity(value: unknown): CatalogEntityInput {
  const raw = record(value);
  keys(raw, ['entityType', 'externalId', 'displayName', 'active', 'attributes']);
  if (!ENTITY_TYPES.includes(raw.entityType as CatalogEntityInput['entityType'])
    || typeof raw.active !== 'boolean') return invalid();
  return {
    entityType: raw.entityType as CatalogEntityInput['entityType'],
    externalId: id(raw.externalId),
    displayName: text(raw.displayName, 512),
    active: raw.active,
    attributes: record(raw.attributes),
  };
}

function rule(value: unknown): CatalogRuleInput {
  const raw = record(value);
  keys(raw, ['ruleKey', 'constraintType', 'definition']);
  const definition = record(raw.definition);
  const subjects = Object.hasOwn(definition, 'subjectExternalIds')
    ? { subjectExternalIds: ids(definition.subjectExternalIds) } : {};
  const base = { modeExternalId: id(definition.modeExternalId), ...subjects };
  const ruleKey = id(raw.ruleKey);
  if (raw.constraintType === 'limit') {
    keys(definition, ['modeExternalId', 'entityType', 'maxSelections'], ['subjectExternalIds']);
    if (definition.entityType !== 'item' && definition.entityType !== 'augment') return invalid();
    return {
      ruleKey,
      constraintType: 'limit',
      definition: { ...base, entityType: definition.entityType, maxSelections: integer(definition.maxSelections) },
    };
  }
  if (raw.constraintType !== 'allow' && raw.constraintType !== 'deny') return invalid();
  keys(definition, ['modeExternalId', 'entityType', 'entityExternalIds'], ['subjectExternalIds']);
  if (definition.entityType !== 'champion' && definition.entityType !== 'item'
    && definition.entityType !== 'augment') return invalid();
  return {
    ruleKey,
    constraintType: raw.constraintType,
    definition: { ...base, entityType: definition.entityType, entityExternalIds: ids(definition.entityExternalIds) },
  };
}

function snapshot(value: unknown): CatalogSnapshotV1 {
  const raw = record(value);
  keys(raw, ['schemaVersion', 'patchKey', 'gameModeExternalId', 'source', 'entities', 'rules']);
  if (raw.schemaVersion !== 1 || raw.gameModeExternalId !== 'aram_mayhem') return invalid();
  const source = record(raw.source);
  keys(source, ['adapterVersion', 'sourceDigest']);
  const result: CatalogSnapshotV1 = {
    schemaVersion: 1,
    patchKey: id(raw.patchKey),
    gameModeExternalId: 'aram_mayhem',
    source: { adapterVersion: id(source.adapterVersion), sourceDigest: text(source.sourceDigest, 64) },
    entities: list(raw.entities).map(entity),
    rules: list(raw.rules).map(rule),
  };
  // Reuse the same canonical identity and duplicate checks as the import authority.
  return normalizeCatalogSnapshot(result).snapshot;
}

export function parseCatalogOperationsInput(stdin: string): CatalogOperationsInput {
  try {
    if (Buffer.byteLength(stdin, 'utf8') > MAX_CATALOG_INPUT_BYTES) return invalid();
    const raw = record(JSON.parse(stdin));
    if (raw.action === 'inspect') {
      keys(raw, ['action', 'snapshot']);
      return { action: 'inspect', snapshot: snapshot(raw.snapshot) };
    }

    const commonKeys = ['action', 'actorId', 'correlationId'];
    const common = { actorId: text(raw.actorId), correlationId: text(raw.correlationId) };
    if (raw.action === 'register-patch') {
      keys(raw, [...commonKeys, 'patchId', 'patchKey', 'displayLabel', 'eventId', 'lifecycleState', 'occurredAt', 'reason']);
      if (!['announced', 'active', 'superseded', 'withdrawn'].includes(raw.lifecycleState as string)) return invalid();
      const timestamp = text(raw.occurredAt, 32);
      const occurredAt = new Date(timestamp);
      if (!Number.isFinite(occurredAt.getTime()) || occurredAt.toISOString() !== timestamp) return invalid();
      return {
        ...common,
        action: 'register-patch',
        patchId: uuid(raw.patchId),
        patchKey: id(raw.patchKey),
        displayLabel: text(raw.displayLabel, 128),
        eventId: uuid(raw.eventId),
        lifecycleState: raw.lifecycleState as RegisterPatchEventCommand['lifecycleState'],
        occurredAt,
        reason: text(raw.reason, 1024),
      };
    }
    if (raw.action === 'import') {
      keys(raw, [...commonKeys, 'catalogRevisionId', 'patchId', 'revision', 'sourceId', 'sourcePolicyRevisionId', 'idempotencyKey', 'snapshot']);
      return {
        ...common,
        action: 'import',
        catalogRevisionId: uuid(raw.catalogRevisionId),
        patchId: uuid(raw.patchId),
        revision: integer(raw.revision, 2_147_483_647),
        sourceId: uuid(raw.sourceId),
        sourcePolicyRevisionId: uuid(raw.sourcePolicyRevisionId),
        idempotencyKey: text(raw.idempotencyKey),
        snapshot: snapshot(raw.snapshot),
      };
    }
    if (raw.action === 'validate') {
      keys(raw, [...commonKeys, 'catalogRevisionId', 'catalogValidationResultId', 'validatorRulesetVersion', 'reason']);
      if (raw.validatorRulesetVersion !== 'catalog-rules-v1') return invalid();
      return {
        ...common,
        action: 'validate',
        catalogRevisionId: uuid(raw.catalogRevisionId),
        catalogValidationResultId: uuid(raw.catalogValidationResultId),
        validatorRulesetVersion: 'catalog-rules-v1',
        reason: text(raw.reason, 1024),
      };
    }
    if (raw.action === 'activate') {
      keys(raw, [...commonKeys, 'catalogRevisionId', 'patchId', 'expectedCurrentCatalogRevisionId', 'reason']);
      return {
        ...common,
        action: 'activate',
        catalogRevisionId: uuid(raw.catalogRevisionId),
        patchId: uuid(raw.patchId),
        expectedCurrentCatalogRevisionId: raw.expectedCurrentCatalogRevisionId === null
          ? null : uuid(raw.expectedCurrentCatalogRevisionId),
        reason: text(raw.reason, 1024),
      };
    }
    return invalid();
  } catch {
    return invalid();
  }
}
