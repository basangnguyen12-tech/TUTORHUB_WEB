//go:build integration

package conversation

import (
	"bytes"
	"context"
	"errors"
	"io"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/tutorhub-v2/core-api/internal/modules/featurecontrol"
	"github.com/tutorhub-v2/core-api/internal/modules/media"
	"github.com/tutorhub-v2/core-api/internal/platform/migrationrunner"
	"github.com/tutorhub-v2/core-api/internal/policy"
)

// MSG-COMPOSER-TOOLS-01: attachments outside room chat, contact cards,
// contact-card directs and instant-class shares against PostgreSQL.
func TestPostgresComposerAttachmentsContactCardsAndInstantClassShares(t *testing.T) {
	migrationURL := requireConversationEnvironment(t, "DATABASE_MIGRATION_URL")
	requireP408WritableIntegrationDatabase(t, migrationURL)
	poolURL := requireConversationEnvironment(t, "DATABASE_POOL_URL")
	ctx, cancel := context.WithTimeout(context.Background(), 180*time.Second)
	defer cancel()
	if err := migrationrunner.Up(ctx, migrationURL); err != nil {
		t.Fatalf("apply composer migrations: %v", err)
	}
	migrationPool := openConversationPool(t, ctx, migrationURL)
	defer migrationPool.Close()
	apiPool := openConversationPool(t, ctx, poolURL)
	defer apiPool.Close()
	fixture := seedConversationFixture(t, ctx, migrationPool)
	service := newComposerIntegrationService(t, apiPool, true)
	owner := integrationAccess(fixture.tenantID, fixture.ownerID, policy.OrganizationRoleTeacher)
	student := integrationAccess(fixture.tenantID, fixture.studentID, policy.OrganizationRoleStudent)
	third := integrationAccess(fixture.tenantID, fixture.thirdID, policy.OrganizationRoleStudent)
	foreign := integrationAccess(fixture.foreignTenantID, fixture.foreignOwnerID, policy.OrganizationRoleTeacher)

	directResult, err := service.CreateDirect(ctx, owner, fixture.studentEmail)
	if err != nil {
		t.Fatalf("create owner-student direct: %v", err)
	}
	direct := directResult.Conversation
	classResult, err := service.CreateClass(ctx, owner, fixture.classID)
	if err != nil {
		t.Fatalf("create class conversation: %v", err)
	}
	class := classResult.Conversation

	// Attachments now work in direct and class conversations.
	png := append([]byte("\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR"), bytes.Repeat([]byte{9}, 32)...)
	for _, target := range []Conversation{direct, class} {
		projected, err := service.Get(ctx, student, target.ID)
		if err != nil || !projected.ViewerAccess.CanUploadAttachments {
			t.Fatalf("%s upload capability=%+v err=%v", target.Kind, projected.ViewerAccess, err)
		}
		upload, err := service.UploadAttachment(ctx, student, target.ID, UploadAttachmentInput{
			ClientAttachmentID: uuid.New(), FileName: "anh-chup.png", Content: png,
		})
		if err != nil || !upload.Created {
			t.Fatalf("%s upload=%+v err=%v", target.Kind, upload, err)
		}
		sent, err := service.SendMessage(ctx, student, target.ID, SendMessageInput{
			ClientMessageID: uuid.New(), AttachmentIDs: []uuid.UUID{upload.Attachment.ID},
		})
		if err != nil || sent.Message.Attachments == nil || len(*sent.Message.Attachments) != 1 {
			t.Fatalf("%s attachment send=%+v err=%v", target.Kind, sent, err)
		}
		content, err := service.ReadAttachmentContent(ctx, owner, target.ID, upload.Attachment.ID)
		if err != nil {
			t.Fatalf("%s attachment read err=%v", target.Kind, err)
		}
		body, readErr := io.ReadAll(content.Body)
		_ = content.Body.Close()
		if readErr != nil || !bytes.Equal(body, png) {
			t.Fatalf("%s attachment bytes mismatch err=%v", target.Kind, readErr)
		}
	}
	if _, err := service.UploadAttachment(ctx, third, class.ID, UploadAttachmentInput{
		ClientAttachmentID: uuid.New(), FileName: "x.png", Content: png,
	}); !errors.Is(err, ErrNotFound) && !errors.Is(err, ErrAccessDenied) {
		t.Fatalf("non-member class upload error=%v", err)
	}
	if _, err := service.UploadAttachment(ctx, foreign, direct.ID, UploadAttachmentInput{
		ClientAttachmentID: uuid.New(), FileName: "x.png", Content: png,
	}); !errors.Is(err, ErrNotFound) && !errors.Is(err, ErrAccessDenied) {
		t.Fatalf("foreign direct upload error=%v", err)
	}

	// Contact cards: the sender or a direct counterparty only.
	cardID := uuid.New()
	card := SendMessageInput{
		ClientMessageID: cardID,
		Embed:           &MessageEmbedInput{Kind: EmbedKindContactCard, UserID: fixture.studentID},
	}
	sentCard, err := service.SendMessage(ctx, owner, class.ID, card)
	if err != nil || !sentCard.Created || sentCard.Message.Embed == nil ||
		sentCard.Message.Embed.Available == nil || !*sentCard.Message.Embed.Available ||
		sentCard.Message.Embed.DisplayName == nil || *sentCard.Message.Embed.DisplayName != "Conversation student" ||
		sentCard.Message.Content == nil || *sentCard.Message.Content != "" {
		t.Fatalf("contact card send=%+v err=%v", sentCard, err)
	}
	replayed, err := service.SendMessage(ctx, owner, class.ID, card)
	if err != nil || replayed.Created || replayed.Message.ID != sentCard.Message.ID || replayed.Message.Embed == nil {
		t.Fatalf("contact card replay=%+v err=%v", replayed, err)
	}
	changed := card
	changed.Embed = &MessageEmbedInput{Kind: EmbedKindContactCard, UserID: fixture.ownerID}
	if _, err := service.SendMessage(ctx, owner, class.ID, changed); !errors.Is(err, ErrIdempotencyConflict) {
		t.Fatalf("changed card replay error=%v, want idempotency conflict", err)
	}
	for name, target := range map[string]uuid.UUID{
		"no direct with sender": fixture.thirdID,
		"foreign tenant member": fixture.foreignOwnerID,
		"unknown user":          uuid.New(),
	} {
		if _, err := service.SendMessage(ctx, owner, class.ID, SendMessageInput{
			ClientMessageID: uuid.New(),
			Embed:           &MessageEmbedInput{Kind: EmbedKindContactCard, UserID: target},
		}); !errors.Is(err, ErrEmbedUnavailable) {
			t.Fatalf("%s card error=%v, want embed unavailable", name, err)
		}
	}
	selfCard, err := service.SendMessage(ctx, owner, class.ID, SendMessageInput{
		ClientMessageID: uuid.New(),
		Embed:           &MessageEmbedInput{Kind: EmbedKindContactCard, UserID: fixture.ownerID},
	})
	if err != nil {
		t.Fatalf("self card: %v", err)
	}
	if _, err := service.EditMessage(ctx, owner, class.ID, selfCard.Message.ID, EditMessageInput{
		Content: "đổi nội dung", ExpectedVersion: selfCard.Message.Version,
	}); !errors.Is(err, ErrMessageNotEditable) {
		t.Fatalf("card edit error=%v, want not editable", err)
	}
	studentPage, err := service.ListMessages(ctx, student, class.ID, MessageListInput{})
	if err != nil {
		t.Fatalf("student list class messages: %v", err)
	}
	var listedCard *MessageEmbed
	for _, item := range studentPage.Items {
		if item.ID == sentCard.Message.ID {
			listedCard = item.Embed
		}
	}
	if listedCard == nil || listedCard.UserID == nil || *listedCard.UserID != fixture.studentID {
		t.Fatalf("listed card=%+v", listedCard)
	}

	// "Message" on a card opens the canonical direct; only readable cards work.
	opened, err := service.CreateDirectFromContactCard(ctx, student, selfCard.Message.ID)
	if err != nil || opened.Created || opened.Conversation.ID != direct.ID {
		t.Fatalf("card direct=%+v err=%v (want existing %s)", opened, err, direct.ID)
	}
	if _, err := service.CreateDirectFromContactCard(ctx, student, sentCard.Message.ID); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("own card direct error=%v, want unavailable", err)
	}
	if _, err := service.CreateDirectFromContactCard(ctx, third, selfCard.Message.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("non-member card direct error=%v, want concealed not found", err)
	}
	if _, err := service.CreateDirectFromContactCard(ctx, foreign, selfCard.Message.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("foreign card direct error=%v, want concealed not found", err)
	}
	textMessage, err := service.SendMessage(ctx, owner, class.ID, SendMessageInput{
		ClientMessageID: uuid.New(), Content: "không phải danh thiếp",
	})
	if err != nil {
		t.Fatalf("text message: %v", err)
	}
	if _, err := service.CreateDirectFromContactCard(ctx, student, textMessage.Message.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("text message direct error=%v, want not found", err)
	}
	deleted, err := service.DeleteMessage(ctx, owner, class.ID, selfCard.Message.ID, DeleteMessageInput{
		ExpectedVersion: selfCard.Message.Version,
	})
	if err != nil || deleted.Embed != nil {
		t.Fatalf("delete card=%+v err=%v", deleted, err)
	}
	if _, err := service.CreateDirectFromContactCard(ctx, student, selfCard.Message.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("deleted card direct error=%v, want not found", err)
	}

	// Instant class shares grant the conversation's readers explicit access.
	spaceID := seedInstantShareSpace(t, ctx, migrationPool, fixture, true)
	if _, err := newComposerIntegrationService(t, apiPool, false).SendMessage(ctx, owner, class.ID, SendMessageInput{
		ClientMessageID: uuid.New(),
		Embed:           &MessageEmbedInput{Kind: EmbedKindInstantClass, MediaSpaceID: spaceID},
	}); !errors.Is(err, ErrEmbedUnavailable) {
		t.Fatalf("share without sharer error=%v, want embed unavailable", err)
	}
	if _, err := service.SendMessage(ctx, student, direct.ID, SendMessageInput{
		ClientMessageID: uuid.New(),
		Embed:           &MessageEmbedInput{Kind: EmbedKindInstantClass, MediaSpaceID: spaceID},
	}); !errors.Is(err, ErrEmbedUnavailable) {
		t.Fatalf("non-owner share error=%v, want embed unavailable", err)
	}
	shared, err := service.SendMessage(ctx, owner, class.ID, SendMessageInput{
		ClientMessageID: uuid.New(),
		Embed:           &MessageEmbedInput{Kind: EmbedKindInstantClass, MediaSpaceID: spaceID},
	})
	embed := shared.Message.Embed
	if err != nil || embed == nil || embed.Title == nil || *embed.Title != "Lớp học tạm thời 15 phút" ||
		embed.Status == nil || *embed.Status != "scheduled" || embed.RemainingSeconds == nil ||
		*embed.RemainingSeconds <= 0 || *embed.RemainingSeconds > 15*60 ||
		embed.ViewerCanJoin == nil || !*embed.ViewerCanJoin {
		t.Fatalf("instant class share=%+v err=%v", shared, err)
	}
	if members := instantShareMembers(t, ctx, migrationPool, fixture.tenantID, spaceID); len(members) != 1 ||
		members[fixture.studentID] != "active" {
		t.Fatalf("shared space members=%v, want only the enrolled student", members)
	}
	var invitedEvents int
	if err := migrationPool.QueryRow(ctx, `
SELECT count(*) FROM tutorhub.outbox_events
WHERE tenant_id = $1 AND aggregate_id = $2 AND event_type = 'media_space_member.invited.v1'`,
		fixture.tenantID, spaceID,
	).Scan(&invitedEvents); err != nil || invitedEvents != 1 {
		t.Fatalf("invited outbox events=%d err=%v", invitedEvents, err)
	}
	studentView, err := service.ListMessages(ctx, student, class.ID, MessageListInput{})
	if err != nil {
		t.Fatalf("student list shared class: %v", err)
	}
	if found := findEmbed(studentView.Items, shared.Message.ID); found == nil ||
		found.ViewerCanJoin == nil || !*found.ViewerCanJoin {
		t.Fatalf("student instant class view=%+v", found)
	}
	if _, err := service.SendMessage(ctx, owner, direct.ID, SendMessageInput{
		ClientMessageID: uuid.New(), Content: "ok",
	}); err != nil {
		t.Fatalf("plain direct send: %v", err)
	}
	// A member the host revoked stays revoked on a later share.
	if _, err := migrationPool.Exec(ctx, `
UPDATE tutorhub.media_space_members
SET status = 'revoked', revoked_by = $3, revoked_at = clock_timestamp(),
    updated_at = clock_timestamp(), version = version + 1
WHERE tenant_id = $1 AND space_id = $2`,
		fixture.tenantID, spaceID, fixture.ownerID,
	); err != nil {
		t.Fatalf("revoke shared member: %v", err)
	}
	if _, err := service.SendMessage(ctx, owner, direct.ID, SendMessageInput{
		ClientMessageID: uuid.New(),
		Embed:           &MessageEmbedInput{Kind: EmbedKindInstantClass, MediaSpaceID: spaceID},
	}); err != nil {
		t.Fatalf("second share: %v", err)
	}
	if members := instantShareMembers(t, ctx, migrationPool, fixture.tenantID, spaceID); members[fixture.studentID] != "revoked" {
		t.Fatalf("revoked member after reshare=%v", members)
	}
	if found := findEmbed(mustListMessages(t, ctx, service, student, class.ID), shared.Message.ID); found == nil ||
		found.ViewerCanJoin == nil || *found.ViewerCanJoin {
		t.Fatalf("revoked student instant class view=%+v", found)
	}
	// Ended spaces cannot be shared and show their status.
	if _, err := migrationPool.Exec(ctx, `
UPDATE tutorhub.media_spaces
SET status = 'ended', opened_at = clock_timestamp(), opened_by = $3,
    ended_at = clock_timestamp(), ended_by = $3, updated_at = clock_timestamp(),
    version = version + 1
WHERE tenant_id = $1 AND id = $2`,
		fixture.tenantID, spaceID, fixture.ownerID,
	); err != nil {
		t.Fatalf("end shared space: %v", err)
	}
	if _, err := service.SendMessage(ctx, owner, class.ID, SendMessageInput{
		ClientMessageID: uuid.New(),
		Embed:           &MessageEmbedInput{Kind: EmbedKindInstantClass, MediaSpaceID: spaceID},
	}); !errors.Is(err, ErrEmbedUnavailable) {
		t.Fatalf("ended share error=%v, want embed unavailable", err)
	}
	if found := findEmbed(mustListMessages(t, ctx, service, owner, class.ID), shared.Message.ID); found == nil ||
		found.Status == nil || *found.Status != "ended" {
		t.Fatalf("ended instant class view=%+v", found)
	}
	// The instant-room feature gate applies to shares.
	secondSpace := seedInstantShareSpace(t, ctx, migrationPool, fixture, false)
	if _, err := migrationPool.Exec(ctx, `
UPDATE tutorhub.tenant_feature_overrides SET enabled = false, updated_at = now()
WHERE tenant_id = $1 AND feature_key = 'instant_study_rooms'`, fixture.tenantID,
	); err != nil {
		t.Fatalf("disable instant rooms: %v", err)
	}
	if _, err := service.SendMessage(ctx, owner, class.ID, SendMessageInput{
		ClientMessageID: uuid.New(),
		Embed:           &MessageEmbedInput{Kind: EmbedKindInstantClass, MediaSpaceID: secondSpace},
	}); !errors.Is(err, featurecontrol.ErrFeatureDisabled) {
		t.Fatalf("disabled instant rooms share error=%v, want feature disabled", err)
	}

	// Archived classes stay read-only for attachments and cards.
	if _, err := migrationPool.Exec(ctx, `
UPDATE tutorhub.classes SET status = 'archived', archived_at = now()
WHERE tenant_id = $1 AND id = $2`, fixture.tenantID, fixture.classID,
	); err != nil {
		t.Fatalf("archive class: %v", err)
	}
	if _, err := service.UploadAttachment(ctx, student, class.ID, UploadAttachmentInput{
		ClientAttachmentID: uuid.New(), FileName: "late.png", Content: png,
	}); !errors.Is(err, ErrReadOnly) {
		t.Fatalf("archived class upload error=%v, want read only", err)
	}
}

