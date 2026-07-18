# Thiết kế bảng duyệt Evidence v3.1

## Mục tiêu

Tạo một bảng duyệt công khai, chỉ đọc tại `/review/` để người duyệt mở nguồn, đối chiếu tướng/lõi/trang bị với catalog Riot/CommunityDragon hiện hành và tải xuống một gói JSON có cấu trúc. Gói chỉ có hiệu lực sau khi được nhập bằng CLI trong repository và vẫn phải đi qua mọi hàng rào moderation hiện hành.

## Phương án đã chọn

Trang GitHub Pages không có backend hoặc phiên đăng nhập quản trị. Vì vậy trình duyệt không được giữ token và không ghi thẳng vào GitHub. Bảng duyệt chỉ tạo tệp tải xuống; CLI có quyền ghi cục bộ sẽ xác minh gói rồi gộp vào `data/community-review-overrides.json`.

Không chọn phương án ghi GitHub trực tiếp từ trình duyệt vì sẽ tạo bề mặt xác thực nguy hiểm. Không chọn bảng chỉ hiển thị vì nó không chuyển được lựa chọn ID thành dữ liệu có thể tái sử dụng trong các lần đồng bộ sau.

## Dữ liệu hiển thị

Chỉ các candidate có `evidenceReviewState` là `image-review-required` hoặc `translation-review-required` xuất hiện. Mỗi candidate hiển thị tiêu đề nguồn, nền tảng, tác giả/ngày nếu có, URL công khai, ID đang khớp, kênh bằng chứng, lý do và số lượng mã ảnh đã băm/tham chiếu. Không hiển thị HTML, mô tả nguồn, phụ đề, transcript, bình luận hoặc nội dung ảnh.

Catalog chọn ID được sinh tại build-time từ `app/generated-guides.ts`, gộp trùng theo ID và gồm tên Việt, tên Trung Quốc, ID cùng ảnh client cho 173 tướng, lõi và trang bị hiện hành.

## Luồng duyệt

1. Người duyệt mở URL nguồn trong tab mới.
2. Chọn đúng một tướng, ít nhất một lõi và ít nhất hai trang bị.
3. Xác nhận đã đối chiếu lựa chọn với nguồn công khai.
4. Thêm candidate vào gói và tải `evidence-v31-review-package.json`.
5. Maintainer chạy `npm run review:apply -- <đường-dẫn-gói>`.
6. CLI kiểm tra schema, candidate ID + URL, ID catalog, số lượng tối thiểu và attestation; sau đó gộp nguyên tử vào override.
7. `npm run sync:data` áp override vào candidate, tạo chữ ký chuẩn, rồi moderation vẫn yêu cầu hai nguồn độc lập hoặc nguồn uy tín + phản hồi tích cực.

## Schema

Gói tải xuống dùng `schemaVersion: 1`, `evidenceVersion: "3.1"`, `generatedAt` và `reviews[]`. Mỗi review chỉ gồm `candidateId`, `url`, `championId`, `augmentIds`, `itemIds`, `attested: true`.

Override bền vững dùng cùng trường lựa chọn, cộng `reviewedAt`. Không lưu tên người duyệt hoặc ghi chú tự do. Candidate sau khi áp override chỉ lưu metadata provenance có cấu trúc và kênh `reviewer-selection`; lựa chọn thủ công không được tính là một nguồn độc lập.

## Hàng rào lỗi và bảo mật

- Candidate ID và URL phải cùng khớp inbox hiện hành tại lúc nhập.
- ID tướng/lõi/trang bị phải tồn tại trong catalog client hiện hành; mảng ID không được trùng.
- Gói thiếu attestation hoặc thiếu tổ hợp tối thiểu bị từ chối toàn bộ, không ghi một phần.
- Override không thể hồi sinh nguồn stale, locked, CAPTCHA, private, sai mode hoặc có disqualifier.
- Trang không có request ghi, secret, token hoặc API quản trị.
- Việc tải gói không đồng nghĩa duyệt đăng; `policy.autoPublish` và moderation vẫn là cổng cuối.

## Giao diện

Desktop dùng danh sách candidate bên trái và vùng biên tập bên phải; mobile xếp dọc. Bộ lọc gồm tất cả, chờ ảnh và chờ bản dịch. Mỗi picker có tìm kiếm theo tên Việt/Trung/ID, hiển thị ảnh game và trạng thái đã chọn. Một khay gói duyệt cố định hiển thị số mục hợp lệ và nút tải JSON.

## Kiểm thử và tiêu chí hoàn tất

- Unit test cho catalog, schema package, merge override, hard gate và dữ liệu không có văn bản thô.
- Render test xác nhận `/review/` có candidate, picker, attestation, nút tải và thông báo không auto-publish.
- `validate:community`, lint, test, build Pages đều đạt.
- Trang `/review/` và mọi CSS/JS tham chiếu trả HTTP 200; trang chính có liên kết tới bảng duyệt.
