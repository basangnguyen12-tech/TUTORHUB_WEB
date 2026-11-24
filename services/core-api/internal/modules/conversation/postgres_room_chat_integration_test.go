//go:build integration

package conversation

import (
	"bytes"
	"context"
	"errors"
	"io"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/tutorhub-v2/core-api/internal/modules/featurecontrol"
	"github.com/tutorhub-v2/core-api/internal/platform/migrationrunner"
	"github.com/tutorhub-v2/core-api/internal/policy"
)

// ROOM-CHAT-01 / ADR-0042: host posting switch, attachment idempotency,
// atomic binding, tenant concealment and delete-to-404 against PostgreSQL.
func TestPostgresRoomChatModerationAndAttachmentLifecycle(t *testing.T) {
	migrationURL := requireConversationEnvironment(t, "DATABASE_MIGRATION_URL")
	requireP408WritableIntegrationDatabase(t, migrationURL)
	poolURL := requireConversationEnvironment(t, "DATABASE_POOL_URL")
	ctx, cancel := context.WithTimeout(context.Background(), 180*time.Second)
	defer cancel()
	if err := migrationrunner.Up(ctx, migrationURL); err != nil {
		t.Fatalf("apply room chat migrations: %v", err)
	}
	migrationPool := openConversationPool(t, ctx, migrationURL)
	defer migrationPool.Close()
	apiPool := openConversationPool(t, ctx, poolURL)
	defer apiPool.Close()
	fixture := seedConversationFixture(t, ctx, migrationPool)
	spaceID := seedRoomChatSpace(t, ctx, migrationPool, fixture)
	service := newRoomChatIntegrationService(t, apiPool)
	owner := integrationAccess(fixture.tenantID, fixture.ownerID, policy.OrganizationRoleTeacher)
	student := integrationAccess(fixture.tenantID, fixture.studentID, policy.OrganizationRoleStudent)
	foreign := integrationAccess(fixture.foreignTenantID, fixture.foreignOwnerID, policy.OrganizationRoleTeacher)

	created, err := service.CreateRoom(ctx, owner, spaceID)
	if err != nil {
		t.Fatalf("create room conversation: %v", err)
	}
	room := created.Conversation
	if !room.ParticipantChatEnabled || !room.ViewerAccess.CanModerateChat ||
		!room.ViewerAccess.CanPostMessages || !room.ViewerAccess.CanUploadAttachments {
		t.Fatalf("owner room projection=%+v", room)
	}
	studentRoom, err := service.Get(ctx, student, room.ID)
	if err != nil || studentRoom.ViewerAccess.CanModerateChat || !studentRoom.ViewerAccess.CanPostMessages {
		t.Fatalf("student room projection=%+v err=%v", studentRoom.ViewerAccess, err)
	}

	// Only moderators toggle; a paused room blocks participants with 409 but
	// keeps host announcements open.
	if _, err := service.UpdateRoomSettings(ctx, student, room.ID, RoomSettingsInput{}); !errors.Is(err, ErrAccessDenied) {
		t.Fatalf("student toggle error=%v, want access denied", err)
	}
	if _, err := service.UpdateRoomSettings(ctx, foreign, room.ID, RoomSettingsInput{}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("foreign toggle error=%v, want concealed not found", err)
	}
	paused, err := service.UpdateRoomSettings(ctx, owner, room.ID, RoomSettingsInput{ParticipantChatEnabled: false})
	if err != nil || paused.ParticipantChatEnabled || !paused.ViewerAccess.CanPostMessages {
		t.Fatalf("pause room chat=%+v err=%v", paused, err)
	}
	studentRoom, err = service.Get(ctx, student, room.ID)
	if err != nil || studentRoom.ParticipantChatEnabled || studentRoom.ViewerAccess.CanPostMessages ||
		studentRoom.ViewerAccess.CanUploadAttachments {
		t.Fatalf("paused student projection=%+v err=%v", studentRoom, err)
	}
	if _, err := service.SendMessage(ctx, student, room.ID, SendMessageInput{
		ClientMessageID: uuid.New(), Content: "blocked",
	}); !errors.Is(err, ErrReadOnly) {
		t.Fatalf("paused student send error=%v, want read only", err)
	}
	png := append([]byte("\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR"), bytes.Repeat([]byte{7}, 32)...)
	if _, err := service.UploadAttachment(ctx, student, room.ID, UploadAttachmentInput{
		ClientAttachmentID: uuid.New(), FileName: "blocked.png", Content: png,
	}); !errors.Is(err, ErrReadOnly) {
		t.Fatalf("paused student upload error=%v, want read only", err)
	}
	if _, err := service.SendMessage(ctx, owner, room.ID, SendMessageInput{
		ClientMessageID: uuid.New(), Content: "Tập trung nghe giảng nhé",
	}); err != nil {
		t.Fatalf("paused host announcement: %v", err)
	}
	if _, err := service.UpdateRoomSettings(ctx, owner, room.ID, RoomSettingsInput{ParticipantChatEnabled: true}); err != nil {
		t.Fatalf("resume room chat: %v", err)
	}

	// Upload idempotency: exact replay returns the same row; a different
	// payload under the same key conflicts.
	clientAttachmentID := uuid.New()
	upload := UploadAttachmentInput{ClientAttachmentID: clientAttachmentID, FileName: "bai-tap.png", Content: png}
	first, err := service.UploadAttachment(ctx, student, room.ID, upload)
	if err != nil || !first.Created || first.Attachment.Kind != AttachmentKindImage ||
		first.Attachment.MediaType != "image/png" {
		t.Fatalf("first upload=%+v err=%v", first, err)
	}
	replay, err := service.UploadAttachment(ctx, student, room.ID, upload)
	if err != nil || replay.Created || replay.Attachment.ID != first.Attachment.ID {
		t.Fatalf("upload replay=%+v err=%v", replay, err)
	}
	changed := upload
	changed.Content = append(append([]byte(nil), png...), 1)
	if _, err := service.UploadAttachment(ctx, student, room.ID, changed); !errors.Is(err, ErrIdempotencyConflict) {
		t.Fatalf("changed upload replay error=%v, want idempotency conflict", err)
	}
	if _, err := service.UploadAttachment(ctx, student, room.ID, UploadAttachmentInput{
		ClientAttachmentID: uuid.New(), FileName: "x.svg", Content: []byte(`<svg onload="alert(1)"/>`),
	}); !errors.Is(err, ErrAttachmentUnsupported) {
		t.Fatalf("svg upload error=%v, want unsupported", err)
	}
	// Staged bytes are not readable before they are sent.
	if _, err := service.ReadAttachmentContent(ctx, owner, room.ID, first.Attachment.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("staged read error=%v, want not found", err)
	}
	// The host cannot bind someone else's staged upload.
	if _, err := service.SendMessage(ctx, owner, room.ID, SendMessageInput{
		ClientMessageID: uuid.New(), Content: "", AttachmentIDs: []uuid.UUID{first.Attachment.ID},
	}); !errors.Is(err, ErrAttachmentUnavailable) {
		t.Fatalf("foreign-owner bind error=%v, want attachment unavailable", err)
	}

	sent, err := service.SendMessage(ctx, student, room.ID, SendMessageInput{
		ClientMessageID: uuid.New(), Content: "", AttachmentIDs: []uuid.UUID{first.Attachment.ID},
	})
	if err != nil || !sent.Created || sent.Message.Content == nil || *sent.Message.Content != "" ||
		sent.Message.Attachments == nil || len(*sent.Message.Attachments) != 1 ||
		(*sent.Message.Attachments)[0].ID != first.Attachment.ID {
		t.Fatalf("attachment-only send=%+v err=%v", sent, err)
	}
	if _, err := service.SendMessage(ctx, student, room.ID, SendMessageInput{
		ClientMessageID: uuid.New(), Content: "again", AttachmentIDs: []uuid.UUID{first.Attachment.ID},
	}); !errors.Is(err, ErrAttachmentUnavailable) {
		t.Fatalf("double bind error=%v, want attachment unavailable", err)
	}
	page, err := service.ListMessages(ctx, owner, room.ID, MessageListInput{})
	if err != nil {
		t.Fatalf("list room messages: %v", err)
	}
	var listed *Message
	for index := range page.Items {
		if page.Items[index].Attachments == nil && page.Items[index].State == MessageStateActive {
			t.Fatal("active messages must project an attachments array")
		}
		if page.Items[index].ID == sent.Message.ID {
			listed = &page.Items[index]
		}
	}
	if listed == nil || len(*listed.Attachments) != 1 {
		t.Fatalf("listed attachment message=%+v", listed)
	}
	content, err := service.ReadAttachmentContent(ctx, owner, room.ID, first.Attachment.ID)
	if err != nil {
		t.Fatalf("read attached content: %v", err)
	}
	readBytes, _ := io.ReadAll(content.Body)
	_ = content.Body.Close()
	if !bytes.Equal(readBytes, png) || content.Attachment.DisplayName != "bai-tap.png" {
		t.Fatalf("attached content mismatch: %d bytes", len(readBytes))
	}
	if _, err := service.ReadAttachmentContent(ctx, foreign, room.ID, first.Attachment.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("foreign read error=%v, want concealed not found", err)
	}

	if _, err := service.DeleteMessage(ctx, student, room.ID, sent.Message.ID, DeleteMessageInput{
		ExpectedVersion: sent.Message.Version,
	}); err != nil {
		t.Fatalf("delete attachment message: %v", err)
	}
	if _, err := service.ReadAttachmentContent(ctx, owner, room.ID, first.Attachment.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("deleted attachment read error=%v, want not found", err)
	}
	var state string
	var inlineCleared bool
	if err := migrationPool.QueryRow(ctx, `
SELECT state, inline_bytes IS NULL
FROM tutorhub.message_attachments
WHERE tenant_id = $1 AND id = $2`, fixture.tenantID, first.Attachment.ID).Scan(&state, &inlineCleared); err != nil {
		t.Fatalf("inspect tombstoned attachment: %v", err)
	}
	if state != "deleted" || !inlineCleared {
		t.Fatalf("tombstoned attachment state=%s cleared=%t", state, inlineCleared)
	}
	var sideEffects int
	if err := migrationPool.QueryRow(ctx, `
SELECT
    (SELECT count(*) FROM tutorhub.audit_events
     WHERE tenant_id = $1 AND metadata::text LIKE '%bai-tap%')
  + (SELECT count(*) FROM tutorhub.outbox_events
     WHERE tenant_id = $1 AND payload::text LIKE '%bai-tap%')`, fixture.tenantID).Scan(&sideEffects); err != nil {
		t.Fatalf("inspect attachment side effects: %v", err)
	}
	if sideEffects != 0 {
		t.Fatal("attachment names must never enter audit or outbox rows")
	}
}

