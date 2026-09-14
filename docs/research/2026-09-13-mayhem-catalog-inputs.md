# Đối chiếu đầu vào catalog Mayhem — 2026-09-13

## Kết quả

Đã xác nhận được phiên bản dữ liệu và một số thay đổi Mayhem, nhưng các nguồn
đã kiểm tra chưa cung cấp đủ tập ID và điều kiện chọn để kích hoạt catalog
backend. Không có `CatalogSnapshotV1` production nào được tạo từ khảo sát này.

| Nguồn | Đã xác nhận | Phần còn thiếu |
| --- | --- | --- |
| [Data Dragon versions](https://ddragon.leagueoflegends.com/api/versions.json) | Phần tử đầu là `16.18.1`; SHA-256 của response đã đọc: `8dd47f7970cc808d67afe854e7be9bb966bd7cf5141cb27354bf7b8e49d2a377` | Feed phiên bản không xác nhận pool lõi hay luật Mayhem |
| [Riot patch 26.18](https://www.leagueoflegends.com/en-us/news/game-updates/league-of-legends-patch-26-18-notes/) | Bài ngày 2026-09-09 có mục ARAM: Mayhem; Clown College được bật lại; có điều chỉnh cách phân phối lõi theo tướng và sửa tương tác Hydra | Patch notes mô tả thay đổi, không đưa toàn bộ danh sách tướng–lõi hợp lệ |
| [海斗小助手 changelog](https://lolhaidou.cn/changelog.html) | Changelog ngày 2026-09-10 ghi đồng bộ 26.18 | Không thay thế snapshot ID và luật backend |
| [海斗小助手](https://lolhaidou.cn/) | HTML công khai đọc được; có 222 liên kết lõi khác nhau | Một số dữ liệu chi tiết nằm trong miniapp; không suy ra quyền chọn lõi chỉ từ bảng đề xuất |
| [虚幻武器](https://lolhaidou.cn/augment/etherealweapon.html) | Metadata Mayhem và `dateModified=2026-09-11`, mô tả công khai | Không đủ để kết luận danh sách tướng được phép chọn ở patch hiện hành; không vượt phần yêu cầu mở miniapp |
| [ARAM Hextech Wiki](https://apexlol.info/zh/hextech) | Trang được công cụ web đọc có 223 mục và nhãn vô hiệu hóa ở một số lõi | Truy cập HTTP trực tiếp trả 403; chưa xác minh toàn bộ ID/patch/ràng buộc |
| [CommunityDragon zh-CN 16.18](https://raw.communitydragon.org/16.18/plugins/rcp-be-lol-game-data/global/zh_cn/v1/) | Đầu mối dữ liệu client có phiên bản | Truy cập trực tiếp trả 403; không nhập pool CHERRY nguyên khối thành Mayhem |
| [lol-mode-mcp](https://github.com/NewJeans0722/lol-mode-mcp/blob/main/src/lol_mode_mcp/mayhem_augments.py) | Mã nguồn công khai tách mô tả Mayhem từ LoL Wiki và đối chiếu tên client | Dùng đường dẫn `latest`; không phải bundle catalog 16.18 có luật chọn đã được kiểm chứng |

Chênh lệch số mục giữa các trang không đủ để kết luận trang nào đúng hoặc sai.
Tên lõi, gợi ý build và bản ghi thay đổi cũng không tự chứng minh tính tương
thích của một tổ hợp tướng–lõi–trang bị.

## Điều kiện tiếp tục

1. Thu dữ liệu công khai có phiên bản và giữ URL/thời điểm/checksum nguồn.
2. Đối chiếu ID canonical với mode Mayhem, phân biệt lõi chung và lõi có điều
   kiện, ghi nhận phần chưa biết thay vì mặc định hợp lệ.
3. Hoàn tất rules allow/deny/limit của phạm vi catalog dự kiến; chưa rõ luật thì
   chưa kích hoạt phạm vi đó.
4. Dùng [catalog operations](../runbooks/catalog-operations.md) để kiểm tra,
   nhập, validate và activate đúng revision đã đối chiếu.
5. Chuẩn hóa observations đúng patch và kiểm tra bằng chứng hiện hành từ các
   nhóm nguồn độc lập trước khi bật AI review/publication.

Các kết quả này là hồ sơ khảo sát nguồn, không phải bằng chứng bài của người
chơi, không được nhập qua community bridge và không làm tăng điểm tin cậy.
