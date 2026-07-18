export const REVIEW_PACKAGE_SCHEMA_VERSION = 1;
export const REVIEW_EVIDENCE_VERSION = "3.1";

const REVIEWABLE_EVIDENCE_STATES = new Set([
  "image-review-required",
  "translation-review-required",
]);
const PACKAGE_KEYS = new Set(["schemaVersion", "evidenceVersion", "generatedAt", "reviews"]);
const OVERRIDE_KEYS = new Set(["schemaVersion", "evidenceVersion", "updatedAt", "reviews"]);
const REVIEW_KEYS = new Set([
  "candidateId",
  "url",
  "championId",
  "augmentIds",
  "itemIds",
  "attested",
]);
const STORED_REVIEW_KEYS = new Set([...REVIEW_KEYS, "reviewedAt"]);

function fail(message) {
  throw new Error(`Evidence v3.1: ${message}`);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requireExactKeys(value, allowed, label) {
  if (!isPlainObject(value)) fail(`${label} phải là object`);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`${label} có trường không được phép: ${key}`);
  }
  for (const key of allowed) {
    if (!(key in value)) fail(`${label} thiếu trường bắt buộc: ${key}`);
  }
}

function requireIsoDate(value, label) {
  if (typeof value !== "string" || !value || Number.isNaN(Date.parse(value))) {
    fail(`${label} không phải ngày ISO hợp lệ`);
  }
  return value;
}

function firstChineseAlias(guide) {
  return (guide.aliases ?? []).find((alias) => typeof alias === "string" && /\p{Script=Han}/u.test(alias))
    ?? guide.name;
}

function compareCatalogEntries(left, right) {
  return String(left.vi).localeCompare(String(right.vi), "vi")
    || String(left.cn).localeCompare(String(right.cn), "zh-CN")
    || String(left.id).localeCompare(String(right.id), "en", { numeric: true });
}

function addCatalogEntry(map, entry) {
  if (entry?.id === undefined || !entry.vi || !entry.cn || !entry.icon) return;
  if (!map.has(entry.id)) map.set(entry.id, entry);
}

export function buildReviewCatalog(guides = []) {
  if (!Array.isArray(guides)) fail("catalog guide phải là mảng");
  const champions = new Map();
  const augments = new Map();
  const items = new Map();

  for (const guide of guides) {
    addCatalogEntry(champions, {
      id: guide?.id,
      vi: guide?.name,
      cn: firstChineseAlias(guide ?? {}),
      icon: guide?.icon,
    });
    for (const augment of [
      ...(guide?.coreAugments ?? []),
      ...(guide?.prismatic ?? []),
      ...(guide?.gold ?? []),
      ...(guide?.silver ?? []),
    ]) {
      addCatalogEntry(augments, {
        id: augment?.id,
        vi: augment?.vi,
        cn: augment?.cn,
        icon: augment?.icon,
      });
    }
    for (const item of guide?.itemData ?? []) {
      addCatalogEntry(items, {
        id: item?.id,
        vi: item?.name,
        cn: item?.original,
        icon: item?.icon,
      });
    }
  }

  return {
    champions: [...champions.values()].sort(compareCatalogEntries),
    augments: [...augments.values()].sort(compareCatalogEntries),
    items: [...items.values()].sort(compareCatalogEntries),
  };
}

function catalogIndex(catalog = {}) {
  return {
    champions: new Map((catalog.champions ?? []).map((entry) => [entry.id, entry])),
    augments: new Map((catalog.augments ?? []).map((entry) => [entry.id, entry])),
    items: new Map((catalog.items ?? []).map((entry) => [entry.id, entry])),
  };
}

function validateIdList(value, { label, minimum, knownIds }) {
  if (!Array.isArray(value) || value.length < minimum) {
    fail(`${label} phải có ít nhất ${minimum} ${label === "itemIds" ? "trang bị" : "lõi"}`);
  }
  const unique = new Set(value);
  if (unique.size !== value.length) fail(`${label} có ID trùng`);
  for (const id of value) {
    if (!knownIds.has(id)) fail(`${label.slice(0, -1)} không tồn tại trong client hiện hành: ${id}`);
  }
  return [...value];
}