func newRoomChatIntegrationService(t *testing.T, pool *pgxpool.Pool) *Service {
	t.Helper()
	authorizer := policy.NewEngine()
	controls, err := featurecontrol.NewPostgresRepository(
		pool, 20*time.Second, authorizer, featurecontrol.NewDefaultCatalog(),
	)
	if err != nil {
		t.Fatalf("create room chat feature enforcer: %v", err)
	}
	repository, err := NewPostgresRepository(pool, 20*time.Second, authorizer, controls)
	if err != nil {
		t.Fatalf("create room chat repository: %v", err)
	}
	service, err := NewService(repository, WithAttachmentStorage(AttachmentStorage{AllowInline: true}))
	if err != nil {
		t.Fatalf("create room chat service: %v", err)
	}
	return service
}

// seedRoomChatSpace mirrors the P4-08 StudyMeeting room fixture: the owner is
// the connected host and the student a connected attendee.
func seedRoomChatSpace(
	t *testing.T,
	ctx context.Context,
	pool *pgxpool.Pool,
	fixture conversationIntegrationFixture,
) uuid.UUID {
	t.Helper()
	meetingID, spaceID, roomID := uuid.New(), uuid.New(), uuid.New()
	transaction, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin room chat fixture: %v", err)
	}
	defer func() { _ = transaction.Rollback(context.Background()) }()
	statements := []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO tutorhub.tenant_feature_overrides (
    tenant_id, feature_key, enabled, updated_by, created_at, updated_at
)
VALUES ($1, 'classroom_media_rooms', true, $2, now(), now())`, []any{fixture.tenantID, fixture.ownerID}},
		{`INSERT INTO tutorhub.study_meetings (
    id, tenant_id, owner_user_id, title, starts_at, ends_at, timezone,
    status, create_idempotency_key, create_request_fingerprint
)
VALUES (
    $1, $2, $3, 'ROOM-CHAT-01 room', now(), now() + interval '1 hour',
    'Asia/Ho_Chi_Minh', 'scheduled', $4, decode(repeat('31', 32), 'hex')
)`, []any{meetingID, fixture.tenantID, fixture.ownerID, "room-chat-study-" + uuid.NewString()}},
		{`INSERT INTO tutorhub.media_spaces (
    id, tenant_id, source_kind, source_study_meeting_id, status, version,
    lobby_enabled, locked, create_idempotency_key, create_request_fingerprint,
    created_by, updated_by, opened_at, opened_by
)
VALUES (
    $1, $2, 'study_meeting', $3, 'open', 2, true, false, $4,
    decode(repeat('32', 32), 'hex'), $5, $5, now(), $5
)`, []any{spaceID, fixture.tenantID, meetingID, "room-chat-space-" + uuid.NewString(), fixture.ownerID}},
		{`INSERT INTO tutorhub.media_space_members (
    tenant_id, space_id, user_id, status, invited_by
)
VALUES ($1, $2, $3, 'active', $4)`, []any{fixture.tenantID, spaceID, fixture.studentID, fixture.ownerID}},
		{`INSERT INTO tutorhub.media_room_instances (
    id, tenant_id, space_id, attempt_number, status, version, provider_kind,
    provider_room_name, provider_room_sid, created_by, updated_by, activated_at
)
VALUES ($1, $2, $3, 1, 'active', 2, 'livekit', $4, $5, $6, $6, now())`, []any{
			roomID, fixture.tenantID, spaceID,
			"room_chat_" + strings.ReplaceAll(uuid.NewString(), "-", ""),
			"RM_" + strings.ReplaceAll(uuid.NewString(), "-", ""), fixture.ownerID,
		}},
		{`INSERT INTO tutorhub.media_participant_sessions (
    id, tenant_id, space_id, room_instance_id, user_id, join_attempt_id,
    provider_participant_identity, instance_role, status, capacity_reserved,
    admitted_at, joining_at, connected_at, roster_sequence
)
VALUES
    ($1, $2, $3, $4, $5, $6, $7, 'host', 'connected', true,
     now() - interval '2 seconds', now() - interval '1 second', now(), 1),
    ($8, $2, $3, $4, $9, $10, $11, 'attendee', 'connected', true,
     now() - interval '2 seconds', now() - interval '1 second', now(), 2)`, []any{
			uuid.New(), fixture.tenantID, spaceID, roomID, fixture.ownerID, uuid.New(),
			"room_chat_owner_" + strings.ReplaceAll(uuid.NewString(), "-", ""),
			uuid.New(), fixture.studentID, uuid.New(),
			"room_chat_student_" + strings.ReplaceAll(uuid.NewString(), "-", ""),
		}},
	}
	for _, statement := range statements {
		if _, err := transaction.Exec(ctx, statement.sql, statement.args...); err != nil {
			t.Fatalf("seed room chat fixture: %v", err)
		}
	}
	if err := transaction.Commit(ctx); err != nil {
		t.Fatalf("commit room chat fixture: %v", err)
	}
	return spaceID
}
