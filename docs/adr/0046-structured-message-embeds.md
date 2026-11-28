# ADR 0046: Server-authored structured message embeds (`contact_card` and `instant_class`)

- Status: Accepted
- Date: 2026-11-28
- Scope: `MSG-COMPOSER-TOOLS-01` structured message cards (`tutorhub.message_embeds`), contact-card direct conversation resolution, and transactional instant-class sharing
- Extends: ADR-0021 (`P3-02D`), ADR-0025 (`P3-07A` / `P4-08`), ADR-0030 (`P4-01` / `P4-04`), ADR-0042

## Context

In TutorHub's Messages workspace (`/app/messages`), teachers and students need ClassIn/Zalo-style rich composer actions to share a member's **Contact Card** (`Danh thiếp`) or launch and share a **Temporary Instant Class** (`Lớp học tạm thời`) directly inside `direct` and `class` conversations.

Encoding actionable cards inside plain-text message content (for example via custom Markdown fences or URLs) creates three security and integrity hazards:

1. **Client-side spoofing**: Any sender could craft raw text pretending to be an official class invitation or contact card with arbitrary display names, fake countdowns, or cross-tenant IDs.
2. **Stale or leaked identity data**: Persisting a member's display name or email in message text freezes stale PII, leaks email addresses to class peers, and continues displaying departed workspace members.
3. **Broken room access boundaries**: Instant `StudyMeeting` media spaces (`ADR-0021`, `ADR-0030`) are visible only to their owner, org admins, and explicit `media_space_members`. Dropping a bare `/app/media/spaces/{id}/prejoin` link into a conversation without atomically granting membership causes recipients to hit `404`, while loosening `media_spaces` visibility to anyone with a link would bypass tenant/member admission boundaries.

## Decision

### 1. Insert-only child table `tutorhub.message_embeds` (`000059_message_embeds`)

- Forward migration `000059_message_embeds` introduces `tutorhub.message_embeds` keyed by `PRIMARY KEY (tenant_id, message_id)` with composite foreign keys:
  - `(tenant_id, conversation_id, message_id) -> tutorhub.messages (tenant_id, conversation_id, id) ON DELETE CASCADE`
  - `(tenant_id, target_user_id) -> tutorhub.memberships (tenant_id, user_id)`
  - `(tenant_id, media_space_id) -> tutorhub.media_spaces (tenant_id, id)`
- A strict `CHECK` constraint (`message_embeds_kind_valid`) enforces discriminated union integrity:
  - `kind = 'contact_card'`: `target_user_id IS NOT NULL AND media_space_id IS NULL`
  - `kind = 'instant_class'`: `media_space_id IS NOT NULL AND target_user_id IS NULL`
- Least-privilege runtime ACL: `REVOKE ALL ON tutorhub.message_embeds FROM PUBLIC;` and `GRANT SELECT, INSERT ON TABLE tutorhub.message_embeds TO <runtime_role>;` (**no** `UPDATE`, `DELETE`, or `TRUNCATE`).

### 2. Message lifecycle, idempotency, and anti-spoofing invariants

- A message carrying an `embed` is the entire message: `content` must be empty (`""`) and `attachment_ids` must be empty. Web clients render actionable Contact Cards and Instant Class Cards **exclusively** from `ActiveMessage.embed`, never from `ActiveMessage.content`.
- `sendRequestFingerprint` preserves byte-for-byte historical SHA-256 fingerprints when `embed == nil`, and domain-separates card fingerprints (`\x00embed:<kind>\x00<target_uuid_bytes>`) so retrying with the same `client_message_id` replays idempotently (`200 OK`) while changing the card payload returns `409 message_idempotency_conflict`.
- Card messages are immutable after creation: `PATCH /api/v1/conversations/{conversation_id}/messages/{message_id}` rejects any message with a row in `message_embeds` with `409 message_not_editable`.
- Unsend (`DELETE .../messages/{message_id}`) transitions the parent `messages` row to `deleted` tombstone state as usual; `loadMessageEmbeds` queries embeds only for `state = 'active'` messages, so tombstones never expose `embed` without needing `DELETE` privilege on `message_embeds`.

