# Thiết kế kiểm duyệt cộng đồng tự động

## Mục tiêu

Tự động thu thập, đối chiếu, phê duyệt, công khai và theo dõi vòng đời các lối chơi ARAM: Mayhem từ nguồn cộng đồng Trung Quốc công khai. Hệ thống dùng phản hồi cộng đồng làm tín hiệu chất lượng, không biến lượt xem hay điểm kiểm duyệt thành tỷ lệ thắng.

Website tiếp tục là web responsive thuần túy. Không thêm PWA, service worker, web manifest hoặc lời mời cài ứng dụng.

## Nguyên tắc bất biến

- Không vượt đăng nhập, CAPTCHA hoặc truy cập phần bị khóa trong WeChat mini-program.
- Không lưu nguyên bài, transcript hoặc bình luận đầy đủ; chỉ lưu metadata, số liệu tổng hợp, trích yếu ngắn và URL nguồn.
- Không tự bịa tỷ lệ thắng, thứ hạng, mức phổ biến, lõi hoặc trang bị.
- Tên và ảnh tướng, lõi, trang bị phải khớp ID dữ liệu client hiện hành.
- Giữ tên Trung Quốc cạnh tên tiếng Việt để đối chiếu bản dịch.
- Build cộng đồng không tự ghi đè build Hải Đấu hiện hành.
- Mọi quyết định tự động phải tái lập được từ bằng chứng đã lưu và có lý do đọc được.

## Kiến trúc

Hệ thống dùng mô hình lai:

1. Bộ luật xác định áp dụng các điều kiện cứng về phiên bản, URL, ID game, độ đầy đủ và chống trùng.
2. Bộ tổng hợp bằng chứng chuẩn hóa tín hiệu theo nền tảng, nguồn, tác giả và thời gian.
3. Bộ quyết định tự động chọn một trong các trạng thái: `auto-approved`, `observing`, `rejected`, `needs-verification`, `demoted`.
4. Bộ xuất bản chỉ tạo dữ liệu web từ các quyết định đủ điều kiện, tách biệt hoàn toàn với dữ liệu biên tập thủ công.

## Mô hình dữ liệu

### Hàng chờ thô

`data/community-inbox.json` tiếp tục lưu ứng viên đã gộp theo URL. Nó chỉ là dữ liệu đầu vào và không trực tiếp xuất hiện trên web.

### Bằng chứng chuẩn hóa

`data/community-evidence.json` lưu một bản ghi cho mỗi ứng viên:

- URL chuẩn hóa, nền tảng, tác giả và ngày xuất bản.
- Bản game được nhận diện và thời điểm quét.
- `championId`, ID lõi và ID trang bị đã khớp.
- Chỉ số công khai: lượt xem, thích, coin, lưu, số bình luận; trường không có ở nền tảng được để trống.
- Tổng hợp bình luận công khai theo số lượng tích cực, tiêu cực, trung tính và số bình luận có ý nghĩa; không lưu toàn văn.
- Chất lượng tác giả, độ mới, trạng thái truy cập và lý do lỗi.
- Hash bằng chứng ổn định, bỏ qua `checkedAt` và dao động metadata không vượt ngưỡng.

### Nhật ký quyết định

`data/community-decisions.json` lưu:

- Khóa `championId + canonicalKey`.
- Các URL và tác giả độc lập đã gộp.
- Đường phê duyệt: `cross-source` hoặc `trusted-creator`.
- Điểm tổng, điều kiện cứng, lý do phê duyệt/từ chối/hạ trạng thái.
- Phiên bản hợp lệ, lần phê duyệt gần nhất và số lần quét lỗi liên tiếp.
- Trạng thái hiện hành và lịch sử chuyển trạng thái tối thiểu để kiểm toán.

### Dữ liệu xuất bản tự động

`app/generated-community-sources.json` chỉ chứa bản ghi `auto-approved` hoặc `needs-verification` đã từng được phê duyệt. Dữ liệu này được gộp với `app/community-sources.json` khi dựng giao diện nhưng không sửa dữ liệu biên tập thủ công.

## Điều kiện cứng

Ứng viên chỉ được chấm điểm khi đồng thời thỏa mãn:

- Đúng ARAM: Mayhem và không phải biến thể Cổ Điển, thử nghiệm hoặc chế độ khác.
- Nguồn công khai có URL, tác giả và ngày nguồn xác định được.
- Phù hợp bản hiện hành hoặc có bằng chứng xác nhận lại sau mốc bản hiện hành.
- Khớp chính xác một tướng và tối thiểu một lõi theo ID game.
- Có tối thiểu hai trang bị khớp ID, hoặc trùng một build Hải Đấu hiện hành đủ để dùng thứ tự trang bị Hải Đấu làm nền.
- Không có tín hiệu rõ ràng về bug, mẹo đã sửa, tin đồn hoặc nội dung không khuyến nghị.

