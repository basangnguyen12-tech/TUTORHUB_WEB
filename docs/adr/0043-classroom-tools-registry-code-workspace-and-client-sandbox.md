# ADR 0043: Classroom tools registry, CodeMirror 6 code workspace, merged snippets and isolated client sandbox

- Status: Accepted
- Date: 2026-11-25
- Scope: `ROOM-TOOLS-CODE-01..04` classroom tools launcher popover, `ClassroomToolRegistry`, in-room Code & Snippet workspace, isolated client-side execution (`Python`, `JavaScript/TypeScript`, `SQL`, `HTML/CSS/JS`), and roadmap boundary for real-time Yjs collaboration and server-side `C/C++/Java` compilation
- Extends: ADR-0015, ADR-0025, ADR-0029, ADR-0030, ADR-0031, ADR-0034, ADR-0037, ADR-0042

## Context

TutorHub V1 offered a 14-item Classroom Apps menu including `Code`, `Snippet`, and `Arena`, which delivered strong pedagogical value (live coding demonstrations, syntax-highlighted snippets, student practice with `stdin`/output, and multi-language STEM teaching). However, the V1 implementation relied on four disconnected, unauthenticated surfaces that cannot be carried into TutorHub V2:

1. An embedded `code-server` instance (`--auth none`) with client-asserted `?user=` cookies (`httpOnly: false`), `sudo NOPASSWD`, and an unauthenticated `/tutorhub-api/get-code?user=` endpoint that exposed any participant's files (IDOR).
2. A whiteboard `CodeShape` synchronized over a public unauthenticated `y-websocket` relay with no keyboard/screen-reader support or execution capability.
3. Classroom problem distribution over LiveKit DataChannels (forbidden by `ADR-0030` `CanPublishData = false`) and browser-direct submission of student code to third-party public `wandbox.org` APIs without tenant quotas or data-processing guarantees.
4. Individual per-tool buttons on the classroom Dock, which would overflow the compact pill Dock (`ROOM-COMPACT-05`) as `Code`, `Files`, `YouTube`, `Math`, `Diagram`, `Quiz`, and `Arena` are added.

In addition, executing untrusted participant JavaScript or Python inside a **same-origin** Dedicated Web Worker on TutorHub V2's web origin is unsafe because same-origin Workers automatically attach `HttpOnly` `SameSite=Lax` BFF session cookies when calling `/api/v1/*`.

## Decision

### 1. Unified Classroom Tools Dock trigger, popover grid and `ClassroomToolRegistry`

- Replace per-tool Dock buttons with **one** round Liquid Glass Dock trigger (`#media-p506-control-tools`, icon reflecting the currently open stage tool or the default tools grid icon when none is open, `variant="primary"` while a stage tool is open, `aria-haspopup="dialog"`, `aria-expanded` reflecting popover visibility).
- Clicking the trigger opens a non-modal Liquid Glass **Classroom Tools Popover** (`role="dialog"`, 4-column grouped grid with 2D arrow-key roving `tabindex`, `Home`/`End`, and `Escape` returning focus to `#media-p506-control-tools`). Only implemented, permitted tools are rendered in production (`Whiteboard` when `classroom_whiteboards` is enabled, `Code`, and future tools as each slice ships).
- Selecting a stage tool closes the popover, mounts the tool into the existing `.media-p506-tool-stage` main-stage slot (keeping the `256px` participant camera strip on desktop, `360px` right-hand `Chat`/`People`/`Effects` inspector reflow from `ADR-0042`, and `ClassroomHeaderSlotContext` Top Bar `40px` action slot without remounting `<video>`), and focuses `#media-p506-stage-title-{id}`. Closing the active stage tool (`#media-p506-close-{id}`) returns focus to `#media-p506-control-tools`.
- Only **one** stage tool occupies `.media-p506-tool-stage` at a time; switching from `Whiteboard` to `Code` (or vice versa) cleanly unmounts/suspends the previous stage tool's network session while preserving bounded local drafts.
- Tool implementations are loaded exclusively via `React.lazy` dynamic chunks (`LazyWhiteboardEngine`, `LazyCodeWorkspace`), adding **`0` bytes** to the initial client entry chunk (`scripts/check-whiteboard-performance-bundle.mjs` / `scripts/check-classroom-tools-bundle.mjs`).

