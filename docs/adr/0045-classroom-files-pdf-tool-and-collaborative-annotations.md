# ADR 0045: Classroom Files / PDF tool, room document library, client-rendered PDF viewer and page-scoped collaborative annotations

- Status: Accepted
- Date: 2026-11-26
- Scope: `ROOM-TOOLS-FILES-01..03` classroom `Files / PDF` (`Tài liệu`) stage tool, `content_files` owner union (`class` | `media_space`), pure-Go `P3-10-PDF/Image` readiness verification, virtualized `pdfjs-dist@6.5.438` client viewer, push-to-whiteboard WebP snippet bridge, and real-time `pdf.annotations.v1` (`pd_*`) presentation & page-scoped annotations
- Extends: ADR-0015, ADR-0026, ADR-0027, ADR-0030, ADR-0031, ADR-0034, ADR-0037, ADR-0042, ADR-0043

_(Note: `ADR-0044` remains reserved for `ADR-0043` Slice 4 isolated server-side `C/C++/Java` execution.)_

## Context

TutorHub V1 provided a popular one-click `Files` workflow for uploading PDF/image worksheets, solving problems live with students, and exporting annotated handouts. However, V1's implementation (`ROOM-TOOLS-FILES-00` audit) had severe security, scalability, and accessibility flaws that cannot be carried into TutorHub V2:

1. **Client-side vulnerabilities and unauthenticated storage**: V1 loaded `pdf.js@3.11.174` from a public CDN without SRI and with default `isEvalSupported` (**CVE-2024-4367**, allowing malicious PDF fonts to execute arbitrary JavaScript inside JCEF), uploaded rasterized PNG pages anonymously to `/upload-document` without tenant isolation, broadcast 7-day presigned URLs over unverified LiveKit DataChannels (forbidden by `ADR-0030` `CanPublishData = false`), and fetched pages through an open-SSRF `/proxy-image?url=` endpoint.
2. **Whiteboard document bloat**: Embedding every PDF page as a scale-2 base64 PNG inside Excalidraw `files` (~400 KiB–1.2 MiB per page) immediately violates TutorHub V2's live collaboration runtime limits (`64 KiB` max update, `2 MiB` max `wb_*` document), breaks past 20 pages due to per-page upload rate limits, and destroys vector zoom quality, text selection, search, and WCAG 2.2 AA screen-reader support.
3. **Current V2 file pipeline gaps**:
   - `tutorhub.content_files` (`ADR-0026`, `ADR-0027`) requires `status = 'ready'` and a verified `stored_checksum_sha256` before `IssueDownloadCapability` succeeds, while `Finalize` stops at `status = 'uploaded'` because general `P3-10` asynchronous malware scanning was deferred.
   - `content_files.class_id` is currently `NOT NULL`, leaving standalone `study_meeting` rooms (`class_id IS NULL`) without a room-scoped document library beyond `10 MiB` Chat attachments (`ADR-0042`).

Benchmarking leading online-teaching and collaboration platforms (`ClassIn`, `Lessonspace`, `Pencil Spaces`, `BigBlueButton`, `Microsoft Teams PowerPoint Live`, `Zoom Whiteboard`, `Figma Spotlight`) shows strong convergence on separating immutable document pages from per-page vector annotation layers, defaulting students to presenter-follow with optional private browsing (`Sync to presenter`), and allowing selective page/region extraction onto an infinite whiteboard for long-form problem solving.

## Decision

### 1. Three-layer hybrid `Files / PDF` classroom tool and Whiteboard bridge