Thiếu bất kỳ điều kiện nào sẽ không được tự động công khai.

## Hai đường phê duyệt

### Xác nhận chéo

- Tối thiểu hai tác giả độc lập trong vòng 45 ngày.
- Hai bản ghi không được tính độc lập nếu cùng tác giả, cùng bản sao nội dung hoặc cùng bài được đăng lại.
- Độ giống tổ hợp lõi và trang bị đạt tối thiểu 75% theo độ tương đồng có trọng số.
- Ít nhất một nguồn thuộc bản hiện hành và không nguồn nào có phản hồi tiêu cực vượt ngưỡng.
- Điểm tổng tối thiểu 85/100.

### Một tác giả uy tín

- Tác giả phải nằm trong danh sách `established` của registry. Phiên bản này không tự nâng hạng tác giả.
- Nguồn đã tồn tại tối thiểu 12 giờ.
- Tối thiểu 1.000 lượt xem và 20 hành động tích cực.
- Tỷ lệ tương tác có trọng số tối thiểu 2%, tính bằng `(likes + 2 * coins + 3 * favorites) / views` trên nền tảng có đủ trường tương ứng.
- Nếu có thể đọc bình luận công khai: tối thiểu 70% tích cực trong ít nhất 10 bình luận có ý nghĩa.
- Điểm tổng tối thiểu 90/100.

Không có bình luận công khai không được tự suy diễn là tích cực. Khi thiếu bình luận, ứng viên phải đạt ngưỡng tương tác mạnh và đầy đủ tổ hợp ID.

## Chấm điểm

Điểm tối đa 100, được cấu hình trong `app/community-source-registry.json`:

- Khớp tướng: 15.
- Khớp lõi: 20.
- Khớp trang bị hoặc build Hải Đấu nền: 15.
- Đúng bản và đủ mới: 15.
- Tác giả uy tín: 10.
- Nguồn độc lập thứ hai: 15.
- Tương tác tích cực vượt ngưỡng: 15.
- Bình luận tích cực vượt ngưỡng: 5.

Tổng điểm được giới hạn ở 100. Điểm chỉ là điều kiện hỗ trợ; không thể bù cho điều kiện cứng bị thiếu.

## Tự động hạ trạng thái

Build đã đăng chuyển thành `needs-verification` khi xảy ra một trong các điều kiện:

- Game chuyển bản và chưa có nguồn xác nhận lại.
- ID lõi hoặc trang bị không còn tồn tại, hoặc tên/mô tả hiệu ứng trong dữ liệu client đổi so với lần phê duyệt gần nhất.
- Phản hồi tiêu cực đạt ít nhất 35% trong tối thiểu 10 bình luận có ý nghĩa.
- Nguồn bị xóa hoặc bị xác định là bug.
- Hai lần quét liên tiếp không còn đủ bằng chứng.

Lỗi mạng hoặc lỗi nguồn trong một lần quét không làm hạ trạng thái. Build `needs-verification` vẫn hiển thị lịch sử nhưng không được xem là khuyến nghị chính.

## Luồng xử lý

1. Thu thập ứng viên công khai.
2. Chuẩn hóa URL và metadata.
3. Đối chiếu tướng, lõi và trang bị theo ID client.
4. Gộp trùng URL, tác giả và chữ ký build.
5. Tổng hợp phản hồi công khai và độ tin cậy nguồn.
6. Chạy điều kiện cứng và chấm điểm.
7. Ghi quyết định cùng lý do.
8. Sinh dữ liệu xuất bản tự động.
9. Validate dữ liệu, lint và build.
10. Chỉ triển khai khi hash nội dung có ý nghĩa thay đổi. `checkedAt`, lượt xem và các số tương tác không làm đổi hash nếu quyết định, đường phê duyệt, nguồn, ID, trạng thái và lý do vẫn giữ nguyên.

## Giao diện công khai

Trong chi tiết tướng, build tự động hiển thị:

- Nhãn `Tự động đối chiếu` hoặc `Cần kiểm chứng`.
- Đường phê duyệt: `Hai nguồn độc lập` hoặc `Nguồn uy tín + phản hồi tích cực`.
- Ngày kiểm tra gần nhất và bản game.
- Tên Việt, tên Trung Quốc, ảnh lõi và trang bị theo ID.
- URL nguồn và ngày nguồn.
- Phần giải thích ngắn vì sao hệ thống công khai hoặc hạ trạng thái.

