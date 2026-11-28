package conversation

import (
	"context"
	"crypto/subtle"
	"database/sql"
	"errors"
	"fmt"
	"slices"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/tutorhub-v2/core-api/internal/modules/featurecontrol"
	"github.com/tutorhub-v2/core-api/internal/policy"
)

// ROOM-CHAT-01 / ADR-0042 storage for room posting moderation and bounded
// message attachments. Attachment names, bytes and object keys never enter
// audit, outbox, logs or errors from this file.

const actorAttachmentRateQuota featurecontrol.QuotaKey = "actor_message_attachments_per_minute"

// liveRoomModeratorExists is true when the actor is a live participant of the
// active RoomInstance with a host/co-host base role or an active co-host
// assignment. `$1` tenant, `$2` media space, `$3` actor.
const liveRoomModeratorExists = `EXISTS (
    SELECT 1
    FROM tutorhub.media_participant_sessions AS moderator_session
    JOIN tutorhub.media_room_instances AS moderator_room
      ON moderator_room.tenant_id = moderator_session.tenant_id
     AND moderator_room.space_id = moderator_session.space_id
     AND moderator_room.id = moderator_session.room_instance_id
     AND moderator_room.status = 'active'
    WHERE moderator_session.tenant_id = $1
      AND moderator_session.space_id = $2
      AND moderator_session.user_id = $3
      AND moderator_session.status IN ('admitted', 'joining', 'connected', 'reconnecting')
      AND (
          moderator_session.instance_role IN ('host', 'co_host')
          OR EXISTS (
              SELECT 1
              FROM tutorhub.media_room_role_assignments AS moderator_assignment
              WHERE moderator_assignment.tenant_id = moderator_session.tenant_id
                AND moderator_assignment.room_instance_id = moderator_session.room_instance_id
                AND moderator_assignment.user_id = moderator_session.user_id
                AND moderator_assignment.assigned_role = 'co_host'
                AND moderator_assignment.status = 'active'
          )
      )
)`

func hasOrganizationAdmin(access AccessContext) bool {
	return slices.Contains(access.OrganizationRoles, policy.OrganizationRoleAdmin)
}

func classRolesModerateRoomChat(access AccessContext, classRoles []policy.ClassRole) bool {
	return hasOrganizationAdmin(access) ||
		slices.Contains(classRoles, policy.ClassRoleOwner) ||
		slices.Contains(classRoles, policy.ClassRoleCoTeacher)
}

