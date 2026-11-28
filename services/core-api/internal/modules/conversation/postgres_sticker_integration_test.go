//go:build integration

package conversation

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/tutorhub-v2/core-api/internal/modules/conversation/stickers"
	"github.com/tutorhub-v2/core-api/internal/modules/featurecontrol"
	"github.com/tutorhub-v2/core-api/internal/platform/migrationrunner"
	"github.com/tutorhub-v2/core-api/internal/policy"
)

// MSG-STICKER-01 (ADR-0047): sticker messages against PostgreSQL —
// send/replay/conflict, read projection, removed stickers, immutability,
// tombstones, the 000060 constraints, archived classes and chat_stickers.
func TestPostgresStickerMessagesFollowCatalogAndConversationRules(t *testing.T) {
	migrationURL := requireConversationEnvironment(t, "DATABASE_MIGRATION_URL")
	requireP408WritableIntegrationDatabase(t, migrationURL)
	poolURL := requireConversationEnvironment(t, "DATABASE_POOL_URL")
	ctx, cancel := context.WithTimeout(context.Background(), 180*time.Second)
	defer cancel()
	if err := migrationrunner.Up(ctx, migrationURL); err != nil {
		t.Fatalf("apply sticker migrations: %v", err)
	}
	migrationPool := openConversationPool(t, ctx, migrationURL)
	defer migrationPool.Close()
	apiPool := openConversationPool(t, ctx, poolURL)
	defer apiPool.Close()
	fixture := seedConversationFixture(t, ctx, migrationPool)
	service := newComposerIntegrationService(t, apiPool, false)
	owner := integrationAccess(fixture.tenantID, fixture.ownerID, policy.OrganizationRoleTeacher)
	student := integrationAccess(fixture.tenantID, fixture.studentID, policy.OrganizationRoleStudent)

	catalog, err := stickers.Default()
	if err != nil {
		t.Fatalf("embedded catalog: %v", err)
	}
	published := catalog.Published().Packs[0].Stickers
	first, second := published[0].ID, published[1].ID

	packs, err := service.ListStickerPacks(ctx, student)
	if err != nil || packs.ETag != catalog.ETag() || len(packs.Catalog.Packs) == 0 {
		t.Fatalf("sticker packs=%+v err=%v", packs, err)
	}

	directResult, err := service.CreateDirect(ctx, owner, fixture.studentEmail)
	if err != nil {
		t.Fatalf("create direct: %v", err)
	}
	classResult, err := service.CreateClass(ctx, owner, fixture.classID)
	if err != nil {
		t.Fatalf("create class conversation: %v", err)
	}
	var lastSticker MessageMutationResult
	for _, target := range []Conversation{directResult.Conversation, classResult.Conversation} {
		input := SendMessageInput{
			ClientMessageID: uuid.New(),
			Embed:           &MessageEmbedInput{Kind: EmbedKindSticker, StickerID: first},
		}
		sent, err := service.SendMessage(ctx, student, target.ID, input)
		if err != nil || !sent.Created {
			t.Fatalf("%s sticker send=%+v err=%v", target.Kind, sent, err)
		}
		embed := sent.Message.Embed
		if embed == nil || embed.Kind != EmbedKindSticker || embed.Available == nil || !*embed.Available ||
			embed.StickerID == nil || *embed.StickerID != first || embed.Asset == nil ||
			!strings.HasPrefix(embed.Asset.StaticURL, "/stickers/") ||
			sent.Message.Content == nil || *sent.Message.Content != "" {
			t.Fatalf("%s sticker projection=%+v", target.Kind, sent.Message)
		}
		replay, err := service.SendMessage(ctx, student, target.ID, input)
		if err != nil || replay.Created || replay.Message.ID != sent.Message.ID {
			t.Fatalf("%s sticker replay=%+v err=%v", target.Kind, replay, err)
		}
		changed := input
		changed.Embed = &MessageEmbedInput{Kind: EmbedKindSticker, StickerID: second}
		if _, err := service.SendMessage(ctx, student, target.ID, changed); !errors.Is(err, ErrIdempotencyConflict) {
			t.Fatalf("%s changed sticker replay error=%v", target.Kind, err)
		}
		if found := findEmbed(mustListMessages(t, ctx, service, owner, target.ID), sent.Message.ID); found == nil ||
			found.StickerID == nil || *found.StickerID != first {
			t.Fatalf("%s reader projection=%+v", target.Kind, found)
		}
		if _, err := service.EditMessage(ctx, student, target.ID, sent.Message.ID, EditMessageInput{
			Content: "sửa", ExpectedVersion: 1,
		}); !errors.Is(err, ErrMessageNotEditable) {
			t.Fatalf("%s sticker edit error=%v", target.Kind, err)
		}
		lastSticker = sent
	}
	class := classResult.Conversation

	// Unknown stickers are rejected like retired and removed ones.
	if _, err := service.SendMessage(ctx, student, class.ID, SendMessageInput{
		ClientMessageID: uuid.New(),
		Embed:           &MessageEmbedInput{Kind: EmbedKindSticker, StickerID: "noto_animated:not-in-catalog"},
	}); !errors.Is(err, ErrEmbedUnavailable) {
		t.Fatalf("unknown sticker error=%v, want embed unavailable", err)
	}

	// The stored row is a three-way discriminated union.
	var kind, stickerID string
	var target, space *uuid.UUID
	if err := migrationPool.QueryRow(ctx, `
SELECT kind, sticker_id, target_user_id, media_space_id
FROM tutorhub.message_embeds WHERE tenant_id = $1 AND message_id = $2`,
		fixture.tenantID, lastSticker.Message.ID,
	).Scan(&kind, &stickerID, &target, &space); err != nil || kind != "sticker" ||
		stickerID != first || target != nil || space != nil {
		t.Fatalf("stored sticker row kind=%q id=%q target=%v space=%v err=%v", kind, stickerID, target, space, err)
	}
	text, err := service.SendMessage(ctx, owner, class.ID, SendMessageInput{
		ClientMessageID: uuid.New(), Content: "nền cho kiểm tra ràng buộc",
	})
	if err != nil {
		t.Fatalf("send text: %v", err)
	}
	for name, statement := range map[string]string{
		"sticker without id":   `INSERT INTO tutorhub.message_embeds (tenant_id, conversation_id, message_id, kind) VALUES ($1, $2, $3, 'sticker')`,
		"sticker with target":  `INSERT INTO tutorhub.message_embeds (tenant_id, conversation_id, message_id, kind, sticker_id, target_user_id) VALUES ($1, $2, $3, 'sticker', 'noto_animated:1f600', $4)`,
		"card with sticker id": `INSERT INTO tutorhub.message_embeds (tenant_id, conversation_id, message_id, kind, sticker_id, target_user_id) VALUES ($1, $2, $3, 'contact_card', 'noto_animated:1f600', $4)`,
		"malformed sticker id": `INSERT INTO tutorhub.message_embeds (tenant_id, conversation_id, message_id, kind, sticker_id) VALUES ($1, $2, $3, 'sticker', 'NOTO:../x')`,
	} {
		args := []any{fixture.tenantID, class.ID, text.Message.ID}
		if strings.Contains(statement, "$4") {
			args = append(args, fixture.studentID)
		}
		if _, err := migrationPool.Exec(ctx, statement, args...); err == nil {
			t.Fatalf("%s must violate the 000060 constraints", name)
		}
	}
	// A sticker later removed from the catalog projects as unavailable only.
	if _, err := migrationPool.Exec(ctx, `
INSERT INTO tutorhub.message_embeds (tenant_id, conversation_id, message_id, kind, sticker_id)
VALUES ($1, $2, $3, 'sticker', 'noto_animated:removed-upstream')`,
		fixture.tenantID, class.ID, text.Message.ID,
	); err != nil {
		t.Fatalf("seed removed sticker row: %v", err)
	}
	if found := findEmbed(mustListMessages(t, ctx, service, student, class.ID), text.Message.ID); found == nil ||
		found.Available == nil || *found.Available || found.StickerID != nil || found.Asset != nil {
		t.Fatalf("removed sticker projection=%+v", found)
	}

	// Unsend hides the sticker with the message.
	if _, err := service.DeleteMessage(ctx, student, class.ID, lastSticker.Message.ID, DeleteMessageInput{
		ExpectedVersion: 1,
	}); err != nil {
		t.Fatalf("unsend sticker: %v", err)
	}
	if found := findEmbed(mustListMessages(t, ctx, service, owner, class.ID), lastSticker.Message.ID); found != nil {
		t.Fatalf("tombstoned sticker exposes %+v", found)
	}

	// chat_stickers gates both the catalog and new sticker messages.
	if _, err := migrationPool.Exec(ctx, `
INSERT INTO tutorhub.tenant_feature_overrides (
    tenant_id, feature_key, enabled, updated_by, created_at, updated_at
)
VALUES ($1, 'chat_stickers', false, $2, now(), now())`,
		fixture.tenantID, fixture.ownerID,
	); err != nil {
		t.Fatalf("disable chat stickers: %v", err)
	}
	if _, err := service.ListStickerPacks(ctx, student); !errors.Is(err, featurecontrol.ErrFeatureDisabled) {
		t.Fatalf("disabled catalog error=%v", err)
	}
	if _, err := service.SendMessage(ctx, student, directResult.Conversation.ID, SendMessageInput{
		ClientMessageID: uuid.New(),
		Embed:           &MessageEmbedInput{Kind: EmbedKindSticker, StickerID: first},
	}); !errors.Is(err, featurecontrol.ErrFeatureDisabled) {
		t.Fatalf("disabled sticker send error=%v", err)
	}
	if _, err := migrationPool.Exec(ctx, `
UPDATE tutorhub.tenant_feature_overrides SET enabled = true, updated_at = now()
WHERE tenant_id = $1 AND feature_key = 'chat_stickers'`, fixture.tenantID,
	); err != nil {
		t.Fatalf("re-enable chat stickers: %v", err)
	}

	// Archived classes stay read-only for stickers too.
	if _, err := migrationPool.Exec(ctx, `
UPDATE tutorhub.classes SET status = 'archived', archived_at = now()
WHERE tenant_id = $1 AND id = $2`, fixture.tenantID, fixture.classID,
	); err != nil {
		t.Fatalf("archive class: %v", err)
	}
	if _, err := service.SendMessage(ctx, student, class.ID, SendMessageInput{
		ClientMessageID: uuid.New(),
		Embed:           &MessageEmbedInput{Kind: EmbedKindSticker, StickerID: first},
	}); !errors.Is(err, ErrReadOnly) {
		t.Fatalf("archived class sticker error=%v, want read only", err)
	}
}
