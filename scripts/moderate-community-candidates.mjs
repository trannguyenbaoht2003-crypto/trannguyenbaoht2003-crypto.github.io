import { readFile, rename, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  generatePublishedRecords,
  moderateCandidates,
  stableDecisionHash,
} from "./lib/community-moderation.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REGISTRY_PATH = path.join(ROOT, "app/community-source-registry.json");
const COMMUNITY_PATH = path.join(ROOT, "app/community-sources.json");
const GUIDES_PATH = path.join(ROOT, "app/generated-guides.ts");
const DATA_PATH = path.join(ROOT, "app/data.ts");
const INBOX_PATH = path.join(ROOT, "data/community-inbox.json");
const EVIDENCE_PATH = path.join(ROOT, "data/community-evidence.json");
const DECISIONS_PATH = path.join(ROOT, "data/community-decisions.json");
const GENERATED_PATH = path.join(ROOT, "app/generated-community-sources.json");
const REPORT_PATH = path.join(ROOT, "community-moderation-report.json");
const REVIEW_STATUSES = new Set(["ready-for-review", "cross-source-review", "patch-watch"]);
const DECISION_STATUSES = new Set(["auto-approved", "needs-verification", "observing", "rejected"]);

function fail(message) {
  throw new Error(`Kiểm duyệt cộng đồng: ${message}`);
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

function isIsoDateTime(value) {
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) && value.includes("T");
}

function isDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value ?? "") && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

function validateEvidence(value) {
  if (value?.schemaVersion !== 1 || !isIsoDateTime(value.updatedAt) || !/^\d+\.\d+$/.test(value.currentPatch)) fail("community-evidence.json không đúng cấu trúc");
  if (!Array.isArray(value.candidates)) fail("community-evidence.json thiếu candidates");
  for (const candidate of value.candidates) {
    if (!candidate.id || !candidate.url || !REVIEW_STATUSES.has(candidate.status)) fail(`bằng chứng không đủ điều kiện: ${candidate.id ?? "không-id"}`);
  }
}

function validateDecisions(value) {
  if (value?.schemaVersion !== 1 || !isIsoDateTime(value.updatedAt) || !/^\d+\.\d+$/.test(value.currentPatch)) fail("community-decisions.json không đúng cấu trúc");
  if (!Array.isArray(value.decisions)) fail("community-decisions.json thiếu decisions");
  const signatures = new Set();
  for (const decision of value.decisions) {
    if (!decision.signature || signatures.has(decision.signature)) fail(`quyết định trùng hoặc thiếu signature: ${decision.signature}`);
    if (!DECISION_STATUSES.has(decision.status)) fail(`quyết định có trạng thái lạ: ${decision.status}`);
    if (!Number.isFinite(decision.score) || decision.score < 0 || decision.score > 100) fail(`quyết định có điểm không hợp lệ: ${decision.signature}`);
    signatures.add(decision.signature);
  }
}

function validateGenerated(value) {
  if (value?.schemaVersion !== 1 || !isDate(value.updatedAt) || !/^\d+\.\d+$/.test(value.patchBaseline)) fail("generated-community-sources.json không đúng cấu trúc");
  if (!Array.isArray(value.records)) fail("generated-community-sources.json thiếu records");
  const keys = new Set();
  for (const record of value.records) {
    const key = `${record.championId}:${record.canonicalKey}`;
    if (!record.championId || !/^auto-[a-f0-9]{12}$/.test(record.canonicalKey) || keys.has(key)) fail(`bản ghi tự động trùng hoặc sai khóa: ${key}`);
    if (!record.title || !record.titleOriginal || !record.summary || !record.coreCn?.length || record.itemCn?.length < 2 || !record.sources?.length) fail(`bản ghi tự động thiếu dữ liệu: ${key}`);
    if (!new Set(["auto-approved", "needs-verification"]).has(record.automation?.status)) fail(`bản ghi tự động thiếu trạng thái: ${key}`);
    if (record.automation.status === "auto-approved" && !new Set(["cross-source", "trusted-creator"]).has(record.automation.approvalPath)) fail(`bản ghi tự động thiếu đường duyệt: ${key}`);
    if (!isIsoDateTime(record.automation.checkedAt) || !/^\d+\.\d+$/.test(record.automation.patch)) fail(`bản ghi tự động thiếu mốc kiểm tra: ${key}`);
    if (!Array.isArray(record.automation.reasons) || !Number.isFinite(record.automation.score)) fail(`bản ghi tự động thiếu lý do/điểm: ${key}`);
    keys.add(key);
  }
}

function validateReport(value) {
  if (!isIsoDateTime(value?.generatedAt) || !/^[a-f0-9]{64}$/.test(value.contentHash ?? "")) fail("community-moderation-report.json không đúng cấu trúc");
  if (!/^\d+\.\d+$/.test(value.currentPatch) || typeof value.autoPublish !== "boolean") fail("báo cáo kiểm duyệt thiếu patch/policy");
}

