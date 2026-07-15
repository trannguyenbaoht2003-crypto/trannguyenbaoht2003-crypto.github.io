import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createHash } from "node:crypto";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = "https://lolhaidou.cn";
const CDRAGON = "https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global";

const roleNames = {
  fighter: "Đấu sĩ",
  tank: "Đỡ đòn",
  assassin: "Sát thủ",
  mage: "Pháp sư",
  marksman: "Xạ thủ",
  support: "Hỗ trợ",
};

const decodeHtml = (value = "") => value
  .replace(/&nbsp;|&#160;/g, " ")
  .replace(/&amp;/g, "&")
  .replace(/&quot;|&#34;/g, '"')
  .replace(/&#39;|&apos;/g, "'")
  .replace(/&lt;/g, "<")
  .replace(/&gt;/g, ">")
  .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
  .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)));

const plain = (value = "") => decodeHtml(value)
  .replace(/<br\s*\/?\s*>/gi, " ")
  .replace(/<[^>]+>/g, " ")
  .replace(/\s+/g, " ")
  .trim();

const normalize = (value = "") => plain(value)
  .normalize("NFKC")
  .toLocaleLowerCase("zh-CN")
  .replace(/[\s\p{P}\p{S}]/gu, "");

const assetUrl = (assetPath = "") => assetPath
  ? `${CDRAGON}/default${assetPath.replace(/^\/lol-game-data\/assets/i, "").toLowerCase()}`
  : undefined;

async function request(url, json = false) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { "user-agent": "LoiMeta/1.0 (+Vietnamese community guide; source sync)" },
      });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      return json ? response.json() : response.text();
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 600));
    }
  }
  throw new Error(`Không thể đọc ${url}: ${lastError?.message ?? lastError}`);
}

function section(html, heading, nextHeading) {
  const start = html.indexOf(heading);
  if (start < 0) return "";
  const end = nextHeading ? html.indexOf(nextHeading, start + heading.length) : -1;
  return html.slice(start, end > start ? end : undefined);
}

function pageSection(html, heading, nextHeading) {
  const headingPattern = new RegExp(`<h2[^>]*class="section-title"[^>]*>[\\s\\S]{0,240}?${heading}[\\s\\S]{0,240}?<\\/h2>`);
  const startMatch = headingPattern.exec(html);
  if (!startMatch) return "";
  const start = startMatch.index + startMatch[0].length;
  if (!nextHeading) return html.slice(start);
  const rest = html.slice(start);
  const nextPattern = new RegExp(`<h2[^>]*class="section-title"[^>]*>[\\s\\S]{0,240}?${nextHeading}[\\s\\S]{0,240}?<\\/h2>`);
  const endMatch = nextPattern.exec(rest);
  return rest.slice(0, endMatch?.index);
}

function matchTexts(html, expression) {
  return [...html.matchAll(expression)].map((match) => plain(match[1])).filter(Boolean);
}

