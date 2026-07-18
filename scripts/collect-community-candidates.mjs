import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { parseSignalMetrics, weightedEngagementRate } from "./lib/community-moderation.mjs";
import {
  EVIDENCE_CLASSIFIER_REVISION as EVIDENCE_V2_CLASSIFIER_REVISION,
  commentEvidenceState,
  countIndependentSources,
  extractBilibiliPublicEvidence,
} from "./lib/community-evidence-v2.mjs";
import {
  EVIDENCE_V3_CLASSIFIER_REVISION,
  buildEvidenceSignatures,
  enforceEvidenceV3Signature,
  extractBilibiliSubtitleText,
  extractPublicPageMetadata,
  hasRawEvidencePayload,
  publicImageEvidenceId,
  selectPublicChineseSubtitleTrack,
  summarizeEntityEvidence,
  summarizeSubtitleEvidence,
} from "./lib/community-evidence-v3.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REGISTRY_PATH = path.join(ROOT, "app/community-source-registry.json");
const COMMUNITY_PATH = path.join(ROOT, "app/community-sources.json");
const GUIDES_PATH = path.join(ROOT, "app/generated-guides.ts");
const DATA_PATH = path.join(ROOT, "app/data.ts");
const INBOX_PATH = path.join(ROOT, "data/community-inbox.json");
const REPORT_PATH = path.join(ROOT, "community-watch-report.json");
const VALID_STATUSES = new Set([
  "known-source",
  "known-build",
  "cross-source-review",
  "ready-for-review",
  "needs-details",
  "needs-champion",
  "patch-watch",
  "stale",
]);
const FETCH_HEADERS = {
  "user-agent": "Mozilla/5.0 (compatible; LoiMetaCommunityWatch/1.0; public metadata only)",
  accept: "application/json,text/xml,text/html;q=0.9,*/*;q=0.8",
};
const VALID_AUTHOR_TIERS = new Set(["established", "watch", "unlisted"]);
const VALID_ACCESS_STATES = new Set(["ok", "temporary-error", "locked", "captcha", "private"]);
const VALID_COMMENT_ACCESS_STATES = new Set(["ok", "insufficient-total", "temporary-error", "not-requested"]);
const VALID_COMMENT_EVIDENCE_STATES = new Set(["positive", "negative", "mixed", "insufficient"]);
const VALID_SUBTITLE_ACCESS_STATES = new Set(["ok", "not-available", "temporary-error", "not-requested"]);
const VALID_IMAGE_EVIDENCE_STATES = new Set(["ok", "not-available", "temporary-error", "not-requested"]);
const VALID_EVIDENCE_REVIEW_STATES = new Set(["complete", "image-review-required", "translation-review-required", "incomplete"]);

function fail(message) {
  throw new Error(`Bộ theo dõi cộng đồng: ${message}`);
}

function hash(value) {
  return createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
}

function finiteMetric(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

function signalFromMetrics(metrics = {}) {
  return [
    metrics.views !== undefined ? `${metrics.views} lượt xem` : undefined,
    metrics.likes !== undefined ? `${metrics.likes} lượt thích` : undefined,
    metrics.coins !== undefined ? `${metrics.coins} coin` : undefined,
    metrics.favorites !== undefined ? `${metrics.favorites} lượt lưu` : undefined,
    metrics.comments !== undefined ? `${metrics.comments} bình luận` : undefined,
  ].filter(Boolean).join(" · ");
}

function engagementPass(metrics, registry) {
  const moderation = registry.policy.moderation;
  const positiveActions = (metrics.likes ?? 0) + (metrics.coins ?? 0) + (metrics.favorites ?? 0);
  return (metrics.views ?? 0) >= moderation.minimumViews
    && positiveActions >= moderation.minimumPositiveActions
    && weightedEngagementRate(metrics) >= moderation.minimumWeightedEngagementRate;
}

function normalize(value = "") {
  return String(value)
    .normalize("NFKC")
    .toLocaleLowerCase("zh-CN")
    .replace(/<[^>]+>/g, " ")
    .replace(/[\s\p{P}\p{S}]/gu, "");
}

function plain(value = "") {
  return String(value)
    .replace(/<em[^>]*>/gi, "")
    .replace(/<\/em>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/\s+/g, " ")
    .trim();
}

function dateOnly(value) {
  if (!value) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString().slice(0, 10);
}

function validDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value ?? "") && Boolean(dateOnly(`${value}T00:00:00Z`));
}

function parseGuides(source) {
  const marker = "export const generatedChampions: ChampionGuide[] = ";
  const start = source.indexOf(marker);
  if (start < 0) fail("không tìm thấy generatedChampions");
  return JSON.parse(source.slice(start + marker.length).trim().replace(/;\s*$/, ""));
}

function currentPatchFromSource(source, fallback) {
  return source.match(/dataDragonVersion\s*=\s*"(\d+\.\d+)/)?.[1] ?? fallback;
}

function patchNumber(value) {
  const match = String(value ?? "").match(/\b(16|26)\.(\d{1,2})\b/);
  if (!match) return undefined;
  return Number(`16.${match[2].padStart(2, "0")}`);
}

function isBeforePatch(value, minimumPatch) {
  const left = patchNumber(value);
  const right = patchNumber(minimumPatch);
  return left !== undefined && right !== undefined && left < right;
}

function canonicalUrl(rawUrl) {
  if (!rawUrl) return undefined;
  try {
    const url = new URL(rawUrl.replace(/^http:/, "https:"));
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|spm|from|share_|vd_source)/i.test(key)) url.searchParams.delete(key);
    }
    if (url.hostname.includes("bilibili.com")) {
      const bvid = url.pathname.match(/\/(BV[\w]+)/i)?.[1];
      if (bvid) return `https://www.bilibili.com/video/${bvid}/`;
    }
    return url.toString();
  } catch {
    return undefined;
  }
}

function xmlItems(xml) {
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)].map((match) => {
    const block = match[1];
    const take = (tag) => plain(block.match(new RegExp(`<${tag}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`, "i"))?.[1]);
    return {
      title: take("title"),
      url: take("link"),
      description: take("description"),
      publishedAt: dateOnly(take("pubDate")),
    };
  });
}

async function request(url, responseType = "json", headers = {}) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { ...FETCH_HEADERS, ...headers },
        signal: AbortSignal.timeout(18_000),
      });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      return responseType === "json" ? response.json() : response.text();
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 500));
    }
  }
  throw lastError;
}