// applyRoomChatControls finalizes room projections with the host posting
// switch and live moderation authority in one bounded query per page.
func (repository *PostgresRepository) applyRoomChatControls(
	ctx context.Context,
	transaction pgx.Tx,
	access AccessContext,
	items []Conversation,
) error {
	roomIDs := make([]uuid.UUID, 0, len(items))
	for _, item := range items {
		if item.Kind == KindRoom {
			roomIDs = append(roomIDs, item.ID)
		}
	}
	if len(roomIDs) == 0 {
		return nil
	}
	type roomChatState struct {
		participantChatEnabled bool
		liveModerator          bool
	}
	rows, err := transaction.Query(
		ctx,
		`SELECT
    conversation.id,
    COALESCE(settings.participant_chat_enabled, true),
    EXISTS (
        SELECT 1
        FROM tutorhub.media_participant_sessions AS moderator_session
        JOIN tutorhub.media_room_instances AS moderator_room
          ON moderator_room.tenant_id = moderator_session.tenant_id
         AND moderator_room.space_id = moderator_session.space_id
         AND moderator_room.id = moderator_session.room_instance_id
         AND moderator_room.status = 'active'
        WHERE moderator_session.tenant_id = conversation.tenant_id
          AND moderator_session.space_id = conversation.media_space_id
          AND moderator_session.user_id = $3
          AND moderator_session.status IN ('admitted', 'joining', 'connected', 'reconnecting')
          AND (
              moderator_session.instance_role IN ('host', 'co_host')
              OR EXISTS (
                  SELECT 1
                  FROM tutorhub.media_room_role_assignments AS moderator_assignment
                  WHERE moderator_assignment.tenant_id = moderator_session.tenant_id
                    AND moderator_assignment.room_instance_id = moderator_session.room_instance_id
                    AND moderator_assignment.user_id = moderator_session.user_id
                    AND moderator_assignment.assigned_role = 'co_host'
                    AND moderator_assignment.status = 'active'
              )
          )
    )
FROM tutorhub.conversations AS conversation
LEFT JOIN tutorhub.room_conversation_settings AS settings
  ON settings.tenant_id = conversation.tenant_id
 AND settings.conversation_id = conversation.id
WHERE conversation.tenant_id = $1
  AND conversation.id = ANY($2::uuid[])
  AND conversation.kind = 'room'`,
		access.TenantID,
		roomIDs,
		access.ActorID,
	)
	if err != nil {
		return fmt.Errorf("query room chat controls: %w", err)
	}
	defer rows.Close()
	states := make(map[uuid.UUID]roomChatState, len(roomIDs))
	for rows.Next() {
		var id uuid.UUID
		var state roomChatState
		if err := rows.Scan(&id, &state.participantChatEnabled, &state.liveModerator); err != nil {
			return fmt.Errorf("scan room chat controls: %w", err)
		}
		states[id] = state
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("iterate room chat controls: %w", err)
	}
	for index := range items {
		item := &items[index]
		if item.Kind != KindRoom {
			continue
		}
		state, ok := states[item.ID]
		if !ok {
			state = roomChatState{participantChatEnabled: true}
		}
		open := item.MediaSpaceStatus != nil && *item.MediaSpaceStatus == "open"
		item.ParticipantChatEnabled = state.participantChatEnabled
		item.ViewerAccess.CanModerateChat = open &&
			(item.roomSourceModerator || state.liveModerator)
		if !item.ParticipantChatEnabled && !item.ViewerAccess.CanModerateChat {
			item.ViewerAccess.CanPostMessages = false
		}
	}
	return nil
}

// roomChatModeratorAuthority re-derives moderation authority inside a write
// transaction. The MediaSpace row is already share-locked by the caller.
func roomChatModeratorAuthority(
	ctx context.Context,
	transaction pgx.Tx,
	access AccessContext,
	mediaSpaceID uuid.UUID,
) (bool, error) {
	if hasOrganizationAdmin(access) {
		return true, nil
	}
	var sourceKind string
	var classOwner, studyOwner sql.NullBool
	var enrollmentRole sql.NullString
	var liveModerator bool
	if err := transaction.QueryRow(
		ctx,
		`SELECT
    space.source_kind,
    class.owner_user_id = $3,
    CASE WHEN enrollment.status = 'active' THEN enrollment.class_role END,
    study_meeting.owner_user_id = $3,
    `+liveRoomModeratorExists+`
FROM tutorhub.media_spaces AS space
LEFT JOIN tutorhub.classes AS class
  ON class.tenant_id = space.tenant_id
 AND class.id = space.class_id
LEFT JOIN tutorhub.class_enrollments AS enrollment
  ON enrollment.tenant_id = space.tenant_id
 AND enrollment.class_id = space.class_id
 AND enrollment.user_id = $3
LEFT JOIN tutorhub.study_meetings AS study_meeting
  ON study_meeting.tenant_id = space.tenant_id
 AND study_meeting.id = space.source_study_meeting_id
WHERE space.tenant_id = $1 AND space.id = $2`,
		access.TenantID,
		mediaSpaceID,
		access.ActorID,
	).Scan(&sourceKind, &classOwner, &enrollmentRole, &studyOwner, &liveModerator); errors.Is(err, pgx.ErrNoRows) {
		return false, ErrNotFound
	} else if err != nil {
		return false, fmt.Errorf("resolve room chat moderation authority: %w", err)
	}
	if liveModerator {
		return true, nil
	}
	switch sourceKind {
	case "class_session", "class_session_occurrence":
		classRoles := make([]policy.ClassRole, 0, 2)
		if classOwner.Valid && classOwner.Bool {
			classRoles = append(classRoles, policy.ClassRoleOwner)
		}
		if enrollmentRole.Valid {
			classRoles = append(classRoles, policy.ClassRole(enrollmentRole.String))
		}
		return classRolesModerateRoomChat(access, classRoles), nil
	case "study_meeting":
		return studyOwner.Valid && studyOwner.Bool, nil
	default:
		return false, nil
	}
}