func newComposerIntegrationService(t *testing.T, pool *pgxpool.Pool, withSharer bool) *Service {
	t.Helper()
	authorizer := policy.NewEngine()
	controls, err := featurecontrol.NewPostgresRepository(
		pool, 20*time.Second, authorizer, featurecontrol.NewDefaultCatalog(),
	)
	if err != nil {
		t.Fatalf("create composer feature enforcer: %v", err)
	}
	var options []PostgresRepositoryOption
	if withSharer {
		options = append(options, WithInstantSpaceSharer(func(
			ctx context.Context, transaction pgx.Tx, tenantID, spaceID, ownerID uuid.UUID,
			recipientIDs []uuid.UUID, now time.Time,
		) error {
			_, err := media.ShareInstantStudySpace(ctx, transaction, tenantID, spaceID, ownerID, recipientIDs, now)
			if errors.Is(err, media.ErrInstantShareUnavailable) {
				return ErrEmbedUnavailable
			}
			return err
		}))
	}
	repository, err := NewPostgresRepository(pool, 20*time.Second, authorizer, controls, options...)
	if err != nil {
		t.Fatalf("create composer repository: %v", err)
	}
	service, err := NewService(repository, WithAttachmentStorage(AttachmentStorage{AllowInline: true}))
	if err != nil {
		t.Fatalf("create composer service: %v", err)
	}
	return service
}