- Register **`files`** (`Tài liệu` / `Documents`, group `present`) inside `ClassroomToolRegistry` (`ADR-0043`) under the unified `#media-p506-control-tools` Dock popover. The tool mounts lazily via `React.lazy` (`LazyDocumentViewer`) into `.media-p506-tool-stage` (`+0 B` initial entry bundle, `0` LiveKit `<video>` remounts when switching `Whiteboard` ↔ `Code` ↔ `Files`).
- Adopt a **3-Layer Hybrid Architecture**:
  1. **L1 — Room & Class Document Library**: Backed by `tutorhub.content_files` and Backblaze B2 versioned objects, never storing PDFs or presigned URLs inside Yjs documents or DataChannels.
  2. **L2 — Virtualized Client PDF & Image Viewer**: Vector PDF rendering in the participant's browser (`$0` server CPU cost) with text selection, search, thumbnails, and strict zero-scripting isolation.
  3. **L3 — Real-Time Presentation & Page-Scoped Annotations (Slice 2)**: Synchronized presenter page/laser and normalized `[0..1]` per-page ink/highlighter strokes over a dedicated collaboration document kind `pdf.annotations.v1` (`pd_*`).
- **Push Page / Crop Region to Whiteboard (`Đưa trang / Cắt vùng sang Bảng trắng`, from Slice 1)**:
  - Participants who hold edit/present capability on the room whiteboard can select an entire page or drag a crop rectangle on a PDF/image page to solve on the room `Whiteboard` (including grid/lined paper modes).
  - The browser renders the selected region onto a bounded canvas (`<= 1,440 px` long edge) and compresses it to **WebP `<= 40 KiB` binary (`~54.6 KiB` base64, strictly below the `64 KiB` `wb_*` update ceiling)** via iterative quality/dimension step-down (`quality 0.82 -> 0.40`, `-15%` dimension steps).
  - The snippet is inserted through `CanonicalExcalidrawAuthority` as a **`locked: true`** image element with a bounded attribution caption (`<= 12` extracted document images per whiteboard; clear user notice when full) and switches the active stage tool to `Whiteboard`.

### 2. `content_files` owner union (`class` | `media_space`) and pure-Go `P3-10-PDF/Image` readiness verifier

- **Owner union for `study_meeting` and classroom rooms**:
  - Extend `tutorhub.content_files` with `owner_kind text NOT NULL DEFAULT 'class'`, nullable `class_id`, nullable `media_space_id` (`FOREIGN KEY (tenant_id, media_space_id) REFERENCES tutorhub.media_spaces(tenant_id, id)`), and a strict check constraint requiring `(owner_kind = 'class' AND class_id IS NOT NULL AND media_space_id IS NULL) OR (owner_kind = 'media_space' AND media_space_id IS NOT NULL AND class_id IS NULL)`.
  - Object keys remain `tenants/{tenant_id}/files/{file_id}/original`. Existing tenant-wide class file discovery/search (`discovery` module) continues joining `authorized_classes`, keeping `media_space` files strictly private to the room.
  - Add `allow_student_download boolean NOT NULL DEFAULT true` (default `true` for `owner_kind = 'class'`, default `false` — toggleable by host/co-host — for `owner_kind = 'media_space'`), `expires_at timestamptz` (`30` days after `media_space` closure for `media_space`-owned files; soft-deleted via `deleted_at` so the Core API runtime role never needs `DELETE`), and bounded verification columns (`page_count integer`, `first_page_aspect double precision`, `active_content boolean NOT NULL DEFAULT false`, `rejection_reason text`).
