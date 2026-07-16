import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const marker = "community-watch-fallback";
const fallbackCss = `
/* ${marker} */
.community-source-section::before{content:"KIỂM DUYỆT TỰ ĐỘNG ĐANG BẬT\A Chỉ xuất bản khi khớp ID game và đạt hai nguồn độc lập hoặc nguồn uy tín + phản hồi tích cực.\A Tương tác công khai là tín hiệu kiểm duyệt, không phải tỷ lệ thắng.";display:block;margin-bottom:18px;padding:20px 22px;border:1px solid rgba(57,216,230,.24);border-radius:15px;background:linear-gradient(105deg,rgba(57,216,230,.08),rgba(113,84,217,.07));color:#b9c8d1;white-space:pre-line;font-size:12px;font-weight:600;line-height:1.8}.community-source-section:has(.automation-watch)::before{display:none}
`;

const html = await readFile(path.join(root, "index.html"), "utf8");
const cssPaths = [...html.matchAll(/href="(\/_next\/static\/css\/[^"?]+\.css)"/g)]
  .map((match) => match[1])
  .filter((value, index, values) => values.indexOf(value) === index);

if (cssPaths.length === 0) throw new Error("Không tìm thấy CSS đang được index.html tham chiếu.");

for (const publicPath of cssPaths) {
  const filePath = path.join(root, publicPath.replace(/^\//, ""));
  const current = await readFile(filePath, "utf8");
  if (current.includes(marker)) continue;
  await writeFile(filePath, `${current.trimEnd()}${fallbackCss}`, "utf8");
  console.log(`Đã thêm trạng thái kiểm duyệt dự phòng vào ${publicPath}`);
}