async function requestPublicBilibiliImageId(rawUrl, { maximumBytes, headers = {} } = {}) {
  const url = new URL(String(rawUrl).replace(/^http:/i, "https:"));
  if (url.protocol !== "https:" || !(url.hostname === "hdslb.com" || url.hostname.endsWith(".hdslb.com"))) {
    throw new Error("máy chủ ảnh Bilibili không nằm trong danh sách công khai cho phép");
  }
  const limit = Math.max(1, Number(maximumBytes) || 5_000_000);
  const response = await fetch(url, {
    headers: { ...FETCH_HEADERS, ...headers, accept: "image/*" },
    signal: AbortSignal.timeout(18_000),
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  if (!String(response.headers.get("content-type") ?? "").toLocaleLowerCase("en-US").startsWith("image/")) {
    throw new Error("phản hồi ảnh Bilibili không đúng content-type");
  }
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > limit) throw new Error("ảnh Bilibili vượt giới hạn kích thước");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > limit) throw new Error("ảnh Bilibili vượt giới hạn kích thước");
  return publicImageEvidenceId(bytes);
}

async function collectBilibili(query) {
  const params = new URLSearchParams({
    search_type: "video",
    keyword: query.query,
    order: "pubdate",
    page: "1",
  });
  const payload = await request(
    `https://api.bilibili.com/x/web-interface/wbi/search/type?${params}`,
    "json",
    { "user-agent": "Mozilla/5.0", referer: "https://www.bilibili.com/" },
  );
  if (payload.code !== 0 || !Array.isArray(payload.data?.result)) throw new Error(payload.message || "phản hồi Bilibili không hợp lệ");
  return payload.data.result.slice(0, query.maxResults).map((row) => {
    const metrics = {
      views: finiteMetric(row.play),
      likes: finiteMetric(row.like),
      favorites: finiteMetric(row.favorites),
    };
    return {
      platform: "Bilibili",
      url: `https://www.bilibili.com/video/${row.bvid}/`,
      title: plain(row.title),
      author: plain(row.author),
      publishedAt: dateOnly(new Date(Number(row.pubdate) * 1000)),
      description: plain([row.description, row.tag].filter(Boolean).join(" · ")),
      metrics,
      signal: signalFromMetrics(metrics),
      accessState: "ok",
      sourceQueryId: query.id,
    };
  });
}

function bilibiliVideoId(url) {
  return String(url ?? "").match(/\/(BV[\w]+)/i)?.[1];
}

async function enrichBilibiliCandidate(raw, registry, { allowSubtitle = false, allowPublicImage = false } = {}) {
  const bvid = bilibiliVideoId(raw.url);
  if (!bvid) return raw;
  try {
    const headers = { "user-agent": "Mozilla/5.0", referer: raw.url };
    const [detailPayload, tagResult] = await Promise.all([
      request(`https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`, "json", headers),
      request(`https://api.bilibili.com/x/tag/archive/tags?bvid=${encodeURIComponent(bvid)}`, "json", headers)
        .then((payload) => ({ ok: payload.code === 0 && Array.isArray(payload.data), payload }))
        .catch(() => ({ ok: false })),
    ]);
    if (detailPayload.code !== 0 || !detailPayload.data?.stat) {
      throw new Error(detailPayload.message || "phản hồi chi tiết Bilibili không hợp lệ");
    }

    const maximumCommentSample = registry.policy.evidenceV2.maximumPublicCommentSample;
    const totalComments = finiteMetric(detailPayload.data.stat.reply) ?? 0;
    let replies;
    let commentAccessState = "not-requested";
    if (totalComments < registry.policy.moderation.minimumCommentSample) {
      commentAccessState = "insufficient-total";
    } else {
      const params = new URLSearchParams({
        type: "1",
        oid: String(detailPayload.data.aid),
        mode: "3",
        next: "0",
        ps: String(maximumCommentSample),
      });
      try {
        const replyPayload = await request(`https://api.bilibili.com/x/v2/reply/main?${params}`, "json", headers);
        if (replyPayload.code !== 0 || !Array.isArray(replyPayload.data?.replies)) {
          throw new Error(replyPayload.message || "phản hồi bình luận Bilibili không hợp lệ");
        }
        replies = replyPayload.data.replies;
        commentAccessState = "ok";
      } catch {
        commentAccessState = "temporary-error";
      }
    }

    const evidence = extractBilibiliPublicEvidence({
      bvid,
      fallback: raw,
      detail: detailPayload.data,
      tags: tagResult.ok ? tagResult.payload.data : [],
      replies,
      maximumCommentSample,
    });

    const evidenceV3 = registry.policy.evidenceV3;
    let subtitleEvidence;
    let subtitleText = "";
    let subtitleAccessState = allowSubtitle ? "not-available" : "not-requested";
    if (allowSubtitle && detailPayload.data.cid) {
      try {
        const playerPayload = await request(
          `https://api.bilibili.com/x/player/v2?bvid=${encodeURIComponent(bvid)}&cid=${encodeURIComponent(detailPayload.data.cid)}`,
          "json",
          headers,
        );
        const track = selectPublicChineseSubtitleTrack(playerPayload);
        if (track) {
          const subtitlePayload = await request(track.url, "json", headers);
          const transientSubtitle = extractBilibiliSubtitleText(subtitlePayload, {
            maximumSegments: evidenceV3.maximumSubtitleSegments,
            maximumCharacters: evidenceV3.maximumSubtitleCharacters,
          });
          subtitleEvidence = summarizeSubtitleEvidence(transientSubtitle);
          subtitleText = transientSubtitle.matchingText;
          subtitleAccessState = subtitleEvidence.state;
        }
      } catch {
        subtitleAccessState = "temporary-error";
      }
    }

    let imageEvidenceState = detailPayload.data.pic ? (allowPublicImage ? "temporary-error" : "not-requested") : "not-available";
    const sourceImageIds = [];
    if (allowPublicImage && detailPayload.data.pic) {
      try {
        const imageId = await requestPublicBilibiliImageId(detailPayload.data.pic, {
          maximumBytes: evidenceV3.maximumPublicImageBytes,
          headers,
        });
        sourceImageIds.push(imageId);
        imageEvidenceState = "ok";
      } catch {
        imageEvidenceState = "temporary-error";
      }
    }

    const tagNames = (tagResult.ok ? tagResult.payload.data : []).map((tag) => tag?.tag_name).filter(Boolean);
    const pageParts = (Array.isArray(detailPayload.data.pages) ? detailPayload.data.pages : []).map((page) => page?.part).filter(Boolean);
    const evidenceChannels = {
      title: evidence.title || raw.title,
      description: plain(detailPayload.data.desc || raw.description),
      dynamic: plain(detailPayload.data.dynamic),
      parts: plain(pageParts.join(" · ")),
      tags: plain(tagNames.join(" · ")),
      subtitle: subtitleText,
    };
    const evidenceFields = [
      ...evidence.evidenceFields,
      subtitleText ? "subtitle" : undefined,
      sourceImageIds.length ? "public-image" : undefined,
    ].filter(Boolean);
    return {
      ...raw,
      title: evidence.title || raw.title,
      author: evidence.author || raw.author,
      publishedAt: evidence.publishedAt || raw.publishedAt,
      description: evidence.matchingText || raw.description,
      evidenceChannels,
      metrics: evidence.metrics,
      signal: signalFromMetrics(evidence.metrics),
      comments: evidence.comments,
      commentAccessState,
      evidenceVersion: 3,
      evidenceClassifierRevision: EVIDENCE_V3_CLASSIFIER_REVISION,
      evidenceFields,
      subtitleAccessState,
      subtitleEvidence,
      imageEvidenceState,
      sourceImageIds,
      sourceContentId: evidence.sourceContentId,
      sourceArchiveId: evidence.sourceArchiveId,
      sourceAuthorId: evidence.sourceAuthorId,
      accessState: "ok",
    };
  } catch {
    return { ...raw, accessState: "temporary-error" };
  }
}

