# Kế hoạch triển khai Evidence v3

1. Thêm kiểm thử cho phụ đề công khai, metadata trang, mã ảnh, bằng chứng theo kênh và chữ ký nghiêm ngặt.
2. Tạo thư viện Evidence v3 thuần, không lưu văn bản nguồn.
3. Nối Bilibili subtitle/ảnh và metadata trang công khai vào collector theo quota.
4. Thêm alias trang bị Trung Quốc chỉ khi canonical ID tồn tại trong client hiện hành.
5. Mở rộng schema inbox/report với provenance theo kênh và hàng chờ đối chiếu ảnh/bản dịch.
6. Chạy đồng bộ, validate, lint, unit test, build GitHub Pages và kiểm tra HTML/tài nguyên sau triển khai.
