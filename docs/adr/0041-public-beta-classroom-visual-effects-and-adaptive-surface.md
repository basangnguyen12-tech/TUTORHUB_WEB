# ADR-0041: Nền & Hiệu ứng Hình ảnh Phòng học Public Beta (Một Lõi Xử lý, Hai Bề mặt Thích ứng)

- Status: Accepted
- Date: 2026-11-23
- Related: [ADR-0031](0031-classroom-media-ux-devices-layout-effects-and-signals.md) §10–13 (cập nhật phạm vi §10 cho Public Beta)

## Context

Trong Phase 4 MVP ([ADR-0031](0031-classroom-media-ux-devices-layout-effects-and-signals.md) §10), hiệu ứng hình ảnh được khóa ở `None` cho đến khi hoàn thiện trải nghiệm phòng học và rà soát bundle/tài nguyên cùng origin. Ở giai đoạn Public Beta (sau `PREJOIN-CLONE-04`), chủ dự án chốt yêu cầu sản phẩm cho giáo viên và học sinh:

1. **Một lõi xử lý duy nhất xuyên suốt từ Pre-Join vào Phòng học trực tuyến**: bao gồm Làm mờ nhẹ (`light_blur`), Làm mờ mạnh (`strong_blur`), bộ 6–8 phông nền giáo dục tuyển chọn, tải ảnh nền cá nhân lưu cục bộ riêng tư trên thiết bị, và chỉnh ánh sáng khuôn mặt / tông màu nhẹ cho môi trường phòng học thiếu sáng (không làm bộ lọc biến dạng khuôn mặt, makeup, sticker hay avatar 3D).
2. **Hai bề mặt giao diện thích ứng theo ngữ cảnh**:
   - **Trên màn Pre-Join (`PREJOIN-CLONE-04`)**: mở từ nút tròn thứ 3 trong khung video `#202124` thành **Hộp thoại Studio Modal 2 cột kiểu Google Meet** (trái là khung xem trước `16:9` lớn, phải là bảng chọn chia 2 tab `Phông nền` | `Ánh sáng`), giữ mặt tiền Pre-Join tối giản không bị đẩy lệch hay che nút `Tham gia`.
   - **Bên trong Phòng học trực tuyến (`ClassroomMediaShell`)**: mở từ thanh công cụ đáy / huy hiệu hiệu ứng thành **Ngăn trượt mép phải (`Drawer` ~`340px–380px`) kiểu Microsoft Teams**, giúp giáo viên và học sinh đổi nền hoặc tăng sáng mà không che khuất Sân khấu Bảng trắng Excalidraw hay lưới camera của lớp.

## Decision

1. **Một đường ống xử lý video duy nhất (`@livekit/track-processors@0.8.3`, Apache-2.0)**:
   - Tách riêng chunk động `media-effects` trong `apps/web/vite.config.ts` (`priority: 110` cho `@livekit/track-processors` và `@mediapipe/tasks-vision`) và chỉ `import()` động khi người dùng thực sự chọn hiệu ứng khác mặc định trên camera đang bật. Giữ nguyên cô lập bundle của `scripts/check-client-bundle-security.mjs` (`MediaSpacePages-*.js` không import tĩnh `livekit-*.js`) và ngân sách `entryRawBytes <= 768 KiB`.
   - Tự phục vụ 100% tài nguyên MediaPipe cùng origin tại `/vendor/mediapipe/wasm` (`@mediapipe/tasks-vision@0.10.14`) và `/vendor/mediapipe/models/selfie_segmenter.tflite` (v1, `249,537` bytes, `SHA-256: 191ac9529ae506ee0beefa6b2c945a172dab9d07d1e802a290a4e4038226658b`), kèm tệp `NOTICE` + manifest `SHA256SUMS.txt`. Cấm hoàn toàn runtime fallback sang `cdn.jsdelivr.net` hoặc `storage.googleapis.com`.
   - Khi chỉ bật **Chỉnh ánh sáng / Tông màu** mà không bật Làm mờ hay Phông nền (`background.kind === "none"` và `lighting` khác mặc định), sử dụng đường ống `VideoTransformer` nhẹ qua `OffscreenCanvas` / Canvas 2D filter để không khởi chạy bộ phân tách AI MediaPipe trên máy cấu hình thấp, đồng thời vẫn xuất ra `processedTrack` để toàn bộ người tham gia trong phòng LiveKit nhìn thấy khung hình đã tăng sáng. Khi kết hợp cả Phông nền/Làm mờ và Ánh sáng, áp dụng bước cân chỉnh sáng/màu ngay trong chu trình biến đổi khung hình trước khi phát.

