# ADR 0047: Curated Noto Animated Emoji sticker packs and server-projected `sticker` message embeds

- Status: Accepted
- Date: 2026-11-28
- Scope: `MSG-STICKER-01..03` curated sticker catalog (`go:embed`), `000060_message_embed_stickers`, `GET /api/v1/conversations/sticker-packs`, same-origin static WebP delivery, `CC BY 4.0` attribution, and `ChatExpressionPicker` (`Sticker | Emoji`) across Messages and Classroom Room Chat
- Extends: ADR-0042 (`ROOM-CHAT-EMOJI-02` / `MSG-COMPOSER-TOOLS-01`), ADR-0046 (`tutorhub.message_embeds`)

## Context

Following the Zalo/ClassIn-style redesign of `/app/messages` and classroom room chat (`ClassroomChatPanel`), users need an expressive **Sticker** tab alongside the existing Unicode **Emoji** tab (`ClassroomEmojiPicker`). Clicking a sticker immediately sends it as a standalone borderless artwork message (`120–160 px`).

Because TutorHub serves minor students and enforces strict CSP (`img-src 'self'`), privacy, and anti-spoofing guarantees:

1. **No client calls to third-party GIF/sticker APIs**: Directly querying external UGC networks from the browser leaks student IP addresses and search queries, risks exposing unmoderated content, and introduces third-party outage risk (e.g., Google sunset the Tenor API on 2026-06-30).
2. **No raw URLs or shortcodes in message text**: Consistent with `ADR-0046`, clients must never parse `:sticker:...:` tokens from `content` or accept arbitrary image URLs from senders.
3. **Clear open-source licensing and bounded bundle/CPU footprint**: Animated stickers must carry a permissive commercial-compatible license with proper attribution, stay small enough for Cloudflare Pages deployment (`<= 10 MB` total static assets), and avoid decoding dozens of off-screen animated images simultaneously.

## Decision

### 1. Sticker source, `CC BY 4.0` attribution, and asset budget

- TutorHub adopts a curated subset (`80–120` stickers covering facial expressions, encouragement gestures, celebrations, and study activities) from **Google Noto Emoji Animation** (`CC BY 4.0`). Custom mascot packs and third-party GIF tabs are out of scope for the current release.
- **Deterministic build script (`apps/web/scripts/generate-sticker-catalog.mjs`)**:
  - Reads a pinned upstream Noto Emoji Animation commit/archive verified by SHA-256 checksum.
  - Emits two same-origin static files per sticker under `apps/web/public/stickers/<pack_id>/<pack_version>/`:
    - `<codepoint>.webp`: animated WebP scaled to `160×160 px` (`<= 100 KB` per file).
    - `<codepoint>.static.webp`: static first/representative frame WebP (`160×160 px`, `<= 15 KB` per file) for reduced-motion and idle picker rendering.
  - Emits the canonical JSON manifest directly to `services/core-api/internal/modules/conversation/stickers/catalog.json` so the Go backend and frontend assets share a single source of truth.
  - **Hard total asset budget**: The entire `apps/web/public/stickers/` directory must not exceed **`10 MB`** (`10,485,760` bytes) and `300` files.
- **Caching headers (`apps/web/public/_headers`)**:
  - `/stickers/*` serves `Cache-Control: public, max-age=31536000, immutable` and `X-Content-Type-Options: nosniff`. Because asset paths include `<pack_version>`, immutable caching is safe across catalog updates.
- **Mandatory `CC BY 4.0` attribution**:
  - Repository root `THIRD_PARTY_NOTICES.md` and public static file `apps/web/public/THIRD_PARTY_NOTICES.txt` (served at `/THIRD_PARTY_NOTICES.txt`) credit **Google Noto Emoji Animation**, link to `https://creativecommons.org/licenses/by/4.0/`, and state the modifications made (curated subset, resized to `160×160` animated WebP, and extracted static frame `.static.webp`).
  - The Sticker picker tab renders a compact attribution line at the bottom of the Noto pack with a link to `/THIRD_PARTY_NOTICES.txt`.

### 2. Platform-owned `go:embed` catalog and feature control

- The sticker catalog is platform reference data embedded into the Core API binary via `go:embed` (`services/core-api/internal/modules/conversation/stickers/catalog.json`); no database table is created for catalog definitions.
- Each sticker entry carries:
  - Stable ID matching `^[a-z0-9_]{1,32}:[a-z0-9_-]{1,64}$` (e.g., `noto_animated:1f602`)
  - Bilingual labels and search keywords (`labels: { vi, en }`, `keywords: { vi, en }`)
  - Dimensions (`width: 160`, `height: 160`), `animated: true`, and lifecycle `status` in `active | retired | removed`:
    - `active`: returned in `GET /api/v1/conversations/sticker-packs`, sendable in new messages, and projected on read.
    - `retired`: omitted from the picker catalog and rejected for new sends (`409 message_embed_unavailable`), but still projected with `available: true` for historical messages.
    - `removed`: omitted from the picker catalog, rejected for new sends, and projected on read as `{ kind: "sticker", available: false }` with all metadata and asset URLs omitted.
- **Feature control**: `chat_stickers` is registered in `services/core-api/internal/modules/featurecontrol/catalog.go` with **`default_enabled: true`** (tenant admins may disable it via feature overrides).

