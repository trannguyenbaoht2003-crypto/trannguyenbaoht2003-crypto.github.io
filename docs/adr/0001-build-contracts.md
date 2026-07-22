# ADR 0001: Tách hợp đồng build frontend và Sites

- Trạng thái: Accepted
- Phạm vi: Sprint 0

## Quyết định

GitHub Pages static export là frontend canonical. `npm run build` và `npm run build:pages` tạo `out/`; `npm run validate:pages` bắt buộc kiểm tra `out/index.html`, `out/review/index.html` và `out/.nojekyll`.

Vinext/Cloudflare Sites/Worker được giữ dưới dạng prototype experimental. `npm run build:sites` tạo `dist/` và chỉ chạy khi có `.openai/hosting.json`. `npm run validate:sites` tiếp tục yêu cầu Worker artifact và `dist/.openai/hosting.json`.

## Hệ quả

Hai artifact có validation riêng. Sites validation không chặn frontend canonical. Sprint này không migrate production, không tạo manifest giả, không thay đổi GitHub Pages deployment và không tuyên bố Sites/Worker production-ready.