// seedInstantShareSpace mirrors an instant createMediaSpace: a classless
// StudyMeeting owned by the class owner, ending in 15 minutes.
func seedInstantShareSpace(
	t *testing.T,
	ctx context.Context,
	pool *pgxpool.Pool,
	fixture conversationIntegrationFixture,
	enableFeatures bool,
) uuid.UUID {
	t.Helper()
	meetingID, spaceID := uuid.New(), uuid.New()
	transaction, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin instant share fixture: %v", err)
	}
	defer func() { _ = transaction.Rollback(context.Background()) }()
	if enableFeatures {
		if _, err := transaction.Exec(ctx, `
INSERT INTO tutorhub.tenant_feature_overrides (
    tenant_id, feature_key, enabled, updated_by, created_at, updated_at
)
VALUES ($1, 'classroom_media_rooms', true, $2, now(), now()),
       ($1, 'instant_study_rooms', true, $2, now(), now())`,
			fixture.tenantID, fixture.ownerID,
		); err != nil {
			t.Fatalf("enable instant share features: %v", err)
		}
	}
	if _, err := transaction.Exec(ctx, `
INSERT INTO tutorhub.study_meetings (
    id, tenant_id, owner_user_id, title, starts_at, ends_at, timezone,
    status, create_idempotency_key, create_request_fingerprint
)
VALUES (
    $1, $2, $3, 'Lớp học tạm thời 15 phút', now(), now() + interval '15 minutes',
    'Asia/Ho_Chi_Minh', 'scheduled', $4, decode(repeat('41', 32), 'hex')
)`, meetingID, fixture.tenantID, fixture.ownerID, "instant-share-meeting-"+uuid.NewString(),
	); err != nil {
		t.Fatalf("insert instant share meeting: %v", err)
	}
	if _, err := transaction.Exec(ctx, `
INSERT INTO tutorhub.media_spaces (
    id, tenant_id, source_kind, source_study_meeting_id, status, version,
    lobby_enabled, locked, create_idempotency_key, create_request_fingerprint,
    created_by, updated_by
)
VALUES (
    $1, $2, 'study_meeting', $3, 'scheduled', 1, true, false, $4,
    decode(repeat('42', 32), 'hex'), $5, $5
)`, spaceID, fixture.tenantID, meetingID, "instant-share-space-"+uuid.NewString(), fixture.ownerID,
	); err != nil {
		t.Fatalf("insert instant share space: %v", err)
	}
	if err := transaction.Commit(ctx); err != nil {
		t.Fatalf("commit instant share fixture: %v", err)
	}
	return spaceID
}

