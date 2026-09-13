# Nguồn meta Trung Quốc cho Hải Đấu

Catalog: `app/chinese-meta-source-catalog.json`. Bộ thu thập đọc catalog trong mỗi lượt chạy; không cần API key mới. Catalog này quản lý nguồn khám phá, không cấp quyền hợp lệ cho tướng/lõi/trang bị trong catalog luật backend.

## Ưu tiên nguồn

| Thứ tự | Nguồn | Vai trò |
| --- | --- | --- |
| 1 | [Bilibili 整活大赏](https://www.bilibili.com/v/topic/detail?topic_id=1326709) | Video gốc về combo và lối chơi độc lạ |
| 2 | [Douyin](https://www.douyin.com/) | Tìm clip thực chiến công khai |
| 3 | [Tieba](https://tieba.baidu.com/) | Bài thử nghiệm và phản biện cơ chế |
| 4 | [ARAM Hextech Wiki](https://apexlol.info/zh) | Tìm tương tác tướng–lõi và đối chiếu thuật ngữ |
| 5 | [海斗小助手](https://lolhaidou.cn/) | Build và liên kết nguồn của hệ thống hiện có |
| 6 | [Zhihu](https://www.zhihu.com/) | Phân tích dài, ví dụ thực chiến |
| 7 | Ali213, 3DM, 17173 | Nguồn hướng dẫn bổ sung từ registry cũ |
| 8 | [Tencent 101](https://101.qq.com/) và [LoL QQ](https://lol.qq.com/) | Dữ liệu nền và thông báo phiên bản |
| 9 | [Riot patch notes](https://www.leagueoflegends.com/en-us/news/tags/patch-notes/) | Tham chiếu chính thức |
| 10 | [CommunityDragon zh-CN 16.18](https://raw.communitydragon.org/16.18/plugins/rcp-be-lol-game-data/global/zh_cn/v1/) | ID/tên client có phiên bản |

Nguồn bổ sung được khảo sát ngày 2026-09-12. Trang gốc và video cũ trong catalog là đầu mối tìm kiếm, không phải bằng chứng đang mạnh ở patch hiện hành. Các truy vấn mới nhắm `黑科技` (cách chơi khác thường), `冷门` (ít người dùng), `整活` (sáng tạo), `联动` (tương tác), `实测` (thử thực tế). Độ lạ chỉ thay đổi thứ tự khám phá, không tăng điểm tin cậy hay tự cấp quyền xuất bản.

## Luồng chạy

1. Kiểm tra schema catalog, HTTPS và ranh giới hostname.
2. Đọc bản phát hành đầu tiên từ [Data Dragon versions](https://ddragon.leagueoflegends.com/api/versions.json). Không dùng phiên bản trong bộ guide cũ làm phiên bản live. Nếu không đọc được, lượt thu thập dừng trước khi ghi inbox.
3. Chạy truy vấn nguồn người chơi trước, sau đó bổ sung truy vấn registry cũ; khử trùng truy vấn.
4. Thu metadata/bằng chứng công khai theo giới hạn hiện có. Giữ khóa đăng nhập/CAPTCHA và không lưu toàn văn hay phụ đề thô.
5. Chỉ đánh dấu hiện hành khi có ngày hợp lệ trong 21 ngày và một patch rõ ràng khớp bản live. `26.18` là nhãn Riot tương ứng với khóa game data `16.18`; alias được so sánh, nhãn gốc vẫn lưu trong provenance. Đây là quy tắc cho mùa 2026; mùa khác dừng để cập nhật adapter.
6. Nội dung chứa Arena/CHERRY/斗魂竞技场 bị giữ lại, kể cả bài trộn nhiều mode. Bài thiếu patch hoặc có nhiều patch được giữ ở hàng chờ kiểm tra.
7. Mỗi lượt kiểm tra lại cả ứng viên đã lưu để cờ hiện hành không tồn tại qua thay đổi patch hoặc quá hạn. Xác nhận mode từ mô tả/phụ đề được giữ khi tiêu đề không nêu mode, nhưng bằng chứng Arena/CHERRY rõ ràng luôn hủy xác nhận cũ (`MODE_EXCLUDED`).
8. Bridge backend độc lập kiểm tra patch gốc và URL HTTPS trong danh sách host cộng đồng trước khi tạo observation. Không gán patch báo cáo cho bài cũ/không rõ patch. Nếu bổ sung host mới vào catalog, phải cập nhật allowlist backend trong `community-inbox-bridge.ts`; host tham chiếu chính thức/client không thuộc đường nhập bài người chơi.

`community-watch-report.json` có hash catalog, số nguồn, số URL bị loại, số ứng viên có dấu hiệu lối chơi lạ và số ứng viên bị giữ; `scanErrors` ghi truy vấn không truy cập được. Các nguồn chính thức/client chỉ phục vụ tham chiếu, không trở thành bài của người chơi. Khử trùng bản đăng lại dùng heuristic tác giả/tiêu đề hiện có, không chứng minh được mọi bản sao là cùng một nguồn.

## Lệnh

```bash
npm run validate:community
npm run collect:community
npm run test:moderation
```

Phát lại có kiểm soát, không truy cập mạng hoặc ghi đè dữ liệu dự án:

```bash
node scripts/collect-community-candidates.mjs \
  --offline --input /tmp/player-posts.json \
  --current-patch 16.18 --output-dir /tmp/hai-dau-replay
```

`--current-patch` chỉ chấp nhận trong chế độ offline, bắt buộc có `--output-dir`. Đường dẫn đầu ra và các tệp inbox/báo cáo không được là hoặc đi qua liên kết tượng trưng, tránh ghi đè dữ liệu live qua đường dẫn khác. Inbox và báo cáo đều ghi `collectionMode: "offline"`; bridge backend và moderator từ chối nhập/xuất bản chúng. Chế độ live từ chối đọc lại inbox offline. Importer chỉ nhận báo cáo `collectionMode: "live"`. Sau nâng cấp, chạy collector live để tạo báo cáo mới trước khi import; báo cáo cũ thiếu nhãn này sẽ bị từ chối.

Luồng `sync:data` cũng dùng patch từ báo cáo collector và luôn tôn trọng cờ giữ lại trước khi áp dụng thời gian ân hạn khi nguồn lỗi. Từng bài trong nhóm phải tự đạt điều kiện bằng chứng mới được tính vào số nguồn độc lập hoặc danh sách nguồn hỗ trợ. Adapter backend mới mang phiên bản `community-collector-bridge-v2`; dữ liệu cũ vẫn giữ provenance phiên bản gốc.

## Điều kiện để AI tự xuất bản

Nguồn khám phá không thay thế catalog luật. Cần catalog ARAM Mayhem có patch, nguồn, pool entity và luật đã được xác minh, nhập, validate, activate qua authority hiện có; sau đó cần observations hiện hành và bằng chứng đủ điều kiện review. Không nhập toàn bộ `cherry-augments.json` hoặc pool `CHERRY` làm pool Mayhem. Không đổi nhãn observations 16.14 thành 16.18. Chỉ bật AI khi các điều kiện dữ liệu này đạt.
