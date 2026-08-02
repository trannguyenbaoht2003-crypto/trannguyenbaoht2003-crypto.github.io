import type { Augment, ChampionGuide, ItemAsset } from "../data.ts";
import type { PublicPublicationMetadata, PublicPublicationV1 } from "./types.ts";

export type PublicChampionGuide = ChampionGuide & {
  publicPublication?: PublicPublicationMetadata;
};

function normalizeExternalId(value: string): string {
  return value.trim().toLocaleLowerCase("en-US");
}

function publicationPriority(left: PublicPublicationV1, right: PublicPublicationV1): number {
  const publishedAt = Date.parse(left.publishedAt) - Date.parse(right.publishedAt);
  if (publishedAt !== 0) return publishedAt;
  const version = left.versionNumber - right.versionNumber;
  if (version !== 0) return version;
  return left.publicationId.localeCompare(right.publicationId, "en");
}

function addAugments(target: Map<string, Augment>, augments: readonly Augment[]): void {
  for (const augment of augments) {
    if (augment.id === undefined) continue;
    const key = String(augment.id);
    if (!target.has(key)) target.set(key, augment);
  }
}

function addItems(target: Map<string, ItemAsset>, items: readonly ItemAsset[]): void {
  for (const item of items) {
    if (item.id === undefined) continue;
    const key = String(item.id);
    if (!target.has(key)) target.set(key, item);
  }
}

export function mergePublicationsIntoGuides(
  guides: readonly ChampionGuide[],
  publications: readonly PublicPublicationV1[],
): PublicChampionGuide[] {
  const augmentById = new Map<string, Augment>();
  const itemById = new Map<string, ItemAsset>();

  for (const guide of guides) {
    addAugments(augmentById, [
      ...guide.coreAugments,
      ...guide.prismatic,
      ...guide.gold,
      ...guide.silver,
      ...(guide.communityBuilds ?? []).flatMap((build) => build.coreAugments),
    ]);
    addItems(itemById, [
      ...(guide.itemData ?? []),
      ...(guide.communityBuilds ?? []).flatMap((build) => build.itemData),
    ]);
  }

  const publicationByChampion = new Map<string, PublicPublicationV1>();
  for (const publication of publications) {
    const augmentIds = publication.payload.augmentExternalIds;
    const itemIds = publication.payload.itemExternalIds;
    if (
      publication.payload.mode !== "aram_mayhem"
      || augmentIds.length < 1
      || itemIds.length < 2
      || new Set(augmentIds).size !== augmentIds.length
      || new Set(itemIds).size !== itemIds.length
    ) {
      continue;
    }

    const championKey = normalizeExternalId(publication.payload.championExternalId);
    const current = publicationByChampion.get(championKey);
    if (!current || publicationPriority(publication, current) > 0) {
      publicationByChampion.set(championKey, publication);
    }
  }

  return guides.map((guide) => {
    const publication = publicationByChampion.get(normalizeExternalId(guide.id));
    if (!publication) return guide;

    const coreAugments = publication.payload.augmentExternalIds.map((id) => augmentById.get(id));
    const itemData = publication.payload.itemExternalIds.map((id) => itemById.get(id));
    if (coreAugments.some((value) => value === undefined) || itemData.some((value) => value === undefined)) {
      return guide;
    }

    const resolvedAugments = coreAugments as Augment[];
    const resolvedItems = itemData as ItemAsset[];
    return {
      ...guide,
      coreAugments: resolvedAugments,
      items: resolvedItems.map((item) => item.name),
      itemData: resolvedItems,
      publicPublication: {
        publicationId: publication.publicationId,
        publicationVersionId: publication.publicationVersionId,
        versionNumber: publication.versionNumber,
        patchKey: publication.payload.patchKey,
        publishedAt: publication.publishedAt,
      },
    };
  });
}
