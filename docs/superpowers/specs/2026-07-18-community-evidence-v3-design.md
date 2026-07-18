# Thiết kế Evidence v3

## Mục tiêu

Evidence v3 tăng độ chính xác của hàng chờ cộng đồng mà không biến pipeline thành công cụ sao chép nội dung. Bộ thu thập được phép đọc tạm metadata, tag, phụ đề công khai và ảnh bìa công khai; dữ liệu lưu lâu dài chỉ gồm ID nguồn, ID thực thể game, kênh đã cung cấp bằng chứng và các trạng thái tổng hợp.

## Hàng rào dữ liệu

- Không vượt đăng nhập, CAPTCHA, trang riêng tư hoặc phần khóa của WeChat mini-program.
- Không lưu HTML, mô tả đầy đủ, phụ đề, transcript, nội dung ảnh hay bình luận.
- Bình luận chỉ còn các số đếm phân loại; ảnh chỉ còn mã băm hoặc mã tham chiếu một chiều.
- Tên lõi và trang bị chỉ được dùng sau khi khớp canonical ID trong dữ liệu Riot/CommunityDragon hiện hành.
- Lượt xem/tương tác chỉ là tín hiệu quan tâm, không phải tỷ lệ thắng.

## Kênh bằng chứng

Mỗi nguồn được tách thành các kênh như `title`, `description`, `tags`, `parts`, `subtitle`, `search-snippet` và `page-metadata`. Việc nhận dạng/loại phủ định diễn ra riêng trong từng kênh. Kết quả lưu chỉ có dạng `{ id, channels[] }`; văn bản kênh không đi vào inbox.

## Chữ ký nghiêm ngặt

`signature` chỉ tồn tại khi nhận dạng đúng một tướng, ít nhất một lõi và ít nhất hai trang bị. Dữ liệu thiếu được giữ bằng `partialSignature` để audit nhưng không được nhóm chéo hoặc đưa sang duyệt tự động.

Nguồn thiếu chi tiết nhưng có ảnh công khai nhận `image-review-required`. Nguồn có nhiều tướng nhận `translation-review-required`. Hai trạng thái này chỉ tạo hàng chờ đối chiếu, không tự suy đoán OCR hoặc bản dịch.

## Làm giàu công khai

- Bilibili: metadata/tag/bình luận như v2, thêm endpoint player công khai để phát hiện phụ đề tiếng Trung, đọc phụ đề có giới hạn và băm ảnh bìa có giới hạn kích thước.
- Zhihu, Tieba, Douyin và web Trung Quốc: đọc metadata công khai (Open Graph/JSON-LD) để bổ sung tác giả, ngày, tiêu đề và từ khóa. Interstitial đăng nhập/CAPTCHA/riêng tư được ghi trạng thái và dừng.
- Gộp nguồn vẫn dựa trên URL chuẩn hóa, ID tác giả nền tảng, tác giả và fingerprint tiêu đề để không đếm mirror hoặc cùng tác giả hai lần.

## Giới hạn vận hành

Mỗi lượt quét có quota riêng cho video Bilibili, phụ đề, ảnh và trang metadata. Các quota và giới hạn ký tự/segment/byte nằm trong `policy.evidenceV3`; `storeRawEvidenceText` bắt buộc là `false`.