### 3. Contact cards (`contact_card`) and anti-enumeration direct chat creation

- **Send-time validation**: Inside the `SendMessage` transaction, `prepareMessageEmbed` verifies that `target_user_id` is an active user with an active membership in `tenant_id`, and is either the sender (`target_user_id = actor_id`) or the counterparty of an existing canonical `direct` conversation with the sender in the same tenant. Unshareable, unknown, or cross-tenant targets return `409 message_embed_unavailable` without disclosing the reason.
- **Read-time projection**: `loadMessageEmbeds` resolves live membership/user status per reader:
  - When both membership and user remain `active`, it projects `{ kind: "contact_card", available: true, user_id, display_name }` — **never** email or phone number.
  - When the member has left or been deactivated, it projects `{ kind: "contact_card", available: false }` and omits `user_id` and `display_name`.
- **Opening a direct chat without raw user-ID enumeration**: `POST /api/v1/conversations/direct` accepts a `oneOf` union of `{ target_member_email }` or `{ source_message_id }`. `CreateDirectFromContactCard` resolves `source_message_id` against an `active` `contact_card` message in `tenant_id` and enforces `authorizeMessageRead` on its conversation — concealing unreadable, deleted, or cross-tenant messages as `404 conversation_not_found` — before creating or reusing the canonical direct pair.

### 4. Instant class cards (`instant_class`) and transactional space membership

- **Two-step idempotent client flow**: The client first creates (or replays via `idempotency_key`) an instant classless `StudyMeeting` space via `POST /api/v1/media/spaces` (`source.kind = "instant"`, `duration_minutes` in `{15, 30, 45, 60}`), then sends `{ client_message_id, content: "", embed: { kind: "instant_class", media_space_id } }`.
- **Transactional share (`media.ShareInstantStudySpace`)**:
  - Enforces `classroom_media_rooms` and `instant_study_rooms` feature controls, and allows only `direct` and `class` conversations (rejecting `room` conversations with `409 message_embed_unavailable`).
  - Acquires locks in strict DAG order after the tenant control advisory lock and `conversations` row lock: `media_spaces FOR UPDATE` -> `study_meetings FOR UPDATE` -> `media_space_members` (preventing deadlocks with media room/lobby transactions, which never lock `direct` or `class` conversations).
  - Verifies that `media_space_id` belongs to `tenant_id`, is backed by a classless `StudyMeeting` (`class_id IS NULL`) owned by `actor_id`, has space status `scheduled` or `open`, and has `ends_at > now`.
  - Grants the conversation's current active readers (`direct`: counterparty; `class`: class owner + `active` enrollees, bounded to `<= 500`) explicit `active` rows in `tutorhub.media_space_members` via `ON CONFLICT (tenant_id, space_id, user_id) DO NOTHING` and appends `media_space_member.invited.v1` outbox/audit events for newly invited members. Previously `revoked` members remain `revoked`; prejoin and host lobby admission rules (`ADR-0030`) remain unchanged.
- **Read-time projection & monotonic countdown**: `loadMessageEmbeds` projects `{ kind: "instant_class", media_space_id, title, status, ends_at, remaining_seconds, viewer_can_join }` where `remaining_seconds` is computed from PostgreSQL `clock_timestamp()` and `viewer_can_join` is `true` only for the space owner or an `active` `media_space_members` row. Clients count down from `remaining_seconds` using a monotonic clock (`performance.now()`) so skewed client wall clocks cannot falsify remaining time, announcing screen-reader milestones only at `5 minutes`, `1 minute`, and `00:00`.

## Consequences

- Contact Cards and Instant Class Cards cannot be spoofed from message text, edited after send, or used to enumerate arbitrary user IDs or emails.
- Current conversation members can immediately click `Vào lớp` -> `/app/media/spaces/{id}/prejoin` without `404` errors while host lobby control and member revocation remain intact; members who join a class _after_ a snapshot share see `viewer_can_join = false` unless the owner re-shares the card.
- `tutorhub.message_embeds` requires only `SELECT, INSERT` for the Core API runtime role (`0` `UPDATE`/`DELETE` privileges).
