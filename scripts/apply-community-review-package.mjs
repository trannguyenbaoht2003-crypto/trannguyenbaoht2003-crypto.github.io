import { readFile, rename, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  buildReviewCatalog,
  mergeReviewOverrides,
  validateReviewOverrides,
  validateReviewPackage,
} from "./lib/community-review-v31.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GUIDES_PATH = path.join(ROOT, "app/generated-guides.ts");
const INBOX_PATH = path.join(ROOT, "data/community-inbox.json");
const OVERRIDES_PATH = path.join(ROOT, "data/community-review-overrides.json");

function fail(message) {
  throw new Error(`Nhập Evidence v3.1: ${message}`);
}

function parseGuides(source) {
  const marker = "export const generatedChampions: ChampionGuide[] = ";
  const start = source.indexOf(marker);
  if (start < 0) fail("không tìm thấy generatedChampions");
  return JSON.parse(source.slice(start + marker.length).trim().replace(/;\s*$/, ""));
}

async function writeJsonAtomic(target, value) {
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.tmp`);
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, target);
}

async function main() {
  const input = process.argv[2];
  if (!input || process.argv.length > 3) {
    fail("cách dùng: npm run review:apply -- <đường-dẫn-gói-json>");
  }
  const packagePath = path.resolve(process.cwd(), input);
  const [packageText, guidesText, inboxText, overridesText] = await Promise.all([
    readFile(packagePath, "utf8"),
    readFile(GUIDES_PATH, "utf8"),
    readFile(INBOX_PATH, "utf8"),
    readFile(OVERRIDES_PATH, "utf8"),
  ]);
  const catalog = buildReviewCatalog(parseGuides(guidesText));
  const inbox = JSON.parse(inboxText);
  const existing = validateReviewOverrides(JSON.parse(overridesText), { catalog });
  const reviewPackage = validateReviewPackage(JSON.parse(packageText), {
    candidates: inbox.candidates,
    catalog,
  });
  const now = new Date().toISOString();
  const merged = mergeReviewOverrides(existing, reviewPackage.reviews, now);
  const validated = validateReviewOverrides(merged, { catalog });
  await writeJsonAtomic(OVERRIDES_PATH, validated);
  console.log(`Đã nhập ${reviewPackage.reviews.length} lựa chọn Evidence v3.1; chạy npm run sync:data để kiểm duyệt.`);
}

await main();
