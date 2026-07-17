# Lõi.Meta — ARAM: Mayhem tiếng Việt

Website công khai: <https://trannguyenbaoht2003-crypto.github.io/>

Lõi.Meta là cẩm nang web tiếng Việt cho ARAM: Mayhem. Trang hiển thị toàn bộ danh sách tướng, lõi ưu tiên, thứ tự trang bị, cách vận hành và nguồn đối chiếu. Đây là website responsive thông thường; dự án không có PWA, service worker, web manifest hoặc lời mời cài ứng dụng.

## Nguồn dữ liệu

Dự án tách dữ liệu thành ba lớp:

- Phần công khai của Hải Đấu để đối chiếu danh sách tướng và hướng dẫn hiện hành.
- Riot Data Dragon/CommunityDragon để khóa đúng ID, tên tiếng Việt và ảnh của tướng, lõi và trang bị.
- Metadata công khai từ Bilibili, Zhihu, Tieba, Douyin và các trang hướng dẫn Trung Quốc để phát hiện lối chơi mới.

Quy trình không vượt đăng nhập/CAPTCHA, không truy cập phần khóa trong WeChat mini-program, không lưu nguyên bài, transcript hoặc nội dung bình luận. Lượt xem và tương tác chỉ là bằng chứng quan tâm dùng trong kiểm duyệt, không phải tỷ lệ thắng.

### Bằng chứng tự động v2

V2 làm giàu ứng viên Bilibili bằng các endpoint công khai cho metadata video, tag và phản hồi cấp cao nhất. Mỗi lượt quét chỉ làm giàu tối đa 30 video; phản hồi chỉ được đọc khi tổng bình luận đủ ngưỡng kiểm duyệt và tối đa 20 mục. Pipeline loại bỏ toàn bộ văn bản sau khi phân loại, chỉ lưu số đếm `positive`, `negative`, `neutral`, `meaningful` và `sampled`.

ID video, ID archive và ID tác giả công khai được giữ để gộp trùng ổn định. Hai URL không được tính là hai nguồn độc lập nếu trùng tác giả, trùng ID tác giả nền tảng hoặc có tiêu đề chuẩn hóa giống nhau. Dao động lượt xem và số tương tác không làm đổi `contentHash`; chỉ việc vượt ngưỡng tương tác/phản hồi hoặc thay đổi ID, trạng thái và quyết định mới được coi là có ý nghĩa.

## Kiểm duyệt tự động

`policy.autoPublish=true` chỉ cho phép runner xuất bản khi mọi hàng rào cứng đều đạt:

- đúng ARAM: Mayhem và còn phù hợp với bản game hiện hành;
- có đúng một `championId` cùng ID/ảnh client;
- có ít nhất một lõi và ít nhất hai trang bị khớp đúng ID/ảnh client;
- có URL, tác giả và ngày nguồn công khai;
- không chứa bug đã sửa, tin đồn hoặc nội dung bị khóa.

Sau đó build phải đi qua một trong hai đường:

1. **Hai nguồn độc lập:** hai tác giả/nền tảng độc lập nêu tổ hợp tương tự, đạt ngưỡng điểm chéo.
2. **Nguồn uy tín + phản hồi tích cực:** tác giả trong danh sách `established`, nguồn đã đủ tuổi tối thiểu và tương tác công khai vượt đồng thời ngưỡng lượt xem, hành động tích cực và tỷ lệ tương tác có trọng số.

Một build từng được duyệt sẽ chuyển thành **Cần kiểm chứng** khi đổi bản mà chưa có xác nhận mới, phản hồi tiêu cực vượt ngưỡng, hoặc nguồn lỗi/vắng mặt trong hai lần quét liên tiếp. Dữ liệu tự động không bao giờ ghi đè bản Hải Đấu hay bản ghi cộng đồng biên tập có cùng `championId + canonicalKey`.

## Tệp audit

- `data/community-inbox.json`: hàng chờ ứng viên đã nhận dạng.
- `data/community-evidence.json`: bằng chứng đủ trạng thái để runner xem xét.
- `data/community-decisions.json`: quyết định, lý do, đường duyệt và lịch sử hạ trạng thái.
- `app/generated-community-sources.json`: chỉ các build tự động được phép hiển thị hoặc đang cần kiểm chứng.
- `community-watch-report.json`: báo cáo thu thập và `contentHash` ổn định.
- `community-moderation-report.json`: báo cáo quyết định tự động và `contentHash` bỏ qua dao động metric.
- `community-sync-report.json`: kiểm tra gộp trùng và khớp ID/ảnh client.

## Lệnh vận hành

Yêu cầu Node.js `>=22.13.0`.

```bash
npm run collect:community    # thu thập metadata công khai vào inbox
npm run moderate:community   # đánh giá và sinh dữ liệu tự động
npm run validate:community   # kiểm tra schema, gộp trùng, ID và ảnh client
npm run sync:data            # đồng bộ Riot/Hải Đấu/cộng đồng rồi kiểm duyệt
npm run test:moderation      # kiểm thử luật duyệt và hạ trạng thái
npm test                     # kiểm thử luật + build GitHub Pages + HTML
npm run lint                 # kiểm tra mã nguồn
npm run build:pages          # tạo bản tĩnh trong out/ và giữ out/.nojekyll
```

Nguồn không xuất hiện qua tìm kiếm web có thể được đưa vào `data/community-manual-input.json` theo mẫu `data/community-manual-input.example.json`, sau đó chạy:

```bash
npm run collect:community -- --input data/community-manual-input.json
```

Đầu vào thủ công vẫn phải đi qua đúng các hàng rào tự động; không có đường tắt để đăng thẳng lên web.

## Triển khai

Nhánh `main` được phát hành lên GitHub Pages. Trước khi đẩy bản mới phải chạy:

```bash
npm run validate:community
npm test
npm run lint
npm run build:pages
```

Sau triển khai, xác nhận trang chính trả HTTP 200 và mọi CSS/JavaScript được HTML tham chiếu đều tải thành công.
