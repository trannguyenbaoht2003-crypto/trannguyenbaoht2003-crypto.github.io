# Vận hành catalog Hải Đấu

CLI riêng `catalog:operations` đưa dữ liệu đã xác minh qua các authority hiện có.
Nó không phải bộ tải dữ liệu nguồn hoặc bộ xác nhận luật game. Không có HTTP
endpoint mới, không gọi AI và không tạo Candidate hay Publication.

## Chuẩn bị dữ liệu thật

Trước khi nhập cần có:

- `CatalogSnapshotV1` của đúng patch và mode `aram_mayhem`, với ID tướng, lõi,
  trang bị, pool hợp lệ, giới hạn chọn và các điều kiện riêng theo tướng.
- Hồ sơ nguồn ghi URL công khai, thời điểm lấy, bản vá gốc và checksum dữ liệu
  nguồn. `source.sourceDigest` phải là SHA-256 chữ thường của dữ liệu nguồn
  đã được đối chiếu; không dùng hash tự đặt để tạo cảm giác đã xác minh.
- `sourceId` và `sourcePolicyRevisionId` thật đang được Source Policy Registry
  cho phép thu thập/lưu tham chiếu. CLI không tự cấp quyền cho một nguồn mới.
- Mã bản vá chuẩn khớp collector. Ví dụ dữ liệu client `16.18` có thể có nhãn
  hiển thị Riot `26.18`; hai giá trị này giữ vai trò riêng. Không đổi nhãn dữ
  liệu thu thập cũ sang bản vá mới.

Danh mục nguồn khám phá ở `app/chinese-meta-source-catalog.json` không phải
`CatalogSnapshotV1`. Không nhập nguyên pool Arena/CHERRY hoặc fixture trong
`backend/test` vào production. Một bộ dữ liệu thiếu hoặc chưa rõ điều kiện
chọn lõi phải tiếp tục ở bước đối chiếu nguồn.

## Chạy lệnh

Chạy tại gốc repository đã checkout đúng phiên bản:

```sh
npm --prefix backend run build
npm --prefix backend run --silent catalog:operations < /private/catalog-command.json
```

CLI chỉ đọc một JSON object qua stdin, tối đa 8 MiB. Không nhận tham số trên
command line; trường không biết, UUID không hợp lệ, timestamp không chuẩn,
schema hoặc kiểu dữ liệu sai đều bị từ chối. UUID lệnh là v4 hoặc v5.
`occurredAt` dùng UTC ISO đầy đủ, gồm mili giây, ví dụ
`2026-09-09T18:00:00.000Z`.

Chỉ các hành động ghi mới cần `DATABASE_URL` của môi trường private. Không
đưa credential vào JSON, command line, Git hoặc frontend. Không cần Redis,
OpenAI key hay AI worker để chạy CLI. Quyền thực thi đến từ quyền truy cập
database private; `actorId` là dấu vết audit, không phải cơ chế đăng nhập.

## Các hành động

| `action` | Trường bắt buộc ngoài `action` | Kết quả |
| --- | --- | --- |
| `inspect` | `snapshot` | Kiểm tra hình dạng, chuẩn hóa thứ tự và trả hash/số entity/số rule; không kết nối database |
| `register-patch` | `actorId`, `correlationId`, `patchId`, `patchKey`, `displayLabel`, `eventId`, `lifecycleState`, `occurredAt`, `reason` | Gọi `registerPatchEvent`, lưu lifecycle/audit/outbox |
| `import` | `actorId`, `correlationId`, `catalogRevisionId`, `patchId`, `revision`, `sourceId`, `sourcePolicyRevisionId`, `idempotencyKey`, `snapshot` | Gọi `importCatalogRevision`, lưu và niêm phong revision |
| `validate` | `actorId`, `correlationId`, `catalogRevisionId`, `catalogValidationResultId`, `validatorRulesetVersion`, `reason` | Gọi `validateCatalogRevision`, ghi kết quả kiểm định bất biến |
| `activate` | `actorId`, `correlationId`, `catalogRevisionId`, `patchId`, `expectedCurrentCatalogRevisionId`, `reason` | Gọi `activateCatalogRevision` với đúng con trỏ hiện tại |

`lifecycleState` thuộc `announced`, `active`, `superseded`, `withdrawn`.
Chỉ patch `active` mới nhập/kích hoạt được catalog. Khi dùng lại một `patchId`,
cả `patchKey` và `displayLabel` phải khớp định danh đã đăng ký.
`validatorRulesetVersion` phải là `catalog-rules-v1`.

Để kiểm tra một snapshot riêng trước khi tạo command nhập:

```sh
node --input-type=module -e '
  import { readFileSync } from "node:fs";
  const snapshot = JSON.parse(readFileSync(process.argv[1], "utf8"));
  process.stdout.write(JSON.stringify({ action: "inspect", snapshot }));
' /private/verified-catalog.json |
  npm --prefix backend run --silent catalog:operations
```

