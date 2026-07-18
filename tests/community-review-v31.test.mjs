import assert from "node:assert/strict";
import test from "node:test";

const review = await import("../scripts/lib/community-review-v31.mjs").catch(() => ({}));
const evidenceV3 = await import("../scripts/lib/community-evidence-v3.mjs");

const guides = [
  {
    id: "ashe",
    name: "Ashe",
    aliases: ["艾希", "寒冰射手"],
    icon: "/champions/ashe.png",
    coreAugments: [
      { id: 1048, vi: "Găng Bảo Thạch", cn: "珠光护手", icon: "/augments/1048.png" },
    ],
    prismatic: [
      { id: 1344, vi: "Bản Thể Tối Thượng", cn: "最终形态", icon: "/augments/1344.png" },
    ],
    gold: [],
    silver: [],
    itemData: [
      { id: 3031, name: "Vô Cực Kiếm", original: "无尽之刃", icon: "/items/3031.png" },
      { id: 3094, name: "Đại Bác Liên Thanh", original: "疾射火炮", icon: "/items/3094.png" },
    ],
  },
  {
    id: "jayce",
    name: "Jayce",
    aliases: ["杰斯"],
    icon: "/champions/jayce.png",
    coreAugments: [
      { id: 1048, vi: "Găng Bảo Thạch", cn: "珠光护手", icon: "/augments/1048.png" },
    ],
    prismatic: [],
    gold: [],
    silver: [],
    itemData: [
      { id: 3031, name: "Vô Cực Kiếm", original: "无尽之刃", icon: "/items/3031.png" },
      { id: 3072, name: "Huyết Kiếm", original: "饮血剑", icon: "/items/3072.png" },
    ],
  },
];

const candidates = [
  {
    id: "candidate-safe",
    url: "https://www.bilibili.com/video/BV1safe/",
    status: "needs-details",
    accessState: "ok",
    modeValid: true,
    currentEnough: true,
    disqualifiers: [],
    reasons: ["Cần đối chiếu"],
    evidenceReviewState: "translation-review-required",
    championMatches: [{ id: "jayce", vi: "Jayce", cn: "杰斯", icon: "/champions/jayce.png" }],
    augmentMatches: [],
    itemMatches: [],
  },
];

function validPackage(overrides = {}) {
  return {
    schemaVersion: 1,
    evidenceVersion: "3.1",
    generatedAt: "2026-07-18T08:00:00.000Z",
    reviews: [
      {
        candidateId: "candidate-safe",
        url: "https://www.bilibili.com/video/BV1safe/",
        championId: "ashe",
        augmentIds: [1344, 1048],
        itemIds: [3094, 3031],
        attested: true,
      },
    ],
    ...overrides,
  };
}

function validOverrides(overrides = {}) {
  return {
    schemaVersion: 1,
    evidenceVersion: "3.1",
    updatedAt: "2026-07-18T08:05:00.000Z",
    reviews: [
      {
        ...validPackage().reviews[0],
        reviewedAt: "2026-07-18T08:05:00.000Z",
      },
    ],
    ...overrides,
  };
}

test("builds a deduplicated current-client catalog with Vietnamese, Chinese and image fields", () => {
  assert.equal(typeof review.buildReviewCatalog, "function");
  const catalog = review.buildReviewCatalog(guides);

  assert.deepEqual(catalog.champions, [
    { id: "ashe", vi: "Ashe", cn: "艾希", icon: "/champions/ashe.png" },
    { id: "jayce", vi: "Jayce", cn: "杰斯", icon: "/champions/jayce.png" },
  ]);
  assert.equal(catalog.augments.filter((entry) => entry.id === 1048).length, 1);
  assert.equal(catalog.items.filter((entry) => entry.id === 3031).length, 1);
  assert.deepEqual(catalog.items.find((entry) => entry.id === 3072), {
    id: 3072,
    vi: "Huyết Kiếm",
    cn: "饮血剑",
    icon: "/items/3072.png",
  });
});

test("validates and normalizes an exact-ID review package without changing selection order", () => {
  assert.equal(typeof review.validateReviewPackage, "function");
  const catalog = review.buildReviewCatalog(guides);
  const normalized = review.validateReviewPackage(validPackage(), { candidates, catalog });

  assert.deepEqual(normalized, validPackage());
  assert.deepEqual(normalized.reviews[0].augmentIds, [1344, 1048]);
  assert.deepEqual(normalized.reviews[0].itemIds, [3094, 3031]);
});

test("rejects URL mismatches, unknown IDs, duplicates, incomplete attestation and raw fields", () => {
  const catalog = review.buildReviewCatalog(guides);
  const invalidCases = [
    ["URL", { reviews: [{ ...validPackage().reviews[0], url: "https://example.test/other" }] }],
    ["itemId", { reviews: [{ ...validPackage().reviews[0], itemIds: [3094, 999999] }] }],
    ["trùng", { reviews: [{ ...validPackage().reviews[0], itemIds: [3094, 3094] }] }],
    ["xác nhận", { reviews: [{ ...validPackage().reviews[0], attested: false }] }],
    ["ít nhất 2 trang bị", { reviews: [{ ...validPackage().reviews[0], itemIds: [3094] }] }],
    ["trường không được phép", { reviews: [{ ...validPackage().reviews[0], note: "raw transcript" }] }],
  ];

  for (const [message, overrides] of invalidCases) {
    assert.throws(
      () => review.validateReviewPackage(validPackage(overrides), { candidates, catalog }),
      new RegExp(message, "i"),
    );
  }
});

