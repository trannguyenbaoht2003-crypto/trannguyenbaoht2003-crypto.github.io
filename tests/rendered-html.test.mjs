import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const html = await readFile(new URL("../out/index.html", import.meta.url), "utf8");
const source = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");

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
