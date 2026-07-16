import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { mergeCommunityRecords, validateGeneratedRecord } from "./lib/community-moderation.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const COMMUNITY_PATH = path.join(ROOT, "app/community-sources.json");
const GENERATED_PATH = path.join(ROOT, "app/generated-community-sources.json");
const GUIDES_PATH = path.join(ROOT, "app/generated-guides.ts");
const REPORT_PATH = path.join(ROOT, "community-sync-report.json");

function fail(message) {
  throw new Error(`Dữ liệu cộng đồng không hợp lệ: ${message}`);
}

function parseGuides(source) {
  const marker = "export const generatedChampions: ChampionGuide[] = ";
  const start = source.indexOf(marker);
  if (start < 0) fail("không tìm thấy generatedChampions");
  return JSON.parse(source.slice(start + marker.length).trim().replace(/;\s*$/, ""));
}

function validDate(value) {
  return /^\d{4}-\d{2}(?:-\d{2})?$/.test(value) && !Number.isNaN(Date.parse(`${value.length === 7 ? `${value}-01` : value}T00:00:00Z`));
}

function validateSource(source, label) {
  if (!source.platform || !source.kind || !source.title) fail(`${label} thiếu thông tin nguồn`);
  try {
    const url = new URL(source.url);
    if (url.protocol !== "https:") fail(`${label} phải dùng HTTPS`);
  } catch {
    fail(`${label} có URL không hợp lệ`);
  }
  if (source.publishedAt && !validDate(source.publishedAt)) fail(`${label} có ngày không hợp lệ: ${source.publishedAt}`);
}

const [communityText, generatedText, guidesText] = await Promise.all([
  readFile(COMMUNITY_PATH, "utf8"),
  readFile(GENERATED_PATH, "utf8"),
  readFile(GUIDES_PATH, "utf8"),
]);
const community = JSON.parse(communityText);
const generated = JSON.parse(generatedText);
const guides = parseGuides(guidesText);

if (community.schemaVersion !== 1) fail("schemaVersion chưa được hỗ trợ");
if (!validDate(community.updatedAt)) fail("updatedAt không hợp lệ");
if (!/^\d+\.\d+$/.test(community.patchBaseline)) fail("patchBaseline không hợp lệ");
if (!Array.isArray(community.records) || !community.records.length) fail("không có bản ghi lối chơi");
if (generated.schemaVersion !== 1) fail("schemaVersion dữ liệu tự động chưa được hỗ trợ");
if (!validDate(generated.updatedAt)) fail("updatedAt dữ liệu tự động không hợp lệ");
if (!/^\d+\.\d+$/.test(generated.patchBaseline)) fail("patchBaseline dữ liệu tự động không hợp lệ");
if (!Array.isArray(generated.records)) fail("dữ liệu tự động thiếu records");

const curatedKeys = new Set(community.records.map((record) => `${record.championId}:${record.canonicalKey}`));
const generatedKeys = new Set();
const generatedCollisions = [];
for (const [index, record] of generated.records.entries()) {
  const key = `${record.championId}:${record.canonicalKey}`;
  if (generatedKeys.has(key)) fail(`bản ghi tự động bị trùng khóa: ${key}`);
  try {
    validateGeneratedRecord(record);
  } catch (error) {
    fail(`generated.records[${index}] ${error.message}`);
  }
  if (curatedKeys.has(key)) generatedCollisions.push(key);
  generatedKeys.add(key);
}
const allRecords = mergeCommunityRecords({ curated: community.records, generated: generated.records });
const automaticRecords = new Set(generated.records.filter((record) => !curatedKeys.has(`${record.championId}:${record.canonicalKey}`)));

const guideById = new Map(guides.map((guide) => [guide.id, guide]));
const augmentByCn = new Map();
const itemByCn = new Map();
for (const guide of guides) {
  for (const augment of [...guide.coreAugments, ...guide.prismatic, ...guide.gold, ...guide.silver]) {
    if (!augmentByCn.has(augment.cn)) augmentByCn.set(augment.cn, augment);
  }
  for (const item of guide.itemData ?? []) {
    if (!itemByCn.has(item.original)) itemByCn.set(item.original, item);
  }
}

const globalUrls = new Set();
for (const [index, source] of community.globalSources.entries()) {
  validateSource(source, `globalSources[${index}]`);
  if (globalUrls.has(source.url)) fail(`nguồn toàn cục bị trùng URL: ${source.url}`);
  globalUrls.add(source.url);
}

