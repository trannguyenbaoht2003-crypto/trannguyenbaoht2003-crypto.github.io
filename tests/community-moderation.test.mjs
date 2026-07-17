import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateCandidate,
  generatePublishedRecords,
  mergeCommunityRecords,
  moderateCandidates,
  parseSignalMetrics,
  stableDecisionHash,
  weightedEngagementRate,
  validateGeneratedRecord,
} from "../scripts/lib/community-moderation.mjs";

const policy = {
  crossSourceWindowDays: 45,
  moderation: {
    crossSourceMinimumScore: 85,
    trustedCreatorMinimumScore: 90,
    minimumSimilarity: 0.75,
    minimumSourceAgeHours: 12,
    minimumViews: 1000,
    minimumPositiveActions: 20,
    minimumWeightedEngagementRate: 0.02,
    minimumCommentSample: 10,
    minimumPositiveCommentRatio: 0.7,
    demoteNegativeCommentRatio: 0.35,
    consecutiveFailureLimit: 2,
  },
};

function fixture(overrides = {}) {
  return {
    id: "candidate-ryze",
    platform: "Bilibili",
    url: "https://www.bilibili.com/video/BV1fixture/",
    title: "海克斯大乱斗 瑞兹 物理转魔法",
    author: "Nguồn A",
    authorTier: "watch",
    publishedAt: "2026-07-15",
    patchHint: "16.14",
    accessState: "ok",
    modeValid: true,
    championMatches: [{ id: "ryze", cn: "符文法师", vi: "Ryze", icon: "/ryze.png" }],
    augmentMatches: [
      { id: 101, cn: "物理转魔法", vi: "Vật Lý Thành Phép", icon: "/a101.png" },
      { id: 102, cn: "由心及物", vi: "Ý Thức Thắng Vật Chất", icon: "/a102.png" },
    ],
    itemMatches: [
      { id: 2001, cn: "时光之杖", vi: "Trượng Trường Sinh", icon: "/i2001.png" },
      { id: 2002, cn: "大天使之杖", vi: "Quyền Trượng Đại Thiên Sứ", icon: "/i2002.png" },
      { id: 2003, cn: "魔宗", vi: "Thần Kiếm Muramana", icon: "/i2003.png" },
    ],
    metrics: { views: 5000, likes: 120, coins: 20, favorites: 15, comments: 30 },
    comments: undefined,
    disqualifiers: [],
    firstSeenAt: "2026-07-15",
    ...overrides,
  };
}

function context(overrides = {}) {
  return {
    policy,
    currentPatch: "16.14",
    now: "2026-07-16T12:00:00.000Z",
    independentSourceCount: 1,
    previousDecision: undefined,
    ...overrides,
  };
}

test("parses legacy Vietnamese signal text", () => {
  assert.deepEqual(
    parseSignalMetrics("5000 lượt xem · 120 lượt thích · 20 coin · 15 lượt lưu · 30 bình luận"),
    { views: 5000, likes: 120, coins: 20, favorites: 15, comments: 30 },
  );
});

test("calculates weighted engagement without treating it as win rate", () => {
  assert.equal(
    weightedEngagementRate({ views: 5000, likes: 120, coins: 20, favorites: 15 }),
    0.041,
  );
});

test("approves two independent sources with the same exact build", () => {
  const result = moderateCandidates({
    candidates: [
      fixture({ id: "candidate-a", url: "https://a.example/1", author: "A", platform: "Bilibili", title: "瑞兹双核心实战玩法" }),
      fixture({ id: "candidate-b", url: "https://b.example/2", author: "B", platform: "Zhihu", title: "符文法师无限法力构筑" }),
    ],
    policy,
    currentPatch: "16.14",
    now: "2026-07-16T12:00:00.000Z",
    previousDecisions: [],
  });

  assert.equal(result.decisions.length, 1);
  assert.equal(result.decisions[0].status, "auto-approved");
  assert.equal(result.decisions[0].approvalPath, "cross-source");
  assert.equal(result.decisions[0].sources.length, 2);
});

