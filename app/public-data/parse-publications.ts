import type {
  PublicPublicationListV1,
  PublicPublicationPayloadV1,
  PublicPublicationV1,
} from "./types.ts";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class PublicPublicationContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublicPublicationContractError";
  }
}

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PublicPublicationContractError(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(
  record: Record<string, unknown>,
  expected: readonly string[],
  path: string,
): void {
  const actual = Object.keys(record).sort();
  const required = [...expected].sort();
  if (actual.length !== required.length || actual.some((key, index) => key !== required[index])) {
    throw new PublicPublicationContractError(`${path} contains unexpected or missing fields`);
  }
}

function asNonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new PublicPublicationContractError(`${path} must be a non-empty string`);
  }
  return value;
}

function asUuid(value: unknown, path: string): string {
  const parsed = asNonEmptyString(value, path);
  if (!UUID_PATTERN.test(parsed)) {
    throw new PublicPublicationContractError(`${path} must be a UUID`);
  }
  return parsed;
}

function asPositiveInteger(value: unknown, path: string): number {
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw new PublicPublicationContractError(`${path} must be a positive integer`);
  }
  return value as number;
}

function asPublishedAt(value: unknown, path: string): string {
  const parsed = asNonEmptyString(value, path);
  if (Number.isNaN(Date.parse(parsed))) {
    throw new PublicPublicationContractError(`${path} must be a valid timestamp`);
  }
  return parsed;
}

function asExternalIds(value: unknown, path: string, minimum: number): string[] {
  if (!Array.isArray(value) || value.length < minimum) {
    throw new PublicPublicationContractError(`${path} must contain at least ${minimum} values`);
  }
  const ids = value.map((entry, index) => asNonEmptyString(entry, `${path}[${index}]`));
  if (new Set(ids).size !== ids.length) {
    throw new PublicPublicationContractError(`${path} must not contain duplicates`);
  }
  return ids;
}

function parsePayload(input: unknown, path: string): PublicPublicationPayloadV1 {
  const record = asRecord(input, path);
  assertExactKeys(record, [
    "schemaVersion",
    "mode",
    "patchKey",
    "catalogRevisionId",
    "championExternalId",
    "augmentExternalIds",
    "itemExternalIds",
  ], path);

  if (record.schemaVersion !== 1) {
    throw new PublicPublicationContractError(`${path}.schemaVersion must equal 1`);
  }
  if (record.mode !== "aram_mayhem") {
    throw new PublicPublicationContractError(`${path}.mode must equal aram_mayhem`);
  }

  return {
    schemaVersion: 1,
    mode: "aram_mayhem",
    patchKey: asNonEmptyString(record.patchKey, `${path}.patchKey`),
    catalogRevisionId: asUuid(record.catalogRevisionId, `${path}.catalogRevisionId`),
    championExternalId: asNonEmptyString(record.championExternalId, `${path}.championExternalId`),
    augmentExternalIds: asExternalIds(record.augmentExternalIds, `${path}.augmentExternalIds`, 1),
    itemExternalIds: asExternalIds(record.itemExternalIds, `${path}.itemExternalIds`, 2),
  };
}

function parsePublication(input: unknown, path: string): PublicPublicationV1 {
  const record = asRecord(input, path);
  assertExactKeys(record, [
    "publicationId",
    "candidateId",
    "candidateRevisionId",
    "publicationVersionId",
    "versionNumber",
    "publishedAt",
    "payload",
  ], path);

  return {
    publicationId: asUuid(record.publicationId, `${path}.publicationId`),
    candidateId: asUuid(record.candidateId, `${path}.candidateId`),
    candidateRevisionId: asUuid(record.candidateRevisionId, `${path}.candidateRevisionId`),
    publicationVersionId: asUuid(record.publicationVersionId, `${path}.publicationVersionId`),
    versionNumber: asPositiveInteger(record.versionNumber, `${path}.versionNumber`),
    publishedAt: asPublishedAt(record.publishedAt, `${path}.publishedAt`),
    payload: parsePayload(record.payload, `${path}.payload`),
  };
}

export function parsePublicPublicationList(input: unknown): PublicPublicationListV1 {
  const record = asRecord(input, "response");
  assertExactKeys(record, ["schemaVersion", "publications"], "response");
  if (record.schemaVersion !== 1) {
    throw new PublicPublicationContractError("response.schemaVersion must equal 1");
  }
  if (!Array.isArray(record.publications)) {
    throw new PublicPublicationContractError("response.publications must be an array");
  }

  return {
    schemaVersion: 1,
    publications: record.publications.map((entry, index) =>
      parsePublication(entry, `response.publications[${index}]`)),
  };
}