`inspect` luôn trả `sourceVerified: false` và `databaseValidated: false`.
Thành công ở bước này chỉ xác nhận cấu trúc và hash, không chứng minh dữ liệu
đúng với game, nguồn được cấp quyền hoặc catalog đã hoạt động.

## Trình tự lần nhập đầu tiên

1. Hoàn tất đối chiếu nguồn; giữ snapshot và hồ sơ checksum cùng nhau.
2. Đọc Source Policy Registry, xác nhận chính xác source/policy được phép.
3. `inspect` snapshot và ghi lại `contentHash`.
4. `register-patch` bản vá đúng với dữ liệu nguồn. Nếu đã có patch đúng định
   danh và đang active thì dùng lại `patchId`, không phát sinh sự kiện thừa.
5. `import` với revision, UUID và idempotency key cố định cho lần nhập này.
6. `validate` và yêu cầu `result: "passed"`. Đối chiếu `contentHash` trả về
   với hash ở bước inspect/import.
7. Đọc con trỏ catalog hiện tại; `activate` với đúng
   `expectedCurrentCatalogRevisionId` vừa đọc. Chỉ dùng `null` khi thật sự
   chưa có catalog cho patch/mode đó.
8. Kiểm tra trạng thái bằng `npm --prefix backend run ai-autonomous:status`.
   Có active catalog chưa chứng minh đã có candidate hoặc bài AI xuất bản.

Có thể đọc con trỏ bằng truy vấn private, chỉ đọc:

```sql
select p.patch_id, p.patch_key, p.display_label,
       a.catalog_revision_id, a.game_mode_external_id
  from patches p
  left join active_catalog_revisions a using (patch_id)
 order by p.patch_key;

select s.source_id, s.source_key, s.status,
       a.source_policy_revision_id, r.storage_permission, r.collector_enabled
  from sources s
  join active_source_policies a using (source_id)
  join source_policy_revisions r using (source_policy_revision_id)
 order by s.source_key;
```

Không chạy bước kế tiếp khi lệnh trước lỗi. Các bước dùng transaction riêng;
một revision đã nhập nhưng chưa validate/activate vẫn được giữ để kiểm tra,
không tự động trở thành catalog đang hoạt động.

## Kết quả và xử lý lỗi

Thành công trả JSON trên stdout và exit code 0. `validate` có `result: "failed"`
trả JSON kèm `reasonCodes` nhưng exit code **1**, vì vậy chuỗi shell `&&`
sẽ dừng trước bước activate. Lỗi input/config/domain trả một mã lỗi an toàn
trên stderr; không in SQL, stack trace, snapshot hoặc connection string.

| Mã/kết quả | Xử lý |
| --- | --- |
| `CATALOG_OPERATIONS_INPUT_INVALID` | Sửa schema, UUID, timestamp hoặc giới hạn input |
| `CATALOG_OPERATIONS_CONFIG_INVALID` | Cấu hình database tại môi trường private |
| `PATCH_IDENTITY_CONFLICT` | Đọc lại định danh patch; không dùng lại UUID cho patch/nhãn khác |
| `CATALOG_PATCH_KEY_MISMATCH` | Đối chiếu patch snapshot và patch registry; không sửa nhãn bài cũ |
| `CATALOG_SOURCE_POLICY_NOT_ACTIVE` | Kiểm tra đúng source và policy hiện hành |
| `IDEMPOTENCY_PAYLOAD_CONFLICT` | Cùng key đã có payload khác; đối chiếu receipt trước khi tạo revision mới |
| `CATALOG_VALIDATION_REQUIRED` | Chưa có kết quả passed cho đúng hash được niêm phong |
| `CATALOG_ACTIVE_POINTER_CONFLICT` | Con trỏ đã đổi; đọc lại và đánh giá thay đổi trước khi gửi lệnh mới |
| `CATALOG_OPERATIONS_FAILED` | Kiểm tra hệ thống private; không tự coi thao tác là đã thất bại hoàn toàn hoặc phát lại mù |

Chỉ `import` có receipt idempotency: cùng key và payload được phát lại với
`replayed: true`. Patch events và validation results dùng ID mới cho mỗi sự
kiện thật; không tự lặp lại khi chưa rõ kết quả. Nếu activate đã thành công,
gửi lại con trỏ cũ sẽ bị từ chối. Không sửa/xóa lịch sử để ép một lệnh qua.

CLI không bật AI, không phát lại các normalization thất bại và không thay
chính sách bằng chứng. Sau khi có catalog thật, cần kiểm tra observations
đúng patch, normalize/materialize qua luồng hiện có và đủ nguồn độc lập trước
khi đánh giá bước bật AI. Xem [autonomous-ai-publication.md](autonomous-ai-publication.md).
