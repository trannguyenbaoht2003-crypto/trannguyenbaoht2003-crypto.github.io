import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

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

function fail(message) {
  throw new Error(`Bộ theo dõi cộng đồng: ${message}`);
}

function hash(value) {
  return createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
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
  return payload.data.result.slice(0, query.maxResults).map((row) => ({
    platform: "Bilibili",
    url: `https://www.bilibili.com/video/${row.bvid}/`,
    title: plain(row.title),
    author: plain(row.author),
    publishedAt: dateOnly(new Date(Number(row.pubdate) * 1000)),
    description: plain([row.description, row.tag].filter(Boolean).join(" · ")),
    signal: [
      Number.isFinite(row.play) ? `${row.play} lượt xem` : undefined,
      Number.isFinite(row.like) ? `${row.like} lượt thích` : undefined,
      Number.isFinite(row.favorites) ? `${row.favorites} lượt lưu` : undefined,
    ].filter(Boolean).join(" · "),
    sourceQueryId: query.id,
  }));
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

function entitySignature(champions, augments, items) {
  if (!champions.length || (!augments.length && !items.length)) return undefined;
  return [
    champions.map((entry) => entry.id).sort().join("-"),
    augments.map((entry) => entry.id).sort((a, b) => a - b).join("-"),
    items.map((entry) => entry.id).sort((a, b) => a - b).join("-"),
  ].join(":");
}

function classify(raw, context) {
  const url = canonicalUrl(raw.url);
  if (!url) return undefined;
  const text = [raw.title, raw.description].filter(Boolean).join(" · ");
  const normalizedText = normalize(text);
  const hasModeKeyword = context.registry.modeKeywords.some((keyword) => normalizedText.includes(normalize(keyword)));
  if (!hasModeKeyword) return undefined;

  const champions = findTerms(raw.title, context.indexes.champions, 1);
  if (!champions.length) champions.push(...findTerms(raw.description, context.indexes.champions, 1));
  const negatedAugments = negatedTermIds(raw.title, context.indexes.augments);
  const negatedItems = negatedTermIds(raw.title, context.indexes.items);
  const augments = findTerms(text, context.indexes.augments).filter((entry) => !negatedAugments.has(entry.id));
  const items = findTerms(text, context.indexes.items).filter((entry) => !negatedItems.has(entry.id));
  const signature = entitySignature(champions, augments, items);
  const tier = sourceTier(context.registry, raw.platform, raw.author);
  const patchHint = text.match(/\b(?:16|26)\.\d{1,2}\b/)?.[0];
  const ageDays = raw.publishedAt
    ? Math.floor((Date.now() - Date.parse(`${raw.publishedAt}T00:00:00Z`)) / 86_400_000)
    : undefined;
  const currentEnough = ageDays === undefined || ageDays <= context.registry.lookbackDays;
  const reasons = ["Có từ khóa Hải Đấu/ARAM Mayhem"];
  let score = 20;
  if (champions.length) { score += 25; reasons.push(`Nhận dạng ${champions.map((entry) => entry.vi).join(", ")}`); }
  if (augments.length) { score += 25; reasons.push(`${augments.length} lõi khớp ID game`); }
  if (items.length) { score += 10; reasons.push(`${items.length} trang bị khớp ID game`); }
  if (tier === "established") { score += 10; reasons.push("Tác giả nằm trong danh sách đã có nguồn đối chiếu"); }
  if (currentEnough) { score += 10; reasons.push("Nguồn nằm trong cửa sổ theo dõi hiện hành"); }
  score = Math.min(score, 100);

  let status = "needs-champion";
  if (context.known.sourceUrls.has(url)) status = "known-source";
  else if (isBeforePatch(patchHint, context.registry.minimumPatch) || (ageDays !== undefined && ageDays > context.registry.lookbackDays)) status = "stale";
  else if (champions.length && signature && context.known.buildSignatures.has(signature)) status = "known-build";
  else if (!champions.length && patchHint) status = "patch-watch";
  else if (!champions.length) status = "needs-champion";
  else if (!augments.length && !items.length) status = "needs-details";
  else if (score >= context.registry.policy.minimumReviewScore && (augments.length > 0 || items.length >= 2)) status = "ready-for-review";
  else status = "needs-details";

  return {
    id: `candidate-${hash(url).slice(0, 16)}`,
    platform: raw.platform,
    url,
    title: plain(raw.title),
    author: plain(raw.author) || undefined,
    publishedAt: validDate(raw.publishedAt) ? raw.publishedAt : undefined,
    patchHint,
    signal: plain(raw.signal) || undefined,
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
    const sourceIdentities = new Set(group.map((candidate) => `${candidate.platform}:${normalize(candidate.author ?? candidate.url)}`));
    const dates = group.map((candidate) => Date.parse(`${candidate.publishedAt ?? candidate.firstSeenAt}T00:00:00Z`)).filter(Number.isFinite);
    const withinWindow = !dates.length || (Math.max(...dates) - Math.min(...dates)) / 86_400_000 <= registry.policy.crossSourceWindowDays;
    if (sourceIdentities.size < 2 || !withinWindow) continue;
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
  if (registry.policy?.autoPublish !== false) fail("autoPublish phải giữ ở false để tránh đăng thẳng dữ liệu chưa kiểm chứng");
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
  for (const raw of rawResults) {
    const candidate = classify(raw, context);
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
    statusCounts,
    newestPublishedAt: limitedCandidates.map((candidate) => candidate.publishedAt).filter(Boolean).sort().at(-1),
    scanErrors: errors,
    autoPublish: false,
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
