const POSITIVE_PHRASES = [
  "很强",
  "真强",
  "太强",
  "好用",
  "实用",
  "能玩",
  "可以玩",
  "推荐",
  "有用",
  "厉害",
  "舒服",
  "合理",
  "学到了",
  "适合",
];

const NEGATIVE_PHRASES = [
  "不强",
  "不好用",
  "没用",
  "不能玩",
  "不推荐",
  "别推荐",
  "不行",
  "垃圾",
  "太弱",
  "很弱",
  "坑人",
  "过时",
  "削了",
  "修复了",
  "有bug",
  "错误",
  "不对",
  "翻车",
];

const BUILD_CONTEXT = [
  "出装",
  "装备",
  "强化",
  "符文",
  "核心",
  "玩法",
  "套路",
  "构筑",
  "这套",
  "这个流派",
  "这把",
];

const NEGATION_MARKERS = ["不", "没", "无", "别", "勿", "未"];

export const EVIDENCE_CLASSIFIER_REVISION = 1;

function normalizedText(value = "") {
  return String(value)
    .normalize("NFKC")
    .toLocaleLowerCase("zh-CN")
    .replace(/\[[^\]]+\]/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/[\s\p{P}\p{S}]/gu, "");
}

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

function dateOnlyFromUnix(seconds) {
  const number = Number(seconds);
  if (!Number.isFinite(number) || number <= 0) return undefined;
  const date = new Date(number * 1000);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString().slice(0, 10);
}