// requireRoomChatPosting runs after the conversation row lock, so it is
// serialized with UpdateRoomSettings (which takes the same lock first).
func (repository *PostgresRepository) requireRoomChatPosting(
	ctx context.Context,
	transaction pgx.Tx,
	access AccessContext,
	conversationID, mediaSpaceID uuid.UUID,
) error {
	var enabled bool
	if err := transaction.QueryRow(
		ctx,
		`SELECT COALESCE((
    SELECT participant_chat_enabled
    FROM tutorhub.room_conversation_settings
    WHERE tenant_id = $1 AND conversation_id = $2
), true)`,
		access.TenantID,
		conversationID,
	).Scan(&enabled); err != nil {
		return fmt.Errorf("read room chat posting switch: %w", err)
	}
	if enabled {
		return nil
	}
	moderator, err := roomChatModeratorAuthority(ctx, transaction, access, mediaSpaceID)
	if err != nil {
		return err
	}
	if !moderator {
		return ErrReadOnly
	}
	return nil
}

func (repository *PostgresRepository) UpdateRoomSettings(
	ctx context.Context,
	access AccessContext,
	conversationID uuid.UUID,
	input RoomSettingsInput,
) (Conversation, error) {
	queryContext, cancel := context.WithTimeout(ctx, repository.queryTimeout)
	defer cancel()
	transaction, err := repository.database.Begin(queryContext)
	if err != nil {
		return Conversation{}, fmt.Errorf("begin room settings update: %w", err)
	}
	defer rollback(transaction)
	access, err = repository.authorizeMessageRead(queryContext, transaction, access, conversationID)
	if err != nil {
		return Conversation{}, err
	}
	var mediaSpaceID uuid.NullUUID
	if err := transaction.QueryRow(
		queryContext,
		`SELECT media_space_id
FROM tutorhub.conversations
WHERE tenant_id = $1 AND id = $2 AND kind = 'room'`,
		access.TenantID,
		conversationID,
	).Scan(&mediaSpaceID); errors.Is(err, pgx.ErrNoRows) || (err == nil && !mediaSpaceID.Valid) {
		return Conversation{}, ErrNotFound
	} else if err != nil {
		return Conversation{}, fmt.Errorf("resolve room settings conversation: %w", err)
	}
	for _, feature := range []featurecontrol.FeatureKey{
		featurecontrol.FeatureConversations,
		featurecontrol.FeatureClassroomMediaRooms,
	} {
		if err := repository.controls.RequireFeature(
			queryContext, transaction, access.TenantID, feature,
		); err != nil {
			return Conversation{}, err
		}
	}
	// Same lock order as a room message write: MediaSpace, then conversation.
	var spaceStatus string
	if err := transaction.QueryRow(
		queryContext,
		`SELECT status
FROM tutorhub.media_spaces
WHERE tenant_id = $1 AND id = $2
FOR SHARE`,
		access.TenantID,
		mediaSpaceID.UUID,
	).Scan(&spaceStatus); errors.Is(err, pgx.ErrNoRows) {
		return Conversation{}, ErrNotFound
	} else if err != nil {
		return Conversation{}, fmt.Errorf("lock room settings media space: %w", err)
	}
	member, err := lockActorMember(queryContext, transaction, access.TenantID, access.ActorID)
	if err != nil {
		return Conversation{}, err
	}
	access.MembershipActive = member.Active
	access.OrganizationRoles = []policy.OrganizationRole{member.Role}
	moderator, err := roomChatModeratorAuthority(
		queryContext, transaction, access, mediaSpaceID.UUID,
	)
	if err != nil {
		return Conversation{}, err
	}
	if !moderator {
		return Conversation{}, ErrAccessDenied
	}
	if spaceStatus != "open" {
		return Conversation{}, ErrReadOnly
	}
	var lockedID uuid.UUID
	if err := transaction.QueryRow(
		queryContext,
		`SELECT id
FROM tutorhub.conversations
WHERE tenant_id = $1 AND id = $2
FOR UPDATE`,
		access.TenantID,
		conversationID,
	).Scan(&lockedID); errors.Is(err, pgx.ErrNoRows) {
		return Conversation{}, ErrNotFound
	} else if err != nil {
		return Conversation{}, fmt.Errorf("lock room settings conversation: %w", err)
	}
	if _, err := transaction.Exec(
		queryContext,
		`INSERT INTO tutorhub.room_conversation_settings AS settings (
    tenant_id, conversation_id, participant_chat_enabled,
    updated_by_user_id, updated_at
)
VALUES ($1, $2, $3, $4, clock_timestamp())
ON CONFLICT (tenant_id, conversation_id)
DO UPDATE SET
    participant_chat_enabled = EXCLUDED.participant_chat_enabled,
    updated_by_user_id = EXCLUDED.updated_by_user_id,
    updated_at = EXCLUDED.updated_at
WHERE settings.participant_chat_enabled IS DISTINCT FROM EXCLUDED.participant_chat_enabled`,
		access.TenantID,
		conversationID,
		input.ParticipantChatEnabled,
		access.ActorID,
	); err != nil {
		return Conversation{}, fmt.Errorf("store room chat settings: %w", err)
	}
	row, err := loadConversationRow(
		queryContext, transaction, access.TenantID, access.ActorID, conversationID,
	)
	if err != nil {
		return Conversation{}, fmt.Errorf("reload room settings conversation: %w", err)
	}
	item, err := repository.project(access, row, policy.ActionClassView)
	if err != nil {
		return Conversation{}, err
	}
	items := []Conversation{item}
	if err := repository.applyRoomChatControls(queryContext, transaction, access, items); err != nil {
		return Conversation{}, err
	}
	if err := transaction.Commit(queryContext); err != nil {
		return Conversation{}, fmt.Errorf("commit room settings update: %w", err)
	}
	return items[0], nil
}

