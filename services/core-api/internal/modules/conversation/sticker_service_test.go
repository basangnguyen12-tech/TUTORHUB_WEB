package conversation

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/tutorhub-v2/core-api/internal/modules/conversation/stickers"
	"github.com/tutorhub-v2/core-api/internal/modules/featurecontrol"
)

// MSG-STICKER-01 (ADR-0047): sticker messages and the sticker catalog.

func firstSticker(t *testing.T) stickers.PublishedSticker {
	t.Helper()
	catalog, err := stickers.Default()
	if err != nil {
		t.Fatalf("embedded catalog: %v", err)
	}
	packs := catalog.Published().Packs
	if len(packs) == 0 || len(packs[0].Stickers) == 0 {
		t.Fatal("embedded catalog has no active sticker")
	}
	return packs[0].Stickers[0]
}

func TestSendMessageAcceptsOnlyWellFormedStickers(t *testing.T) {
	t.Parallel()
	sticker := MessageEmbedInput{Kind: EmbedKindSticker, StickerID: "noto_animated:1f602"}
	repository := &fakeRepository{}
	service, _ := NewService(repository)
	input := sticker
	if _, err := service.SendMessage(context.Background(), testAccess(uuid.New()), uuid.New(), SendMessageInput{
		ClientMessageID: uuid.New(), Content: " ", Embed: &input,
	}); err != nil {
		t.Fatalf("sticker send => %v", err)
	}
	sent := repository.sendInput
	if sent.Embed == nil || *sent.Embed != sticker || sent.Content != "" || len(sent.AttachmentIDs) != 0 {
		t.Fatalf("sticker reached the repository as %+v", sent)
	}

	userID, spaceID := uuid.New(), uuid.New()
	invalid := map[string]SendMessageInput{
		"caption":             {Content: "haha", Embed: &sticker},
		"attachments":         {AttachmentIDs: []uuid.UUID{uuid.New()}, Embed: &sticker},
		"missing id":          {Embed: &MessageEmbedInput{Kind: EmbedKindSticker}},
		"uppercase id":        {Embed: &MessageEmbedInput{Kind: EmbedKindSticker, StickerID: "Noto:1F602"}},
		"path traversal":      {Embed: &MessageEmbedInput{Kind: EmbedKindSticker, StickerID: "noto:../x"}},
		"oversized id":        {Embed: &MessageEmbedInput{Kind: EmbedKindSticker, StickerID: "noto:" + strings.Repeat("a", 65)}},
		"sticker with user":   {Embed: &MessageEmbedInput{Kind: EmbedKindSticker, StickerID: "noto:1f602", UserID: userID}},
		"sticker with space":  {Embed: &MessageEmbedInput{Kind: EmbedKindSticker, StickerID: "noto:1f602", MediaSpaceID: spaceID}},
		"contact w/ sticker":  {Embed: &MessageEmbedInput{Kind: EmbedKindContactCard, UserID: userID, StickerID: "noto:1f602"}},
		"class with sticker":  {Embed: &MessageEmbedInput{Kind: EmbedKindInstantClass, MediaSpaceID: spaceID, StickerID: "noto:1f602"}},
		"invalid utf8 filler": {Content: string([]byte{0xff}), Embed: &sticker},
	}
	for name, test := range invalid {
		repository := &fakeRepository{}
		service, _ := NewService(repository)
		test.ClientMessageID = uuid.New()
		if _, err := service.SendMessage(context.Background(), testAccess(uuid.New()), uuid.New(), test); !errors.Is(err, ErrInvalidInput) {
			t.Fatalf("%s => %v, want invalid input", name, err)
		}
		if repository.sendInput.ClientMessageID != uuid.Nil {
			t.Fatalf("%s reached the repository", name)
		}
	}
}