function uniqueText(parts) {
  const seen = new Set();
  return parts
    .map((part) => String(part ?? "").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .filter((part) => {
      const key = normalizedText(part);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function phraseOccurrences(text, phrase) {
  const positions = [];
  let cursor = text.indexOf(phrase);
  while (cursor >= 0) {
    positions.push(cursor);
    cursor = text.indexOf(phrase, cursor + phrase.length);
  }
  return positions;
}

function isNegatedAt(text, position) {
  const prefix = text.slice(Math.max(0, position - 2), position);
  return NEGATION_MARKERS.some((marker) => prefix.includes(marker));
}

function classifyPublicComment(message) {
  const text = normalizedText(message);
  if (text.length < 4) return "ignored";
  const hasContext = BUILD_CONTEXT.some((phrase) => text.includes(normalizedText(phrase)));
  const negatedPositive = POSITIVE_PHRASES.some((phrase) => {
    const normalizedPhrase = normalizedText(phrase);
    return phraseOccurrences(text, normalizedPhrase).some((position) => isNegatedAt(text, position));
  });
  const negative = negatedPositive || NEGATIVE_PHRASES.some((phrase) => text.includes(normalizedText(phrase)));
  const positiveText = NEGATIVE_PHRASES.reduce(
    (value, phrase) => value.replaceAll(normalizedText(phrase), ""),
    text,
  );
  const positive = POSITIVE_PHRASES.some((phrase) => {
    const normalizedPhrase = normalizedText(phrase);
    return phraseOccurrences(positiveText, normalizedPhrase).some((position) => !isNegatedAt(positiveText, position));
  });
  if (!hasContext && !positive && !negative) return "ignored";
  if (positive && negative) return "neutral";
  if (negative) return "negative";
  if (positive) return "positive";
  return "neutral";
}

export function summarizePublicComments(replies = [], { maximumSample = 20 } = {}) {
  const limit = Math.max(0, Math.min(50, Number.isInteger(maximumSample) ? maximumSample : 20));
  const uniqueReplies = [];
  const seenIds = new Set();
  for (const reply of Array.isArray(replies) ? replies : []) {
    const id = String(reply?.rpid ?? reply?.id ?? `row-${uniqueReplies.length}`);
    if (seenIds.has(id)) continue;
    seenIds.add(id);
    uniqueReplies.push(reply);
    if (uniqueReplies.length >= limit) break;
  }

  const summary = { positive: 0, negative: 0, neutral: 0, meaningful: 0, sampled: uniqueReplies.length };
  for (const reply of uniqueReplies) {
    const classification = classifyPublicComment(reply?.content?.message ?? reply?.message);
    if (classification === "ignored") continue;
    summary[classification] += 1;
    summary.meaningful += 1;
  }
  return summary;
}

export function commentEvidenceState(comments = {}, policy = {}) {
  const meaningful = finite(comments.meaningful) ?? 0;
  const minimumSample = finite(policy.minimumCommentSample) ?? 10;
  if (meaningful < minimumSample) return "insufficient";
  const positive = finite(comments.positive) ?? 0;
  const negative = finite(comments.negative) ?? 0;
  const positiveRatio = meaningful > 0 ? positive / meaningful : 0;
  const negativeRatio = meaningful > 0 ? negative / meaningful : 0;
  if (negativeRatio >= (finite(policy.demoteNegativeCommentRatio) ?? 0.35)) return "negative";
  if (positiveRatio >= (finite(policy.minimumPositiveCommentRatio) ?? 0.7)) return "positive";
  return "mixed";
}

export function extractBilibiliPublicEvidence({
  bvid,
  fallback = {},
  detail = {},
  tags = [],
  replies,
  maximumCommentSample = 20,
} = {}) {
  const stat = detail.stat ?? {};
  const tagNames = (Array.isArray(tags) ? tags : []).map((tag) => tag?.tag_name).filter(Boolean);
  const pageParts = (Array.isArray(detail.pages) ? detail.pages : []).map((page) => page?.part).filter(Boolean);
  const evidenceFields = [];
  if (detail.title || fallback.title) evidenceFields.push("title");
  if (detail.desc || fallback.description) evidenceFields.push("description");
  if (detail.dynamic) evidenceFields.push("dynamic");
  if (pageParts.length) evidenceFields.push("parts");
  if (tagNames.length) evidenceFields.push("tags");
  if (Array.isArray(replies)) evidenceFields.push("public-comments");

  const matchingText = uniqueText([
    detail.title,
    fallback.title,
    detail.desc,
    detail.dynamic,
    ...pageParts,
    ...tagNames,
    fallback.description,
  ]).join(" · ");
  const metrics = {
    views: finite(stat.view) ?? finite(fallback.metrics?.views),
    likes: finite(stat.like) ?? finite(fallback.metrics?.likes),
    coins: finite(stat.coin) ?? finite(fallback.metrics?.coins),
    favorites: finite(stat.favorite) ?? finite(fallback.metrics?.favorites),
    comments: finite(stat.reply) ?? finite(fallback.metrics?.comments),
  };

  return {
    evidenceVersion: 2,
    classifierRevision: EVIDENCE_CLASSIFIER_REVISION,
    evidenceFields,
    sourceContentId: String(bvid ?? detail.bvid ?? "") || undefined,
    sourceArchiveId: detail.aid === undefined ? undefined : String(detail.aid),
    sourceAuthorId: detail.owner?.mid === undefined ? undefined : String(detail.owner.mid),
    title: String(detail.title ?? fallback.title ?? "").trim(),
    author: String(detail.owner?.name ?? fallback.author ?? "").trim(),
    publishedAt: dateOnlyFromUnix(detail.pubdate) ?? fallback.publishedAt,
    matchingText,
    metrics: Object.fromEntries(Object.entries(metrics).filter(([, value]) => value !== undefined)),
    comments: Array.isArray(replies)
      ? summarizePublicComments(replies, { maximumSample: maximumCommentSample })
      : undefined,
  };
}

function sourceKeys(candidate) {
  const platform = normalizedText(candidate.platform) || "unknown";
  const author = normalizedText(candidate.author);
  const authorId = normalizedText(candidate.sourceAuthorId);
  let host;
  try {
    host = new URL(candidate.url).hostname.toLocaleLowerCase("en-US");
  } catch {
    host = normalizedText(candidate.url);
  }
  return {
    author: author ? `author:${author}` : undefined,
    authorId: authorId ? `author-id:${platform}:${authorId}` : undefined,
    fallback: !author && !authorId ? `host:${host}` : undefined,
    fingerprint: normalizedText(candidate.title).length >= 8 ? `title:${normalizedText(candidate.title)}` : undefined,
  };
}

export function countIndependentSources(candidates = []) {
  const seen = new Set();
  let count = 0;
  for (const candidate of candidates) {
    const keys = Object.values(sourceKeys(candidate)).filter(Boolean);
    const duplicate = keys.some((key) => seen.has(key));
    for (const key of keys) seen.add(key);
    if (!duplicate) count += 1;
  }
  return count;
}
