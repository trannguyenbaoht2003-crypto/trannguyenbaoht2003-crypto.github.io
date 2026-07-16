import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const POLICY_PATH = path.join(ROOT, "data/public-api-policy.json");
const CATALOG_PATH = path.join(ROOT, "data/public-api-catalog.json");
const REPORT_PATH = path.join(ROOT, "public-api-discovery-report.json");
const SOURCE_URL = "https://raw.githubusercontent.com/public-apis/public-apis/master/README.md";
const SOURCE_REPOSITORY = "https://github.com/public-apis/public-apis";
const USER_AGENT = "LoiMetaApiDiscovery/1.0 (+https://github.com/trannguyenbaoht2003-crypto/trannguyenbaoht2003-crypto.github.io)";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function cleanMarkdown(value = "") {
  return String(value)
    .replace(/<br\s*\/?\s*>/gi, " ")
    .replace(/`/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function parseLink(value = "") {
  const match = value.match(/\[([^\]]+)]\((https?:\/\/[^)]+)\)/i);
  if (!match) return { name: cleanMarkdown(value), url: undefined };
  return { name: cleanMarkdown(match[1]), url: match[2].trim() };
}

function parseBoolean(value = "") {
  const normalized = cleanMarkdown(value).toLowerCase();
  if (["yes", "true", "✅"].includes(normalized)) return true;
  if (["no", "false", "❌"].includes(normalized)) return false;
  return undefined;
}

function parseCategories(markdown) {
  const lines = markdown.split(/\r?\n/);
  const rows = [];
  let category;

  for (const line of lines) {
    const heading = line.match(/^###\s+(.+?)\s*$/);
    if (heading) {
      category = cleanMarkdown(heading[1]);
      continue;
    }
    if (!category || !line.trim().startsWith("|")) continue;

    const cells = line
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map(cleanMarkdown);

    if (cells.length < 5 || /^:?-{3,}/.test(cells[0]) || cells[0].toLowerCase() === "api") continue;
    const api = parseLink(cells[0]);
    if (!api.url || !api.name) continue;

    rows.push({
      category,
      name: api.name,
      documentationUrl: api.url,
      description: cells[1],
      auth: cells[2] || "Unknown",
      https: parseBoolean(cells[3]),
      cors: cells[4] || "Unknown",
    });
  }
  return rows;
}

function normalize(value = "") {
  return String(value).normalize("NFKC").toLowerCase();
}

function scoreApi(api, policy) {
  const text = normalize(`${api.category} ${api.name} ${api.description}`);
  let score = 0;
  const reasons = [];

  if (api.https === true) {
    score += 20;
    reasons.push("HTTPS");
  } else if (api.https === false) {
    score -= 100;
    reasons.push("không hỗ trợ HTTPS");
  }

  const cors = normalize(api.cors);
  if (cors === "yes") {
    score += 10;
    reasons.push("CORS công khai");
  } else if (cors === "no") {
    score -= 5;
  }

  const auth = normalize(api.auth);
  if (["no", "", "none"].includes(auth)) {
    score += 5;
    reasons.push("không cần khóa API");
  }

  for (const keyword of policy.priorityKeywords ?? []) {
    if (text.includes(normalize(keyword))) {
      score += 8;
      reasons.push(`phù hợp: ${keyword}`);
    }
  }
  for (const keyword of policy.blockedKeywords ?? []) {
    if (text.includes(normalize(keyword))) {
      score -= 100;
      reasons.push(`bị chặn: ${keyword}`);
    }
  }

  return { score, reasons: [...new Set(reasons)] };
}

function stableId(api) {
  return sha256(`${api.category}\n${api.name}\n${api.documentationUrl}`).slice(0, 16);
}

async function loadJson(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

async function fetchSource() {
  const response = await fetch(SOURCE_URL, {
    headers: { "user-agent": USER_AGENT, accept: "text/markdown,text/plain;q=0.9,*/*;q=0.5" },
    signal: AbortSignal.timeout(25_000),
  });
  if (!response.ok) throw new Error(`Public APIs trả về ${response.status} ${response.statusText}`);
  return response.text();
}

async function main() {
  const policy = await loadJson(POLICY_PATH, {});
  const previous = await loadJson(CATALOG_PATH, { apis: [] });
  const previousByUrl = new Map((previous.apis ?? []).map((api) => [api.documentationUrl, api]));
  let markdown;
  let sourceStatus = "fresh";

  try {
    markdown = await fetchSource();
  } catch (error) {
    if ((previous.apis ?? []).length === 0) throw error;
    sourceStatus = "cached";
    console.warn(`Không tải được Public APIs; giữ catalog cũ: ${error.message}`);
  }

  if (!markdown) {
    await writeFile(REPORT_PATH, `${JSON.stringify({
      generatedAt: new Date().toISOString(),
      sourceStatus,
      retainedApis: previous.apis.length,
      warning: "Không tải được nguồn; không thay đổi catalog.",
    }, null, 2)}\n`);
    return;
  }

  const allowedCategories = new Set(policy.allowedCategories ?? []);
  const minimumScore = Number(policy.minimumDiscoveryScore ?? 0);
  const parsed = parseCategories(markdown);
  const selected = parsed
    .filter((api) => allowedCategories.size === 0 || allowedCategories.has(api.category))
    .map((api) => {
      const previousEntry = previousByUrl.get(api.documentationUrl);
      const ranking = scoreApi(api, policy);
      return {
        id: stableId(api),
        ...api,
        score: ranking.score,
        scoreReasons: ranking.reasons,
        verificationStatus: previousEntry?.verificationStatus ?? "discovered",
        approved: previousEntry?.approved === true,
        approvedUses: previousEntry?.approvedUses ?? [],
        notes: previousEntry?.notes ?? "",
        discoveredFrom: SOURCE_REPOSITORY,
      };
    })
    .filter((api) => api.score >= minimumScore)
    .sort((a, b) => b.score - a.score || a.category.localeCompare(b.category) || a.name.localeCompare(b.name));

  const catalog = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    source: {
      repository: SOURCE_REPOSITORY,
      readme: SOURCE_URL,
      commitPolicy: "Theo dõi nhánh master; mọi API mới chỉ ở trạng thái discovered.",
      contentSha256: sha256(markdown),
    },
    safety: {
      autoExecutionAllowed: false,
      rule: "Chỉ API có approved=true và verificationStatus=verified mới được ứng dụng sử dụng.",
    },
    apis: selected,
  };

  const countsByCategory = Object.fromEntries([...new Set(selected.map((api) => api.category))]
    .sort()
    .map((category) => [category, selected.filter((api) => api.category === category).length]));

  await mkdir(path.dirname(CATALOG_PATH), { recursive: true });
  await writeFile(CATALOG_PATH, `${JSON.stringify(catalog, null, 2)}\n`);
  await writeFile(REPORT_PATH, `${JSON.stringify({
    generatedAt: catalog.generatedAt,
    sourceStatus,
    parsedApis: parsed.length,
    selectedApis: selected.length,
    approvedApis: selected.filter((api) => api.approved && api.verificationStatus === "verified").length,
    countsByCategory,
    nextAction: "Xác minh thủ công hoặc bằng validator trước khi đổi approved thành true.",
  }, null, 2)}\n`);

  console.log(`Đã phát hiện ${selected.length}/${parsed.length} API phù hợp; chưa tự động kích hoạt API nào.`);
}

main().catch((error) => {
  console.error(`Đồng bộ Public APIs thất bại: ${error.stack || error.message}`);
  process.exitCode = 1;
});