func TestStickerFingerprintIsDomainSeparatedAndLengthPrefixed(t *testing.T) {
	t.Parallel()
	fingerprint := func(id string) [32]byte {
		return sendRequestFingerprint(SendMessageInput{Embed: &MessageEmbedInput{Kind: EmbedKindSticker, StickerID: id}})
	}
	id := "noto_animated:1f602"
	payload := append([]byte{0}, []byte("embed:sticker")...)
	payload = append(payload, 0, 0, byte(len(id)))
	payload = append(payload, id...)
	if fingerprint(id) != sha256.Sum256(payload) {
		t.Fatal("sticker fingerprint must be NUL embed:sticker NUL + uint16 length + id bytes")
	}
	if fingerprint(id) != fingerprint(id) {
		t.Fatal("sticker fingerprints must be deterministic")
	}
	if fingerprint(id) == fingerprint("noto_animated:1f600") {
		t.Fatal("changing the sticker must change the fingerprint")
	}
	if fingerprint(id) == sendRequestFingerprint(SendMessageInput{Content: id}) ||
		fingerprint(id) == sendRequestFingerprint(SendMessageInput{}) {
		t.Fatal("sticker fingerprints must not collide with text sends")
	}
	card := sendRequestFingerprint(SendMessageInput{Embed: &MessageEmbedInput{Kind: EmbedKindContactCard, UserID: uuid.New()}})
	if fingerprint(id) == card {
		t.Fatal("sticker fingerprints must not collide with cards")
	}
}

func TestStickerProjectionFollowsCatalogLifecycle(t *testing.T) {
	t.Parallel()
	manifest := `{"catalog_version":"t.1","packs":[{"id":"pack","version":"v3",
"title":{"vi":"Bộ","en":"Pack"},
"attribution":{"text":"Art, CC BY 4.0","license":"CC BY 4.0","url":"https://creativecommons.org/licenses/by/4.0/","notices_path":"/THIRD_PARTY_NOTICES.txt"},
"stickers":[
{"id":"pack:a","labels":{"vi":"Vui","en":"Happy"},"keywords":{"vi":["vui"],"en":["happy"]},"width":160,"height":160,"animated":true,"status":"active"},
{"id":"pack:b","labels":{"vi":"Cũ","en":"Old"},"keywords":{"vi":[],"en":[]},"width":160,"height":160,"animated":true,"status":"retired"},
{"id":"pack:c","labels":{"vi":"Gỡ","en":"Gone"},"keywords":{"vi":[],"en":[]},"width":160,"height":160,"animated":true,"status":"removed"}]}]}`
	catalog, err := stickers.Parse([]byte(manifest))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	for _, id := range []string{"pack:a", "pack:b"} {
		embed := projectStickerEmbed(catalog, id)
		if embed.Available == nil || !*embed.Available || embed.StickerID == nil || *embed.StickerID != id ||
			embed.PackID == nil || *embed.PackID != "pack" || embed.Labels == nil || embed.Asset == nil ||
			embed.Asset.StaticURL != "/stickers/pack/v3/"+strings.TrimPrefix(id, "pack:")+".static.webp" {
			t.Fatalf("%s projection = %+v", id, embed)
		}
	}
	for _, id := range []string{"pack:c", "pack:zz", ""} {
		embed := projectStickerEmbed(catalog, id)
		raw, _ := json.Marshal(embed)
		if string(raw) != `{"kind":"sticker","available":false}` {
			t.Fatalf("%q must project only available=false, got %s", id, raw)
		}
	}
	active, _ := json.Marshal(projectStickerEmbed(catalog, "pack:a"))
	for _, field := range []string{`"sticker_id":"pack:a"`, `"pack_id":"pack"`, `"labels":{"vi":"Vui","en":"Happy"}`, `"animated_url":"/stickers/pack/v3/a.webp"`, `"width":160`} {
		if !strings.Contains(string(active), field) {
			t.Fatalf("active projection %s is missing %s", active, field)
		}
	}
	if strings.Contains(string(active), "user_id") || strings.Contains(string(active), "keywords") {
		t.Fatalf("sticker projection leaks unrelated fields: %s", active)
	}
}

