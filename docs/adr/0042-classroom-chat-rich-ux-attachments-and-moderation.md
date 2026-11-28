# ADR 0042: Classroom chat studio UX, bounded attachments and room posting moderation

- Status: Accepted
- Date: 2026-11-24
- Scope: `ROOM-CHAT-01` non-modal classroom chat inspector, live sync, host posting switch, emoji picker, and bounded image/file attachments
- Extends: ADR-0025 (`P3-07A` / `P4-08`), ADR-0027, ADR-0031, ADR-0041

## Context

`P4-08` connected Classroom MediaSpaces to the canonical `room` conversation aggregate (`ADR-0025`), but the classroom UI mounted the generic admin-style `ConversationMessages` form inside a modal overlay `<Drawer>`. In live classes this caused four concrete problems:

1. **Stage occlusion**: Opening Chat covered the right camera column and the right edge of the Excalidraw whiteboard instead of docking side-by-side like Google Meet, Microsoft Teams, and Zoom.
2. **Form-centric UX instead of live messenger UX**: Manual `"Refresh messages"` button, middle-of-panel `"New message"` heading, `Ctrl+Enter` submit requirement, permanent `0/4000` counter, and a duplicate bottom `"Close"` button wasted vertical space and broke chat muscle memory.
3. **No classroom media sharing**: Teachers and students could not pick emojis easily, paste homework/problem screenshots (`Ctrl+V`), or send images and lesson files (`.pdf`, `.docx`, `.xlsx`, `.pptx`, `.txt`, `.zip`) inside the room chat.
4. **No host chat posting switch**: Unlike Google Meet (`"Let everyone send messages"`), hosts/teachers could not temporarily pause participant chat posting during focused explanation while keeping host announcements open.

At the same time, TutorHub V2 must preserve `ADR-0025` invariants (PostgreSQL + authenticated Core API REST as the sole source of truth, tenant-composite foreign keys, `X-TutorHub-Expected-Tenant-ID` + CSRF on every mutation, zero message/filename leakage into logs, audit, or outbox) and must work both when Backblaze B2 object storage is configured and in zero-credential local/test environments (`APP_ENV=development|test`).

## Decision

### 1. Unified non-modal right-hand classroom inspector (`360px`)

- On desktop viewports (`>= 1024px`), `Chat` (`#media-p408-control-chat`), `People` (`#media-p406-control-roster`), and `Effects` (`#media-p405-control-effects`) share one mutually exclusive non-modal right-hand inspector slot (`width: min(360px, 100vw)`).
- Opening any one of the three closes whichever other inspector was open and applies a unified shell reserve class (`.media-p405-shell--inspector-open`, preserving `.media-p405-shell--effects-open` compatibility) with `padding-inline-end: calc(360px + 12px)` so the video grid, Whiteboard canvas, Top Bar, and floating Dock reflow cleanly to the left without covering stage content and without remounting `<video>` or Excalidraw.
- Below `1024px`, the drawer behaves as a responsive overlay sheet so `320px` viewports remain accessible without horizontal overflow.
- `#media-p408-control-chat` reflects `aria-expanded={chatOpen}`, uses `variant={chatOpen ? "primary" : "secondary"}`, and renders a bounded unread count badge (`1..99`, `99+`) while `chatOpen === false` and `unreadCount > 0`.

### 2. Live room sync and messenger timeline UX

