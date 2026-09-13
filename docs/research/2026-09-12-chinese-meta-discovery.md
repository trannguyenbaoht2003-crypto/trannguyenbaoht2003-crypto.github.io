# Khảo sát nguồn meta Trung Quốc — 2026-09-12

Lượt collector thật hoàn tất lúc **2026-09-12T09:55:52.175Z**, nhận phiên bản live **16.18** từ Data Dragon. Chạy ở thư mục đầu ra riêng, không ghi vào cơ sở dữ liệu production. Bản quét dùng commit `f2ecabf`; các sửa lỗi review tiếp theo được kiểm tra bằng phát lại tách biệt.

| Kết quả | Số lượng |
| --- | ---: |
| Nhóm nguồn trong catalog | 10 |
| Truy vấn chạy | 16 |
| Ứng viên được giữ trong inbox khảo sát | 80 |
| Ứng viên có từ khóa lối chơi độc lạ | 9 |
| Khớp patch hiện hành và ngày đăng | 3 |
| Đủ bằng chứng ID để sẵn sàng duyệt | 0 |
| URL ngoài phạm vi nguồn bị loại | 100 |
| Truy vấn báo lỗi truy cập | 0 |

Cả 80 ứng viên hợp lệ về nguồn URL trong lượt này đều đến từ Bilibili. Việc truy vấn Douyin/Tieba/Zhihu không lỗi không đồng nghĩa đã tìm được bài phù hợp ở những nền tảng đó. Trong các ứng viên, 73 bài không xác nhận patch, 4 bài lệch patch, 11 bài quá cũ và 7 bài có vấn đề ngữ cảnh mode; một bài có thể có nhiều lý do giữ lại.

## Đầu mối hiện hành cần đối chiếu

| Nguồn gốc | Người đăng / ngày | Hướng khai thác | Trạng thái |
| --- | --- | --- | --- |
| [Kai'Sa sau cập nhật 16.18](https://www.bilibili.com/video/BV1FYYD6bEHU/) | 夜陨zz · 2026-09-12 | Kiểm tra lại build AP khi tác giả nêu lõi 虚幻武器 bị cấm | Chưa xác minh pool lõi và đầy đủ build |
| [Clown College: khác biệt mô tả và sát thương](https://www.bilibili.com/video/BV1yvYV6aEzU/) | 艾莉丝喵Zzz · 2026-09-11 | Đầu mối kiểm tra cơ chế, nhãn patch 26.18 | Bài nói về máy chủ Malaysia; không tự áp dụng kết luận cho mọi máy chủ |
| [Twisted Fate: lõi và trang bị](https://www.bilibili.com/video/BV1AuYg6XEx6/) | 熊猫老陈的游戏时光 · 2026-09-10 | Đối chiếu nhiều tổ hợp tướng–lõi–trang bị | Chưa đủ ID chính xác để tạo candidate backend |
| [Rek'Sai AP — lối chơi thử nghiệm](https://www.bilibili.com/video/BV1phtd6qEfM/) | 嚯嚯嚯你是个沙雕 · 2026-09-03 | Ý tưởng ít phổ biến theo yêu cầu ưu tiên | Chưa có patch rõ ràng; giữ ở hàng khám phá |

Đây là đầu mối do người chơi đăng, không phải kết luận về sức mạnh hay khuyến nghị build đã được kiểm chứng. Không có bài nào trong lượt khảo sát này được tự xuất bản.

## Nguồn catalog luật

[Changelog 海斗小助手](https://lolhaidou.cn/changelog.html) ngày 2026-09-10 ghi đã đồng bộ cập nhật 26.18. [Trang 虚幻武器](https://lolhaidou.cn/augment/etherealweapon.html) có metadata `dateModified=2026-09-11` và định danh ARAM Mayhem. Đây là đầu mối tốt để đối chiếu pool lõi theo mode, nhưng chưa đủ chứng minh toàn bộ ID, các giới hạn chọn và các cấm riêng theo tướng của catalog backend.

[ARAM Hextech Wiki](https://apexlol.info/zh/hextech) có chỉ dẫn lõi bị vô hiệu hóa và tương tác; vẫn là nguồn cộng đồng. [CommunityDragon zh-CN 16.18](https://raw.communitydragon.org/16.18/plugins/rcp-be-lol-game-data/global/zh_cn/v1/) dùng để đối chiếu ID/tên; pool CHERRY không được dùng thay cho pool Mayhem.

Trước khi kích hoạt AI xuất bản: xác minh catalog Mayhem đúng patch; nhập, validate, activate qua các hàm authority hiện có; thu đủ observations hiện hành và bằng chứng độc lập. Không chuyển observations 16.14 cũ thành 16.18.