- **Narrow pure-Go `P3-10-PDF/Image` readiness verifier (`$0` server cost, no new container)**:
  - Classroom `Files / PDF` uploads allowlist four media types: `application/pdf` (`<= 50 MiB`, `1..300` pages) and `image/png`, `image/jpeg`, `image/webp` (`<= 10 MiB`, `<= 50` megapixels).
  - For finalized files matching those four media types (both `owner_kind = 'class'` and `owner_kind = 'media_space'`), `core-api` runs a pure-Go verifier (no CGo, no GPL/AGPL dependencies, no external ClamAV daemon in Private Alpha) against the exact `storage_version_id` in B2 — triggered immediately upon `Finalize` with bounded `SKIP LOCKED` recovery for interrupted `uploaded`/`processing` rows:
    1. Streams the exact object version to compute full `SHA-256` and verifies byte-for-byte equality with `expected_checksum_sha256` (populating `stored_checksum_sha256` required by `000027` `content_files_storage_proof_consistent`).
    2. Verifies magic bytes (`%PDF-1.` / `%PDF-2.` header within first `1,024` bytes and `%%EOF` trailer marker for PDF; canonical PNG, JPEG, or WebP headers plus decoded header dimensions `<= 50 MP` for images).
    3. Parses PDF structure safely in pure Go to extract `page_count` (`1..300`) and `first_page_aspect`, **rejecting** encrypted/password-protected PDFs (`status = 'rejected'`, `rejection_reason = 'pdf_encrypted'`), page-count overflows (`pdf_too_many_pages`), and malformed/polyglot files (`pdf_invalid`, `media_type_mismatch`, `checksum_mismatch`, `file_too_large_for_viewer`, `image_dimensions_exceeded`).
    4. Scans for active PDF dictionary tokens (`/JavaScript`, `/JS`, `/OpenAction`, `/AA`, `/XFA`, `/Launch`, `/EmbeddedFile`); matches set `active_content = true` without rejecting the file (since the client viewer disables all scripting/forms, while downloading the raw original file shows an explicit warning).
  - Non-viewer class uploads (e.g. `.zip`, `.docx`) retain existing `uploaded` semantics until general `P3-10` malware scanning is introduced.
- **Feature controls and room document API**:
  - Add feature keys `classroom_files_tool` (default `false`, deployment guardrail `FEATURE_CONTROL_ENABLE_CLASSROOM_FILES_TOOL=false`) and, in Slice 2, `classroom_pdf_collaboration` (default `false`, guardrail `FEATURE_CONTROL_ENABLE_CLASSROOM_PDF_COLLABORATION=false`).
  - Provide tenant-scoped room endpoints returning uniform `404` on unauthorized or cross-tenant access:
    - `GET /api/v1/media/spaces/{space_id}/documents` (keyset list of viewer-supported class `ready` files when `class_id` is linked + room `media_space` files; uploader and room teaching staff also see in-flight `pending`/`uploaded`/`processing`/`rejected` rows).
    - `POST /api/v1/media/spaces/{space_id}/documents/upload-intents` (creates `media_space` or `class` upload intent for host/co-host/teaching staff, reusing `/api/v1/files/{file_id}/{upload-capability,multipart-uploads,finalize}`).
    - `POST /api/v1/media/spaces/{space_id}/documents/{file_id}/view-capabilities` (requires active room admission/membership + `status = 'ready'`; issues a version-bound B2 presigned `GET` capability with `TTL <= 5 minutes`, separate from raw `download-capabilities` which additionally enforces `allow_student_download`).
    - `PATCH /api/v1/media/spaces/{space_id}/documents/{file_id}` (host/co-host/staff toggle `allow_student_download` or soft-delete room documents).

### 3. Pinned `pdfjs-dist@6.5.438` (`Apache-2.0`) virtualized zero-scripting viewer

- Pin **`pdfjs-dist@6.5.438` (`Apache-2.0`)** exact in lockfile and call its core display API directly inside a custom React virtualized viewer (no `react-pdf` or `@pdfslick/*` wrappers; AGPL/commercial PDF engines are strictly forbidden). Every future `pdfjs-dist` version bump must re-audit default flags (`enableHWA`, `enableWebGPU`, scripting/eval flags).
- Self-host `pdf.worker.min.mjs` and required WASM/CMap/font/ICC assets under `/pdf-runtime/*` (`< 10 MiB` per file, zero third-party CDN requests, full `NOTICE.txt` license attribution for Apache-2.0 / OpenJPEG / JBIG2 / QCMS).
- **Mandatory zero-scripting & link hardening**:
  - **Never** create a `scriptingManager`, and **never** ship `pdf.sandbox*` or `quickjs-eval*` in the build output (enforced by bundle verification script). Keep `enableXfa: false`, `withCredentials: false`, and `maxImageSize: 50_000_000`, with per-page `15s` render watchdogs.
  - Render `TextLayer` spans via DOM `textContent` only (`0` `innerHTML`). Disable `AnnotationLayer` forms/widgets; construct a custom link layer that handles internal page jumps directly and permits external `https:` and `mailto:` URLs **only** after a confirmation dialog showing the target host (`window.open(..., "_blank", "noopener,noreferrer")`). All other schemes (`javascript:`, `data:`, `blob:`, `file:`, `http:`) are rendered inert.