- While the classroom session is live (`connected` or `reconnecting`) and `document.visibilityState === "visible"`, the room chat client polls `listConversationMessages` (`2.5s` while open, `5s` while closed for the Dock unread badge) and refreshes the `room` conversation projection (`5s` while open) so peer messages, edits, deletions, attachments, and host posting-switch changes appear automatically without a manual refresh button.
- The classroom chat surface uses a dedicated `ClassroomChatPanel` component (leaving `ConversationsPage` outside the room intact):
  - Slim header (`Trò chuyện trong phòng` + audience/persistence subtitle + `✕` close icon; no duplicate bottom Close button).
  - Optional top host switch card (`Cho phép người tham gia gửi tin nhắn`) visible when `viewer_access.can_moderate_chat === true`, plus a calm read-only notice banner for participants when posting is paused by the host or after the room ends.
  - Full-height scrollable message stream (`flex: 1 1 auto; min-height: 0`) anchored to the bottom, with date pills, 5-minute same-author bubble grouping, 6-tone participant avatars, safe `http://` / `https://` linkification (`rel="noopener noreferrer" target="_blank"`), Jumbo Emoji presentation for active text-only messages of `1–3` emoji graphemes, hover/focus `Edit` / `Delete` / `Copy` actions on own active messages, and a floating `"New messages"` jump pill when scrolled up.
  - Bottom-pinned Liquid Glass composer card with staged attachment preview strip, auto-growing `<textarea>` (`1–5` rows, `Enter` to send, `Shift+Enter` for newline, `Ctrl+V` clipboard image/file paste, drag-and-drop overlay), and an integrated bottom action bar (`Emoji`, `Image`, `File`, divider, `Send`).

### 3. Host room-chat posting moderation (`tutorhub.room_conversation_settings`)

- Forward migration `000053_room_chat_moderation_and_attachments` creates `tutorhub.room_conversation_settings` keyed by `(tenant_id, conversation_id)` referencing `tutorhub.conversations (tenant_id, id) ON DELETE CASCADE`, with `participant_chat_enabled boolean NOT NULL DEFAULT true`, `updated_by_user_id uuid NOT NULL`, and `updated_at timestamptz NOT NULL`. Keeping this in a child table preserves the exact column-level `UPDATE` privilege contract on `tutorhub.conversations`.
- `PATCH /api/v1/conversations/{conversation_id}/room-settings` (`{ participant_chat_enabled: boolean }`, CSRF + `X-TutorHub-Expected-Tenant-ID`) is authorized only on `kind = 'room'` when the MediaSpace is `open` and the actor has live room moderation authority (class teacher/owner/org admin for class-backed spaces, StudyMeeting creator for study-meeting spaces, or an active `host` / `co_host` role in the active `RoomInstance`).
- When `participant_chat_enabled = false`, moderators (`can_moderate_chat = true`) retain `can_post_messages = true`; regular participants receive `can_post_messages = false` and any direct `POST`/`PATCH`/`DELETE` message or attachment upload by a non-moderator returns `409` (`ErrReadOnly`).

### 4. Bounded conversation attachments (`tutorhub.message_attachments`)

- Forward migration `000053` creates `tutorhub.message_attachments` with tenant-composite foreign keys to `tutorhub.conversations` and `tutorhub.messages`, `REVOKE ALL ... FROM PUBLIC`, and relaxes `messages_content_lifecycle_valid` so an active message may have `content = ''` when it owns at least one attachment (keeping `ActiveMessage.content` a non-null string `0..4000` chars for backward-compatible TypeScript consumers).
- Bounds and allowlists (enforced fail-closed on the server):
  - At most `4` attachments per message; staged unattached uploads expire after `15` minutes.
  - Images (`kind = 'image'`, max `5 MiB` / `5,242,880` bytes): `image/png`, `image/jpeg`, `image/webp`, `image/gif` verified via server magic-byte sniffing (`http.DetectContentType`); `image/svg+xml` and HTML are strictly rejected to prevent stored XSS. Raster photos selected/pasted in the browser strip EXIF/GPS metadata client-side when re-encoded (`PNG`/`JPEG`/`WebP`; animated `GIF` kept intact within size bounds).
  - Files (`kind = 'file'`, max `10 MiB` / `10,485,760` bytes): `application/pdf`, `text/plain`, `text/csv`, `text/markdown`, `application/zip`, `application/msword`, `application/vnd.openxmlformats-officedocument.wordprocessingml.document`, `application/vnd.ms-excel`, `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`, `application/vnd.ms-powerpoint`, `application/vnd.openxmlformats-officedocument.presentationml.presentation`. Executables, scripts, HTML, and SVG are rejected (`400`/`415`).
