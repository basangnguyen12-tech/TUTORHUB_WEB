package conversation

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/google/uuid"
)

// MSG-COMPOSER-TOOLS-01: server-authored card messages.

func TestSendMessageAcceptsOnlyWellFormedCards(t *testing.T) {
	t.Parallel()
	userID, spaceID := uuid.New(), uuid.New()
	valid := []MessageEmbedInput{
		{Kind: EmbedKindContactCard, UserID: userID},
		{Kind: EmbedKindInstantClass, MediaSpaceID: spaceID},
	}
	for _, embed := range valid {
		repository := &fakeRepository{}
		service, _ := NewService(repository)
		input := embed
		_, err := service.SendMessage(context.Background(), testAccess(uuid.New()), uuid.New(), SendMessageInput{
			ClientMessageID: uuid.New(), Content: "  \n ", Embed: &input,
		})
		if err != nil {
			t.Fatalf("%s card => %v", embed.Kind, err)
		}
		sent := repository.sendInput
		if sent.Embed == nil || *sent.Embed != embed || sent.Content != "" || len(sent.AttachmentIDs) != 0 {
			t.Fatalf("%s card reached the repository as %+v", embed.Kind, sent)
		}
		if sent.Embed == &input {
			t.Fatal("the service must not alias the caller's embed")
		}
	}

	invalid := []struct {
		name  string
		input SendMessageInput
	}{
		{"caption", SendMessageInput{Content: "xem này", Embed: &valid[0]}},
		{"attachments", SendMessageInput{AttachmentIDs: []uuid.UUID{uuid.New()}, Embed: &valid[0]}},
		{"contact without user", SendMessageInput{Embed: &MessageEmbedInput{Kind: EmbedKindContactCard}}},
		{"contact with space", SendMessageInput{Embed: &MessageEmbedInput{Kind: EmbedKindContactCard, UserID: userID, MediaSpaceID: spaceID}}},
		{"class without space", SendMessageInput{Embed: &MessageEmbedInput{Kind: EmbedKindInstantClass}}},
		{"class with user", SendMessageInput{Embed: &MessageEmbedInput{Kind: EmbedKindInstantClass, UserID: userID, MediaSpaceID: spaceID}}},
		{"unknown kind", SendMessageInput{Embed: &MessageEmbedInput{Kind: "poll", UserID: userID}}},
		{"invalid utf8", SendMessageInput{Content: string([]byte{0xff}), Embed: &valid[0]}},
	}
	for _, test := range invalid {
		repository := &fakeRepository{}
		service, _ := NewService(repository)
		test.input.ClientMessageID = uuid.New()
		_, err := service.SendMessage(context.Background(), testAccess(uuid.New()), uuid.New(), test.input)
		if !errors.Is(err, ErrInvalidInput) {
			t.Fatalf("%s => %v, want invalid input", test.name, err)
		}
		if repository.sendInput.ClientMessageID != uuid.Nil {
			t.Fatalf("%s reached the repository", test.name)
		}
	}
}

func TestCardFingerprintBindsKindAndTargetWithoutChangingLegacySends(t *testing.T) {
	t.Parallel()
	attachmentID := uuid.New()
	for _, input := range []SendMessageInput{
		{Content: "Xin chào"},
		{Content: "", AttachmentIDs: []uuid.UUID{attachmentID}},
	} {
		if sendRequestFingerprint(input) != messageRequestFingerprint(input.Content, input.AttachmentIDs) {
			t.Fatal("text and attachment fingerprints must stay byte-identical for replays")
		}
	}
	target := uuid.New()
	contact := sendRequestFingerprint(SendMessageInput{Embed: &MessageEmbedInput{Kind: EmbedKindContactCard, UserID: target}})
	class := sendRequestFingerprint(SendMessageInput{Embed: &MessageEmbedInput{Kind: EmbedKindInstantClass, MediaSpaceID: target}})
	other := sendRequestFingerprint(SendMessageInput{Embed: &MessageEmbedInput{Kind: EmbedKindContactCard, UserID: uuid.New()}})
	empty := sendRequestFingerprint(SendMessageInput{})
	if contact == class || contact == other || contact == empty || class == empty {
		t.Fatal("card fingerprints must bind both the kind and the target")
	}
	again := sendRequestFingerprint(SendMessageInput{Embed: &MessageEmbedInput{Kind: EmbedKindContactCard, UserID: target}})
	if contact != again {
		t.Fatal("card fingerprints must be deterministic")
	}
}

func TestCreateDirectFromContactCardRequiresASourceMessage(t *testing.T) {
	t.Parallel()
	repository := &fakeRepository{direct: CreateResult{Conversation: Conversation{Kind: KindDirect}, Created: true}}
	service, _ := NewService(repository)
	if _, err := service.CreateDirectFromContactCard(
		context.Background(), testAccess(uuid.New()), uuid.Nil,
	); !errors.Is(err, ErrNotFound) {
		t.Fatalf("nil source => %v", err)
	}
	if _, err := service.CreateDirectFromContactCard(
		context.Background(), AccessContext{}, uuid.New(),
	); !errors.Is(err, ErrAccessDenied) {
		t.Fatalf("missing access => %v", err)
	}
	sourceID := uuid.New()
	result, err := service.CreateDirectFromContactCard(context.Background(), testAccess(uuid.New()), sourceID)
	if err != nil || !result.Created || repository.directSourceMessageID != sourceID {
		t.Fatalf("card direct => %+v %v (source %s)", result, err, repository.directSourceMessageID)
	}
}

func TestMessageEmbedMigrationIsInsertOnlyTenantScopedAndReversible(t *testing.T) {
	t.Parallel()
	up := readMigration(t, "000059_message_embeds.up.sql")
	for _, required := range []string{
		"CREATE TABLE tutorhub.message_embeds",
		"PRIMARY KEY (tenant_id, message_id)",
		"FOREIGN KEY (tenant_id, conversation_id, message_id)",
		"REFERENCES tutorhub.messages (tenant_id, conversation_id, id)",
		"ON DELETE CASCADE",
		"REFERENCES tutorhub.memberships (tenant_id, user_id)",
		"REFERENCES tutorhub.media_spaces (tenant_id, id)",
		"kind = 'contact_card'",
		"kind = 'instant_class'",
		"REVOKE ALL ON tutorhub.message_embeds FROM PUBLIC",
	} {
		if !strings.Contains(up, required) {
			t.Fatalf("000059 up migration is missing %q", required)
		}
	}
	for _, forbidden := range []string{"GRANT ", "UPDATE tutorhub.messages", "ALTER TABLE tutorhub.messages"} {
		if strings.Contains(up, forbidden) {
			t.Fatalf("000059 up migration must not contain %q", forbidden)
		}
	}
	down := readMigration(t, "000059_message_embeds.down.sql")
	if !strings.Contains(down, "DROP TABLE tutorhub.message_embeds;") {
		t.Fatal("000059 down migration must drop the embed table")
	}
}
