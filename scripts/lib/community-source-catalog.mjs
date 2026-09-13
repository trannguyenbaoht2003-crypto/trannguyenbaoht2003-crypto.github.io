const NOVELTY_TERMS = ["黑科技", "冷门", "骚套路", "奇葩", "整活", "联动", "实测"];
const MODE_PATTERN = /海克斯大乱斗|海克斯乱斗|符文大乱斗|海斗|ARAM\s*:?\s*Mayhem/iu;
const EXCLUDED_MODE_PATTERN = /\bCHERRY\b|\bArena\b|斗魂竞技场|经典模式|经典海斗|怀旧海斗/iu;

function publicUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port) return undefined;
    return url;
  } catch {
    return undefined;
  }
}

function hostMatches(hostname, host) {
  return hostname === host || hostname.endsWith(`.${host}`);
}

export function sourceForUrl(catalog, value) {
  const url = publicUrl(value);
  if (!url) return undefined;
  return catalog.sources.find((source) => source.hosts.some((host) => hostMatches(url.hostname, host)));
}

export function validateSourceCatalog(catalog) {
  if (catalog?.schemaVersion !== 1 || catalog.gameModeExternalId !== "aram_mayhem"
    || catalog.purpose !== "discovery-only" || !Array.isArray(catalog.sources) || !catalog.sources.length) {
    throw new Error("SOURCE_CATALOG_SCHEMA_INVALID");
  }
  const ids = new Set();
  const queryIds = new Set();
  const hosts = new Set();
  for (const source of catalog.sources) {
    if (!/^[a-z0-9-]+$/.test(source.id ?? "") || ids.has(source.id)) throw new Error("SOURCE_CATALOG_DUPLICATE_ID");
    ids.add(source.id);
    if (!source.name || !source.platform || !["zh-CN", "en"].includes(source.language)
      || !["player-evidence", "community-reference", "official-reference", "client-reference"].includes(source.role)
      || !Number.isInteger(source.priority) || source.priority < 1 || source.priority > 100
      || !Array.isArray(source.hosts) || !source.hosts.length || !Array.isArray(source.entryUrls)
      || !source.entryUrls.length || !Array.isArray(source.queries)) throw new Error("SOURCE_CATALOG_ENTRY_INVALID");
    for (const host of source.hosts) {
      if (!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(host) || hosts.has(host)) throw new Error("SOURCE_CATALOG_HOST_INVALID");
      hosts.add(host);
    }
    for (const value of source.entryUrls) {
      const url = publicUrl(value);
      if (!url || !source.hosts.some((host) => hostMatches(url.hostname, host))) throw new Error("SOURCE_CATALOG_URL_INVALID");
    }
    for (const query of source.queries) {
      if (!/^[a-z0-9-]+$/.test(query.id ?? "") || queryIds.has(query.id)) throw new Error("SOURCE_CATALOG_QUERY_DUPLICATE");
      queryIds.add(query.id);
      if (!["bilibili-search", "bing-rss"].includes(query.adapter) || typeof query.query !== "string"
        || !query.query.trim() || query.query.length > 200 || !Number.isInteger(query.maxResults)
        || query.maxResults < 1 || query.maxResults > 30
        || (query.adapter === "bilibili-search" && source.platform !== "Bilibili")) throw new Error("SOURCE_CATALOG_QUERY_INVALID");
    }
  }
  return catalog;
}

export function buildDiscoveryQueries(catalog, legacyQueries = []) {
  validateSourceCatalog(catalog);
  const prioritized = [...catalog.sources].sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id))
    .flatMap((source) => source.queries.map((query) => ({ ...query, platform: source.platform, sourceCatalogId: source.id })));
  const ids = new Set();
  const searches = new Set();
  return [...prioritized, ...legacyQueries].filter((query) => {
    const key = `${query.adapter}:${query.query}`;
    if (ids.has(query.id) || searches.has(key)) return false;
    ids.add(query.id);
    searches.add(key);
    return true;
  });
}

export function normalizePatch(value) {
  const match = /^(?:16|26)\.([1-9]|[12]\d|30)$/.exec(String(value ?? ""));
  return match ? `16.${Number(match[1])}` : undefined;
}

export async function resolveCurrentPatch(requestJson) {
  const versions = await requestJson("https://ddragon.leagueoflegends.com/api/versions.json");
  const version = Array.isArray(versions) ? versions[0] : undefined;
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error("PATCH_RELEASE_INVALID");
  const patch = normalizePatch(version.split(".").slice(0, 2).join("."));
  if (!patch) throw new Error("PATCH_RELEASE_INVALID");
  return patch;
}

export function collectorReportPatch(report) {
  const patch = normalizePatch(report?.currentPatch);
  if (report?.collectionMode !== "live" || !patch) throw new Error("COLLECTOR_REPORT_NOT_LIVE");
  return patch;
}

export function assessSourceEvidence({ text = "", patchHint, publishedAt, currentPatch, now = new Date(), lookbackDays = 21 }) {
  const matches = [...String(text).matchAll(/\b(?:16|26)\.\d{1,2}\b/g)].map(([value]) => value);
  if (patchHint) matches.push(patchHint);
  const distinct = new Set(matches.map(normalizePatch).filter(Boolean));
  const holdReasons = [];
  const modeExcluded = EXCLUDED_MODE_PATTERN.test(text);
  const modeValid = MODE_PATTERN.test(text) && !modeExcluded;
  if (modeExcluded) holdReasons.push("MODE_EXCLUDED");
  else if (!modeValid) holdReasons.push("MODE_NOT_CONFIRMED");
  if (!distinct.size) holdReasons.push("PATCH_NOT_CONFIRMED");
  else if (distinct.size > 1) holdReasons.push("PATCH_AMBIGUOUS");
  else if (!normalizePatch(currentPatch) || !distinct.has(normalizePatch(currentPatch))) holdReasons.push("PATCH_MISMATCH");
  const date = typeof publishedAt === "string" && /^\d{4}-\d{2}-\d{2}$/.test(publishedAt)
    ? new Date(`${publishedAt}T00:00:00.000Z`) : undefined;
  if (!date || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== publishedAt) {
    holdReasons.push("PUBLISHED_AT_NOT_CONFIRMED");
  } else {
    const age = (new Date(now).getTime() - date.getTime()) / 86_400_000;
    if (!Number.isFinite(age)) holdReasons.push("PUBLISHED_AT_NOT_CONFIRMED");
    else if (age < 0) holdReasons.push("SOURCE_FUTURE_DATED");
    else if (age > lookbackDays) holdReasons.push("SOURCE_STALE");
  }
  return {
    modeValid,
    patchHint: matches[0],
    currentEnough: holdReasons.length === 0,
    holdReasons,
    noveltySignals: NOVELTY_TERMS.filter((term) => text.includes(term)),
  };
}