function extractBuilds(html) {
  const block = pageSection(html, "核心构建方案", "高胜率推荐海克斯");
  if (!block) return [];
  return block.split('<div class="glass-card">').slice(1).map((card) => {
    const grade = plain(card.match(/class="level-text">([\s\S]*?)<\/span>/)?.[1]) || "S";
    const name = plain(card.match(/level-shimmer"><\/div><\/div><div[^>]*>([\s\S]*?)<\/div>/)?.[1]);
    const description = plain(card.match(/class="desc-text">([\s\S]*?)<\/div>/)?.[1]);
    const coreBlock = section(card, "核心海克斯", "核心装备");
    const itemBlock = section(card, "核心装备", "查看小程序");
    const core = matchTexts(coreBlock, /<a[^>]+href="\.\.\/augment\/[^\"]+"[^>]*>([\s\S]*?)<\/a>/g);
    const items = matchTexts(itemBlock, /class="text-pill pill-item"[^>]*>([\s\S]*?)<\/span>/g);
    return { grade, name, description, core, items };
  }).filter((build) => build.name || build.items.length || build.core.length);
}

function extractHeroPage(slug, html) {
  const titleCn = plain(html.match(/<h1 class="name">([\s\S]*?)<\/h1>/)?.[1]);
  const nameCn = plain(html.match(/<div class="alias(?:es)?">([\s\S]*?)<\/div>/)?.[1])
    || plain(html.match(/<meta name="keywords" content="[^,]+,\s*([^,]+),/)?.[1]);
  const recommendationBlock = pageSection(html, "强力玩法推荐", "核心构建方案");
  const recommendation = plain(recommendationBlock.match(/class="glass-card">\s*<div[^>]*>([\s\S]*?)<\/div>/)?.[1]);
  const builds = extractBuilds(html);
  const augmentsBlock = pageSection(html, "高胜率推荐海克斯", "特殊机制与避坑");
  const augments = {
    prismatic: matchTexts(augmentsBlock, /class="text-pill pill-prismatic"[^>]*>([\s\S]*?)<\/a>/g),
    gold: matchTexts(augmentsBlock, /class="text-pill pill-gold"[^>]*>([\s\S]*?)<\/a>/g),
    silver: matchTexts(augmentsBlock, /class="text-pill pill-silver"[^>]*>([\s\S]*?)<\/a>/g),
  };
  const notesBlock = pageSection(html, "特殊机制与避坑", "更多英雄攻略");
  const notes = matchTexts(notesBlock, /class="box-special">([\s\S]*?)<\/div>/g);
  const modified = html.match(/"dateModified":"([^"]+)"/)?.[1];
  return { slug, titleCn, nameCn, recommendation, builds, augments, notes, modified };
}

function indexLocalized(zhRows, viRows, nameField) {
  const viById = new Map(viRows.map((row) => [row.id, row]));
  const entries = [];
  for (const zh of zhRows) {
    const names = [zh[nameField], zh.simpleNameTRA, zh.name].filter(Boolean);
    const vi = viById.get(zh.id);
    for (const name of names) entries.push({ key: normalize(name), zh, vi });
  }
  return entries;
}

function resolveFromIndex(name, entries) {
  const key = normalize(name);
  const variants = [key, key.replace(/^任务/, "")];
  const exact = entries.find((entry) => variants.includes(entry.key) || variants.includes(entry.key.replace(/^任务/, "")));
  if (exact) return exact;
  const fuzzy = entries.filter((entry) => entry.key.length > 2 && variants.some((variant) => entry.key.includes(variant) || variant.includes(entry.key)));
  return fuzzy.length === 1 ? fuzzy[0] : undefined;
}

function displayAugment(cn, augmentIndex) {
  const found = resolveFromIndex(cn, augmentIndex);
  const viName = found?.vi?.nameTRA || found?.vi?.simpleNameTRA || cn;
  return {
    vi: plain(viName),
    cn,
    id: found?.zh?.id,
    icon: assetUrl(found?.vi?.augmentSmallIconPath || found?.zh?.augmentSmallIconPath),
  };
}

function displayItem(cn, itemIndex) {
  const found = resolveFromIndex(cn, itemIndex);
  return {
    name: plain(found?.vi?.name || cn),
    original: cn,
    id: found?.zh?.id,
    icon: assetUrl(found?.vi?.iconPath || found?.zh?.iconPath),
  };
}

function negativeNote(note) {
  return /不要|不能|无法|无效|不触发|避坑|bug|错误|浪费|不推荐|会导致|小心/i.test(note);
}

function sourceHeroLinks(html) {
  const seen = new Set();
  const rows = [];
  for (const match of html.matchAll(/<a href="hero\/([^"/]+)\.html"[^>]*>([\s\S]*?)<\/a>/g)) {
    const slug = match[1];
    if (seen.has(slug)) continue;
    seen.add(slug);
    const label = plain(match[2]);
    const tier = label.match(/^(SSS|SS|S|A|B)\b/)?.[1] || "S";
    rows.push({ slug, tier });
  }
  return rows;
}

async function parallelMap(rows, limit, worker) {
  const results = new Array(rows.length);
  let cursor = 0;
  async function runner() {
    while (cursor < rows.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(rows[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, rows.length) }, runner));
  return results;
}

function findChampion(page, championsZh, championsVi) {
  const viById = new Map(championsVi.map((row) => [row.id, row]));
  const slugKey = normalize(page.slug);
  const aliases = {
    monkeyking: "MonkeyKing",
    renata: "Renata",
    nunu: "Nunu",
    ksante: "KSante",
    reksai: "RekSai",
  };
  const aliasKey = normalize(aliases[page.slug] || page.slug);
  let zh = championsZh.find((row) => normalize(row.alias) === aliasKey);
  if (!zh) zh = championsZh.find((row) => normalize(row.description) === normalize(page.titleCn));
  if (!zh) zh = championsZh.find((row) => normalize(row.name) === normalize(page.nameCn));
  if (!zh) zh = championsZh.find((row) => normalize(row.alias).includes(slugKey) || slugKey.includes(normalize(row.alias)));
  return zh ? { zh, vi: viById.get(zh.id) } : undefined;
}

async function main() {
  console.log("Đang đọc danh mục Hải Đấu và dữ liệu Riot...");
  const [home, championsVi, championsZh, itemsVi, itemsZh, augmentsVi, augmentsZh] = await Promise.all([
    request(`${SOURCE}/`),
    request(`${CDRAGON}/vi_vn/v1/champion-summary.json`, true),
    request(`${CDRAGON}/zh_cn/v1/champion-summary.json`, true),
    request(`${CDRAGON}/vi_vn/v1/items.json`, true),
    request(`${CDRAGON}/zh_cn/v1/items.json`, true),
    request(`${CDRAGON}/vi_vn/v1/cherry-augments.json`, true),
    request(`${CDRAGON}/zh_cn/v1/cherry-augments.json`, true),
  ]);

  const links = sourceHeroLinks(home);
  console.log(`Tìm thấy ${links.length} trang tướng; đang đồng bộ nội dung công khai...`);
  const pages = await parallelMap(links, 14, async (link) => {
    const html = await request(`${SOURCE}/hero/${link.slug}.html`);
    return { ...link, ...extractHeroPage(link.slug, html) };
  });

  const augmentIndex = indexLocalized(augmentsZh, augmentsVi, "nameTRA");
  const itemIndex = indexLocalized(itemsZh, itemsVi, "name");
  const unmatchedChampions = [];
  const unmatchedItems = new Set();
  const unmatchedAugments = new Set();

  const guides = pages.map((page) => {
    const localized = findChampion(page, championsZh, championsVi);
    if (!localized?.vi) unmatchedChampions.push(page.slug);
    const champion = localized?.vi || localized?.zh || {};
    const selectedBuild = page.builds.find((build) => build.items.length || build.core.length) || page.builds[0] || { grade: page.tier, name: "", description: "", core: [], items: [] };
    const itemData = selectedBuild.items.map((item) => displayItem(item, itemIndex));
    const toAugments = (names) => names.map((name) => displayAugment(name, augmentIndex));
    let coreAugments = toAugments(selectedBuild.core);
    const prismatic = toAugments(page.augments.prismatic);
    const gold = toAugments(page.augments.gold);
    const silver = toAugments(page.augments.silver);
    if (!coreAugments.length) coreAugments = [...prismatic, ...gold, ...silver].slice(0, 2);

    for (const item of itemData) if (!item.id) unmatchedItems.add(item.original);
    for (const augment of [...coreAugments, ...prismatic, ...gold, ...silver]) if (!augment.id) unmatchedAugments.add(augment.cn);

    const isSpecialSourceCharacter = page.slug === "huijinqumoren";
    const role = isSpecialSourceCharacter ? "Pháp sư" : (roleNames[champion.roles?.[0]] || "Đấu sĩ");
    const championName = isSpecialSourceCharacter ? "Locke" : (champion.name || page.nameCn || page.slug);
    const championTitle = isSpecialSourceCharacter ? "Kẻ Trừ Tà Tro Tàn" : (champion.description || page.titleCn);
    const coreLabel = coreAugments.map((augment) => augment.vi).join(" + ");
    const itemLabel = itemData.slice(0, 4).map((item) => item.name).join(" → ");
    const buildName = coreLabel ? `Lối ${coreLabel}` : `Lối ${role} theo Hải Đấu`;
    const summaryParts = [];
    if (coreLabel) summaryParts.push(`Ưu tiên lõi ${coreLabel}`);
    if (itemLabel) summaryParts.push(`lên trang bị theo nhịp ${itemLabel}`);
    const summary = `${summaryParts.join("; ") || `Theo lối ${role} được nguồn đề xuất`}. Tên và thứ tự đã được đối chiếu theo ID dữ liệu game; nguyên văn Trung Quốc được giữ riêng để kiểm tra.`;

    const sourceNotes = [page.recommendation, selectedBuild.description, ...page.notes].filter(Boolean);
    const tips = page.notes.filter((note) => !negativeNote(note)).map((note) => {
      const cn = note.match(/^\[([^\]]+)\]/)?.[1];
      const vi = cn ? displayAugment(cn, augmentIndex).vi : undefined;
      return vi
        ? `${vi}: đây là tương tác đặc biệt được nguồn đánh dấu cho ${championName}; đối chiếu nguyên văn ở mục ghi chú nguồn.`
        : `Nguồn đánh dấu một tương tác đặc biệt cho ${championName}; đối chiếu nguyên văn ở mục ghi chú nguồn.`;
    });
    const traps = page.notes.filter(negativeNote).map((note) => {
      const cn = note.match(/^\[([^\]]+)\]/)?.[1];
      const vi = cn ? displayAugment(cn, augmentIndex).vi : undefined;
      return vi
        ? `${vi}: nguồn cảnh báo có tình huống không hoạt động như kỳ vọng; kiểm tra nguyên văn trước khi chọn.`
        : `Nguồn có cảnh báo tương tác không hoạt động như kỳ vọng; kiểm tra nguyên văn trước khi áp dụng.`;
    });

    return {
      id: page.slug,
      ddragon: champion.alias || page.slug,
      championId: champion.id,
      icon: assetUrl(champion.squarePortraitPath) || "/placeholder-champion.svg",
      splash: champion.alias
        ? `https://ddragon.leagueoflegends.com/cdn/img/champion/splash/${champion.alias}_0.jpg`
        : "/placeholder-champion.svg",
      name: championName,
      title: championTitle,
      aliases: [page.nameCn, page.titleCn, localized?.zh?.name, localized?.zh?.description, isSpecialSourceCharacter ? "Kẻ Trừ Tà Tro Tàn" : ""].filter(Boolean),
      role,
      tier: page.tier,
      buildGrade: /^(SSS|SS|S|A|B)$/.test(selectedBuild.grade) ? selectedBuild.grade : "S",
      buildName,
      buildOriginal: selectedBuild.name || page.recommendation || page.titleCn,
      summary,
      summaryOriginal: selectedBuild.description,
      coreAugments,
      items: itemData.map((item) => item.name),
      itemData,
      prismatic,
      gold,
      silver,
      tips,
      traps,
      alternatives: page.builds.slice(1).map((_, index) => `Biến thể ${index + 2} theo nguồn`),
      alternativeOriginals: page.builds.slice(1).map((build) => build.name).filter(Boolean),
      sourceNotes,
      sourceModified: page.modified,
      source: `${SOURCE}/hero/${page.slug}.html`,
    };
  });

  const newestSourceDate = guides.map((guide) => guide.sourceModified).filter(Boolean).sort().at(-1);
  const generatedAt = new Date().toISOString();
  const contentHash = createHash("sha256").update(JSON.stringify(guides)).digest("hex");
  const sourceFile = `import type { ChampionGuide } from "./data";\n\nexport const sourceSync = ${JSON.stringify({ generatedAt, newestSourceDate, championCount: guides.length, contentHash, source: `${SOURCE}/` }, null, 2)} as const;\n\nexport const generatedChampions: ChampionGuide[] = ${JSON.stringify(guides, null, 2)};\n`;
  await writeFile(path.join(ROOT, "app/generated-guides.ts"), sourceFile);
  await writeFile(path.join(ROOT, "data-sync-report.json"), `${JSON.stringify({ generatedAt, newestSourceDate, championCount: guides.length, contentHash, unmatchedChampions, unmatchedItems: [...unmatchedItems].sort(), unmatchedAugments: [...unmatchedAugments].sort() }, null, 2)}\n`);
  console.log(`Đã tạo ${guides.length} hướng dẫn. Tướng chưa khớp: ${unmatchedChampions.length}; trang bị chưa khớp: ${unmatchedItems.size}; lõi chưa khớp: ${unmatchedAugments.size}.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
