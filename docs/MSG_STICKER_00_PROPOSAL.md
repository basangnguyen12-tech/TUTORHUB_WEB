# MSG-STICKER-00 — Đề xuất kỹ thuật: tab Sticker trong bộ chọn biểu cảm

- Trạng thái: **Đã duyệt (Approved — chuẩn hóa tại [ADR-0047](adr/0047-sticker-packs-and-message-embeds.md))**
- Ngày: 2026-11-28
- Người soạn: Claude Code (worker), thẩm định & chốt kiến trúc bởi Antigravity cùng chủ dự án
- Liên quan: ADR-0042 (chat phòng học, kiểm duyệt đăng tin), ADR-0046 (`message_embeds`),
  checkpoint `ROOM-CHAT-EMOJI-02`, `MSG-COMPOSER-TOOLS-01`

## 1. Bối cảnh và mục tiêu

Hiện trạng (đã đối chiếu mã nguồn):

- Bộ chọn emoji là `apps/web/src/features/media/ClassroomEmojiPicker.tsx`, dùng chung cho
  composer Tin nhắn (`ConversationMessages.tsx`) và chat phòng học (`ClassroomChatPanel.tsx`).
- Emoji là ký tự Unicode từ `emojibase-data@18.0.0` (MIT), hiển thị bằng **font của hệ điều
  hành** — không có file ảnh. "Gần đây" lưu `localStorage` theo khóa
  `tutorhub:chat-emoji-recent:v1:<tenant>:<user>` và bị xóa khi đăng xuất (`session.tsx`).
- Card có cấu trúc (danh thiếp, lớp học tạm thời) đã đi qua bảng insert-only
  `tutorhub.message_embeds` (migration `000059`) với chiếu dữ liệu theo người đọc lúc đọc.

Mục tiêu: thêm tab **Sticker** bên cạnh tab **Emoji** theo bố cục Zalo. Bấm một sticker là gửi
ngay thành một tin nhắn riêng, hiển thị cỡ lớn, không có bong bóng.

Ngoài phạm vi MVP: tìm GIF, sticker do người dùng hoặc tenant tự tải lên, cửa hàng/mua sticker,
dùng sticker làm reaction, Lottie.

## 2. Chọn nguồn sticker (khảo sát ngày 2026-11-28)

| Nguồn                            | Giấy phép / tình trạng                                                                                               | Kết luận                                |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| **Noto Animated Emoji** (Google) | CC BY 4.0; có `.webp`, `.gif`, `lottie.json`, `.svg`; khoảng 400 emoji động                                          | **Chọn** làm bộ mặc định                |
| **Bộ TutorHub** (thuê họa sĩ vẽ) | Sở hữu qua hợp đồng chuyển nhượng bản quyền                                                                          | **Chọn** làm bộ thứ hai; không chặn MVP |
| Sticker Zalo / LINE / Telegram   | Bản quyền thuộc tác giả từng bộ                                                                                      | Loại                                    |
| Tenor API                        | Ngừng nhận key mới từ 13/01/2026, **tắt API từ 30/06/2026**                                                          | Loại                                    |
| GIPHY, KLIPY                     | Còn hoạt động (GIPHY phải xin key production; KLIPY miễn phí, quảng cáo không bắt buộc). Nội dung do người dùng đăng | Hoãn sang task GIF riêng (mục 7)        |
| Fluent Emoji (Microsoft)         | MIT nhưng bản chính thức chỉ có ảnh tĩnh; các bộ "Fluent động" trên GitHub chưa rõ nguồn gốc giấy phép               | Loại cho MVP                            |
| OpenMoji                         | CC BY-SA 4.0 (điều khoản ShareAlike)                                                                                 | Loại                                    |

Lý do không dùng API tìm kiếm bên ngoài làm nguồn chính: người dùng có học sinh nhỏ tuổi nên nội
dung do người dùng đăng khó kiểm soát; trình duyệt gọi thẳng nhà cung cấp sẽ lộ IP và từ khóa;
và Tenor cho thấy rủi ro nhà cung cấp tắt API.