### 2. CodeMirror 6 editor and merged `Code` + `Snippet` model

- **Editor engine**: Adopt **CodeMirror 6** (`@codemirror/*`, `@lezer/*`, `MIT`) instead of Monaco Editor. CodeMirror 6 keeps the lazy code-editor chunk compact (`<= 250 KB` gzip target before runtime WASM assets), supports mobile touch and Vietnamese IME (`Telex`/`VNI`) via `contenteditable`, satisfies WCAG 2.2 SC 2.1.2 (*No Keyboard Trap*: `Tab` does not trap focus by default; `Escape` then `Tab` or `Ctrl+M` / `Shift+Alt+M` always exits cleanly), and binds cleanly to `yjs@13.6.27` via `y-codemirror.next` (`MIT`) without dual undo stacks.
- **Language support from Slice 1**:
  - **Edit + syntax highlight + client-side Run (`0 USD` server cost)**: `Python`, `JavaScript`, `TypeScript`, `SQL` (SQLite), and `HTML / CSS / JS` (live sandboxed preview).
  - **Edit + syntax highlight + share/download from Slice 1 (server compilation deferred to Slice 4)**: `C`, `C++`, and `Java`, showing a clear, honest status notice when Run is clicked before Slice 4 server execution is enabled.
- **Merged `Snippet` workflow**: `Snippet` is unified into `Code` rather than creating a second Dock tool:
  - A built-in **Snippet Library (`Kho Snippet`)** slide-over inside the Code card (starter pedagogical templates in Slice 1; persistent personal/class database library in Slice 3).
  - **"Send to Chat" (`Gửi vào Chat`)**: Prefills the `ClassroomChatPanel` composer (`ADR-0042`) with a fenced Markdown code block (`<= 4,000` characters) so the sender explicitly confirms sending (respecting host `participant_chat_enabled` moderation). `ClassroomChatPanel` renders fenced code blocks safely as read-only monospace cards (text nodes only, never `innerHTML`) with `Copy` and **`Open in Code` (`Mở trong Code`)** actions. Received code **never** auto-executes.
- **Bounded session draft (`ADR-0029`)**: In Slice 1–2, participant multi-file workspace drafts (`<= 8` files, `<= 64 KB` UTF-8 total) persist locally in `localStorage` scoped strictly to `(tenantId, actorId, mediaSpaceId)` with an `8`-hour TTL and mandatory wipe inside `clearPrivateSessionCache()` on sign-out or workspace revocation, alongside one-click client-side file download. Durable server scratchpads/snippets ship in Slice 3.

### 3. Zero-trust client-side execution sandbox (`$0` server cost)

- **No same-origin Worker execution**: Untrusted code must **never** execute in the TutorHub application origin or in a same-origin Dedicated/Shared Worker.
- **Opaque `null`-origin sandboxed iframe + strict CSP**:
  - Client execution runs inside a hidden/preview `<iframe sandbox="allow-scripts" referrerpolicy="no-referrer" allow="">` (**never** `allow-same-origin`, `allow-top-navigation*`, `allow-popups`, `allow-forms`, `allow-modals`, or `allow-downloads`), optionally hosted on a dedicated cross-site static origin (`VITE_CODE_SANDBOX_URL`, e.g. `https://tutorhub-sandbox.pages.dev` with strict response CSP and `frame-ancestors`) and defaulting in single-origin local/CI environments to an opaque-origin `srcdoc` runner locked down before user execution with `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob:; worker-src blob:; connect-src 'none'; img-src data: blob:; media-src 'none'; font-src data:; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none';">`.
  - Parent-to-sandbox communication uses a dedicated `MessageChannel` (`port2` transferred once, schema-validated messages only). Session tokens, collaboration grants, user emails, and tenant IDs are **never** sent into the sandbox.
  - Runtime assets (`sucrase` `MIT` for TypeScript transpilation, `sql.js` `MIT` WASM for SQLite, and `pyodide` `MPL-2.0` unmodified WASM/stdlib for Python — loaded lazily only when the user first runs Python/SQL, with progress reporting) are fetched/cached by the host or cross-site sandbox asset origin and initialized inside the isolated Worker without granting user code network access to `/api/v1/*` or external origins.
