export type PublicPublicationPayloadV1 = {
  schemaVersion: 1;
  mode: "aram_mayhem";
  patchKey: string;
  catalogRevisionId: string;
  championExternalId: string;
  augmentExternalIds: string[];
  itemExternalIds: string[];
};

export type PublicPublicationV1 = {
  publicationId: string;
  candidateId: string;
  candidateRevisionId: string;
  publicationVersionId: string;
  versionNumber: number;
  publishedAt: string;
  payload: PublicPublicationPayloadV1;
};

export type PublicPublicationListV1 = {
  schemaVersion: 1;
  publications: PublicPublicationV1[];
};

export type PublicDataStatus = "static" | "loading" | "live" | "fallback";

export type PublicPublicationMetadata = {
  publicationId: string;
  publicationVersionId: string;
  versionNumber: number;
  patchKey: string;
  publishedAt: string;
};