Nghĩa vụ CC BY 4.0: ghi tên tác giả, dẫn link giấy phép và **nêu rõ đã chỉnh sửa** (đổi kích
thước, cắt khung tĩnh). Hiện repo chưa có trang hoặc file thông báo bên thứ ba — cần chốt vị trí
(câu hỏi Q5).

## 3. Thiết kế đề xuất

### 3.1 Danh mục sticker do server sở hữu

- Một manifest có phiên bản, nhúng vào Core API bằng `go:embed` (đã có tiền lệ ở
  `services/core-api/migrations/embed.go`), ví dụ
  `services/core-api/internal/modules/conversation/stickers/catalog.json`.
- Danh mục là **dữ liệu tham chiếu cấp nền tảng**, không phải dữ liệu nghiệp vụ của tenant, nên
  MVP **không** tạo bảng DB. Thay đổi danh mục đi kèm lần deploy.
- Mỗi pack: `id` (ví dụ `noto_animated`, `tutorhub_classroom`), `version`, `title {vi, en}`,
  `attribution {text, license, url}`, danh sách sticker.
- Mỗi sticker: `id` ổn định vĩnh viễn (ví dụ `noto_animated:1f602`), `labels {vi, en}`,
  `keywords {vi, en}`, `width`, `height`, `animated`, và `status`:
  - `active`: hiện trong bộ chọn;
  - `retired`: ẩn khỏi bộ chọn, tin nhắn cũ vẫn hiển thị;
  - `removed`: gỡ vì lý do pháp lý, tin nhắn cũ hiển thị `available: false`.
- Feature control mới `chat_stickers` trong `featurecontrol/catalog.go` để tenant có thể tắt.
  Chưa làm bật/tắt riêng từng pack theo tenant.

### 3.2 Contract (OpenAPI)

- **Đọc danh mục**: `GET /api/v1/conversations/sticker-packs` (đường dẫn để Antigravity chốt).
  Yêu cầu session, feature `conversations` và `chat_stickers`. Trả về `catalog_version` + các pack
  có sticker `active`, kèm `ETag` và `Cache-Control: private, max-age=300`. Khi feature bị tắt,
  trả lỗi có cấu trúc để web ẩn tab.
- **Gửi**: mở rộng `MessageEmbedInput` thêm
  `StickerEmbedInput { kind: "sticker", sticker_id }`, với `sticker_id` theo mẫu
  `^[a-z0-9_]{1,32}:[a-z0-9_-]{1,64}$`.
- **Đọc tin nhắn**: mở rộng `MessageEmbed` thêm
  `StickerEmbed { kind: "sticker", available, sticker_id?, pack_id?, labels? {vi, en}, asset? { animated_url, static_url, width, height } }`.
  Đường dẫn asset do **server chiếu từ manifest**; web không bao giờ tự ghép URL từ nội dung tin
  nhắn.
- Sau khi sửa `openapi/tutorhub.yaml`: chạy `pnpm api:generate` và `pnpm api:check`.

### 3.3 Cơ sở dữ liệu — migration `000060_message_embed_stickers`

- `ALTER TABLE tutorhub.message_embeds ADD COLUMN sticker_id text;`
- Thay ràng buộc `message_embeds_kind_valid`: thêm nhánh
  `kind = 'sticker' AND sticker_id IS NOT NULL AND target_user_id IS NULL AND media_space_id IS NULL`,
  và thêm `sticker_id IS NULL` vào hai nhánh cũ. Thêm `CHECK` cho mẫu và độ dài của `sticker_id`.
- Không có FK vì danh mục không nằm trong DB; server kiểm tra với manifest lúc gửi.
- Quyền của runtime giữ nguyên `SELECT, INSERT` (bảng vẫn insert-only).
- Migration down: đề xuất **dừng với lỗi** nếu còn dòng `kind = 'sticker'`. Nếu xóa các dòng đó,
  tin nhắn sticker sẽ thành tin rỗng.

### 3.4 Quy tắc lúc gửi (trong transaction `SendMessage`)

- `prepareMessageEmbed` xử lý `kind = sticker`: kiểm tra feature `chat_stickers`; `sticker_id`
  phải có trong manifest và đang `active` (sai thì `409 message_embed_unavailable`).