- **Hard execution bounds**:
  - Wall-clock watchdog of **`5` seconds** per run (`worker.terminate()` / iframe teardown + clean respawn on timeout or manual `Stop`, keeping the UI responsive on `while (true) {}` or `while True: pass`).
  - Combined `stdout` + `stderr` capped at **`64 KB`** (`5,000` lines max; ANSI control sequences stripped; rendered strictly via DOM text nodes in `<pre>`), `stdin` capped at **`16 KB`**, SQL result sets capped at `500` rows × `50` columns, and at most `1` active run per tab.
  - HTML/CSS/JS Preview renders only on explicit user Run/Preview inside a nested sandboxed frame with `connect-src 'none'` and a `Stop preview` control.

### 4. Phased architecture for Slices 2–4

- **Slice 1 (`ROOM-TOOLS-CODE-01`)**: `ClassroomToolRegistry` + unified `Công cụ` Dock popover (`Whiteboard` + `Code`), `LazyCodeWorkspace` (`CodeMirror 6`, `<= 8` files, starter `Kho Snippet`, bounded `ADR-0029` draft, file download), isolated client sandbox (`Python`, `JS/TS`, `SQL`, `HTML/CSS/JS`), and `ClassroomChatPanel` fenced code card + `Open in Code`.
- **Slice 2 (`ROOM-TOOLS-CODE-02`)**: Real-time collaborative teaching workspace reusing the `ADR-0034` grant broker and `services/whiteboard-runtime` (`Hocuspocus`/`Yjs`) via a typed `document_kind` (`"whiteboard.excalidraw.v1"` vs `"code.workspace.v1"`) with per-kind resource budgets, separate `tutorhub.code_workspaces` / `code_workspace_generations` / `code_workspace_actor_grants` tables, feature flags `classroom_code_tool` & `classroom_code_collaboration`, instructor live mode, temporary student `edit` grants (`<= 3` editors, `<= 30` minutes), 8-tone participant cursors, and local fork-to-scratchpad.
- **Slice 3 (`ROOM-TOOLS-CODE-03`)**: Durable tenant/class-scoped `tutorhub.code_snippets` and `tutorhub.code_scratchpads` (`<= 64 KB`/file, student opt-in *"Share with teacher"* replacing V1's `👁️ Code` IDOR), lazy syntax highlighting in Chat, and portable B2 exports.
- **Slice 4 (`ROOM-TOOLS-CODE-04`, requires separate `ADR-0044`)**: Isolated server-side compilation & execution runner (`nsjail` / `gVisor` `Apache-2.0`, zero egress network, internal HMAC/mTLS from `core-api`, tenant hourly quotas, default force-off; `Judge0` `GPL-3.0` is explicitly rejected) for `C`, `C++`, and `Java`.

## Consequences

- Classroom tools scale cleanly from 2 tools (`Whiteboard`, `Code`) to the full multi-tool roadmap without crowding the classroom Dock or inflating the initial web bundle (`+0 B` entry).
- Students and teachers get instant, zero-cost browser execution for `Python`, `JavaScript/TypeScript`, `SQL`, and `HTML/CSS/JS` with hard protection against infinite loops, XSS, and BFF cookie/API exfiltration, while `C/C++/Java` editing works immediately and server compilation is cleanly gated behind `ADR-0044`.
- Existing Phase 5 collaboration infrastructure (`whiteboard-runtime` + grant broker) is preserved for Slice 2 without introducing premature microservices or recurring Private Alpha infrastructure cost.