- Storage data plane:
  - When `objectstorage.Store` (Backblaze B2) is configured, attachment bytes are stored under opaque keys `tenants/{tenant_id}/chat-attachments/{attachment_id}` (`storage_backend = 'b2'`).
  - When `objectstorage.Store` is unconfigured in `development` or `test` (`APP_ENV` not `staging`/`production`), bounded bytes use `storage_backend = 'inline_dev'` (`inline_bytes bytea`) so local preview (`localhost:5173`) and CI/Playwright E2E work end-to-end without cloud credentials. In `staging` and `production`, missing object storage fails closed (`can_upload_attachments = false`, upload returns `503`).
- Endpoints & privacy:
  - `POST /api/v1/conversations/{conversation_id}/attachments`: `multipart/form-data` (`file` part + `client_attachment_id` UUID), requires session, CSRF, `X-TutorHub-Expected-Tenant-ID`, and current conversation write access; enforces actor rate limits and returns `MessageAttachment` metadata.
  - `POST /api/v1/conversations/{conversation_id}/messages`: accepts `{ client_message_id, content, attachment_ids? }` (`content` may be `""` when `attachment_ids` has `1..4` items) and atomically binds staged attachments owned by `(tenant_id, conversation_id, actor_user_id)` to the new message.
  - `GET /api/v1/conversations/{conversation_id}/attachments/{attachment_id}/content`: reauthorizes conversation read (`X-TutorHub-Expected-Tenant-ID`), rejects tombstoned/unattached rows as `404`, and serves bytes with `Cache-Control: private, no-store`, `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'`, and `Content-Disposition: attachment; filename*=UTF-8''...`. The web client fetches image/file bytes with credentials + `X-TutorHub-Expected-Tenant-ID` into revocable `Blob` URLs (`URL.createObjectURL`) for inline image thumbnails, Lightbox preview, and one-click file download — never placing session or capability secrets in query strings.
  - Deleting a message (`DELETE .../messages/{message_id}`) atomically marks its attachments `deleted` and clears `inline_bytes` (and best-effort deletes the B2 object when present) so deleted media immediately becomes `404`. Filenames, message bodies, and object keys never enter logs, audit events, metrics, or outbox rows.

## Consequences

- Classroom chat matches the ergonomics of Google Meet, Microsoft Teams, and Zoom while fitting TutorHub V2's macOS Liquid Glass room aesthetic (`ROOM-MACOS-03` / `ROOM-COMPACT-05`).
- Opening Chat, People, or Effects smoothly resizes the stage side-by-side on desktop without covering Whiteboard strokes or participant cameras.
- Emoji, clipboard screenshots, images with Lightbox zoom, and lesson files work end-to-end across participants in both local preview and B2-backed environments while maintaining strict tenant isolation and XSS/EXIF safety.

## Amendment — 2026-11-28 (`MSG-COMPOSER-TOOLS-01`): Conversation attachments across `direct`, `class`, and `room`

- **Scope extension**: Bounded conversation attachments (`tutorhub.message_attachments`, `POST /api/v1/conversations/{conversation_id}/attachments`, and `GET /api/v1/conversations/{conversation_id}/attachments/{attachment_id}/content`) are extended from `kind = 'room'` only to **all conversation kinds** (`direct`, `class`, and `room`) whenever the authenticated viewer currently holds posting authority (`viewer_access.can_post_messages === true`) and an attachment storage data plane is available (`B2` in staging/production, or bounded `inline_dev` in `development`/`test`).
- **Preserved invariants**:
  - All `ADR-0042` §4 bounds and safety controls remain unchanged: max `4` attachments per message, `5 MiB` image / `10 MiB` lesson-file ceilings, magic-byte MIME verification (`SVG`, `HTML`, scripts, and executables rejected fail-closed), `15`-minute staged TTL, client-side EXIF/GPS stripping on raster images (including in-browser cropped screenshots from `getDisplayMedia`), private `no-store` / `nosniff` / `CSP: default-src 'none'` content delivery, and tombstone erasure on message recall.
  - Authorization follows `authorizeMessageWrite` per conversation kind: archived classes (`409 conversation_read_only`), ended rooms, and rooms with participant chat paused by a moderator reject attachment staging and binding.
  - Operational kill-switches remain enforced at two layers without adding a separate feature flag: tenant-scoped `conversations` feature control (`RequireFeature(..., FeatureConversations)`) plus `actor_message_attachments_per_minute` rate limiting, and environment-level `OBJECT_STORAGE_ENABLED` fail-closed (`503` / `can_upload_attachments = false` when unset in `staging`/`production`).