test("does not count two URLs by the same author as independent", () => {
  const result = moderateCandidates({
    candidates: [
      fixture({ id: "candidate-a", url: "https://a.example/1", author: "A" }),
      fixture({ id: "candidate-b", url: "https://a.example/2", author: "A" }),
    ],
    policy,
    currentPatch: "16.14",
    now: "2026-07-16T12:00:00.000Z",
    previousDecisions: [],
  });

  assert.equal(result.decisions.length, 1);
  assert.equal(result.decisions[0].status, "observing");
  assert.equal(result.decisions[0].approvalPath, undefined);
});

test("does not count a mirrored title under another author as an independent source", () => {
  const result = moderateCandidates({
    candidates: [
      fixture({ id: "candidate-a", url: "https://a.example/1", author: "A", platform: "Bilibili", title: "瑞兹无限法力玩法！" }),
      fixture({ id: "candidate-b", url: "https://b.example/2", author: "B", platform: "Zhihu", title: "瑞兹 无限法力玩法" }),
    ],
    policy,
    currentPatch: "16.14",
    now: "2026-07-16T12:00:00.000Z",
    previousDecisions: [],
  });

  assert.equal(result.decisions[0].status, "observing");
  assert.equal(result.decisions[0].approvalPath, undefined);
});

test("uses a stable platform author id when a creator changes display name", () => {
  const result = moderateCandidates({
    candidates: [
      fixture({ id: "candidate-a", url: "https://a.example/1", author: "Tên cũ", sourceAuthorId: "42", title: "瑞兹双核心实战玩法" }),
      fixture({ id: "candidate-b", url: "https://a.example/2", author: "Tên mới", sourceAuthorId: "42", title: "符文法师无限法力构筑" }),
    ],
    policy,
    currentPatch: "16.14",
    now: "2026-07-16T12:00:00.000Z",
    previousDecisions: [],
  });

  assert.equal(result.decisions[0].status, "observing");
  assert.equal(result.decisions[0].approvalPath, undefined);
});

test("approves an established creator with strong public engagement", () => {
  const decision = evaluateCandidate(
    fixture({ authorTier: "established" }),
    context(),
  );

  assert.equal(decision.status, "auto-approved");
  assert.equal(decision.approvalPath, "trusted-creator");
  assert.ok(decision.score >= 90);
  assert.ok(decision.reasons.includes("Tương tác công khai đạt ngưỡng"));
});

test("rejects high views with weak engagement", () => {
  const decision = evaluateCandidate(
    fixture({
      authorTier: "established",
      metrics: { views: 100000, likes: 20, coins: 0, favorites: 0, comments: 4 },
    }),
    context(),
  );

  assert.equal(decision.status, "observing");
  assert.ok(decision.reasons.includes("Tương tác tích cực chưa đạt ngưỡng"));
});

test("blocks a candidate with missing exact item evidence", () => {
  const decision = evaluateCandidate(
    fixture({ itemMatches: [] }),
    context(),
  );

  assert.equal(decision.status, "observing");
  assert.ok(decision.hardGateFailures.includes("missing-item-evidence"));
});

test("demotes after a patch change without reconfirmation", () => {
  const decision = evaluateCandidate(
    fixture({ patchHint: "16.13" }),
    context({
      previousDecision: {
        status: "auto-approved",
        patch: "16.13",
        consecutiveFailures: 0,
      },
    }),
  );

  assert.equal(decision.status, "needs-verification");
  assert.ok(decision.reasons.includes("Chưa được xác nhận lại cho bản hiện hành"));
});

test("demotes when negative comments reach 35 percent", () => {
  const decision = evaluateCandidate(
    fixture({ comments: { positive: 6, negative: 4, neutral: 0, meaningful: 10 } }),
    context({
      previousDecision: {
        status: "auto-approved",
        patch: "16.14",
        consecutiveFailures: 0,
      },
    }),
  );

  assert.equal(decision.status, "needs-verification");
  assert.ok(decision.reasons.includes("Phản hồi tiêu cực đã vượt ngưỡng an toàn"));
});

test("one source failure keeps approval but the second demotes", () => {
  const first = evaluateCandidate(
    fixture({ accessState: "temporary-error" }),
    context({
      previousDecision: {
        status: "auto-approved",
        patch: "16.14",
        consecutiveFailures: 0,
      },
    }),
  );
  const second = evaluateCandidate(
    fixture({ accessState: "temporary-error" }),
    context({ previousDecision: first }),
  );

  assert.equal(first.status, "auto-approved");
  assert.equal(first.consecutiveFailures, 1);
  assert.equal(second.status, "needs-verification");
  assert.equal(second.consecutiveFailures, 2);
});