func TestListStickerPacksRequiresAccessAndRepositoryAuthorization(t *testing.T) {
	t.Parallel()
	repository := &fakeRepository{}
	service, _ := NewService(repository)
	if _, err := service.ListStickerPacks(context.Background(), AccessContext{}); !errors.Is(err, ErrAccessDenied) {
		t.Fatalf("missing access => %v", err)
	}
	if repository.stickerCalls != 0 {
		t.Fatal("invalid access must not reach the repository")
	}

	disabled := &featurecontrol.FeatureDisabledError{Feature: featurecontrol.FeatureChatStickers}
	repository.stickerError = disabled
	if _, err := service.ListStickerPacks(context.Background(), testAccess(uuid.New())); !errors.Is(err, featurecontrol.ErrFeatureDisabled) {
		t.Fatalf("disabled feature => %v", err)
	}

	repository.stickerError = nil
	access := testAccess(uuid.New())
	packs, err := service.ListStickerPacks(context.Background(), access)
	if err != nil {
		t.Fatalf("list sticker packs: %v", err)
	}
	catalog, _ := stickers.Default()
	if repository.stickerAccess.TenantID != access.TenantID || packs.ETag != catalog.ETag() ||
		len(packs.Catalog.Packs) == 0 || packs.Catalog.Packs[0].Stickers[0].ID != firstSticker(t).ID {
		t.Fatalf("packs = %+v (access %+v)", packs, repository.stickerAccess)
	}
}

func TestStickerMigrationExtendsInsertOnlyEmbedsAndGuardsRollback(t *testing.T) {
	t.Parallel()
	up := readMigration(t, "000060_message_embed_stickers.up.sql")
	normalized := strings.Join(strings.Fields(up), " ")
	for _, required := range []string{
		"ALTER TABLE tutorhub.message_embeds ADD COLUMN sticker_id text;",
		"char_length(sticker_id) BETWEEN 3 AND 97",
		"sticker_id ~ '^[a-z0-9_]{1,32}:[a-z0-9_-]{1,64}$'",
		"DROP CONSTRAINT message_embeds_kind_valid",
		"kind = 'contact_card' AND target_user_id IS NOT NULL AND media_space_id IS NULL AND sticker_id IS NULL",
		"kind = 'instant_class' AND media_space_id IS NOT NULL AND target_user_id IS NULL AND sticker_id IS NULL",
		"kind = 'sticker' AND sticker_id IS NOT NULL AND target_user_id IS NULL AND media_space_id IS NULL",
		"'chat_stickers'",
	} {
		if !strings.Contains(normalized, required) {
			t.Fatalf("000060 up migration is missing %q", required)
		}
	}
	upper := strings.ToUpper(up)
	for _, forbidden := range []string{"GRANT ", "DELETE FROM", "UPDATE TUTORHUB", "TRUNCATE"} {
		if strings.Contains(upper, forbidden) {
			t.Fatalf("000060 up migration must not contain %q", forbidden)
		}
	}
	down := strings.Join(strings.Fields(readMigration(t, "000060_message_embed_stickers.down.sql")), " ")
	for _, required := range []string{
		"LOCK TABLE tutorhub.message_embeds",
		"IF EXISTS (SELECT 1 FROM tutorhub.message_embeds WHERE kind = 'sticker') THEN RAISE EXCEPTION",
		"kind = 'contact_card' AND target_user_id IS NOT NULL AND media_space_id IS NULL )",
		"kind = 'instant_class' AND media_space_id IS NOT NULL AND target_user_id IS NULL )",
		"DROP CONSTRAINT message_embeds_sticker_id_valid",
		"DROP COLUMN sticker_id",
	} {
		if !strings.Contains(down, required) {
			t.Fatalf("000060 down migration is missing %q", required)
		}
	}
	guard := strings.Index(down, "RAISE EXCEPTION")
	drop := strings.Index(down, "DROP COLUMN sticker_id")
	if guard < 0 || drop < guard {
		t.Fatal("rollback must refuse before dropping the sticker column")
	}
	if strings.Contains(strings.ToUpper(down), "DELETE FROM TUTORHUB.MESSAGE") {
		t.Fatal("rollback must never delete messages or embeds")
	}
}