const attachmentProjection = `
    attachment.id,
    attachment.conversation_id,
    attachment.kind,
    attachment.display_name,
    attachment.media_type,
    attachment.size_bytes,
    attachment.width_px,
    attachment.height_px,
    attachment.created_at`

func scanAttachment(row rowScanner, extra ...any) (MessageAttachment, error) {
	var item MessageAttachment
	var width, height sql.NullInt32
	values := append([]any{
		&item.ID,
		&item.ConversationID,
		&item.Kind,
		&item.DisplayName,
		&item.MediaType,
		&item.SizeBytes,
		&width,
		&height,
		&item.CreatedAt,
	}, extra...)
	if err := row.Scan(values...); err != nil {
		return MessageAttachment{}, err
	}
	if width.Valid {
		value := int(width.Int32)
		item.WidthPx = &value
	}
	if height.Valid {
		value := int(height.Int32)
		item.HeightPx = &value
	}
	return item, nil
}

type idempotentAttachment struct {
	attachment     MessageAttachment
	conversationID uuid.UUID
	fingerprint    []byte
}

func loadIdempotentAttachment(
	ctx context.Context,
	transaction pgx.Tx,
	tenantID, uploaderID, clientAttachmentID uuid.UUID,
) (idempotentAttachment, bool, error) {
	var result idempotentAttachment
	item, err := scanAttachment(transaction.QueryRow(
		ctx,
		`SELECT`+attachmentProjection+`,
    attachment.request_fingerprint
FROM tutorhub.message_attachments AS attachment
WHERE attachment.tenant_id = $1
  AND attachment.uploader_user_id = $2
  AND attachment.client_attachment_id = $3`,
		tenantID,
		uploaderID,
		clientAttachmentID,
	), &result.fingerprint)
	if errors.Is(err, pgx.ErrNoRows) {
		return idempotentAttachment{}, false, nil
	}
	if err != nil {
		return idempotentAttachment{}, false, safeMessageStoreError("load idempotent attachment", err)
	}
	result.attachment = item
	result.conversationID = item.ConversationID
	return result, true, nil
}