function normalizeReview(value, { indexes, stored = false }) {
  requireExactKeys(value, stored ? STORED_REVIEW_KEYS : REVIEW_KEYS, "review");
  if (typeof value.candidateId !== "string" || !value.candidateId) fail("candidateId không hợp lệ");
  if (typeof value.url !== "string" || !value.url) fail("URL không hợp lệ");
  if (!indexes.champions.has(value.championId)) {
    fail(`championId không tồn tại trong client hiện hành: ${value.championId}`);
  }
  if (value.attested !== true) fail("review phải xác nhận đã đối chiếu nguồn công khai");

  const normalized = {
    candidateId: value.candidateId,
    url: value.url,
    championId: value.championId,
    augmentIds: validateIdList(value.augmentIds, {
      label: "augmentIds",
      minimum: 1,
      knownIds: indexes.augments,
    }),
    itemIds: validateIdList(value.itemIds, {
      label: "itemIds",
      minimum: 2,
      knownIds: indexes.items,
    }),
    attested: true,
  };
  if (stored) normalized.reviewedAt = requireIsoDate(value.reviewedAt, "reviewedAt");
  return normalized;
}

export function validateReviewPackage(value, { candidates = [], catalog = {} } = {}) {
  requireExactKeys(value, PACKAGE_KEYS, "gói duyệt");
  if (value.schemaVersion !== REVIEW_PACKAGE_SCHEMA_VERSION) fail("schemaVersion chưa được hỗ trợ");
  if (value.evidenceVersion !== REVIEW_EVIDENCE_VERSION) fail("evidenceVersion phải là 3.1");
  requireIsoDate(value.generatedAt, "generatedAt");
  if (!Array.isArray(value.reviews) || !value.reviews.length) fail("gói duyệt phải có ít nhất một review");

  const indexes = catalogIndex(catalog);
  const candidatesById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const seen = new Set();
  const reviews = value.reviews.map((entry) => {
    const normalized = normalizeReview(entry, { indexes });
    if (seen.has(normalized.candidateId)) fail(`candidateId bị trùng: ${normalized.candidateId}`);
    seen.add(normalized.candidateId);
    const candidate = candidatesById.get(normalized.candidateId);
    if (!candidate) fail(`candidateId không còn trong inbox: ${normalized.candidateId}`);
    if (candidate.url !== normalized.url) fail(`URL không khớp candidate: ${normalized.candidateId}`);
    if (!REVIEWABLE_EVIDENCE_STATES.has(candidate.evidenceReviewState)) {
      fail(`candidate không nằm trong hàng chờ Evidence v3.1: ${normalized.candidateId}`);
    }
    return normalized;
  });

  return {
    schemaVersion: REVIEW_PACKAGE_SCHEMA_VERSION,
    evidenceVersion: REVIEW_EVIDENCE_VERSION,
    generatedAt: value.generatedAt,
    reviews,
  };
}

export function validateReviewOverrides(value, { catalog = {} } = {}) {
  requireExactKeys(value, OVERRIDE_KEYS, "override");
  if (value.schemaVersion !== REVIEW_PACKAGE_SCHEMA_VERSION) fail("override schemaVersion chưa được hỗ trợ");
  if (value.evidenceVersion !== REVIEW_EVIDENCE_VERSION) fail("override evidenceVersion phải là 3.1");
  requireIsoDate(value.updatedAt, "updatedAt");
  if (!Array.isArray(value.reviews)) fail("override reviews phải là mảng");
  const indexes = catalogIndex(catalog);
  const seen = new Set();
  const reviews = value.reviews.map((entry) => {
    const normalized = normalizeReview(entry, { indexes, stored: true });
    if (seen.has(normalized.candidateId)) fail(`override candidateId bị trùng: ${normalized.candidateId}`);
    seen.add(normalized.candidateId);
    return normalized;
  });
  return {
    schemaVersion: REVIEW_PACKAGE_SCHEMA_VERSION,
    evidenceVersion: REVIEW_EVIDENCE_VERSION,
    updatedAt: value.updatedAt,
    reviews,
  };
}