test("applies a safe override as exact reviewer-selection evidence ready for signature hardening", () => {
  assert.equal(typeof review.validateReviewOverrides, "function");
  assert.equal(typeof review.applyReviewOverrides, "function");
  const catalog = review.buildReviewCatalog(guides);
  const overrides = review.validateReviewOverrides(validOverrides(), { catalog });
  const [candidate] = review.applyReviewOverrides(candidates, overrides, catalog);

  assert.deepEqual(candidate.championMatches, [
    { id: "ashe", vi: "Ashe", cn: "艾希", icon: "/champions/ashe.png" },
  ]);
  assert.deepEqual(candidate.augmentMatches.map((entry) => entry.id), [1344, 1048]);
  assert.deepEqual(candidate.itemMatches.map((entry) => entry.id), [3094, 3031]);
  assert.deepEqual(candidate.entityEvidence, {
    champions: [{ id: "ashe", channels: ["reviewer-selection"] }],
    augments: [
      { id: 1048, channels: ["reviewer-selection"] },
      { id: 1344, channels: ["reviewer-selection"] },
    ],
    items: [
      { id: 3031, channels: ["reviewer-selection"] },
      { id: 3094, channels: ["reviewer-selection"] },
    ],
  });
  assert.deepEqual(candidate.reviewOverride, {
    evidenceVersion: "3.1",
    reviewedAt: "2026-07-18T08:05:00.000Z",
    attested: true,
  });
  assert.equal(candidate.status, "ready-for-review");
  assert.equal(JSON.stringify(candidate).includes("raw transcript"), false);
});

test("turns a safe review into a standard signature without treating reviewer provenance as raw evidence", () => {
  const catalog = review.buildReviewCatalog(guides);
  const [reviewed] = review.applyReviewOverrides(candidates, validOverrides(), catalog);
  const hardened = evidenceV3.enforceEvidenceV3Signature(reviewed);

  assert.equal(hardened.signature, "ashe:1048-1344:3031-3094");
  assert.equal(hardened.evidenceReviewState, "complete");
  assert.equal(hardened.status, "ready-for-review");
  assert.equal(evidenceV3.hasRawEvidencePayload(hardened.entityEvidence), false);
});

test("never revives stale, inaccessible, wrong-mode, outdated or disqualified candidates", () => {
  const catalog = review.buildReviewCatalog(guides);
  const blocked = [
    { status: "stale" },
    { accessState: "locked" },
    { accessState: "captcha" },
    { accessState: "private" },
    { modeValid: false },
    { currentEnough: false },
    { disqualifiers: ["bug exploit"] },
  ];

  for (const [index, mutation] of blocked.entries()) {
    const candidate = {
      ...candidates[0],
      id: `candidate-blocked-${index}`,
      url: `https://example.test/blocked-${index}`,
      ...mutation,
    };
    const overrides = validOverrides({
      reviews: [{
        ...validOverrides().reviews[0],
        candidateId: candidate.id,
        url: candidate.url,
      }],
    });
    const [result] = review.applyReviewOverrides([candidate], overrides, catalog);
    assert.deepEqual(result, candidate);
    assert.equal(result.reviewOverride, undefined);
  }
});

test("strips prior reviewer selections when a reviewed source later becomes unsafe", () => {
  const catalog = review.buildReviewCatalog(guides);
  const [previouslyReviewed] = review.applyReviewOverrides(candidates, validOverrides(), catalog);
  const [locked] = review.applyReviewOverrides(
    [{ ...previouslyReviewed, accessState: "locked", status: "needs-details" }],
    validOverrides(),
    catalog,
  );

  assert.equal(locked.reviewOverride, undefined);
  assert.equal(locked.signature, undefined);
  assert.deepEqual(locked.championMatches, []);
  assert.deepEqual(locked.augmentMatches, []);
  assert.deepEqual(locked.itemMatches, []);
  assert.deepEqual(locked.entityEvidence, { champions: [], augments: [], items: [] });
  assert.match(locked.reasons.at(-1), /không còn được áp dụng/i);
});

test("merges imported reviews by candidateId and keeps only structured fields", () => {
  assert.equal(typeof review.mergeReviewOverrides, "function");
  const prior = validOverrides({
    reviews: [{
      ...validOverrides().reviews[0],
      championId: "jayce",
      augmentIds: [1048],
      itemIds: [3031, 3072],
      reviewedAt: "2026-07-17T07:00:00.000Z",
    }],
  });
  const merged = review.mergeReviewOverrides(
    prior,
    validPackage().reviews,
    "2026-07-18T09:00:00.000Z",
  );

  assert.equal(merged.reviews.length, 1);
  assert.equal(merged.reviews[0].championId, "ashe");
  assert.equal(merged.reviews[0].reviewedAt, "2026-07-18T09:00:00.000Z");
  assert.deepEqual(Object.keys(merged.reviews[0]).sort(), [
    "attested",
    "augmentIds",
    "candidateId",
    "championId",
    "itemIds",
    "reviewedAt",
    "url",
  ]);
});