func matchIdempotentAttachment(
	existing idempotentAttachment,
	conversationID uuid.UUID,
	fingerprint []byte,
) (MessageAttachment, error) {
	if existing.conversationID != conversationID ||
		subtle.ConstantTimeCompare(existing.fingerprint, fingerprint) != 1 {
		return MessageAttachment{}, ErrIdempotencyConflict
	}
	return existing.attachment, nil
}

func (repository *PostgresRepository) FindAttachmentReplay(
	ctx context.Context,
	access AccessContext,
	conversationID, clientAttachmentID uuid.UUID,
	fingerprint []byte,
) (MessageAttachment, bool, error) {
	queryContext, cancel := context.WithTimeout(ctx, repository.queryTimeout)
	defer cancel()
	transaction, err := repository.database.Begin(queryContext)
	if err != nil {
		return MessageAttachment{}, false, fmt.Errorf("begin attachment replay lookup: %w", err)
	}
	defer rollback(transaction)
	access, err = repository.authorizeMessageRead(queryContext, transaction, access, conversationID)
	if err != nil {
		return MessageAttachment{}, false, err
	}
	existing, found, err := loadIdempotentAttachment(
		queryContext, transaction, access.TenantID, access.ActorID, clientAttachmentID,
	)
	if err != nil || !found {
		return MessageAttachment{}, false, err
	}
	item, err := matchIdempotentAttachment(existing, conversationID, fingerprint)
	if err != nil {
		return MessageAttachment{}, false, err
	}
	if err := transaction.Commit(queryContext); err != nil {
		return MessageAttachment{}, false, fmt.Errorf("commit attachment replay lookup: %w", err)
	}
	return item, true, nil
}