func instantShareMembers(
	t *testing.T,
	ctx context.Context,
	pool *pgxpool.Pool,
	tenantID, spaceID uuid.UUID,
) map[uuid.UUID]string {
	t.Helper()
	rows, err := pool.Query(ctx, `
SELECT user_id, status FROM tutorhub.media_space_members
WHERE tenant_id = $1 AND space_id = $2`, tenantID, spaceID)
	if err != nil {
		t.Fatalf("query instant share members: %v", err)
	}
	defer rows.Close()
	members := map[uuid.UUID]string{}
	for rows.Next() {
		var userID uuid.UUID
		var status string
		if err := rows.Scan(&userID, &status); err != nil {
			t.Fatalf("scan instant share member: %v", err)
		}
		members[userID] = status
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("iterate instant share members: %v", err)
	}
	return members
}

func findEmbed(items []Message, messageID uuid.UUID) *MessageEmbed {
	for _, item := range items {
		if item.ID == messageID {
			return item.Embed
		}
	}
	return nil
}

func mustListMessages(
	t *testing.T,
	ctx context.Context,
	service *Service,
	access AccessContext,
	conversationID uuid.UUID,
) []Message {
	t.Helper()
	page, err := service.ListMessages(ctx, access, conversationID, MessageListInput{})
	if err != nil {
		t.Fatalf("list messages: %v", err)
	}
	return page.Items
}
