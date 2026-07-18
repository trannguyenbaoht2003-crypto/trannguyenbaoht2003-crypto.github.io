export interface ReviewCatalogEntry<Id extends string | number = string | number> {
  id: Id;
  vi: string;
  cn: string;
  icon: string;
}

export interface ReviewCatalog {
  champions: ReviewCatalogEntry<string>[];
  augments: ReviewCatalogEntry<number>[];
  items: ReviewCatalogEntry<number>[];
}

export function buildReviewCatalog(guides?: unknown[]): ReviewCatalog;