func (repository *PostgresRepository) CreateAttachment(
	ctx context.Context,
	access AccessContext,
	conversationID uuid.UUID,
	record attachmentRecord,
) (MessageAttachment, bool, []string, error) {
	queryContext, cancel := context.WithTimeout(ctx, repository.queryTimeout)
	defer cancel()
	transaction, err := repository.database.Begin(queryContext)
	if err != nil {
		return MessageAttachment{}, false, nil, fmt.Errorf("begin attachment upload: %w", err)
	}
	defer rollback(transaction)
	access, err = repository.authorizeMessageRead(queryContext, transaction, access, conversationID)
	if err != nil {
		return MessageAttachment{}, false, nil, err
	}
	// MSG-COMPOSER-TOOLS-01 (ADR-0042 amendment): every conversation kind
	// accepts attachments from members who may post in it.
	if err := repository.controls.RequireFeature(
		queryContext, transaction, access.TenantID, featurecontrol.FeatureConversations,
	); err != nil {
		return MessageAttachment{}, false, nil, err
	}
	// Direct membership, class chat policy and archived state, or the room
	// source, live participant and posting switch, plus the conversation row
	// lock, are all enforced exactly as for a message send.
	access, err = repository.authorizeMessageWrite(queryContext, transaction, access, conversationID)
	if err != nil {
		return MessageAttachment{}, false, nil, err
	}
	if existing, found, err := loadIdempotentAttachment(
		queryContext, transaction, access.TenantID, access.ActorID, record.ClientAttachmentID,
	); err != nil {
		return MessageAttachment{}, false, nil, err
	} else if found {
		item, err := matchIdempotentAttachment(existing, conversationID, record.Fingerprint)
		if err != nil {
			return MessageAttachment{}, false, nil, err
		}
		if err := transaction.Commit(queryContext); err != nil {
			return MessageAttachment{}, false, nil, fmt.Errorf("commit attachment replay: %w", err)
		}
		return item, false, nil, nil
	}
	var now time.Time
	if err := transaction.QueryRow(queryContext, `SELECT clock_timestamp()`).Scan(&now); err != nil {
		return MessageAttachment{}, false, nil, fmt.Errorf("read attachment server time: %w", err)
	}
	now = now.UTC()
	expiredKeys, err := expireStagedAttachments(queryContext, transaction, access, now)
	if err != nil {
		return MessageAttachment{}, false, nil, err
	}
	if err := enforceActorAttachmentRate(queryContext, transaction, access, now); err != nil {
		return MessageAttachment{}, false, expiredKeys, err
	}
	var objectKey any
	if record.ObjectKey != "" {
		objectKey = record.ObjectKey
	}
	var inlineBytes any
	if record.InlineBytes != nil {
		inlineBytes = record.InlineBytes
	}
	item, err := scanAttachment(transaction.QueryRow(
		queryContext,
		`INSERT INTO tutorhub.message_attachments AS attachment (
    id, tenant_id, conversation_id, uploader_user_id, client_attachment_id,
    request_fingerprint, kind, display_name, media_type, size_bytes,
    width_px, height_px, storage_backend, object_key, inline_bytes,
    state, expires_at, created_at, updated_at
)
VALUES (
    $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
    'staged', $16, $17, $17
)
RETURNING`+attachmentProjection,
		record.ID,
		access.TenantID,
		conversationID,
		access.ActorID,
		record.ClientAttachmentID,
		record.Fingerprint,
		string(record.Kind),
		record.DisplayName,
		record.MediaType,
		record.SizeBytes,
		record.WidthPx,
		record.HeightPx,
		record.Backend,
		objectKey,
		inlineBytes,
		now.Add(stagedAttachmentLifetime),
		now,
	))
	if err != nil {
		return MessageAttachment{}, false, expiredKeys, safeMessageStoreError("insert attachment", err)
	}
	if err := transaction.Commit(queryContext); err != nil {
		return MessageAttachment{}, false, expiredKeys, fmt.Errorf("commit attachment upload: %w", err)
	}
	return item, true, expiredKeys, nil
}

// expireStagedAttachments tombstones the actor's abandoned uploads so staged
// bytes stay bounded without a background worker.
func expireStagedAttachments(
	ctx context.Context,
	transaction pgx.Tx,
	access AccessContext,
	now time.Time,
) ([]string, error) {
	rows, err := transaction.Query(
		ctx,
		`UPDATE tutorhub.message_attachments
SET state = 'deleted',
    inline_bytes = NULL,
    updated_at = greatest(updated_at, $3)
WHERE tenant_id = $1
  AND uploader_user_id = $2
  AND state = 'staged'
  AND expires_at <= $3
RETURNING object_key`,
		access.TenantID,
		access.ActorID,
		now,
	)
	if err != nil {
		return nil, fmt.Errorf("expire staged attachments: %w", err)
	}
	return collectObjectKeys(rows, "expire staged attachments")
}