const groups = new Map();
for (const [index, record] of allRecords.entries()) {
  const label = `${automaticRecords.has(record) ? "generated.records" : "records"}[${index}]`;
  const guide = guideById.get(record.championId);
  if (!guide) fail(`${label} dùng championId không tồn tại: ${record.championId}`);
  if (!/^[a-z0-9-]+$/.test(record.canonicalKey)) fail(`${label} có canonicalKey không chuẩn`);
  if (!["primary", "alternative", "candidate"].includes(record.relation)) fail(`${label} có relation không hợp lệ`);
  if (!record.title || !record.titleOriginal || !record.summary) fail(`${label} thiếu tên hoặc mô tả`);
  if (!Array.isArray(record.coreCn) || !record.coreCn.length) fail(`${label} phải có ít nhất một lõi`);
  if (!Array.isArray(record.itemCn) || !Array.isArray(record.sources) || !record.sources.length) fail(`${label} thiếu mảng trang bị/nguồn`);

  for (const cn of record.coreCn) {
    const augment = augmentByCn.get(cn);
    if (!augment?.id || !augment?.icon) fail(`${label} có lõi không khớp ID/ảnh client: ${cn}`);
  }
  for (const cn of record.itemCn) {
    const item = itemByCn.get(cn);
    if (!item?.id || !item?.icon) fail(`${label} có trang bị không khớp ID/ảnh client: ${cn}`);
  }

  const sourceUrls = new Set();
  for (const [sourceIndex, source] of record.sources.entries()) {
    validateSource(source, `${label}.sources[${sourceIndex}]`);
    if (sourceUrls.has(source.url)) fail(`${label} lặp lại URL nguồn ${source.url}`);
    sourceUrls.add(source.url);
  }

  if (record.relation === "alternative") {
    if (!record.matchesAlternativeOriginal) fail(`${label} là alternative nhưng thiếu matchesAlternativeOriginal`);
    if (!guide.alternativeOriginals?.includes(record.matchesAlternativeOriginal)) {
      fail(`${label} không khớp biến thể Hải Đấu: ${record.matchesAlternativeOriginal}`);
    }
  }
  if (record.relation === "primary") {
    const primaryCore = new Set(guide.coreAugments.map((augment) => augment.cn));
    if (!record.coreCn.some((cn) => primaryCore.has(cn))) fail(`${label} không khớp lõi build chính Hải Đấu`);
  }

  const groupKey = `${record.championId}:${record.canonicalKey}`;
  const group = groups.get(groupKey) ?? [];
  if (group.length) {
    const first = group[0];
    if (first.relation !== record.relation || first.titleOriginal !== record.titleOriginal || first.matchesAlternativeOriginal !== record.matchesAlternativeOriginal) {
      fail(`${label} xung đột với bản ghi cùng khóa ${groupKey}`);
    }
  }
  group.push(record);
  groups.set(groupKey, group);
}

const normalized = [...groups.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([key, records]) => ({
  key,
  relation: records[0].relation,
  titleOriginal: records[0].titleOriginal,
  coreCn: [...new Set(records.flatMap((record) => record.coreCn))].sort(),
  itemCn: [...new Set(records.flatMap((record) => record.itemCn))].sort(),
  sourceUrls: [...new Set(records.flatMap((record) => record.sources.map((source) => source.url)))].sort(),
  automation: records[0].automation ? {
    status: records[0].automation.status,
    approvalPath: records[0].automation.approvalPath,
    patch: records[0].automation.patch,
    reasons: [...records[0].automation.reasons].sort(),
    score: records[0].automation.score,
  } : undefined,
}));
const contentHash = createHash("sha256").update(JSON.stringify({
  schemaVersion: community.schemaVersion,
  updatedAt: { curated: community.updatedAt, automatic: generated.updatedAt },
  patchBaseline: { curated: community.patchBaseline, automatic: generated.patchBaseline },
  globalSources: community.globalSources,
  builds: normalized,
})).digest("hex");
const report = {
  generatedAt: new Date().toISOString(),
  contentHash,
  rawRecordCount: allRecords.length,
  buildCount: groups.size,
  championCount: new Set(allRecords.map((record) => record.championId)).size,
  mergedDuplicates: allRecords.length - groups.size,
  automaticRecordCount: automaticRecords.size,
  automaticApprovedCount: [...automaticRecords].filter((record) => record.automation.status === "auto-approved").length,
  automaticNeedsVerificationCount: [...automaticRecords].filter((record) => record.automation.status === "needs-verification").length,
  generatedCollisionCount: generatedCollisions.length,
  generatedCollisions,
  sourceCount: new Set([
    ...community.globalSources.map((source) => source.url),
    ...allRecords.flatMap((record) => record.sources.map((source) => source.url)),
  ]).size,
  unmatchedAugments: [],
  unmatchedItems: [],
};

const previousReport = await readFile(REPORT_PATH, "utf8").then(JSON.parse).catch(() => undefined);
if (previousReport?.contentHash === contentHash) {
  console.log(`Dữ liệu cộng đồng hợp lệ và không đổi; giữ nguyên hash ${contentHash}.`);
  process.exit(0);
}
await writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
console.log(`Đã kiểm tra ${report.buildCount} lối chơi cho ${report.championCount} tướng; gộp ${report.mergedDuplicates} bản ghi trùng; tất cả lõi/trang bị đều có ID và ảnh client.`);