test("volatile metric changes keep the same decision hash", () => {
  const left = [{
    status: "auto-approved",
    signature: "ryze:101-102:2001-2002-2003",
    checkedAt: "2026-07-16T10:00:00Z",
    metrics: { views: 1000, likes: 40 },
    reasons: ["Hai nguồn độc lập xác nhận"],
  }];
  const right = [{
    status: "auto-approved",
    signature: "ryze:101-102:2001-2002-2003",
    checkedAt: "2026-07-16T11:00:00Z",
    metrics: { views: 1200, likes: 45 },
    reasons: ["Hai nguồn độc lập xác nhận"],
  }];

  assert.equal(stableDecisionHash(left), stableDecisionHash(right));
});

const guideFixture = [{
  id: "ryze",
  name: "Ryze",
  aliases: ["瑞兹"],
  coreAugments: [{ id: 999, cn: "主构筑", vi: "Lõi Hải Đấu", icon: "/main.png" }],
  prismatic: [
    { id: 101, cn: "物理转魔法", vi: "Vật Lý Thành Phép", icon: "/a101.png" },
    { id: 102, cn: "由心及物", vi: "Ý Thức Thắng Vật Chất", icon: "/a102.png" },
  ],
  gold: [],
  silver: [],
  itemData: [
    { id: 2001, original: "时光之杖", name: "Trượng Trường Sinh", icon: "/i2001.png" },
    { id: 2002, original: "大天使之杖", name: "Quyền Trượng Đại Thiên Sứ", icon: "/i2002.png" },
    { id: 2003, original: "魔宗", name: "Thần Kiếm Muramana", icon: "/i2003.png" },
  ],
}];

const approvedCrossSource = [{
  signature: "ryze:101-102:2001-2002-2003",
  championId: "ryze",
  augmentIds: [101, 102],
  itemIds: [2001, 2002, 2003],
  status: "auto-approved",
  approvalPath: "cross-source",
  score: 95,
  reasons: ["Hai nguồn độc lập xác nhận cùng tổ hợp"],
  patch: "16.14",
  checkedAt: "2026-07-16T12:00:00.000Z",
  sources: [
    { platform: "Bilibili", url: "https://a.example/1", title: "Nguồn A", author: "A", publishedAt: "2026-07-15" },
    { platform: "Zhihu", url: "https://b.example/2", title: "Nguồn B", author: "B", publishedAt: "2026-07-15" },
  ],
}];

test("creates one generated record from two approved duplicate sources", () => {
  const output = generatePublishedRecords({
    decisions: approvedCrossSource,
    guides: guideFixture,
    curatedRecords: [],
  });

  assert.equal(output.records.length, 1);
  assert.equal(output.records[0].sources.length, 2);
  assert.match(output.records[0].canonicalKey, /^auto-/);
  assert.equal(output.records[0].automation.status, "auto-approved");
});

test("does not generate a record that duplicates curated data", () => {
  const output = generatePublishedRecords({
    decisions: approvedCrossSource,
    guides: guideFixture,
    curatedRecords: [{
      championId: "ryze",
      canonicalKey: "curated-loop",
      coreCn: ["物理转魔法", "由心及物"],
      itemCn: ["时光之杖", "大天使之杖", "魔宗"],
    }],
  });

  assert.equal(output.records.length, 0);
  assert.equal(output.skippedCollisions.length, 1);
});

test("curated record wins a champion and canonical key collision", () => {
  const curatedRecord = { championId: "ryze", canonicalKey: "same-key", title: "Bản biên tập" };
  const generatedCollision = { championId: "ryze", canonicalKey: "same-key", title: "Bản tự động" };
  const merged = mergeCommunityRecords({ curated: [curatedRecord], generated: [generatedCollision] });

  assert.equal(merged.length, 1);
  assert.equal(merged[0].title, "Bản biên tập");
});

test("generated record requires automation provenance", () => {
  const generated = generatePublishedRecords({
    decisions: approvedCrossSource,
    guides: guideFixture,
    curatedRecords: [],
  }).records[0];

  assert.throws(() => validateGeneratedRecord({ ...generated, automation: undefined }), /automation/);
  assert.doesNotThrow(() => validateGeneratedRecord(generated));
});