- **Virtualization, memory hygiene & accessibility**:
  - Mount at most **`5` active `<canvas>` elements on desktop (`2` on `< 768px` viewports)** (`<= 16 MP`/canvas desktop, `<= 8 MP` mobile) via `IntersectionObserver` + priority queue; evicted pages cancel active `RenderTask`s, zero `canvas.width = canvas.height = 0`, and call `page.cleanup()`.
  - Fetch bytes with `{ credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store" }` into memory only (full-file fetch up to `30 MiB` in Slice 1, plus transparent version-bound `PDFDataRangeTransport` renewal for `30–50 MiB` in Slice 2); **never** persist student/class PDFs in `IndexedDB` or `CacheStorage`, and release memory on tool close or `clearPrivateSessionCache()`.
  - Support WCAG 2.2 AA landmarks, `PageUp`/`PageDown`/`Home`/`End`, `Escape` focus return, `320px` single-column layout (collapsible thumbnail drawer), `forced-colors`, `prefers-reduced-motion`, and full `vi`/`en` localization.

### 4. Phased delivery (`ROOM-TOOLS-FILES-01..03`)

- **Slice 1 (`ROOM-TOOLS-FILES-01A` + `01B`)**: Migration `000056` (`content_files` owner union + verification metadata + `classroom_files_tool`), pure-Go `P3-10-PDF/Image` readiness verifier, room document list/upload/view-capability/patch APIs, `LazyDocumentViewer` (`pdfjs-dist@6.5.438`, virtualization, thumbnails, search, safe links), and `Đưa trang / Cắt vùng sang Bảng trắng` (`<= 40 KiB` WebP, `<= 12` snippets/board).
- **Slice 2 (`ROOM-TOOLS-FILES-02A` + `02B`)**: `document_kind = "pdf.annotations.v1"` (`pd_*`, `1 MiB` max doc / `32 KiB` max update) on `services/whiteboard-runtime` (`0` new runtime npm dependencies), `tutorhub.pdf_presentations*` tables + temporary student annotation grants (`<= 3` students × `10–30` minutes via `ClassroomPeoplePanel`), normalized `[0..1]` per-page `pen`/`highlighter` strokes with actor-isolated `Y.UndoManager` and my-stroke eraser, presenter follow (`Theo dõi GV` / `Tự xem` / `Quay về trang GV`, `followLock`, `hiddenPages` UX) + `20 Hz` presenter laser authenticated by server-stamped `tutorhub.capability === "present"`, and `30–50 MiB` HTTP Range transport.
- **Slice 3 (`ROOM-TOOLS-FILES-03A` + `03B`)**: Bidirectional Chat ↔ `Tài liệu` workflow (`Mở trong Tài liệu` on Chat PDF attachments, `Chia sẻ vào Trò chuyện` reference cards without URLs, save Chat attachment to room library), client-side study PDF export combining original vector pages with stroke overlays, private student study notes, and `SKIP LOCKED` `30`-day post-close retention cleanup for `media_space` files.

## Consequences

- Unblocks `ready` downloads for PDFs and images across **both** Class Files (`P3-08/P3-10`) and live classrooms (`class_session` and `study_meeting`) at `$0` extra infrastructure cost while keeping Core API runtime roles free of `DELETE` privileges.
- Eliminates V1's `CVE-2024-4367` PDF scripting RCE, open-SSRF image proxy, unauthenticated uploads, 7-day URL leakage, and 20-page truncation, while preserving crisp vector zoom, text search, screen-reader support, and 1-tap problem extraction onto the classroom Whiteboard.
- Reuses the existing `whiteboard-runtime` Hocuspocus process and collaboration grant broker for Slice 2 page-scoped annotations without risking `wb_*` or `cw_*` document budgets.