2. **Quyền riêng tư camera & lưu trữ ảnh nền cá nhân chỉ cục bộ**:
   - Giữ nguyên bất biến `0` lần gọi `getUserMedia` / `enumerateDevices` khi tải trang Pre-Join. Nếu camera đang tắt khi người dùng mở bảng hiệu ứng và chọn một nền/làm mờ, lựa chọn được ghi nhận nhưng **chỉ bật phần cứng camera khi người dùng chủ động bấm nút bật camera** (ví dụ nút `"Bật camera để xem thử"` trong khung preview của Modal hoặc nút Camera).
   - Ảnh nền cá nhân do người dùng tải lên: chỉ chấp nhận `image/jpeg`, `image/png`, `image/webp` (`<= 8 MiB`), giải mã bằng `createImageBitmap`, thu phóng tối đa `1920×1080` trên canvas và mã hóa lại sang Blob `image/webp` / `image/jpeg` để **loại bỏ hoàn toàn siêu dữ liệu EXIF/GPS**. Lưu tối đa `4` ảnh tùy chỉnh trong IndexedDB cục bộ phân vùng theo `(tenant_id, user_id)`, **tuyệt đối không gửi lên Core API hay Backblaze B2**, và xóa sạch khi người dùng đăng xuất (`clearClientDrafts`).
   - Bộ 6–8 phông nền giáo dục có sẵn là tài sản đồ họa tự tạo sạch bản quyền (SVG/Canvas sắc nét độ phân giải `16:9` `1600×900`: Thư viện học thuật, Phòng học sáng hiện đại, Góc làm việc Bắc Âu, Bảng xanh giảng đường, Phòng đọc sách ấm, Không gian xanh tự nhiên...), không chép ảnh có bản quyền từ nền tảng thứ ba.

3. **Bàn giao lựa chọn xuyên suốt Pre-Join → Phòng học & Dọn dẹp tài nguyên**:
   - Mở rộng `MediaJoinChoices` trong memory escrow (`putMediaRoomEscrow`) để mang cấu hình `visualEffects` từ Pre-Join vào thẳng `ClassroomLiveKitRoom` mà không cần chọn lại; đồng thời lưu tùy chọn nhẹ (id nền + mức sáng/tông màu, không chứa PII hay token) theo `(tenant_id, user_id)` và xóa khi đăng xuất.
   - Tuân thủ đầy đủ quy tắc dọn dẹp idempotent của [ADR-0031](0031-classroom-media-ux-devices-layout-effects-and-signals.md) §11: khi tắt camera, đổi sang `Không dùng`, rời phòng, unmount hoặc đổi tài khoản, phải gọi `destroy()` trên processor, đóng `ImageSegmenter` / `VideoFrame` / `ImageBitmap`, thu hồi `blob:` URL (`URL.revokeObjectURL`) và không để rò rỉ track phần cứng. Nếu trình duyệt không hỗ trợ WebGL2 / `VideoFrame` hoặc processor gặp lỗi khi khởi tạo, tự động hạ cấp an toàn về camera gốc (`None`) kèm thông báo không chặn thao tác.

## Consequences

- Trải nghiệm chọn nền & chỉnh sáng mặt đồng nhất với các nền tảng hội nghị lớn (Google Meet ở Pre-Join, Microsoft Teams ở trong Phòng học, danh mục tinh lọc kiểu Zoom) mà không phá vỡ bố cục 1 khung nhìn của `PREJOIN-CLONE-04` hay che khuất Bảng trắng Excalidraw khi giảng dạy.
- Không phát sinh lưu lượng máy chủ, chi phí lưu trữ đám mây hay kết nối tới CDN bên thứ ba; giữ nguyên toàn bộ ranh giới bảo mật, quyền riêng tư và kiểm thử E2E của Phase 4–5.
