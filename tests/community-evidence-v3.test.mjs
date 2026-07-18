import assert from "node:assert/strict";
import test from "node:test";

const evidence = await import("../scripts/lib/community-evidence-v3.mjs").catch(() => ({}));

test("selects a public Chinese Bilibili subtitle track and normalizes its URL", () => {
  assert.equal(typeof evidence.selectPublicChineseSubtitleTrack, "function");

  const track = evidence.selectPublicChineseSubtitleTrack({
    data: {
      subtitle: {
        subtitles: [
          { lan: "en-US", subtitle_url: "//example.test/en.json" },
          { lan: "zh-CN", lan_doc: "中文（自动生成）", subtitle_url: "//i0.hdslb.com/bfs/subtitle/zh.json" },
        ],
      },
    },
  });

  assert.deepEqual(track, {
    language: "zh-CN",
    label: "中文（自动生成）",
    url: "https://i0.hdslb.com/bfs/subtitle/zh.json",
  });
});

test("bounds transient subtitle text without retaining segment bodies in its summary", () => {
  assert.equal(typeof evidence.extractBilibiliSubtitleText, "function");

  const transient = evidence.extractBilibiliSubtitleText({
    body: [
      { from: 0, to: 2, content: "寒冰海克斯大乱斗" },
      { from: 2, to: 4, content: "核心强化珠光护手" },
      { from: 4, to: 6, content: "出无尽之刃和疾射火炮" },
    ],
  }, { maximumSegments: 2, maximumCharacters: 100 });

  assert.equal(transient.segmentCount, 2);
  assert.equal(transient.truncated, true);
  assert.match(transient.matchingText, /寒冰/);
  assert.doesNotMatch(transient.matchingText, /疾射火炮/);

  const summary = evidence.summarizeSubtitleEvidence(transient);
  assert.deepEqual(summary, { state: "ok", segmentCountBucket: "1-20", truncated: true });
  assert.equal(JSON.stringify(summary).includes("寒冰"), false);
});

test("extracts safe author/date metadata from a public page and does not return page HTML", () => {
  assert.equal(typeof evidence.extractPublicPageMetadata, "function");

  const html = `<!doctype html><html><head>
    <meta property="og:title" content="寒冰海克斯大乱斗出装">
    <meta name="description" content="珠光护手、无尽之刃、疾射火炮">
    <meta property="og:image" content="https://pic.example.test/cover.jpg">
    <script type="application/ld+json">{
      "@type":"Article",
      "author":{"@type":"Person","name":"攻略作者"},
      "datePublished":"2026-07-17T09:30:00+08:00",
      "keywords":["海克斯大乱斗","寒冰"]
    }</script>
  </head><body><article>全文不应被保留</article></body></html>`;

  const result = evidence.extractPublicPageMetadata(html, {
    url: "https://zhuanlan.zhihu.com/p/123456",
  });

  assert.equal(result.accessState, "ok");
  assert.equal(result.title, "寒冰海克斯大乱斗出装");
  assert.equal(result.author, "攻略作者");
  assert.equal(result.publishedAt, "2026-07-17");
  assert.equal(result.sourceContentId, "123456");
  assert.deepEqual(result.imageUrls, ["https://pic.example.test/cover.jpg"]);
  assert.match(result.matchingText, /珠光护手/);
  assert.equal(JSON.stringify(result).includes("全文不应被保留"), false);
});

test("recognizes CAPTCHA/login/private interstitials without attempting to bypass them", () => {
  const captcha = evidence.extractPublicPageMetadata(
    "<html><head><title>安全验证</title></head><body>请完成验证码后继续访问</body></html>",
    { url: "https://tieba.baidu.com/p/1" },
  );
  const locked = evidence.extractPublicPageMetadata(
    "<html><head><title>登录</title></head><body>登录后查看完整内容</body></html>",
    { url: "https://www.zhihu.com/question/1" },
  );
  const privatePage = evidence.extractPublicPageMetadata(
    "<html><head><title>无权访问</title></head><body>该内容仅作者可见</body></html>",
    { url: "https://www.douyin.com/video/1" },
  );

  assert.equal(captcha.accessState, "captcha");
  assert.equal(locked.accessState, "locked");
  assert.equal(privatePage.accessState, "private");
});

