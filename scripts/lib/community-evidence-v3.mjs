import { createHash } from "node:crypto";

export const EVIDENCE_V3_CLASSIFIER_REVISION = 1;

const PUBLIC_ACCESS_STATES = new Set(["ok", "captcha", "locked", "private"]);
const ENTITY_EVIDENCE_KEYS = new Set(["champions", "augments", "items"]);
const EVIDENCE_CHANNELS = new Set([
  "title",
  "description",
  "dynamic",
  "parts",
  "tags",
  "subtitle",
  "search-snippet",
  "page-metadata",
]);

function plain(value = "") {
  return String(value)
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x([a-f0-9]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/\s+/g, " ")
    .trim();
}

function dateOnly(value) {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString().slice(0, 10);
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function normalizedProtocolUrl(value) {
  if (!value) return undefined;
  try {
    return new URL(String(value).startsWith("//") ? `https:${value}` : value).toString();
  } catch {
    return undefined;
  }
}

function subtitleTracks(payload = {}) {
  const candidates = [
    payload?.data?.subtitle?.subtitles,
    payload?.subtitle?.subtitles,
    payload?.subtitles,
  ];
  return candidates.find(Array.isArray) ?? [];
}

export function selectPublicChineseSubtitleTrack(payload = {}) {
  const tracks = subtitleTracks(payload);
  const ranked = tracks
    .map((track) => {
      const language = String(track?.lan ?? track?.language ?? "").trim();
      const label = plain(track?.lan_doc ?? track?.label ?? language);
      const url = normalizedProtocolUrl(track?.subtitle_url ?? track?.url);
      const normalized = `${language} ${label}`.toLocaleLowerCase("zh-CN");
      const score = /^(zh-cn|zh-hans)$/i.test(language)
        ? 3
        : language.toLocaleLowerCase("en-US").startsWith("zh")
          ? 2
          : /中文|汉语|漢語|简体|簡體/.test(normalized)
            ? 1
            : 0;
      return { language, label, url, score };
    })
    .filter((track) => track.url && track.score > 0)
    .sort((left, right) => right.score - left.score);
  const selected = ranked[0];
  return selected
    ? { language: selected.language, label: selected.label, url: selected.url }
    : undefined;
}

export function extractBilibiliSubtitleText(payload = {}, options = {}) {
  const maximumSegments = Math.max(1, Math.min(500, Number(options.maximumSegments) || 200));
  const maximumCharacters = Math.max(100, Math.min(50_000, Number(options.maximumCharacters) || 12_000));
  const body = Array.isArray(payload?.body) ? payload.body : [];
  const parts = [];
  let characters = 0;
  let truncated = body.length > maximumSegments;

  for (const segment of body.slice(0, maximumSegments)) {
    const content = plain(segment?.content);
    if (!content) continue;
    const available = maximumCharacters - characters;
    if (available <= 0) {
      truncated = true;
      break;
    }
    const next = content.slice(0, available);
    parts.push(next);
    characters += next.length;
    if (next.length < content.length) {
      truncated = true;
      break;
    }
  }

  return {
    matchingText: parts.join(" · "),
    segmentCount: parts.length,
    truncated,
  };
}

export function summarizeSubtitleEvidence(value = {}) {
  const count = Number(value.segmentCount) || 0;
  const segmentCountBucket = count === 0 ? "0" : count <= 20 ? "1-20" : count <= 100 ? "21-100" : "101+";
  return {
    state: count > 0 ? "ok" : "not-available",
    segmentCountBucket,
    truncated: Boolean(value.truncated),
  };
}

function parseTagAttributes(tag) {
  const attributes = {};
  for (const match of tag.matchAll(/([:\w-]+)\s*=\s*(["'])([\s\S]*?)\2/g)) {
    attributes[match[1].toLocaleLowerCase("en-US")] = plain(match[3]);
  }
  return attributes;
}

function metaValues(html) {
  const values = new Map();
  for (const match of String(html).matchAll(/<meta\b[^>]*>/gi)) {
    const attributes = parseTagAttributes(match[0]);
    const key = (attributes.property ?? attributes.name ?? attributes.itemprop)?.toLocaleLowerCase("en-US");
    if (!key || !attributes.content) continue;
    const rows = values.get(key) ?? [];
    rows.push(attributes.content);
    values.set(key, rows);
  }
  return values;
}

function firstMeta(values, keys) {
  for (const key of keys) {
    const value = values.get(key)?.[0];
    if (value) return value;
  }
  return undefined;
}

function jsonLdObjects(html) {
  const objects = [];
  for (const match of String(html).matchAll(/<script\b[^>]*type\s*=\s*(["'])application\/ld\+json\1[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const parsed = JSON.parse(match[2].trim());
      const queue = Array.isArray(parsed) ? [...parsed] : [parsed];
      while (queue.length) {
        const value = queue.shift();
        if (!value || typeof value !== "object") continue;
        objects.push(value);
        if (Array.isArray(value["@graph"])) queue.push(...value["@graph"]);
      }
    } catch {
      // JSON-LD lỗi không được dùng để suy đoán hoặc chặn toàn bộ nguồn công khai.
    }
  }
  return objects;
}

function authorName(value) {
  if (typeof value === "string") return plain(value);
  if (Array.isArray(value)) return value.map(authorName).find(Boolean);
  return plain(value?.name);
}

function publicAccessState(html) {
  const sample = plain(String(html).slice(0, 30_000)).toLocaleLowerCase("zh-CN");
  if (/验证码|安全验证|人机验证|captcha|verify you are human/.test(sample)) return "captcha";
  if (/无权访问|仅作者可见|仅自己可见|私密内容|内容不可见|private content/.test(sample)) return "private";
  if (/登录后(?:查看|继续|访问)|请先登录|登录才能|sign in to (?:view|continue)/.test(sample)) return "locked";
  return "ok";
}

export function sourceContentIdFromUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const patterns = [
      /\/(?:video|p)\/([\w-]+)/i,
      /\/question\/(\d+)/i,
      /\/answer\/(\d+)/i,
    ];
    for (const pattern of patterns) {
      const match = url.pathname.match(pattern);
      if (match) return match[1];
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export function extractPublicPageMetadata(html, { url, fallback = {} } = {}) {
  const accessState = publicAccessState(html);
  if (!PUBLIC_ACCESS_STATES.has(accessState) || accessState !== "ok") {
    return {
      accessState,
      sourceContentId: sourceContentIdFromUrl(url),
      evidenceFields: [],
      imageUrls: [],
      matchingText: "",
    };
  }

  const metas = metaValues(html);
  const jsonLd = jsonLdObjects(html);
  const documentTitle = plain(String(html).match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1]);
  const jsonTitle = jsonLd.map((row) => plain(row.headline ?? row.name)).find(Boolean);
  const jsonDescription = jsonLd.map((row) => plain(row.description)).find(Boolean);
  const jsonAuthor = jsonLd.map((row) => authorName(row.author ?? row.creator)).find(Boolean);
  const jsonPublishedAt = jsonLd.map((row) => dateOnly(row.datePublished ?? row.uploadDate)).find(Boolean);
  const jsonKeywords = jsonLd.flatMap((row) => Array.isArray(row.keywords)
    ? row.keywords.map(plain)
    : String(row.keywords ?? "").split(/[,，]/).map(plain));
  const title = firstMeta(metas, ["og:title", "twitter:title", "title"]) ?? jsonTitle ?? documentTitle ?? plain(fallback.title);
  const description = firstMeta(metas, ["description", "og:description", "twitter:description"])
    ?? jsonDescription
    ?? plain(fallback.description);
  const keywords = unique([
    ...String(firstMeta(metas, ["keywords", "news_keywords"]) ?? "").split(/[,，]/).map(plain),
    ...jsonKeywords,
  ]);
  const author = firstMeta(metas, ["author", "article:author", "byl"])
    ?? jsonAuthor
    ?? plain(fallback.author);
  const publishedAt = dateOnly(firstMeta(metas, ["article:published_time", "datepublished", "pubdate", "publishdate", "date"]))
    ?? jsonPublishedAt
    ?? dateOnly(fallback.publishedAt);
  const imageUrls = unique([
    ...["og:image", "twitter:image", "image"].flatMap((key) => metas.get(key) ?? []),
    ...jsonLd.flatMap((row) => {
      const value = row.image;
      if (typeof value === "string") return [value];
      if (Array.isArray(value)) return value.map((item) => typeof item === "string" ? item : item?.url);
      return [value?.url];
    }),
  ].map(normalizedProtocolUrl)).slice(0, 3);
  const matchingParts = unique([title, description, ...keywords]);
  const evidenceFields = [
    title ? "title" : undefined,
    description ? "description" : undefined,
    keywords.length ? "keywords" : undefined,
    author ? "author" : undefined,
    publishedAt ? "published-at" : undefined,
    imageUrls.length ? "public-image" : undefined,
  ].filter(Boolean);

  return {
    accessState,
    title,
    author,
    publishedAt,
    sourceContentId: sourceContentIdFromUrl(url),
    evidenceFields,
    imageUrls,
    matchingText: matchingParts.join(" · "),
  };
}

function entityIdKey(value) {
  return `${typeof value}:${String(value)}`;
}

function summarizeType(channelRows, key) {
  const byId = new Map();
  for (const row of channelRows) {
    for (const entity of row[key] ?? []) {
      if (entity?.id === undefined) continue;
      const idKey = entityIdKey(entity.id);
      const previous = byId.get(idKey) ?? { entity, channels: new Set() };
      previous.channels.add(row.channel);
      byId.set(idKey, previous);
    }
  }
  const values = [...byId.values()].sort((left, right) => String(left.entity.id).localeCompare(String(right.entity.id)));
  return {
    matches: values.map((value) => value.entity),
    evidence: values.map((value) => ({ id: value.entity.id, channels: [...value.channels].sort() })),
  };
}

export function summarizeEntityEvidence(channelRows = []) {
  const safeRows = (Array.isArray(channelRows) ? channelRows : [])
    .filter((row) => row?.channel)
    .map((row) => ({
      channel: String(row.channel),
      champions: Array.isArray(row.champions) ? row.champions : [],
      augments: Array.isArray(row.augments) ? row.augments : [],
      items: Array.isArray(row.items) ? row.items : [],
    }));
  const champions = summarizeType(safeRows, "champions");
  const augments = summarizeType(safeRows, "augments");
  const items = summarizeType(safeRows, "items");
  return {
    championMatches: champions.matches,
    augmentMatches: augments.matches,
    itemMatches: items.matches,
    entityEvidence: {
      champions: champions.evidence,
      augments: augments.evidence,
      items: items.evidence,
    },
  };
}

export function hasRawEvidencePayload(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return true;
  if (Object.keys(value).some((key) => !ENTITY_EVIDENCE_KEYS.has(key))) return true;
  for (const key of ENTITY_EVIDENCE_KEYS) {
    if (!Array.isArray(value[key])) return true;
    for (const entry of value[key]) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return true;
      if (Object.keys(entry).some((entryKey) => !new Set(["id", "channels"]).has(entryKey))) return true;
      if (entry.id === undefined || !Array.isArray(entry.channels)) return true;
      if (entry.channels.some((channel) => typeof channel !== "string" || !EVIDENCE_CHANNELS.has(channel))) return true;
    }
  }
  return false;
}

function sortedIds(values) {
  return unique((values ?? []).map((value) => value?.id).filter((id) => id !== undefined))
    .sort((left, right) => String(left).localeCompare(String(right), "en", { numeric: true }));
}

export function buildEvidenceSignatures({ champions = [], augments = [], items = [] } = {}) {
  const championIds = sortedIds(champions);
  const augmentIds = sortedIds(augments);
  const itemIds = sortedIds(items);
  const hasAnyEntity = championIds.length || augmentIds.length || itemIds.length;
  const partialSignature = hasAnyEntity
    ? `${championIds.join("-")}:${augmentIds.join("-")}:${itemIds.join("-")}`
    : undefined;
  const complete = championIds.length === 1 && augmentIds.length >= 1 && itemIds.length >= 2;
  return {
    complete,
    signature: complete ? partialSignature : undefined,
    partialSignature,
  };
}

export function enforceEvidenceV3Signature(candidate = {}) {
  const champions = candidate.championMatches ?? [];
  const signatures = buildEvidenceSignatures({
    champions,
    augments: candidate.augmentMatches ?? [],
    items: candidate.itemMatches ?? [],
  });
  const hasImageEvidence = (candidate.sourceImageIds?.length ?? 0) > 0
    || (candidate.sourceImageReferenceIds?.length ?? 0) > 0;
  const evidenceReviewState = signatures.complete
    ? "complete"
    : champions.length > 1
      ? "translation-review-required"
      : hasImageEvidence
        ? "image-review-required"
        : "incomplete";
  const wasReviewable = new Set(["ready-for-review", "cross-source-review"]).has(candidate.status);
  const mustDemote = wasReviewable && !signatures.complete;
  const reasons = [...new Set(candidate.reasons ?? [])];
  if (mustDemote) reasons.push("Evidence v3 yêu cầu đúng 1 tướng, ít nhất 1 lõi và ít nhất 2 trang bị");
  return {
    ...candidate,
    ...signatures,
    evidenceReviewState,
    status: mustDemote ? "needs-details" : candidate.status,
    reasons,
  };
}

export function publicImageEvidenceId(bytes) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes ?? []);
  return `sha256:${createHash("sha256").update(buffer).digest("hex").slice(0, 24)}`;
}