func enforceActorAttachmentRate(
	ctx context.Context,
	transaction pgx.Tx,
	access AccessContext,
	now time.Time,
) error {
	var used int64
	var oldest sql.NullTime
	if err := transaction.QueryRow(
		ctx,
		`SELECT count(*), min(created_at)
FROM tutorhub.message_attachments
WHERE tenant_id = $1
  AND uploader_user_id = $2
  AND created_at >= $3`,
		access.TenantID,
		access.ActorID,
		now.Add(-actorAttachmentRateWindow),
	).Scan(&used, &oldest); err != nil {
		return fmt.Errorf("inspect actor attachment rate: %w", err)
	}
	if used < actorAttachmentRateLimit {
		return nil
	}
	retryAfter := actorAttachmentRateWindow
	if oldest.Valid {
		retryAfter = oldest.Time.Add(actorAttachmentRateWindow).Sub(now)
		if retryAfter < time.Second {
			retryAfter = time.Second
		}
	}
	return &featurecontrol.QuotaExceededError{
		Quota:      actorAttachmentRateQuota,
		Limit:      actorAttachmentRateLimit,
		Used:       used,
		ResetAt:    now.Add(retryAfter),
		RetryAfter: retryAfter,
	}
}

// bindMessageAttachments atomically moves every requested staged upload of
// the actor in this conversation onto the new message.
func bindMessageAttachments(
	ctx context.Context,
	transaction pgx.Tx,
	access AccessContext,
	conversationID, messageID uuid.UUID,
	attachmentIDs []uuid.UUID,
	now time.Time,
) error {
	if len(attachmentIDs) == 0 {
		return nil
	}
	tag, err := transaction.Exec(
		ctx,
		`UPDATE tutorhub.message_attachments
SET message_id = $4,
    state = 'attached',
    updated_at = greatest(updated_at, $6)
WHERE tenant_id = $1
  AND conversation_id = $2
  AND uploader_user_id = $3
  AND id = ANY($5::uuid[])
  AND state = 'staged'
  AND message_id IS NULL
  AND expires_at > $6`,
		access.TenantID,
		conversationID,
		access.ActorID,
		messageID,
		attachmentIDs,
		now,
	)
	if err != nil {
		return safeMessageStoreError("bind message attachments", err)
	}
	if tag.RowsAffected() != int64(len(attachmentIDs)) {
		return ErrAttachmentUnavailable
	}
	return nil
}

// tombstoneMessageAttachments clears inline bytes and returns object keys to
// delete after commit.
func tombstoneMessageAttachments(
	ctx context.Context,
	transaction pgx.Tx,
	tenantID, conversationID, messageID uuid.UUID,
) ([]string, error) {
	rows, err := transaction.Query(
		ctx,
		`UPDATE tutorhub.message_attachments
SET state = 'deleted',
    inline_bytes = NULL,
    updated_at = greatest(updated_at, clock_timestamp())
WHERE tenant_id = $1
  AND conversation_id = $2
  AND message_id = $3
  AND state <> 'deleted'
RETURNING object_key`,
		tenantID,
		conversationID,
		messageID,
	)
	if err != nil {
		return nil, fmt.Errorf("tombstone message attachments: %w", err)
	}
	return collectObjectKeys(rows, "tombstone message attachments")
}

func collectObjectKeys(rows pgx.Rows, operation string) ([]string, error) {
	defer rows.Close()
	keys := make([]string, 0)
	for rows.Next() {
		var key sql.NullString
		if err := rows.Scan(&key); err != nil {
			return nil, fmt.Errorf("%s: scan object key: %w", operation, err)
		}
		if key.Valid && key.String != "" {
			keys = append(keys, key.String)
		}
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("%s: %w", operation, err)
	}
	return keys, nil
}