test("persists only exact entity IDs and evidence-channel names", () => {
  assert.equal(typeof evidence.summarizeEntityEvidence, "function");

  const result = evidence.summarizeEntityEvidence([
    {
      channel: "title",
      text: "寒冰海克斯大乱斗",
      champions: [{ id: "ashe", cn: "艾希", vi: "Ashe", icon: "/ashe.png" }],
      augments: [],
      items: [{ id: 3031, cn: "无尽之刃", vi: "Vô Cực Kiếm", icon: "/3031.png" }],
    },
    {
      channel: "subtitle",
      text: "珠光护手、无尽之刃、疾射火炮",
      champions: [],
      augments: [{ id: 136, cn: "珠光护手", vi: "Găng Bảo Thạch", icon: "/136.png" }],
      items: [
        { id: 3031, cn: "无尽之刃", vi: "Vô Cực Kiếm", icon: "/3031.png" },
        { id: 3094, cn: "疾射火炮", vi: "Đại Bác Liên Thanh", icon: "/3094.png" },
      ],
    },
  ]);

  assert.deepEqual(result.entityEvidence, {
    champions: [{ id: "ashe", channels: ["title"] }],
    augments: [{ id: 136, channels: ["subtitle"] }],
    items: [
      { id: 3031, channels: ["subtitle", "title"] },
      { id: 3094, channels: ["subtitle"] },
    ],
  });
  assert.equal(JSON.stringify(result.entityEvidence).includes("寒冰"), false);
  assert.equal(JSON.stringify(result.entityEvidence).includes("Vô Cực Kiếm"), false);
  assert.equal(typeof evidence.hasRawEvidencePayload, "function");
  assert.equal(evidence.hasRawEvidencePayload(result.entityEvidence), false);
  assert.equal(evidence.hasRawEvidencePayload({
    ...result.entityEvidence,
    rawSubtitle: "寒冰海克斯大乱斗",
  }), true);
});

test("creates a moderation signature only for one champion, one augment and two items", () => {
  assert.equal(typeof evidence.buildEvidenceSignatures, "function");
  const champion = [{ id: "ashe" }];
  const augment = [{ id: 136 }];
  const items = [{ id: 3031 }, { id: 3094 }];

  const complete = evidence.buildEvidenceSignatures({ champions: champion, augments: augment, items });
  assert.equal(complete.complete, true);
  assert.equal(complete.signature, "ashe:136:3031-3094");
  assert.equal(complete.partialSignature, "ashe:136:3031-3094");

  const missingItem = evidence.buildEvidenceSignatures({ champions: champion, augments: augment, items: items.slice(0, 1) });
  assert.equal(missingItem.complete, false);
  assert.equal(missingItem.signature, undefined);
  assert.equal(missingItem.partialSignature, "ashe:136:3031");

  const ambiguousChampion = evidence.buildEvidenceSignatures({
    champions: [{ id: "ashe" }, { id: "senna" }],
    augments: augment,
    items,
  });
  assert.equal(ambiguousChampion.complete, false);
  assert.equal(ambiguousChampion.signature, undefined);
});

test("hardens legacy review candidates before moderation", () => {
  assert.equal(typeof evidence.enforceEvidenceV3Signature, "function");

  const legacy = evidence.enforceEvidenceV3Signature({
    id: "legacy-candidate",
    status: "ready-for-review",
    signature: "ashe:136:",
    reasons: ["legacy"],
    championMatches: [{ id: "ashe" }],
    augmentMatches: [{ id: 136 }],
    itemMatches: [],
    sourceImageIds: ["sha256:aaaaaaaaaaaaaaaaaaaaaaaa"],
  });
  assert.equal(legacy.signature, undefined);
  assert.equal(legacy.partialSignature, "ashe:136:");
  assert.equal(legacy.status, "needs-details");
  assert.equal(legacy.evidenceReviewState, "image-review-required");
  assert.match(legacy.reasons.at(-1), /Evidence v3/);

  const complete = evidence.enforceEvidenceV3Signature({
    id: "complete-candidate",
    status: "ready-for-review",
    signature: "stale-value",
    reasons: [],
    championMatches: [{ id: "ashe" }],
    augmentMatches: [{ id: 136 }],
    itemMatches: [{ id: 3094 }, { id: 3031 }],
  });
  assert.equal(complete.signature, "ashe:136:3031-3094");
  assert.equal(complete.status, "ready-for-review");
  assert.equal(complete.evidenceReviewState, "complete");
});

test("turns public image bytes into an opaque stable ID only", () => {
  assert.equal(typeof evidence.publicImageEvidenceId, "function");
  const id = evidence.publicImageEvidenceId(Buffer.from("public-image-fixture"));
  assert.match(id, /^sha256:[a-f0-9]{24}$/);
  assert.equal(id.includes("public-image-fixture"), false);
  assert.equal(id, evidence.publicImageEvidenceId(Buffer.from("public-image-fixture")));
});
