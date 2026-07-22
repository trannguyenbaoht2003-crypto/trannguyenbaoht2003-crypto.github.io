# Lõi.Meta — ARAM: Mayhem tiếng Việt

Website công khai: <https://trannguyenbaoht2003-crypto.github.io/>

Lõi.Meta là cẩm nang web tiếng Việt cho ARAM: Mayhem. Frontend production hiện tại là Next static export chạy trên GitHub Pages.

## Hợp đồng build

### Frontend canonical — GitHub Pages

`npm run build` là frontend production build duy nhất trong Sprint 0. Lệnh này tương đương `npm run build:pages`, tạo static export trong `out/` và tự chạy `npm run validate:pages`.

Artifact bắt buộc:

- `out/index.html`;
- `out/review/index.html`;
- `out/.nojekyll`.

### Sites/Worker prototype — experimental

`npm run build:sites` giữ prototype Vinext/Cloudflare riêng biệt. Lệnh này yêu cầu `.openai/hosting.json`, tạo `dist/` và chạy `npm run validate:sites`. Đây không phải production build, không nằm trong quality gate bắt buộc của Sprint 0 và không biểu thị migration production sang Cloudflare.

Không tạo hosting manifest giả để làm build xanh. Xem ADR tại `docs/adr/0001-build-contracts.md`.

## Nguồn dữ liệu và kiểm duyệt

Dự án đối chiếu dữ liệu Hải Đấu, Riot Data Dragon/CommunityDragon và metadata công khai từ cộng đồng Trung Quốc. Pipeline không vượt đăng nhập/CAPTCHA và không lưu nguyên bài, transcript, bình luận hoặc ảnh nguồn. Tương tác công khai là tín hiệu kiểm duyệt, không phải tỷ lệ thắng.

Evidence v3 chỉ lưu ID thực thể, kênh bằng chứng và mã băm/tham chiếu an toàn. Trang `/review/` tạo gói Evidence v3.1 có cấu trúc; moderation vẫn là cổng xuất bản cuối cùng. Không có token, request ghi hoặc quyền tự đăng từ trang duyệt.

## Lệnh vận hành

Yêu cầu Node.js `>=22.13.0`.

```bash
npm run collect:community    # thu thập metadata công khai vào inbox
npm run moderate:community   # đánh giá và sinh dữ liệu tự động
npm run validate:community   # kiểm tra schema, gộp trùng, ID và ảnh client
npm run test:moderation      # kiểm thử Evidence/moderation
npm run lint                 # kiểm tra mã nguồn
npm test                     # kiểm thử luật + canonical Pages build + HTML
npm run build                # frontend production canonical, output out/
npm run build:pages          # alias rõ nghĩa cho canonical Pages build
npm run validate:pages       # kiểm tra /, /review/ và .nojekyll trong out/
npm run build:sites          # experimental Vinext/Cloudflare build
npm run validate:sites       # validation riêng cho dist/ Sites artifact
```

## Triển khai

Nhánh `main` hiện được phát hành bằng GitHub Pages. Trước khi đề xuất phát hành phải chạy:

```bash
npm ci
npm run validate:community
npm run lint
npm test
npm run build
npm run validate:pages
```

Workflow dry-run chỉ có quyền đọc, upload `out/` làm artifact kiểm thử và không deploy, push hoặc thay đổi cấu hình GitHub Pages production.