async function enrichPublicPageCandidate(raw) {
  try {
    const html = await request(raw.url, "text");
    const metadata = extractPublicPageMetadata(html, { url: raw.url, fallback: raw });
    if (metadata.accessState !== "ok") {
      return {
        ...raw,
        accessState: metadata.accessState,
        evidenceVersion: 3,
        evidenceClassifierRevision: EVIDENCE_V3_CLASSIFIER_REVISION,
        evidenceFields: metadata.evidenceFields,
        sourceContentId: metadata.sourceContentId,
        pageMetadataAccessState: metadata.accessState,
      };
    }
    return {
      ...raw,
      title: metadata.title || raw.title,
      author: metadata.author || raw.author,
      publishedAt: metadata.publishedAt || raw.publishedAt,
      description: metadata.matchingText || raw.description,
      evidenceChannels: {
        title: metadata.title || raw.title,
        "search-snippet": raw.description,
        "page-metadata": metadata.matchingText,
      },
      evidenceVersion: 3,
      evidenceClassifierRevision: EVIDENCE_V3_CLASSIFIER_REVISION,
      evidenceFields: metadata.evidenceFields,
      sourceContentId: metadata.sourceContentId,
      pageMetadataAccessState: "ok",
      imageEvidenceState: metadata.imageUrls.length ? "not-requested" : "not-available",
      sourceImageReferenceIds: metadata.imageUrls.map((url) => `ref:${hash(url).slice(0, 24)}`),
      accessState: "ok",
    };
  } catch {
    return {
      ...raw,
      accessState: "temporary-error",
      pageMetadataAccessState: "temporary-error",
      evidenceVersion: 3,
      evidenceClassifierRevision: EVIDENCE_V3_CLASSIFIER_REVISION,
    };
  }
}

async function collectBingRss(query) {
  const url = `https://www.bing.com/search?format=rss&q=${encodeURIComponent(query.query)}`;
  const xml = await request(url, "text");
  return xmlItems(xml).slice(0, query.maxResults).map((row) => ({
    ...row,
    platform: query.platform,
    author: undefined,
    signal: undefined,
    sourceQueryId: query.id,
  }));
}