- Kế thừa nguyên quy tắc của ADR-0046: `content` rỗng, không có `attachment_ids`, không sửa được
  (`409 message_not_editable`), thu hồi thành tombstone như cũ.
- Fingerprint idempotency tách miền theo mẫu ADR-0046: `\x00embed:sticker\x00` + độ dài + byte
  của `sticker_id`. Gửi lại cùng `client_message_id` thì replay `200`; đổi sticker thì `409`.
- Quyền ghi đi qua `authorizeMessageWrite` hiện có, nên lớp đã lưu trữ và phòng đang tạm khóa chat
  (ADR-0042) tự động chặn sticker.
- Giới hạn tốc độ: dùng chung quota `actor_message_sends_per_minute`. Có cần quota riêng cho
  sticker trong phòng học trực tiếp hay không thì đo sau khi chạy thử.

### 3.5 Chiếu dữ liệu lúc đọc

`loadMessageEmbeds` tra manifest. Sticker `active` hoặc `retired` thì trả `available: true` kèm
đầy đủ trường; `removed` hoặc không tìm thấy thì trả `available: false` và bỏ các trường còn lại.

### 3.6 File ảnh và phân phối

- Đặt ở `apps/web/public/stickers/<pack_id>/<pack_version>/<sticker>.webp` (WebP động, khoảng
  320 px) và `<sticker>.static.webp` (khung tĩnh dùng khi giảm chuyển động).
- Web chạy trên Cloudflare Pages **cùng origin**, nên CSP `img-src 'self'` hiện có là đủ. Không
  cần B2, không ký URL, trình duyệt không gọi bên thứ ba.
- Bổ sung `_headers`: `/stickers/*` → `Cache-Control: public, max-age=31536000, immutable` +
  `X-Content-Type-Options: nosniff`. Đường dẫn có phiên bản nên đặt `immutable` là an toàn.
- Script sinh `apps/web/scripts/generate-sticker-catalog.mjs` (cùng mô hình với
  `generate-emoji-catalog.mjs`):
  - đầu vào là bản Noto đã ghim phiên bản và checksum;
  - đầu ra là ảnh đã đổi kích thước, khung tĩnh và `catalog.json` ghi thẳng vào thư mục
    `go:embed`, để giữ **một nguồn sự thật duy nhất**.
- Tuyển khoảng 120–200 sticker trong bộ Noto, ưu tiên mặt cười, cử chỉ, chúc mừng và học tập,
  thay vì đưa cả bộ vào.
- Ngân sách cần đo ở Phase 0: mỗi sticker động ≤ ~150 KB, cả pack ≤ ~30 MB. Đối chiếu giới hạn số
  file và dung lượng mỗi file của Cloudflare Pages.

### 3.7 Giao diện web

- Thêm component `ChatExpressionPicker` có tablist `Sticker | Emoji` (bàn phím: roving tabindex,
  `role="tablist"`). Tab Emoji **tái dùng nguyên** `ClassroomEmojiPicker`. Tab mặc định là tab
  dùng gần nhất.
- Tab Sticker gồm:
  - ô tìm kiếm theo `labels` và `keywords` vi/en, không phân biệt dấu (tái dùng cách chuẩn hóa của
    emoji);
  - hàng "Gần đây";
  - các mục theo pack, lưới 4 cột;
  - thanh chọn pack ở đáy như Zalo;
  - dòng ghi nguồn CC BY ở cuối pack Noto.
- Bấm sticker là gửi ngay: tin hiện ở trạng thái chờ, lỗi thì có nút thử lại (tái dùng luồng
  `sendCard`). Bản nháp đang gõ được giữ nguyên.
- "Gần đây" lưu ở `tutorhub:chat-sticker-recent:v1:<tenant>:<user>` (chỉ ID, không có PII), tối đa
  24 mục, và xóa khi đăng xuất cùng chỗ với emoji.
- Hiển thị trong luồng tin nhắn:
  - không có bong bóng, cỡ 120–160 px;
  - `<img loading="lazy" decoding="async" width height alt={label}>`;
  - `<picture>` có source `(prefers-reduced-motion: reduce)` trỏ tới khung tĩnh.