## Amendment — 2026-11-28 (`MSG-RICH-COMPOSE-01`): Zoom/Gmail-style "Format text" composer and zero-HTML chat markup

- **UX & Accessibility (`ChatRichComposer`)**:
  - Both `/app/messages` (`ConversationMessages.tsx`) and live Classroom Room Chat (`ClassroomChatPanel.tsx`) add a Zoom-style **"Format text" (`Định dạng văn bản`)** toggle button (`PenLine` icon, `aria-pressed`) as the first composer tool.
  - Activating the toggle swaps the plain `<textarea>` for a WYSIWYG rich composer (`contenteditable="true"`, `role="textbox"`, `aria-multiline="true"`) with an WAI-ARIA APG `role="toolbar"` above the input in Gmail order: **Undo / Redo | Text size ▾ (`Small`, `Normal`, `Large`, `Huge`) | Bold (`Ctrl+B`), Italic (`Ctrl+I`), Underline (`Ctrl+U`), Strikethrough (`Ctrl+Shift+X`), Text color ▾ (6 WCAG-AA swatches + Default) | Align ▾ (`Left` `Ctrl+Shift+L`, `Center` `Ctrl+Shift+E`, `Right` `Ctrl+Shift+R`), Numbered list (`Ctrl+Shift+7`), Bulleted list (`Ctrl+Shift+8`) | Remove formatting (`Ctrl+\`)**.
  - On narrow containers (`@container (max-width: 400px)`, such as the `360px` classroom side panel), Undo/Redo buttons and menu chevrons hide so the toolbar fits on a single row while keeping `Ctrl+Z` / `Ctrl+Y` active.
  - If the user hides the toolbar after applying formatting, the composer stays in rich mode so formatting is preserved; if the draft has no formatting when the toolbar is closed, it returns seamlessly to the plain `<textarea>`.
  - Keyboard and IME safety: roving `tabIndex` across toolbar items (`ArrowLeft`/`ArrowRight`/`Home`/`End`), `Alt+F10` jumps from editor to toolbar, `Escape` returns focus to the editor, and Vietnamese IME composition (`isComposing` / `keyCode === 229`) never triggers premature `Enter` submission.
- **Zero-schema, zero-HTML Markdown-compatible serialization (`chatMarkup.ts`, `ChatFormattedText.tsx`)**:
  - Consistent with reply quotes (`ConversationQuote.ts`) and code blocks (`codeFence.ts`), formatting is serialized directly inside `content` without adding a database column or altering the OpenAPI schema:
    - `**bold**`, `*italic*`, `~~strike~~` (flanked by non-word boundaries so `2*3*4`, `snake_case`, Python `__init__`, and URLs remain literal; fenced ` ``` ` code blocks are never formatted).
    - `[text]{.underline .red .large}` explicit attribute spans for underline, 6 semantic color tokens (`red`, `orange`, `green`, `blue`, `purple`, `gray`), and 3 size tokens (`small`, `large`, `huge`).
    - `- item` and `1. item` list lines, `::: center` / `::: right` ... `:::` alignment blocks, and backslash escapes (`\*`, `\~`, `\[`, `\]`, `\\`).
  - **XSS & paste safety**: `ChatFormattedText` never uses `dangerouslySetInnerHTML` or parses HTML from message content; it builds pure React elements from the parsed AST, and pasting/dropping into `ChatRichComposer` strips all external HTML/styles to `text/plain` (while forwarding clipboard image/file attachments).
  - Conversation list previews, reply quote excerpts, in-thread search, and Copy actions strip markup via `chatMarkupToPlainText`.
  - All 6 color tokens satisfy WCAG 2.1 AA (`>= 4.5:1`) across light surfaces, dark surfaces, and own blue classroom bubbles.