// loadMessageAttachments batches attached rows for one message page in a
// single query (no N+1) and fills every active message with a non-nil slice.
func loadMessageAttachments(
	ctx context.Context,
	transaction pgx.Tx,
	tenantID, conversationID uuid.UUID,
	items []Message,
) error {
	activeIDs := make([]uuid.UUID, 0, len(items))
	for index := range items {
		if items[index].State == MessageStateActive {
			empty := []MessageAttachment{}
			items[index].Attachments = &empty
			activeIDs = append(activeIDs, items[index].ID)
		}
	}
	if len(activeIDs) == 0 {
		return nil
	}
	rows, err := transaction.Query(
		ctx,
		`SELECT attachment.message_id,`+attachmentProjection+`
FROM tutorhub.message_attachments AS attachment
WHERE attachment.tenant_id = $1
  AND attachment.conversation_id = $2
  AND attachment.message_id = ANY($3::uuid[])
  AND attachment.state = 'attached'
ORDER BY attachment.created_at, attachment.id`,
		tenantID,
		conversationID,
		activeIDs,
	)
	if err != nil {
		return fmt.Errorf("query message attachments: %w", err)
	}
	defer rows.Close()
	byMessage := make(map[uuid.UUID][]MessageAttachment, len(activeIDs))
	for rows.Next() {
		var messageID uuid.UUID
		var item MessageAttachment
		var width, height sql.NullInt32
		if err := rows.Scan(
			&messageID,
			&item.ID,
			&item.ConversationID,
			&item.Kind,
			&item.DisplayName,
			&item.MediaType,
			&item.SizeBytes,
			&width,
			&height,
			&item.CreatedAt,
		); err != nil {
			return safeMessageStoreError("scan message attachment", err)
		}
		if width.Valid {
			value := int(width.Int32)
			item.WidthPx = &value
		}
		if height.Valid {
			value := int(height.Int32)
			item.HeightPx = &value
		}
		byMessage[messageID] = append(byMessage[messageID], item)
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("iterate message attachments: %w", err)
	}
	for index := range items {
		if attachments, ok := byMessage[items[index].ID]; ok && items[index].Attachments != nil {
			*items[index].Attachments = attachments
		}
	}
	return nil
}

func (repository *PostgresRepository) ReadAttachment(
	ctx context.Context,
	access AccessContext,
	conversationID, attachmentID uuid.UUID,
) (storedAttachment, error) {
	queryContext, cancel := context.WithTimeout(ctx, repository.queryTimeout)
	defer cancel()
	transaction, err := repository.database.Begin(queryContext)
	if err != nil {
		return storedAttachment{}, fmt.Errorf("begin attachment read: %w", err)
	}
	defer rollback(transaction)
	access, err = repository.authorizeMessageRead(queryContext, transaction, access, conversationID)
	if err != nil {
		return storedAttachment{}, err
	}
	var result storedAttachment
	var objectKey sql.NullString
	item, err := scanAttachment(transaction.QueryRow(
		queryContext,
		`SELECT`+attachmentProjection+`,
    attachment.storage_backend,
    attachment.object_key,
    attachment.inline_bytes
FROM tutorhub.message_attachments AS attachment
JOIN tutorhub.messages AS message
  ON message.tenant_id = attachment.tenant_id
 AND message.conversation_id = attachment.conversation_id
 AND message.id = attachment.message_id
WHERE attachment.tenant_id = $1
  AND attachment.conversation_id = $2
  AND attachment.id = $3
  AND attachment.state = '`+attachmentStateAttached+`'
  AND message.state = 'active'`,
		access.TenantID,
		conversationID,
		attachmentID,
	), &result.Backend, &objectKey, &result.InlineBytes)
	if errors.Is(err, pgx.ErrNoRows) {
		return storedAttachment{}, ErrNotFound
	}
	if err != nil {
		return storedAttachment{}, safeMessageStoreError("load attachment content", err)
	}
	result.Attachment = item
	if objectKey.Valid {
		result.ObjectKey = objectKey.String
	}
	if result.Backend == attachmentBackendInline &&
		int64(len(result.InlineBytes)) != item.SizeBytes {
		return storedAttachment{}, fmt.Errorf("inline attachment size mismatch")
	}
	if err := transaction.Commit(queryContext); err != nil {
		return storedAttachment{}, fmt.Errorf("commit attachment read: %w", err)
	}
	return result, nil
}