- Cần đo CPU khi luồng có khoảng 50 sticker động.
- Bổ sung `cardPreviewText` và `embedSearchText` cho sticker. Thêm khóa i18n:
  `conversations.stickerPreview` ("[Sticker] {label}"), `conversations.stickerUnavailable`, nhãn
  tab và aria-label (vi/en).
- Trạng thái bắt buộc:
  - loading: lưới skeleton;
  - empty: tìm không có kết quả;
  - error + retry: tải danh mục lỗi;
  - forbidden: feature tắt thì ẩn tab;
  - read-only: lớp đã lưu trữ hoặc phòng tạm khóa chat thì vô hiệu tab kèm lý do.
- Accessibility:
  - nút sticker có `aria-label` = nhãn theo ngôn ngữ;
  - lưới di chuyển bằng phím mũi tên;
  - sau khi gửi, focus quay về composer;
  - `Escape` hai tầng giữ đúng hành vi của `ROOM-CHAT-EMOJI-02`.

### 3.8 Bảo mật và quyền riêng tư

- Không có request nào từ trình duyệt ra bên thứ ba; trong tin nhắn không có URL tùy ý.
- Cô lập tenant: dòng `message_embeds` có khóa `tenant_id`; feature control theo tenant; đọc và ghi
  qua các hàm `authorize*` hiện có.
- Gỡ một sticker: đổi `status` sang `removed` trong manifest, deploy, rồi xóa file ở lần phát hành
  sau.

## 4. Phương án bị loại

| Phương án                                             | Lý do loại                                                          |
| ----------------------------------------------------- | ------------------------------------------------------------------- |
| Gửi sticker như ảnh đính kèm                          | Mất định danh danh mục; tốn lưu trữ B2 cho mỗi lần gửi              |
| Mã sticker nằm trong `content` (ví dụ `:sticker:id:`) | Trái ADR-0046 (giả mạo được, client phải tự phân tích)              |
| Bảng danh mục trong DB ngay từ đầu                    | Chưa cần khi chưa có pack riêng của tenant                          |
| Lottie                                                | Phải thêm runtime JS hoặc WASM và nới CSP; WebP chỉ cần thẻ `<img>` |
| Phục vụ file từ B2                                    | File công khai, không cần ký URL; thêm chi phí egress               |

## 5. Bộ sticker TutorHub (giai đoạn 2)

- 16–24 sticker cho một nhân vật đại diện. Câu gợi ý: "Giỏi lắm!", "Cố lên!", "Em hiểu rồi",
  "Thầy/cô ơi, em hỏi", "Đã nộp bài", "Chờ chút nhé", "Cảm ơn ạ", "Hẹn buổi sau".
- Hợp đồng cần có: chuyển nhượng bản quyền hoặc giấy phép độc quyền, bao gồm quyền chỉnh sửa;
  bàn giao file gốc (AI/PSD) và bản xuất động 512 px.
- Chữ trên sticker gắn với một ngôn ngữ. Cần chọn giữa bản không chữ, hoặc hai biến thể vi/en
  (câu hỏi Q3).

## 6. Đề xuất chia lát cắt

| Mã                     | Nội dung                                                                                                                                                                                           | Phụ thuộc                                      |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| ADR-0047               | Antigravity chốt mục 3.1–3.5                                                                                                                                                                       | —                                              |
| MSG-STICKER-01 (API)   | Migration `000060`, manifest + `go:embed`, feature control, `GET sticker-packs`, embed `sticker`, OpenAPI. Test Go: tenant, idempotency, retired/removed/unknown, feature tắt, phòng tạm khóa chat | ADR-0047                                       |
| MSG-STICKER-02 (asset) | Script sinh, tuyển bộ Noto, `_headers`, ghi nguồn CC BY                                                                                                                                            | Chốt định dạng manifest; chạy song song với 01 |
| MSG-STICKER-03 (web)   | `ChatExpressionPicker`, tab Sticker, hiển thị trong luồng, preview/tìm kiếm, "Gần đây", i18n, test Vitest/Playwright, a11y                                                                         | Contract của 01, file của 02                   |
| MSG-STICKER-04         | Thêm pack TutorHub                                                                                                                                                                                 | Họa sĩ bàn giao                                |

