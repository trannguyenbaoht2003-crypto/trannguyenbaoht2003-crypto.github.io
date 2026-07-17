import assert from "node:assert/strict";
import test from "node:test";

const evidence = await import("../scripts/lib/community-evidence-v2.mjs").catch(() => ({}));

test("summarizes only build-related public comments without retaining comment text", () => {
  assert.equal(typeof evidence.summarizePublicComments, "function");

  const summary = evidence.summarizePublicComments([
    { rpid: 1, content: { message: "这套出装实战很强，确实好用，推荐" } },
    { rpid: 2, content: { message: "这套出装不强，也不好用，别推荐了" } },
    { rpid: 3, content: { message: "这套玩法核心强化是什么？" } },
    { rpid: 4, content: { message: "哈哈哈哈[doge]" } },
  ], { maximumSample: 20 });

  assert.deepEqual(summary, {
    positive: 1,
    negative: 1,
    neutral: 1,
    meaningful: 3,
    sampled: 4,
  });
  assert.equal(JSON.stringify(summary).includes("出装"), false);
});

test("treats negated positive phrases as negative build feedback", () => {
  const summary = evidence.summarizePublicComments([
    { rpid: 21, content: { message: "这套出装没有用" } },
    { rpid: 22, content: { message: "这个玩法不太强" } },
  ], { maximumSample: 20 });

  assert.deepEqual(summary, {
    positive: 0,
    negative: 2,
    neutral: 0,
    meaningful: 2,
    sampled: 2,
  });
});

test("extracts Bilibili v2 metadata for matching while retaining only aggregate comments", () => {
  assert.equal(typeof evidence.extractBilibiliPublicEvidence, "function");

  const result = evidence.extractBilibiliPublicEvidence({
    bvid: "BV1fixture",
    fallback: {
      title: "海克斯大乱斗 安妮",
      author: "旧名称",
      description: "搜索摘要",
      metrics: { views: 10 },
    },
    detail: {
      aid: 9988,
      title: "空投熊安妮",
      desc: "核心强化是空投熊",
      dynamic: "海克斯大乱斗",
      pubdate: 1_760_000_000,
      owner: { mid: 13758607, name: "螃蟹俄洛伊" },
      stat: { view: 1200, like: 30, coin: 4, favorite: 5, reply: 3 },
      pages: [{ part: "安妮空投熊完整玩法" }],
    },
    tags: [{ tag_name: "海克斯大乱斗" }, { tag_name: "新装备" }],
    replies: [
      { rpid: 11, content: { message: "这套玩法很强，推荐试试" } },
      { rpid: 12, content: { message: "路过看看" } },
    ],
    maximumCommentSample: 20,
  });

  assert.equal(result.evidenceVersion, 2);
  assert.equal(result.classifierRevision, 1);
  assert.equal(result.sourceContentId, "BV1fixture");
  assert.equal(result.sourceArchiveId, "9988");
  assert.equal(result.sourceAuthorId, "13758607");
  assert.equal(result.author, "螃蟹俄洛伊");
  assert.equal(result.metrics.views, 1200);
  assert.match(result.matchingText, /空投熊安妮/);
  assert.match(result.matchingText, /新装备/);
  assert.deepEqual(result.comments, {
    positive: 1,
    negative: 0,
    neutral: 0,
    meaningful: 1,
    sampled: 2,
  });
  assert.equal(JSON.stringify(result.comments).includes("推荐试试"), false);
});

test("buckets comment evidence only when a meaningful sample crosses policy thresholds", () => {
  assert.equal(typeof evidence.commentEvidenceState, "function");
  const policy = {
    minimumCommentSample: 10,
    minimumPositiveCommentRatio: 0.7,
    demoteNegativeCommentRatio: 0.35,
  };

  assert.equal(evidence.commentEvidenceState({ positive: 8, negative: 1, neutral: 1, meaningful: 10 }, policy), "positive");
  assert.equal(evidence.commentEvidenceState({ positive: 4, negative: 4, neutral: 2, meaningful: 10 }, policy), "negative");
  assert.equal(evidence.commentEvidenceState({ positive: 3, negative: 1, neutral: 2, meaningful: 6 }, policy), "insufficient");
  assert.equal(evidence.commentEvidenceState({ positive: 6, negative: 2, neutral: 2, meaningful: 10 }, policy), "mixed");
});

test("counts mirrored titles and repeated creator identities as one source", () => {
  assert.equal(typeof evidence.countIndependentSources, "function");
  const count = evidence.countIndependentSources([
    { platform: "Bilibili", sourceAuthorId: "1", author: "作者甲", title: "瑞兹无限法力玩法！", url: "https://www.bilibili.com/video/BV1a/" },
    { platform: "Bilibili", sourceAuthorId: "1", author: "作者甲改名", title: "另一条视频", url: "https://www.bilibili.com/video/BV1b/" },
    { platform: "Zhihu", author: "作者乙", title: "瑞兹 无限法力玩法", url: "https://zhuanlan.zhihu.com/p/1" },
    { platform: "Tieba", author: "作者丙", title: "瑞兹双核心实战复盘", url: "https://tieba.baidu.com/p/2" },
  ]);

  assert.equal(count, 2);
});
