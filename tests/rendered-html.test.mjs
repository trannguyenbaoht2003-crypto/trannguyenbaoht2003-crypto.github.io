import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const html = await readFile(new URL("../out/index.html", import.meta.url), "utf8");
const source = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
const reviewHtml = await readFile(new URL("../out/review/index.html", import.meta.url), "utf8").catch(() => "");
const reviewPageSource = await readFile(new URL("../app/review/page.tsx", import.meta.url), "utf8").catch(() => "");
const reviewClientSource = await readFile(new URL("../app/review/ReviewWorkbench.tsx", import.meta.url), "utf8").catch(() => "");

test("renders the Hai Dau-inspired information architecture", () => {
  assert.match(html, /Kho tướng/i);
  assert.match(html, /Lối lên đồ/i);
  assert.match(html, /Lõi ưu tiên/i);
  assert.match(html, /Cách chơi/i);
  assert.match(html, /Nguồn/i);
});

test("explains automatic moderation without presenting engagement as win rate", () => {
  assert.match(html, /Kiểm duyệt tự động đang bật/i);
  assert.match(html, /Không phải tỷ lệ thắng/i);
  assert.match(html, /Hai nguồn độc lập/i);
  assert.match(html, /Nguồn uy tín.{0,20}phản hồi tích cực/i);
});

test("publishes the Evidence v3 audit status without exposing raw evidence", () => {
  assert.match(html, /Evidence v3/i);
  assert.match(html, /nguồn v3/i);
  assert.match(html, /ảnh đã băm/i);
  assert.doesNotMatch(html, /matchingText|rawSubtitle|pageHtml/i);
});

test("keeps the champion detail accessible", () => {
  assert.match(source, /role="dialog"/);
  assert.match(source, /aria-label="Đóng hướng dẫn"/);
  assert.match(source, /aria-label="Điều hướng hướng dẫn tướng"/);
  assert.match(source, /href="#builds"/);
  assert.match(source, /href="#augments"/);
  assert.match(source, /href="#notes"/);
  assert.match(source, /href="#sources"/);
});

test("does not add an installable app surface", () => {
  assert.doesNotMatch(html, /rel=["']manifest["']/i);
  assert.doesNotMatch(source, /serviceWorker|beforeinstallprompt|Cài đặt ứng dụng/i);
});

test("renders the public Evidence v3.1 review workbench with exact-ID controls", () => {
  assert.match(reviewHtml, /Bảng duyệt Evidence v3\.1/i);
  const candidateCount = reviewHtml.match(/aria-label=["'](\d+) ứng viên["']/i);
  assert.ok(candidateCount, "review workbench must render its current candidate count");
  assert.ok(Number(candidateCount[1]) > 0, "review workbench must contain an actionable candidate");
  assert.match(reviewHtml, /Chờ đối chiếu ảnh/i);
  assert.match(reviewHtml, /Chờ đối chiếu bản dịch/i);
  assert.match(reviewHtml, /Chọn đúng 1 tướng/i);
  assert.match(reviewHtml, /Ít nhất 1 lõi/i);
  assert.match(reviewHtml, /Ít nhất 2 trang bị/i);
  assert.match(reviewHtml, /Tôi đã đối chiếu/i);
  assert.match(reviewHtml, /Tải gói JSON/i);
  assert.match(reviewHtml, /Không tự động đăng/i);
});

test("exports a local structured package without authenticated browser writes", () => {
  assert.match(reviewClientSource, /new Blob\(/);
  assert.match(reviewClientSource, /evidence-v31-review-package\.json/);
  assert.match(reviewClientSource, /schemaVersion:\s*1/);
  assert.match(reviewClientSource, /evidenceVersion:\s*["']3\.1["']/);
  assert.doesNotMatch(reviewClientSource, /\bfetch\s*\(|authorization|github[_-]?token|localStorage/i);
  assert.doesNotMatch(`${reviewHtml}\n${reviewPageSource}`, /matchingText|rawSubtitle|pageHtml|transcript/i);
});

test("links the public guide to the Evidence v3.1 workbench", () => {
  assert.match(html, /href=["']\/review\/["']/i);
  assert.match(html, /Mở bảng duyệt Evidence v3\.1/i);
});