### 3. Database migration `000060_message_embed_stickers`

- Forward migration `000060_message_embed_stickers` alters `tutorhub.message_embeds`:
  - `ALTER TABLE tutorhub.message_embeds ADD COLUMN sticker_id text;`
  - Adds a format check `sticker_id IS NULL OR (char_length(sticker_id) BETWEEN 3 AND 97 AND sticker_id ~ '^[a-z0-9_]{1,32}:[a-z0-9_-]{1,64}$')`.
  - Updates `message_embeds_kind_valid` to enforce the three-way discriminated union:
    - `kind = 'contact_card' AND target_user_id IS NOT NULL AND media_space_id IS NULL AND sticker_id IS NULL`
    - `kind = 'instant_class' AND media_space_id IS NOT NULL AND target_user_id IS NULL AND sticker_id IS NULL`
    - `kind = 'sticker' AND sticker_id IS NOT NULL AND target_user_id IS NULL AND media_space_id IS NULL`
- Down migration refuses rollback with a preflight error if any `kind = 'sticker'` row exists in `tutorhub.message_embeds`.
- Runtime database role privileges on `tutorhub.message_embeds` remain strictly `SELECT, INSERT` (`0` `UPDATE`/`DELETE` privileges).

### 4. OpenAPI contract and send/read rules (`direct`, `class`, and `room`)

- **Catalog endpoint (`GET /api/v1/conversations/sticker-packs`)**:
  - Requires an authenticated session with an active tenant where both `conversations` and `chat_stickers` features are enabled (returning `403 feature_disabled` when disabled).
  - Returns `{ catalog_version, packs: [...] }` containing only packs with at least one `active` sticker and only `active` stickers within each pack, accompanied by `ETag` (supporting `If-None-Match` -> `304 Not Modified`) and `Cache-Control: private, max-age=300`.
- **Sending a sticker (`POST /api/v1/conversations/{conversation_id}/messages`)**:
  - Supported across **`direct`, `class`, and `room`** conversations (`Q1` decision).
  - `MessageEmbedInput` adds `StickerEmbedInput { kind: "sticker", sticker_id }`.
  - `prepareMessageEmbed` checks `chat_stickers` feature availability, validates that `sticker_id` exists in the embedded catalog with `status == "active"`, and enforces existing `authorizeMessageWrite` rules (automatically blocking archived classes and teacher-paused room chat with `409 conversation_read_only`).
  - Inherits all `ADR-0046` invariants: `content` must be `""`, `attachment_ids` must be empty, `PATCH` editing is rejected with `409 message_not_editable`, unsend converts the parent message to a tombstone, and idempotency fingerprints use `\x00embed:sticker\x00` + length + `sticker_id` bytes.
- **Reading a sticker (`MessageEmbed`)**:
  - `loadMessageEmbeds` resolves `sticker_id` against the embedded manifest and projects:
    - When `active` or `retired`: `{ kind: "sticker", available: true, sticker_id, pack_id, labels: { vi, en }, asset: { animated_url, static_url, width, height } }`.
    - When `removed` or unknown: `{ kind: "sticker", available: false }`.

### 5. Web UX, accessibility, and CPU protection

- **`ChatExpressionPicker` (`Sticker | Emoji`)**:
  - Replaces the standalone emoji popover in both `/app/messages` (`ConversationMessages.tsx`) and live classroom room chat (`ClassroomChatPanel.tsx`) when `chat_stickers` is enabled; falls back to the Emoji-only picker when `chat_stickers` is disabled.
  - Implements WAI-ARIA `role="tablist"` (`Sticker` | `Emoji`) with roving tabindex, accent-insensitive `vi`/`en` search across `labels` and `keywords`, a `Recent` row (`tutorhub:chat-sticker-recent:v1:<tenantId>:<userId>`, capped at 24 sticker IDs, wiped on sign-out in `clearPrivateSessionCache`), a 4-column keyboard-navigable sticker grid, a bottom pack strip, and the `CC BY 4.0` attribution footer.
  - Clicking or pressing `Enter`/`Space` on a sticker sends it immediately without discarding any typed text draft in the composer, and returns focus cleanly.
- **CPU & reduced-motion guardrails**:
  - **In the picker grid**: Sticker tiles render `static_url` by default and swap to `animated_url` only while hovered or keyboard-focused (and never when `prefers-reduced-motion: reduce` matches).
  - **In the message thread**: Borderless sticker rendering (`120–148 px`, `loading="lazy"`, `decoding="async"`, explicit `width`/`height` for `CLS = 0`) uses `<picture>` with `<source media="(prefers-reduced-motion: reduce)" srcSet={asset.static_url} />` plus an `IntersectionObserver` that swaps off-screen stickers to `asset.static_url` so scrolling through long threads never decodes dozens of off-screen animated WebPs simultaneously.
- Thread previews, reply quotes, and in-thread search render `[Sticker] {label}` (`conversations.stickerPreview`).

## Consequences

- Students and teachers get instant, lively Zalo-style stickers in both Messages (`direct`, `class`) and live Classroom Room Chat (`room`) with zero third-party network calls, zero CSP relaxation, and full `CC BY 4.0` compliance.
- `tutorhub.message_embeds` remains insert-only (`SELECT, INSERT`), and sticker retirement or legal takedown requires only a manifest status update without mutating historical database rows.