Không gọi điểm, lượt xem, tỷ lệ thích hoặc tổng hợp bình luận là tỷ lệ thắng. Giao diện dùng màu và văn bản đồng thời để trạng thái không phụ thuộc riêng vào màu sắc; mọi liên kết và nút có vùng chạm tối thiểu 44 px, trạng thái focus rõ và hỗ trợ bàn phím.

## Hợp đồng thiết kế theo giao diện Hải Đấu

Bộ ảnh WeChat do người dùng cung cấp là tham chiếu trực tiếp cho cấu trúc và mật độ thông tin, không phải nguồn dữ liệu để sao chép nội dung bị khóa. Bản web Việt hóa áp dụng các đặc điểm sau:

- Trang đầu dùng phần đầu gọn, thống kê nội dung, ô tìm kiếm lớn và hàng tab/bộ lọc ngay trước lưới tướng.
- Lưới tướng ưu tiên ảnh chân dung, tên Việt và huy hiệu phẩm; không hiển thị thứ hạng, biến động hoặc tỷ lệ thắng khi không có dữ liệu đáng tin cậy.
- Mobile dùng bốn cột từ 360–479 px và năm cột từ 480–767 px; desktop tăng dần theo bề rộng nhưng giữ thẻ dễ đọc và không vượt quá mật độ hợp lý.
- Chi tiết tướng mở thành lớp toàn màn hình trên mobile và hộp lớn trên desktop, có phần đầu tướng, điều hướng dính và các nhóm `Lối lên đồ`, `Lõi ưu tiên`, `Cách chơi`, `Nguồn`.
- Mỗi lối chơi là một thẻ riêng: phẩm build, tên, nhãn thuộc tính, lõi chính, lõi dự phòng, thứ tự trang bị có số và bằng chứng nguồn.
- Build Hải Đấu chính đứng trước; build tự động hoặc cộng đồng đứng sau với trạng thái và lý do kiểm duyệt rõ ràng.
- Bỏ toàn bộ quảng cáo, nút chia sẻ mini-program, mô phỏng rút thẻ, nút tạo phương án, liên kết nhóm QQ và chrome hệ thống WeChat.
- Giữ phong cách nền xanh đen, bề mặt xanh slate, cyan cho hành động, xanh lục cho lõi chính, vàng/hồng/tím cho phẩm; giảm hiệu ứng phát sáng để tăng độ rõ trên web.
- Mọi tương tác hoạt động bằng chuột, bàn phím và cảm ứng; vùng chạm tối thiểu 44 px, focus rõ, không khóa zoom và không có cuộn ngang.
- Đây vẫn là web responsive thuần túy, không thêm cơ chế cài ứng dụng.

## Xử lý lỗi

- Sai hoặc thiếu ID: chặn xuất bản và ghi lý do.
- Nguồn mâu thuẫn: giữ `observing`.
- Nguồn tạm lỗi: giữ quyết định trước đó và tăng bộ đếm lỗi.
- Hai lần lỗi liên tiếp: hạ `needs-verification` nhưng không xóa lịch sử.
- Dữ liệu quyết định không hợp lệ: pipeline thất bại trước bước build.
- Build tạo ra hash không đổi sau khi bỏ metadata dao động: không triển khai.

## Kiểm thử

Phát triển theo TDD với fixture cố định cho các trường hợp:

- Hai nguồn độc lập đủ điều kiện được tự duyệt.
- Một tác giả uy tín đủ tương tác được tự duyệt.
- Lượt xem cao nhưng tương tác yếu bị từ chối.
- Sai ID, sai chế độ hoặc nguồn cũ bị chặn.
- Hai URL cùng tác giả không được tính hai nguồn.
- Phản hồi tiêu cực làm build hạ `needs-verification`.
- Một lần lỗi mạng không làm hạ build; lần thứ hai có làm hạ.
- Thay đổi timestamp hoặc dao động tương tác nhỏ không đổi content hash.
- Build tự động không ghi đè build Hải Đấu hoặc bản ghi biên tập thủ công.
- Giao diện hiển thị trạng thái, lý do, tên Trung Quốc và nguồn tương ứng.

## Phạm vi triển khai

- Mở rộng bộ thu thập hiện có và thêm bộ kiểm duyệt/xuất bản độc lập.
- Cập nhật schema registry, validator, báo cáo đồng bộ và package scripts.
- Tích hợp dữ liệu tự động vào mô hình giao diện hiện có.
- Bổ sung thành phần minh bạch quyết định trong chi tiết tướng và khu vực nguồn cộng đồng.
- Cập nhật quy trình đồng bộ định kỳ để chạy kiểm duyệt tự động trước khi quyết định triển khai.
- Không xây trang quản trị, tài khoản người dùng, backend riêng hoặc PWA.