function isSafeForReview(candidate) {
  return candidate?.accessState === "ok"
    && candidate.modeValid === true
    && candidate.currentEnough === true
    && (candidate.disqualifiers?.length ?? 0) === 0
    && candidate.status !== "stale"
    && REVIEWABLE_EVIDENCE_STATES.has(candidate.evidenceReviewState);
}

function entityEvidence(ids) {
  return [...ids]
    .sort((left, right) => String(left).localeCompare(String(right), "en", { numeric: true }))
    .map((id) => ({ id, channels: ["reviewer-selection"] }));
}

function stripPriorReview(candidate) {
  if (candidate.reviewOverride?.evidenceVersion !== REVIEW_EVIDENCE_VERSION) return candidate;
  const rest = { ...candidate };
  delete rest.reviewOverride;
  delete rest.signature;
  delete rest.partialSignature;
  return {
    ...rest,
    championMatches: [],
    augmentMatches: [],
    itemMatches: [],
    entityEvidence: { champions: [], augments: [], items: [] },
    complete: false,
    evidenceReviewState: (candidate.sourceImageIds?.length ?? 0) > 0
      || (candidate.sourceImageReferenceIds?.length ?? 0) > 0
      ? "image-review-required"
      : "incomplete",
    reasons: [...new Set([
      ...(candidate.reasons ?? []),
      "Lựa chọn Evidence v3.1 không còn được áp dụng vì nguồn không vượt hàng rào an toàn",
    ])],
  };
}

export function applyReviewOverrides(candidates = [], overrideFile, catalog = {}) {
  const overrides = validateReviewOverrides(overrideFile, { catalog });
  const indexes = catalogIndex(catalog);
  const byCandidateId = new Map(overrides.reviews.map((entry) => [entry.candidateId, entry]));

  return candidates.map((candidate) => {
    const review = byCandidateId.get(candidate.id);
    if (!review || review.url !== candidate.url || !isSafeForReview(candidate)) return stripPriorReview(candidate);
    const champion = indexes.champions.get(review.championId);
    const augments = review.augmentIds.map((id) => indexes.augments.get(id));
    const items = review.itemIds.map((id) => indexes.items.get(id));
    const reasons = [...new Set([
      ...(candidate.reasons ?? []),
      "Evidence v3.1 đã đối chiếu thủ công theo ID và ảnh client hiện hành",
    ])];
    return {
      ...candidate,
      championMatches: [champion],
      augmentMatches: augments,
      itemMatches: items,
      entityEvidence: {
        champions: entityEvidence([review.championId]),
        augments: entityEvidence(review.augmentIds),
        items: entityEvidence(review.itemIds),
      },
      reviewOverride: {
        evidenceVersion: REVIEW_EVIDENCE_VERSION,
        reviewedAt: review.reviewedAt,
        attested: true,
      },
      status: new Set(["needs-details", "needs-champion"]).has(candidate.status)
        ? "ready-for-review"
        : candidate.status,
      reasons,
    };
  });
}

export function mergeReviewOverrides(existing, importedReviews, reviewedAt) {
  requireIsoDate(reviewedAt, "reviewedAt");
  if (!Array.isArray(importedReviews)) fail("reviews nhập phải là mảng");
  const byCandidateId = new Map((existing?.reviews ?? []).map((entry) => [entry.candidateId, entry]));
  for (const entry of importedReviews) {
    byCandidateId.set(entry.candidateId, {
      candidateId: entry.candidateId,
      url: entry.url,
      championId: entry.championId,
      augmentIds: [...entry.augmentIds],
      itemIds: [...entry.itemIds],
      attested: true,
      reviewedAt,
    });
  }
  return {
    schemaVersion: REVIEW_PACKAGE_SCHEMA_VERSION,
    evidenceVersion: REVIEW_EVIDENCE_VERSION,
    updatedAt: reviewedAt,
    reviews: [...byCandidateId.values()].sort((left, right) => left.candidateId.localeCompare(right.candidateId)),
  };
}
