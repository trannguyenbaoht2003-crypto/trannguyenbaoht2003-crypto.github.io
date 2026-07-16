# Public API Discovery cho Hải Đấu

Module này dùng danh mục cộng đồng từ `public-apis/public-apis` để **phát hiện** các API có thể hữu ích cho website Hải Đấu. Danh mục không phải là nguồn dữ liệu meta chính thức và không được tự động cấp quyền gọi API trong ứng dụng.

## Luồng xử lý

1. `scripts/sync-public-apis.mjs` tải README hiện tại của `public-apis/public-apis`.
2. Script phân tích bảng API, lọc theo `data/public-api-policy.json` và chấm điểm mức phù hợp.
3. Kết quả được ghi vào `data/public-api-catalog.json`.
4. Báo cáo tóm tắt được ghi vào `public-api-discovery-report.json`.
5. Mọi API mới đều có `verificationStatus: "discovered"` và `approved: false`.

## Quy tắc an toàn bắt buộc

Ứng dụng chỉ được sử dụng một API khi đồng thời đáp ứng:

- `verificationStatus` là `verified`;
- `approved` là `true`;
- đã kiểm tra giấy phép và điều khoản sử dụng;
- đã ghi rõ xác thực, giới hạn gọi và phương án lưu khóa;
- hỗ trợ HTTPS;
- CORS phù hợp nếu gọi từ trình duyệt;
- không đưa khóa API hoặc bí mật vào client bundle.

Danh mục sinh tự động không được coi là bằng chứng API đang hoạt động. Trước khi phê duyệt cần kiểm tra endpoint thật, schema phản hồi, độ ổn định và quyền sử dụng dữ liệu.

## Câu lệnh

```bash
npm run sync:public-apis
```

Lệnh đồng bộ dữ liệu tổng thể `npm run sync:data` cũng chạy module này trước các bước thu thập cộng đồng hiện có.

## Phạm vi phù hợp với Hải Đấu

Ưu tiên các API hỗ trợ dữ liệu game, Riot Games/TFT, dịch Trung–Việt, từ điển, phân tích văn bản, tin tức và tín hiệu cộng đồng. Module này không thay thế API chính thức hoặc quy trình kiểm chứng nguồn meta.

## Giấy phép nguồn danh mục

Danh mục `public-apis/public-apis` được phát hành theo giấy phép MIT. Bản thông báo giấy phép được lưu tại `LICENSES/public-apis-MIT.txt`.