## 7. Tab GIF (giai đoạn 3, task riêng)

Nếu cần: dùng KLIPY hoặc GIPHY qua proxy BFF/Core API, lọc nội dung mức `g`, tắt quảng cáo. Cần
ADR riêng cho nhà cung cấp bên ngoài, rà soát xử lý dữ liệu và cơ chế cache/ghim nội dung đã gửi.

## 8. Quyết định đã chốt (2026-11-28 — khóa trong ADR-0047)

1. **Q1 (Phạm vi hiển thị)**: **Bật ở cả hai nơi ngay từ MVP** — Tab Tin nhắn (`/app/messages`: `direct` và `class`) và Chat trong Phòng học trực tuyến (`room` — `ClassroomChatPanel`). Cả hai đều đi qua `authorizeMessageWrite` (tự động chặn khi lớp đã `archived` hoặc giáo viên tạm khóa chat phòng học theo `ADR-0042`).
2. **Q2 (Cờ tính năng `chat_stickers`)**: **Mặc định BẬT (`default_enabled: true`)** cho mọi workspace; quản trị viên tổ chức vẫn có thể tắt qua Feature Controls khi cần.
3. **Q3 (Nguồn bộ sticker)**: **Chỉ sử dụng bộ Noto Animated Emoji (Google, `CC BY 4.0`)**, chưa triển khai bộ Mascot TutorHub riêng (bỏ `MSG-STICKER-04` khỏi lộ trình hiện tại). Tuyển chọn `80–120` sticker tiêu biểu nhất (biểu cảm khuôn mặt, cử chỉ khích lệ, chúc mừng, học tập); ngân sách tối đa `<= 100 KB`/file `.webp` động, `<= 15 KB`/file `.static.webp` tĩnh và **tổng dung lượng toàn bộ `apps/web/public/stickers/` `<= 10 MB`**.
4. **Q4 (Tab GIF)**: **Không làm Tab GIF trong đợt này** — tập trung hoàn thiện `Sticker | Emoji` an toàn, không gọi bên thứ ba.
5. **Q5 (Đường dẫn API, ghi nguồn `CC BY 4.0` & bảo vệ CPU)**:
   - Đường dẫn danh mục: `GET /api/v1/conversations/sticker-packs` (`Cache-Control: private, max-age=300`, `ETag`).
   - Ghi nguồn `CC BY 4.0`: tạo `THIRD_PARTY_NOTICES.md` ở gốc repository + `apps/web/public/THIRD_PARTY_NOTICES.txt` (phục vụ tĩnh tại `/THIRD_PARTY_NOTICES.txt`), nêu rõ tác giả Google Noto Emoji Animation, link giấy phép `CC BY 4.0` và các bước chỉnh sửa (tuyển chọn, thu nhỏ WebP động + trích khung tĩnh `.static.webp`), đồng thời hiển thị dòng ghi nguồn kèm liên kết `/THIRD_PARTY_NOTICES.txt` ở chân tab Sticker.
   - Bảo vệ CPU: trong lưới bộ chọn `ChatExpressionPicker`, các ô sticker hiển thị khung tĩnh `static_url` mặc định và chỉ phát ảnh động `animated_url` khi hover/focus (khi không bật `prefers-reduced-motion: reduce`); trong luồng tin nhắn dùng `<picture>` tự chuyển sang `static_url` khi `prefers-reduced-motion: reduce` kết hợp `IntersectionObserver` để dừng phát ảnh động cho các sticker nằm ngoài vùng nhìn.

## 9. Nguồn

- Noto Animated Emoji: <https://googlefonts.github.io/noto-emoji-animation/> — giấy phép tại
  <https://googlefonts.github.io/noto-emoji-files/>
- Tenor API sunset FAQ: <https://support.google.com/tenor/answer/10455265>
- GIPHY API: <https://developers.giphy.com/docs/api/>
- KLIPY API: <https://klipy.com/developers>