function carryForwardMissing({ previousDecisions, decisions, currentPatch, now, consecutiveFailureLimit }) {
  const currentSignatures = new Set(decisions.map((decision) => decision.signature));
  const carried = [];
  for (const previous of previousDecisions) {
    if (currentSignatures.has(previous.signature) || !new Set(["auto-approved", "needs-verification"]).has(previous.status)) continue;
    const patchChanged = previous.patch !== currentPatch;
    const failures = (previous.consecutiveFailures ?? 0) + 1;
    const demote = patchChanged || failures >= consecutiveFailureLimit;
    carried.push({
      ...previous,
      status: demote ? "needs-verification" : previous.status,
      checkedAt: now,
      patch: currentPatch,
      consecutiveFailures: failures,
      reasons: [patchChanged ? "Chưa được xác nhận lại cho bản hiện hành" : demote ? "Nguồn vắng mặt trong hai lần quét liên tiếp" : "Nguồn chưa xuất hiện trong lần quét này; tạm giữ một chu kỳ"],
    });
  }
  return carried;
}

async function readJson(filePath, fallback) {
  return readFile(filePath, "utf8").then(JSON.parse).catch((error) => {
    if (fallback !== undefined && error?.code === "ENOENT") return fallback;
    throw error;
  });
}

async function writeJsonAtomic(filePath, value) {
  const temporaryPath = `${filePath}.tmp-${process.pid}`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temporaryPath, filePath);
}

async function validateExistingOutputs() {
  const [evidence, decisions, generated, report] = await Promise.all([
    readJson(EVIDENCE_PATH),
    readJson(DECISIONS_PATH),
    readJson(GENERATED_PATH),
    readJson(REPORT_PATH),
  ]);
  validateEvidence(evidence);
  validateDecisions(decisions);
  validateGenerated(generated);
  validateReport(report);
  if (stableDecisionHash({ decisions: decisions.decisions, records: generated.records }) !== report.contentHash) {
    fail("contentHash báo cáo không khớp quyết định và dữ liệu xuất bản");
  }
  console.log(`Đã kiểm tra ${decisions.decisions.length} quyết định và ${generated.records.length} bản ghi tự động.`);
}

async function main() {
  if (process.argv.includes("--validate-only")) {
    await validateExistingOutputs();
    return;
  }

  const [registry, community, guidesText, dataText, inbox, previousDecisionFile, previousReport] = await Promise.all([
    readJson(REGISTRY_PATH),
    readJson(COMMUNITY_PATH),
    readFile(GUIDES_PATH, "utf8"),
    readFile(DATA_PATH, "utf8"),
    readJson(INBOX_PATH),
    readJson(DECISIONS_PATH, { decisions: [] }),
    readJson(REPORT_PATH, undefined).catch(() => undefined),
  ]);
  if (registry.policy?.autoPublish !== true) fail("policy.autoPublish chưa bật");
  const guides = parseGuides(guidesText);
  const currentPatch = currentPatchFromSource(dataText, registry.minimumPatch);
  const now = new Date().toISOString();
  const candidates = inbox.candidates.filter((candidate) => REVIEW_STATUSES.has(candidate.status));
  const buildCandidates = candidates.filter((candidate) => candidate.signature && candidate.championMatches?.length === 1);
  const moderation = moderateCandidates({
    candidates: buildCandidates,
    policy: registry.policy,
    currentPatch,
    now,
    previousDecisions: previousDecisionFile.decisions ?? [],
  });
  const carried = carryForwardMissing({
    previousDecisions: previousDecisionFile.decisions ?? [],
    decisions: moderation.decisions,
    currentPatch,
    now,
    consecutiveFailureLimit: registry.policy.moderation.consecutiveFailureLimit,
  });
  const decisions = [...moderation.decisions, ...carried]
    .sort((left, right) => left.signature.localeCompare(right.signature));
  const published = generatePublishedRecords({
    decisions,
    guides,
    curatedRecords: community.records,
  });
  const evidenceFile = {
    schemaVersion: 1,
    updatedAt: now,
    currentPatch,
    eligibleStatuses: [...REVIEW_STATUSES],
    candidates,
  };
  const decisionFile = {
    schemaVersion: 1,
    updatedAt: now,
    currentPatch,
    contentHash: stableDecisionHash(decisions),
    decisions,
  };
  const generatedFile = {
    schemaVersion: 1,
    updatedAt: now.slice(0, 10),
    patchBaseline: currentPatch,
    records: published.records,
  };
  const contentHash = stableDecisionHash({ decisions, records: published.records });
  const statusCounts = Object.fromEntries([...DECISION_STATUSES].map((status) => [status, decisions.filter((decision) => decision.status === status).length]));
  const report = {
    generatedAt: now,
    contentHash,
    evidenceHash: stableDecisionHash(candidates),
    currentPatch,
    candidateCount: candidates.length,
    decisionCount: decisions.length,
    statusCounts,
    generatedRecordCount: published.records.length,
    skippedCollisionCount: published.skippedCollisions.length,
    skippedCollisions: published.skippedCollisions,
    autoPublish: registry.policy.autoPublish,
  };
  validateEvidence(evidenceFile);
  validateDecisions(decisionFile);
  validateGenerated(generatedFile);
  validateReport(report);

  if (previousReport?.contentHash === contentHash) {
    console.log(`Không có quyết định kiểm duyệt thay đổi; giữ nguyên hash ${contentHash}.`);
    return;
  }
  await Promise.all([
    writeJsonAtomic(EVIDENCE_PATH, evidenceFile),
    writeJsonAtomic(DECISIONS_PATH, decisionFile),
    writeJsonAtomic(GENERATED_PATH, generatedFile),
    writeJsonAtomic(REPORT_PATH, report),
  ]);
  console.log(`Đã lưu ${decisions.length} quyết định, công khai ${published.records.length} lối chơi; hash ${contentHash}.`);
}

await main();