function uniqueTerms(terms, minimumLength = 2) {
  const seen = new Set();
  return terms
    .filter((term) => term.cn && term.id !== undefined && normalize(term.match ?? term.cn).length >= minimumLength)
    .filter((term) => {
      const key = `${term.id}:${normalize(term.match ?? term.cn)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((left, right) => normalize(right.match ?? right.cn).length - normalize(left.match ?? left.cn).length);
}

function buildIndexes(guides, registry) {
  const guideById = new Map(guides.map((guide) => [guide.id, guide]));
  const baseChampions = guides.flatMap((guide) => guide.aliases
    .filter((alias) => /\p{Script=Han}/u.test(alias))
    .map((alias) => ({ id: guide.id, cn: alias, match: alias, vi: guide.name, icon: guide.icon })));
  const championAliases = (registry.aliases?.champions ?? []).flatMap((entry) => {
    const guide = guideById.get(entry.id);
    if (!guide) fail(`biệt danh dùng championId không tồn tại: ${entry.id}`);
    return entry.names.map((alias) => ({ id: guide.id, cn: guide.aliases[0], match: alias, vi: guide.name, icon: guide.icon }));
  });
  const champions = uniqueTerms([...baseChampions, ...championAliases], 1);

  const baseAugments = uniqueTerms(guides.flatMap((guide) => [...guide.coreAugments, ...guide.prismatic, ...guide.gold, ...guide.silver]
    .map((augment) => ({ id: augment.id, cn: augment.cn, match: augment.cn, vi: augment.vi, icon: augment.icon }))));
  const augmentByCn = new Map(baseAugments.map((augment) => [augment.cn, augment]));
  const augmentAliases = (registry.aliases?.augments ?? []).flatMap((entry) => {
    const augment = augmentByCn.get(entry.canonicalCn);
    if (!augment) fail(`biệt danh dùng lõi không tồn tại: ${entry.canonicalCn}`);
    return entry.names.map((alias) => ({ ...augment, match: alias }));
  });
  const augments = uniqueTerms([...baseAugments, ...augmentAliases], 1);

  const baseItems = uniqueTerms(guides.flatMap((guide) => (guide.itemData ?? [])
    .map((item) => ({ id: item.id, cn: item.original, match: item.original, vi: item.name, icon: item.icon }))));
  const itemByCn = new Map(baseItems.map((item) => [item.cn, item]));
  const itemAliases = (registry.aliases?.items ?? []).flatMap((entry) => {
    const item = itemByCn.get(entry.canonicalCn);
    if (!item) fail(`biệt danh dùng trang bị không tồn tại: ${entry.canonicalCn}`);
    return entry.names.map((alias) => ({ ...item, match: alias }));
  });
  const items = uniqueTerms([...baseItems, ...itemAliases], 1);
  return { champions, augments, items };
}

function findTerms(text, terms, limit = 8) {
  const haystack = normalize(text);
  const ids = new Set();
  const matches = [];
  for (const term of terms) {
    if (ids.has(term.id) || !haystack.includes(normalize(term.match ?? term.cn))) continue;
    ids.add(term.id);
    matches.push(term);
    if (matches.length >= limit) break;
  }
  return matches;
}

function negatedTermIds(text, terms) {
  const haystack = normalize(text);
  const prefixes = ["没有", "没拿", "没出", "不需要", "不用", "不要", "不考虑", "无需", "不推荐", "非"];
  const ids = new Set();
  for (const term of terms) {
    const needle = normalize(term.match ?? term.cn);
    let cursor = haystack.indexOf(needle);
    while (cursor >= 0) {
      const before = haystack.slice(Math.max(0, cursor - 8), cursor);
      if (prefixes.some((prefix) => before.endsWith(prefix) || before.includes(prefix))) ids.add(term.id);
      cursor = haystack.indexOf(needle, cursor + needle.length);
    }
  }
  return ids;
}

function sourceTier(registry, platform, author) {
  if (!author) return "unlisted";
  return registry.creators.find((creator) => creator.platform === platform && normalize(creator.name) === normalize(author))?.tier ?? "unlisted";
}

function buildKnownSets(community, indexes) {
  const sourceUrls = new Set([
    ...community.globalSources.map((source) => canonicalUrl(source.url)),
    ...community.records.flatMap((record) => record.sources.map((source) => canonicalUrl(source.url))),
  ].filter(Boolean));
  const augmentByCn = new Map(indexes.augments.map((augment) => [augment.cn, augment.id]));
  const itemByCn = new Map(indexes.items.map((item) => [item.cn, item.id]));
  const buildSignatures = new Set(community.records.map((record) => [
    record.championId,
    record.coreCn.map((cn) => augmentByCn.get(cn)).filter(Boolean).sort((a, b) => a - b).join("-"),
    record.itemCn.map((cn) => itemByCn.get(cn)).filter(Boolean).sort((a, b) => a - b).join("-"),
  ].join(":")));
  return { sourceUrls, buildSignatures };
}

function evidenceChannels(raw) {
  const configured = raw.evidenceChannels && typeof raw.evidenceChannels === "object"
    ? Object.entries(raw.evidenceChannels)
    : [];
  const rows = configured.length
    ? configured
    : [["title", raw.title], ["description", raw.description]];
  return rows
    .map(([channel, value]) => ({ channel: plain(channel), text: plain(value) }))
    .filter((row) => row.channel && row.text);
}

function classifyEvidenceChannels(rows, indexes) {
  return summarizeEntityEvidence(rows.map((row) => {
    const negatedAugments = negatedTermIds(row.text, indexes.augments);
    const negatedItems = negatedTermIds(row.text, indexes.items);
    return {
      channel: row.channel,
      champions: findTerms(row.text, indexes.champions),
      augments: findTerms(row.text, indexes.augments).filter((entry) => !negatedAugments.has(entry.id)),
      items: findTerms(row.text, indexes.items).filter((entry) => !negatedItems.has(entry.id)),
    };
  }));
}

function classify(raw, context) {
  const url = canonicalUrl(raw.url);
  if (!url) return undefined;
  const channels = evidenceChannels(raw);
  const text = channels.map((row) => row.text).join(" · ");
  const normalizedText = normalize(text);
  const hasModeKeyword = context.registry.modeKeywords.some((keyword) => normalizedText.includes(normalize(keyword)));
  if (!hasModeKeyword) return undefined;
  const modeValid = !(context.registry.excludedModeKeywords ?? [])
    .some((keyword) => normalizedText.includes(normalize(keyword)));
  const disqualifiers = (context.registry.disqualifierKeywords ?? [])
    .filter((keyword) => normalizedText.includes(normalize(keyword)));

  const entities = classifyEvidenceChannels(channels, context.indexes);
  const champions = entities.championMatches;
  const augments = entities.augmentMatches;
  const items = entities.itemMatches;
  const signatures = buildEvidenceSignatures({ champions, augments, items });
  const { signature, partialSignature } = signatures;
  const tier = sourceTier(context.registry, raw.platform, raw.author);
  const metrics = {
    ...parseSignalMetrics(raw.signal),
    ...(raw.metrics ?? {}),
  };
  const comments = raw.comments && typeof raw.comments === "object" ? raw.comments : undefined;
  const commentsState = commentEvidenceState(comments, context.registry.policy.moderation);
  const patchHint = text.match(/\b(?:16|26)\.\d{1,2}\b/)?.[0];
  const ageDays = raw.publishedAt
    ? Math.floor((Date.now() - Date.parse(`${raw.publishedAt}T00:00:00Z`)) / 86_400_000)
    : undefined;
  const currentEnough = ageDays === undefined || ageDays <= context.registry.lookbackDays;
  const reasons = ["Có từ khóa Hải Đấu/ARAM Mayhem"];
  let score = 20;
  if (champions.length === 1) { score += 25; reasons.push(`Nhận dạng ${champions[0].vi}`); }
  else if (champions.length > 1) reasons.push("Có nhiều tướng trong bằng chứng; cần đối chiếu bản dịch/ngữ cảnh");
  if (augments.length) { score += 25; reasons.push(`${augments.length} lõi khớp ID game`); }
  if (items.length) { score += 10; reasons.push(`${items.length} trang bị khớp ID game`); }
  if (tier === "established") { score += 10; reasons.push("Tác giả nằm trong danh sách đã có nguồn đối chiếu"); }
  if (currentEnough) { score += 10; reasons.push("Nguồn nằm trong cửa sổ theo dõi hiện hành"); }
  score = Math.min(score, 100);

  let status = "needs-champion";
  if (context.known.sourceUrls.has(url)) status = "known-source";
  else if (isBeforePatch(patchHint, context.registry.minimumPatch) || (ageDays !== undefined && ageDays > context.registry.lookbackDays)) status = "stale";
  else if (champions.length === 1 && signature && context.known.buildSignatures.has(signature)) status = "known-build";
  else if (!champions.length && patchHint) status = "patch-watch";
  else if (!champions.length) status = "needs-champion";
  else if (!signature) status = "needs-details";
  else if (score >= context.registry.policy.minimumReviewScore) status = "ready-for-review";
  else status = "needs-details";

  const sourceImageIds = [...new Set(raw.sourceImageIds ?? [])].sort();
  const sourceImageReferenceIds = [...new Set(raw.sourceImageReferenceIds ?? [])].sort();
  const evidenceReviewState = signature
    ? "complete"
    : champions.length > 1
      ? "translation-review-required"
      : (sourceImageIds.length || sourceImageReferenceIds.length)
        ? "image-review-required"
        : "incomplete";
  if (evidenceReviewState === "image-review-required") reasons.push("Ảnh công khai chỉ lưu mã tham chiếu; cần OCR/đối chiếu thủ công trước khi duyệt");

  return {
    id: `candidate-${hash(url).slice(0, 16)}`,
    platform: raw.platform,
    url,
    title: plain(raw.title),
    author: plain(raw.author) || undefined,
    publishedAt: validDate(raw.publishedAt) ? raw.publishedAt : undefined,
    patchHint,
    signal: plain(raw.signal) || undefined,
    metrics,
    authorTier: tier,
    accessState: raw.accessState ?? "ok",
    modeValid,
    disqualifiers,
    engagementState: engagementPass(metrics, context.registry),
    commentEvidenceState: commentsState,
    comments,
    commentAccessState: raw.commentAccessState,
    currentEnough,
    evidenceVersion: raw.evidenceVersion,
    evidenceClassifierRevision: raw.evidenceClassifierRevision,
    evidenceFields: [...new Set(raw.evidenceFields ?? [])].sort(),
    entityEvidence: entities.entityEvidence,
    partialSignature,
    evidenceReviewState,
    subtitleAccessState: raw.subtitleAccessState,
    subtitleEvidence: raw.subtitleEvidence,
    pageMetadataAccessState: raw.pageMetadataAccessState,
    imageEvidenceState: raw.imageEvidenceState,
    sourceImageIds,
    sourceImageReferenceIds,
    sourceContentId: raw.sourceContentId,
    sourceArchiveId: raw.sourceArchiveId,
    sourceAuthorId: raw.sourceAuthorId,
    sourceQueryIds: [raw.sourceQueryId].filter(Boolean),
    championMatches: champions,
    augmentMatches: augments,
    itemMatches: items,
    signature,
    score,
    status,
    reasons,
    firstSeenAt: context.today,
  };
}

function mergeCandidates(existing, discovered) {
  const byUrl = new Map(existing.map((candidate) => [candidate.url, candidate]));
  let newCount = 0;
  let updatedCount = 0;
  for (const candidate of discovered) {
    const previous = byUrl.get(candidate.url);
    if (!previous) {
      byUrl.set(candidate.url, candidate);
      newCount += 1;
      continue;
    }
    const merged = {
      ...previous,
      ...candidate,
      sourceQueryIds: [...new Set([...(previous.sourceQueryIds ?? []), ...candidate.sourceQueryIds])].sort(),
      firstSeenAt: previous.firstSeenAt,
    };
    const before = JSON.stringify(normalizeCandidate(previous));
    const after = JSON.stringify(normalizeCandidate(merged));
    if (before !== after) updatedCount += 1;
    byUrl.set(candidate.url, merged);
  }
  return { candidates: [...byUrl.values()], newCount, updatedCount };
}

function applyCrossSourceStatus(candidates, registry) {
  const groups = new Map();
  for (const candidate of candidates) {
    if (!candidate.signature || ["known-source", "known-build", "stale"].includes(candidate.status)) continue;
    const group = groups.get(candidate.signature) ?? [];
    group.push(candidate);
    groups.set(candidate.signature, group);
  }
  for (const group of groups.values()) {
    const dates = group.map((candidate) => Date.parse(`${candidate.publishedAt ?? candidate.firstSeenAt}T00:00:00Z`)).filter(Number.isFinite);
    const withinWindow = !dates.length || (Math.max(...dates) - Math.min(...dates)) / 86_400_000 <= registry.policy.crossSourceWindowDays;
    if (countIndependentSources(group) < 2 || !withinWindow) continue;
    for (const candidate of group) {
      candidate.status = "cross-source-review";
      candidate.score = Math.max(candidate.score, 80);
      if (!candidate.reasons.includes("Có ít nhất hai nguồn độc lập cùng dấu vân tay")) {
        candidate.reasons.push("Có ít nhất hai nguồn độc lập cùng dấu vân tay");
      }
    }
  }
}

function normalizeCandidate(candidate) {
  return {
    id: candidate.id,
    platform: candidate.platform,
    url: candidate.url,
    title: candidate.title,
    author: candidate.author,
    publishedAt: candidate.publishedAt,
    patchHint: candidate.patchHint,
    authorTier: candidate.authorTier,
    accessState: candidate.accessState,
    modeValid: candidate.modeValid,
    disqualifiers: [...(candidate.disqualifiers ?? [])].sort(),
    engagementState: candidate.engagementState,
    commentEvidenceState: candidate.commentEvidenceState,
    currentEnough: candidate.currentEnough,
    evidenceVersion: candidate.evidenceVersion,
    evidenceClassifierRevision: candidate.evidenceClassifierRevision,
    evidenceFields: [...(candidate.evidenceFields ?? [])].sort(),
    entityEvidence: candidate.entityEvidence,
    partialSignature: candidate.partialSignature,
    evidenceReviewState: candidate.evidenceReviewState,
    subtitleAccessState: candidate.subtitleAccessState,
    subtitleEvidence: candidate.subtitleEvidence,
    pageMetadataAccessState: candidate.pageMetadataAccessState,
    imageEvidenceState: candidate.imageEvidenceState,
    sourceImageIds: [...(candidate.sourceImageIds ?? [])].sort(),
    sourceImageReferenceIds: [...(candidate.sourceImageReferenceIds ?? [])].sort(),
    sourceContentId: candidate.sourceContentId,
    sourceArchiveId: candidate.sourceArchiveId,
    sourceAuthorId: candidate.sourceAuthorId,
    sourceQueryIds: [...(candidate.sourceQueryIds ?? [])].sort(),
    championMatches: (candidate.championMatches ?? []).map(({ id, cn, vi, icon }) => ({ id, cn, vi, icon })).sort((a, b) => String(a.id).localeCompare(String(b.id))),
    augmentMatches: (candidate.augmentMatches ?? []).map(({ id, cn, vi, icon }) => ({ id, cn, vi, icon })).sort((a, b) => a.id - b.id),
    itemMatches: (candidate.itemMatches ?? []).map(({ id, cn, vi, icon }) => ({ id, cn, vi, icon })).sort((a, b) => a.id - b.id),
    signature: candidate.signature,
    score: candidate.score,
    status: candidate.status,
    reasons: [...(candidate.reasons ?? [])].sort(),
    firstSeenAt: candidate.firstSeenAt,
  };
}

function validateRegistry(registry) {
  if (registry.schemaVersion !== 1) fail("schemaVersion danh mục nguồn chưa được hỗ trợ");
  if (!Array.isArray(registry.queries) || !registry.queries.length) fail("danh mục nguồn không có truy vấn");
  if (!Array.isArray(registry.creators) || !Array.isArray(registry.modeKeywords)) fail("danh mục nguồn thiếu tác giả/từ khóa");
  if (registry.policy?.autoPublish !== true) fail("autoPublish phải bật để runner áp dụng luật kiểm duyệt tự động");
  const moderation = registry.policy?.moderation;
  if (!moderation) fail("danh mục nguồn thiếu policy.moderation");
  const evidenceV2 = registry.policy?.evidenceV2;
  if (evidenceV2?.enabled !== true) fail("policy.evidenceV2.enabled phải bật");
  if (!Number.isInteger(evidenceV2.classifierRevision) || evidenceV2.classifierRevision < 1) {
    fail("evidenceV2.classifierRevision phải là số nguyên dương");
  }
  if (evidenceV2.classifierRevision !== EVIDENCE_V2_CLASSIFIER_REVISION) {
    fail(`evidenceV2.classifierRevision phải bằng ${EVIDENCE_V2_CLASSIFIER_REVISION}`);
  }
  if (!Number.isInteger(evidenceV2.maximumBilibiliEnrichmentsPerRun) || evidenceV2.maximumBilibiliEnrichmentsPerRun < 1) {
    fail("maximumBilibiliEnrichmentsPerRun phải là số nguyên dương");
  }
  if (!Number.isInteger(evidenceV2.maximumPublicCommentSample) || evidenceV2.maximumPublicCommentSample < 1 || evidenceV2.maximumPublicCommentSample > 50) {
    fail("maximumPublicCommentSample phải nằm trong 1..50");
  }
  const evidenceV3 = registry.policy?.evidenceV3;
  if (evidenceV3?.enabled !== true) fail("policy.evidenceV3.enabled phải bật");
  if (evidenceV3.classifierRevision !== EVIDENCE_V3_CLASSIFIER_REVISION) {
    fail(`evidenceV3.classifierRevision phải bằng ${EVIDENCE_V3_CLASSIFIER_REVISION}`);
  }
  for (const key of [
    "maximumBilibiliEnrichmentsPerRun",
    "maximumBilibiliSubtitleFetchesPerRun",
    "maximumPublicImageFetchesPerRun",
    "maximumPublicPageEnrichmentsPerRun",
    "maximumSubtitleSegments",
    "maximumSubtitleCharacters",
    "maximumPublicImageBytes",
  ]) {
    if (!Number.isInteger(evidenceV3[key]) || evidenceV3[key] < 1) fail(`evidenceV3.${key} phải là số nguyên dương`);
  }
  if (evidenceV3.maximumSubtitleSegments > 500) fail("maximumSubtitleSegments không được vượt 500");
  if (evidenceV3.maximumSubtitleCharacters > 50_000) fail("maximumSubtitleCharacters không được vượt 50000");
  if (evidenceV3.storeRawEvidenceText !== false) fail("evidenceV3.storeRawEvidenceText phải tắt");
  for (const key of ["crossSourceMinimumScore", "trustedCreatorMinimumScore"]) {
    if (!Number.isFinite(moderation[key]) || moderation[key] < 0 || moderation[key] > 100) fail(`ngưỡng ${key} phải nằm trong 0..100`);
  }
  for (const key of [
    "minimumSimilarity",
    "minimumWeightedEngagementRate",
    "minimumPositiveCommentRatio",
    "demoteNegativeCommentRatio",
  ]) {
    if (!Number.isFinite(moderation[key]) || moderation[key] < 0 || moderation[key] > 1) fail(`ngưỡng ${key} phải nằm trong 0..1`);
  }
  for (const key of [
    "minimumSourceAgeHours",
    "minimumViews",
    "minimumPositiveActions",
    "minimumCommentSample",
    "consecutiveFailureLimit",
  ]) {
    if (!Number.isFinite(moderation[key]) || moderation[key] < 0) fail(`ngưỡng ${key} phải là số không âm`);
  }
  const ids = new Set();
  for (const query of registry.queries) {
    if (!query.id || ids.has(query.id)) fail(`truy vấn nguồn bị trùng hoặc thiếu id: ${query.id}`);
    if (!new Set(["bilibili-search", "bing-rss"]).has(query.adapter)) fail(`adapter không hỗ trợ: ${query.adapter}`);
    if (!query.platform || !query.query || !Number.isInteger(query.maxResults)) fail(`truy vấn ${query.id} thiếu cấu hình`);
    ids.add(query.id);
  }
}

function validateInbox(inbox, indexes) {
  if (inbox.schemaVersion !== 1 || !Array.isArray(inbox.candidates)) fail("community-inbox.json không đúng cấu trúc");
  const ids = new Set();
  const urls = new Set();
  const championIds = new Set(indexes.champions.map((entry) => entry.id));
  const augmentIds = new Set(indexes.augments.map((entry) => entry.id));
  const itemIds = new Set(indexes.items.map((entry) => entry.id));
  for (const candidate of inbox.candidates) {
    if (!candidate.id || ids.has(candidate.id)) fail(`candidate id bị trùng: ${candidate.id}`);
    if (!candidate.url || urls.has(candidate.url) || !canonicalUrl(candidate.url)) fail(`candidate URL bị trùng hoặc sai: ${candidate.url}`);
    if (!VALID_STATUSES.has(candidate.status)) fail(`candidate có trạng thái lạ: ${candidate.status}`);
    if (candidate.authorTier !== undefined && !VALID_AUTHOR_TIERS.has(candidate.authorTier)) fail(`candidate có authorTier lạ: ${candidate.authorTier}`);
    if (candidate.accessState !== undefined && !VALID_ACCESS_STATES.has(candidate.accessState)) fail(`candidate có accessState lạ: ${candidate.accessState}`);
    if (candidate.modeValid !== undefined && typeof candidate.modeValid !== "boolean") fail(`candidate có modeValid không hợp lệ: ${candidate.id}`);
    if (candidate.engagementState !== undefined && typeof candidate.engagementState !== "boolean") fail(`candidate có engagementState không hợp lệ: ${candidate.id}`);
    if (candidate.commentAccessState !== undefined && !VALID_COMMENT_ACCESS_STATES.has(candidate.commentAccessState)) fail(`candidate có commentAccessState lạ: ${candidate.id}`);
    if (candidate.commentEvidenceState !== undefined && !VALID_COMMENT_EVIDENCE_STATES.has(candidate.commentEvidenceState)) fail(`candidate có commentEvidenceState lạ: ${candidate.id}`);
    if (candidate.evidenceVersion !== undefined && !new Set([2, 3]).has(candidate.evidenceVersion)) fail(`candidate có evidenceVersion lạ: ${candidate.id}`);
    if (candidate.evidenceClassifierRevision !== undefined && (!Number.isInteger(candidate.evidenceClassifierRevision) || candidate.evidenceClassifierRevision < 1)) fail(`candidate có evidenceClassifierRevision lạ: ${candidate.id}`);
    if (candidate.evidenceFields !== undefined && !Array.isArray(candidate.evidenceFields)) fail(`candidate có evidenceFields không hợp lệ: ${candidate.id}`);
    if (candidate.evidenceReviewState !== undefined && !VALID_EVIDENCE_REVIEW_STATES.has(candidate.evidenceReviewState)) fail(`candidate có evidenceReviewState lạ: ${candidate.id}`);
    if (candidate.subtitleAccessState !== undefined && !VALID_SUBTITLE_ACCESS_STATES.has(candidate.subtitleAccessState)) fail(`candidate có subtitleAccessState lạ: ${candidate.id}`);
    if (candidate.imageEvidenceState !== undefined && !VALID_IMAGE_EVIDENCE_STATES.has(candidate.imageEvidenceState)) fail(`candidate có imageEvidenceState lạ: ${candidate.id}`);
    if (candidate.pageMetadataAccessState !== undefined && !VALID_ACCESS_STATES.has(candidate.pageMetadataAccessState)) fail(`candidate có pageMetadataAccessState lạ: ${candidate.id}`);
    if (candidate.partialSignature !== undefined && typeof candidate.partialSignature !== "string") fail(`candidate có partialSignature lạ: ${candidate.id}`);
    if (candidate.subtitleEvidence !== undefined) {
      if (!candidate.subtitleEvidence || typeof candidate.subtitleEvidence !== "object" || Array.isArray(candidate.subtitleEvidence)) fail(`candidate có subtitleEvidence không hợp lệ: ${candidate.id}`);
      if (!new Set(["ok", "not-available"]).has(candidate.subtitleEvidence.state)) fail(`candidate có subtitleEvidence.state lạ: ${candidate.id}`);
      if (!new Set(["0", "1-20", "21-100", "101+"]).has(candidate.subtitleEvidence.segmentCountBucket)) fail(`candidate có segmentCountBucket lạ: ${candidate.id}`);
      if (typeof candidate.subtitleEvidence.truncated !== "boolean") fail(`candidate có subtitleEvidence.truncated lạ: ${candidate.id}`);
    }
    for (const imageId of candidate.sourceImageIds ?? []) if (!/^sha256:[a-f0-9]{24}$/.test(imageId)) fail(`candidate có sourceImageId lạ: ${candidate.id}`);
    for (const imageId of candidate.sourceImageReferenceIds ?? []) if (!/^ref:[a-f0-9]{24}$/.test(imageId)) fail(`candidate có sourceImageReferenceId lạ: ${candidate.id}`);
    if (candidate.entityEvidence !== undefined) {
      for (const key of ["champions", "augments", "items"]) {
        if (!Array.isArray(candidate.entityEvidence[key])) fail(`candidate thiếu entityEvidence.${key}: ${candidate.id}`);
        for (const entry of candidate.entityEvidence[key]) {
          if (entry?.id === undefined || !Array.isArray(entry.channels) || entry.channels.some((channel) => typeof channel !== "string")) {
            fail(`candidate có entityEvidence.${key} lạ: ${candidate.id}`);
          }
        }
      }
      if (hasRawEvidencePayload(candidate.entityEvidence)) fail(`candidate lưu văn bản bằng chứng ngoài schema: ${candidate.id}`);
    }
    if (candidate.disqualifiers !== undefined && !Array.isArray(candidate.disqualifiers)) fail(`candidate có disqualifiers không hợp lệ: ${candidate.id}`);
    if (candidate.metrics !== undefined) {
      if (!candidate.metrics || typeof candidate.metrics !== "object" || Array.isArray(candidate.metrics)) fail(`candidate có metrics không hợp lệ: ${candidate.id}`);
      for (const [key, value] of Object.entries(candidate.metrics)) {
        if (!["views", "likes", "coins", "favorites", "comments"].includes(key)) fail(`candidate có metric lạ: ${key}`);
        if (!Number.isFinite(value) || value < 0) fail(`candidate có metric âm hoặc không phải số: ${candidate.id}.${key}`);
      }
    }
    if (candidate.comments !== undefined) {
      if (!candidate.comments || typeof candidate.comments !== "object" || Array.isArray(candidate.comments)) fail(`candidate có comments không hợp lệ: ${candidate.id}`);
      for (const [key, value] of Object.entries(candidate.comments)) {
        if (!["positive", "negative", "neutral", "meaningful", "sampled"].includes(key)) fail(`candidate có comment metric lạ: ${key}`);
        if (!Number.isFinite(value) || value < 0) fail(`candidate có comment metric âm hoặc không phải số: ${candidate.id}.${key}`);
      }
    }
    for (const entry of candidate.championMatches ?? []) if (!championIds.has(entry.id)) fail(`candidate dùng championId lạ: ${entry.id}`);
    for (const entry of candidate.augmentMatches ?? []) if (!augmentIds.has(entry.id)) fail(`candidate dùng augmentId lạ: ${entry.id}`);
    for (const entry of candidate.itemMatches ?? []) if (!itemIds.has(entry.id)) fail(`candidate dùng itemId lạ: ${entry.id}`);
    ids.add(candidate.id);
    urls.add(candidate.url);
  }
}

async function main() {
  const validateOnly = process.argv.includes("--validate-only");
  const inputIndex = process.argv.indexOf("--input");
  const inputPath = inputIndex >= 0 ? path.resolve(ROOT, process.argv[inputIndex + 1]) : undefined;
  const [registryText, communityText, guidesText, dataText, inboxText] = await Promise.all([
    readFile(REGISTRY_PATH, "utf8"),
    readFile(COMMUNITY_PATH, "utf8"),
    readFile(GUIDES_PATH, "utf8"),
    readFile(DATA_PATH, "utf8"),
    readFile(INBOX_PATH, "utf8"),
  ]);
  const registry = JSON.parse(registryText);
  const community = JSON.parse(communityText);
  const guides = parseGuides(guidesText);
  const inbox = JSON.parse(inboxText);
  const indexes = buildIndexes(guides, registry);
  validateRegistry(registry);
  validateInbox(inbox, indexes);

  if (validateOnly) {
    console.log(`Đã kiểm tra danh mục ${registry.queries.length} truy vấn, ${registry.creators.length} tác giả và ${inbox.candidates.length} ứng viên.`);
    return;
  }

  const today = new Date().toISOString().slice(0, 10);
  const currentPatch = currentPatchFromSource(dataText, registry.minimumPatch);
  const known = buildKnownSets(community, indexes);
  const rawResults = [];
  const errors = [];

  if (inputPath) {
    const manualRows = JSON.parse(await readFile(inputPath, "utf8"));
    if (!Array.isArray(manualRows)) fail("tệp --input phải là một mảng JSON");
    rawResults.push(...manualRows.map((row) => ({ ...row, sourceQueryId: "manual-input" })));
  }

  for (const query of registry.queries) {
    try {
      const rows = query.adapter === "bilibili-search" ? await collectBilibili(query) : await collectBingRss(query);
      rawResults.push(...rows);
      console.log(`${query.id}: đọc ${rows.length} kết quả công khai`);
    } catch (error) {
      errors.push({ queryId: query.id, message: String(error?.message ?? error) });
      console.warn(`${query.id}: bỏ qua do lỗi tạm thời (${error?.message ?? error})`);
    }
  }

  const context = { registry, indexes, known, today };
  const discoveredByUrl = new Map();
  const bilibiliEvidenceCache = new Map();
  const publicPageEvidenceCache = new Map();
  let bilibiliEnrichmentCount = 0;
  let bilibiliSubtitleFetchCount = 0;
  let publicImageFetchCount = 0;
  let publicPageEnrichmentCount = 0;
  for (const raw of rawResults) {
    let candidate = classify(raw, context);
    const candidateUrl = canonicalUrl(raw.url);
    const hasChampionHint = findTerms([raw.title, raw.description].filter(Boolean).join(" · "), indexes.champions, 1).length === 1;
    const canEnrich = raw.platform === "Bilibili"
      && Boolean(candidateUrl)
      && hasChampionHint
      && !new Set(["known-source", "known-build", "stale"]).has(candidate?.status);
    if (canEnrich) {
      let enrichedPromise = bilibiliEvidenceCache.get(candidateUrl);
      if (!enrichedPromise && bilibiliEnrichmentCount < registry.policy.evidenceV3.maximumBilibiliEnrichmentsPerRun) {
        const allowSubtitle = bilibiliSubtitleFetchCount < registry.policy.evidenceV3.maximumBilibiliSubtitleFetchesPerRun;
        const allowPublicImage = publicImageFetchCount < registry.policy.evidenceV3.maximumPublicImageFetchesPerRun;
        enrichedPromise = enrichBilibiliCandidate(raw, registry, { allowSubtitle, allowPublicImage });
        bilibiliEvidenceCache.set(candidateUrl, enrichedPromise);
        bilibiliEnrichmentCount += 1;
        if (allowSubtitle) bilibiliSubtitleFetchCount += 1;
        if (allowPublicImage) publicImageFetchCount += 1;
      }
      if (enrichedPromise) {
        const enriched = await enrichedPromise;
        candidate = classify({ ...enriched, sourceQueryId: raw.sourceQueryId }, context);
      }
    }
    const canEnrichPublicPage = raw.platform !== "Bilibili"
      && Boolean(candidateUrl)
      && hasChampionHint
      && !new Set(["known-source", "known-build", "stale"]).has(candidate?.status);
    if (canEnrichPublicPage) {
      let enrichedPromise = publicPageEvidenceCache.get(candidateUrl);
      if (!enrichedPromise && publicPageEnrichmentCount < registry.policy.evidenceV3.maximumPublicPageEnrichmentsPerRun) {
        enrichedPromise = enrichPublicPageCandidate(raw);
        publicPageEvidenceCache.set(candidateUrl, enrichedPromise);
        publicPageEnrichmentCount += 1;
      }
      if (enrichedPromise) {
        const enriched = await enrichedPromise;
        candidate = classify({ ...enriched, sourceQueryId: raw.sourceQueryId }, context);
      }
    }
    if (!candidate) continue;
    const previous = discoveredByUrl.get(candidate.url);
    if (!previous) discoveredByUrl.set(candidate.url, candidate);
    else discoveredByUrl.set(candidate.url, {
      ...previous,
      ...candidate,
      sourceQueryIds: [...new Set([...previous.sourceQueryIds, ...candidate.sourceQueryIds])].sort(),
    });
  }

  const merged = mergeCandidates(inbox.candidates, [...discoveredByUrl.values()]);
  merged.candidates = merged.candidates.map(enforceEvidenceV3Signature);
  applyCrossSourceStatus(merged.candidates, registry);
  merged.candidates.sort((left, right) =>
    String(right.publishedAt ?? right.firstSeenAt).localeCompare(String(left.publishedAt ?? left.firstSeenAt))
      || right.score - left.score
      || left.url.localeCompare(right.url));
  const limitedCandidates = merged.candidates.slice(0, registry.policy.maxInboxItems);
  const normalizedCandidates = limitedCandidates.map(normalizeCandidate);
  const contentHash = hash({
    registryHash: hash(JSON.parse(registryText)),
    currentPatch,
    candidates: normalizedCandidates,
  });
  const previousReport = await readFile(REPORT_PATH, "utf8").then(JSON.parse).catch(() => undefined);
  const statusCounts = Object.fromEntries([...VALID_STATUSES].map((status) => [status, limitedCandidates.filter((candidate) => candidate.status === status).length]));
  const report = {
    generatedAt: new Date().toISOString(),
    contentHash,
    currentPatch,
    queryCount: registry.queries.length,
    creatorCount: registry.creators.length,
    candidateCount: limitedCandidates.length,
    newCandidateCount: merged.newCount,
    updatedCandidateCount: merged.updatedCount,
    reviewCandidateCount: statusCounts["ready-for-review"] + statusCounts["cross-source-review"],
    evidenceV3: {
      candidateCount: limitedCandidates.filter((candidate) => candidate.evidenceVersion === 3).length,
      completeSignatureCount: limitedCandidates.filter((candidate) => candidate.evidenceVersion === 3 && candidate.evidenceReviewState === "complete").length,
      subtitleEvidenceCount: limitedCandidates.filter((candidate) => candidate.subtitleAccessState === "ok").length,
      publicPageMetadataCount: limitedCandidates.filter((candidate) => candidate.pageMetadataAccessState === "ok").length,
      publicImageEvidenceCount: limitedCandidates.filter((candidate) => candidate.imageEvidenceState === "ok").length,
      imageReviewQueueCount: limitedCandidates.filter((candidate) => candidate.evidenceVersion === 3 && candidate.evidenceReviewState === "image-review-required").length,
      translationReviewQueueCount: limitedCandidates.filter((candidate) => candidate.evidenceVersion === 3 && candidate.evidenceReviewState === "translation-review-required").length,
    },
    statusCounts,
    newestPublishedAt: limitedCandidates.map((candidate) => candidate.publishedAt).filter(Boolean).sort().at(-1),
    scanErrors: errors,
    autoPublish: registry.policy.autoPublish,
  };

  if (previousReport?.contentHash === contentHash) {
    console.log(`Không có ứng viên mới có ý nghĩa; giữ nguyên hash ${contentHash}.`);
    return;
  }

  const nextInbox = { schemaVersion: 1, updatedAt: today, candidates: limitedCandidates };
  validateInbox(nextInbox, indexes);
  await Promise.all([
    writeFile(INBOX_PATH, `${JSON.stringify(nextInbox, null, 2)}\n`),
    writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`),
  ]);
  console.log(`Đã lưu ${limitedCandidates.length} ứng viên (${report.reviewCandidateCount} chờ duyệt có ID rõ); hash ${contentHash}.`);
}

await main();
