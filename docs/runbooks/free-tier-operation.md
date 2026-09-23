# Vận hành database trong hạn mức miễn phí

## Thay đổi ngày 23/09/2026

Worker production xử lý outbox mỗi giây khi có công việc. Sau lần nhận
công việc cuối cùng, worker tiếp tục kiểm tra nhanh trong 60 giây để các
worker bất đồng bộ có thời gian tạo sự kiện tiếp theo. Khi không còn công
việc sẵn sàng, worker nghỉ 30 phút. Lỗi dispatch cũng chờ 30 phút trước
lần thử tiếp theo để tránh lặp truy vấn khi database hết quota.

Chế độ này áp dụng khi `NODE_ENV=production`; môi trường khác giữ nhịp
một giây. Collector giữ lịch hiện có `0 */6 * * *`. Không thay đổi schema,
receipt, lease, chính sách kiểm duyệt hay điều kiện xuất bản.

## Đánh đổi

- Sự kiện mới xuất hiện trong lúc nghỉ có thể chờ tới 30 phút cộng thời
  gian xử lý. Công việc nối tiếp chạy lâu hơn 60 giây cũng có thể chịu
  độ trễ này ở từng bước. Đây không phải chế độ cập nhật tức thời.
- Redis/BullMQ vẫn hoạt động; thay đổi chỉ giảm truy vấn PostgreSQL.
- PostgreSQL chỉ tự nghỉ nếu không có truy vấn khác. Lưu lượng web,
  kiểm tra `/health/ready`, collector, AI và công việc lỗi lặp lại đều
  có thể giữ database hoạt động. Dùng `/health/live` cho kiểm tra tiến
  trình thường xuyên; giữ `/health/ready` để kiểm chứng phụ thuộc khi
  phát hành hoặc chẩn đoán. Không coi liveness là bằng chứng DB sẵn sàng.
- Không bảo đảm toàn bộ hệ thống miễn phí. Railway và nhà cung cấp AI
  có ngân sách riêng. Không bật gọi AI trả phí như một phần bản sửa này.

## Ước tính để theo dõi, không phải cam kết quota

Neon Free công bố 100 CU-giờ/project/tháng, 0,5 GB và tự nghỉ sau 5 phút
không hoạt động: https://neon.com/docs/introduction/plans

Nếu compute cố định 0,25 CU, chỉ thức khoảng 5 phút mỗi 30 phút,
chi phí compute tính theo quota khoảng 30 CU-giờ trong tháng 30 ngày.
Đây chỉ là ước tính lúc nhàn rỗi; phải cộng thời gian xử lý, grace period,
truy cập web và các truy vấn khác. Xác nhận bằng số liệu sử dụng thực tế.

## Điều kiện phát hành và khôi phục

Kiểm tra chỉ đọc ngày 23/09/2026 vẫn trả HTTP 402 do hết quota. Kỳ hiện
hành kết thúc 01/10/2026 UTC. Sửa worker không khôi phục quota đã tiêu hao.
Không xóa project, không tạo project mới để né quota và không bỏ qua
production release gate.

1. Khi database trở lại, kiểm tra `select 1` và khả năng đọc catalog,
   outbox, receipt. Không dùng database production để chạy bộ test reset schema.
2. Chạy production release gate bằng exact SHA đã merge và vượt CI.
3. Kiểm tra cả năm service, HTTP/browser smoke, rồi kiểm tra log collector
   có kết quả import/replay; trạng thái deploy thành công chưa đủ.
4. Theo dõi CU-giờ và thời gian compute hoạt động trong 24 giờ có tải thấp.
   Xác minh thực tế có khoảng suspend giữa các đợt; điều tra mọi truy vấn
   định kỳ nếu compute vẫn hoạt động liên tục.
5. Catalog thực phải được xác minh, import, validate và activate theo
   `catalog-operations.md` trước khi coi normalizer đã sẵn sàng.
6. Chỉ kết luận AI tự duyệt/xuất bản hoạt động sau khi có kết quả đầu-cuối
   từ nguồn thật, evidence hợp lệ và publication đọc được trên web.

Rollback qua production release gate về SHA đã xác minh trước đó sẽ
khôi phục nhịp một giây, đồng thời khôi phục nguy cơ tiêu hao quota.
