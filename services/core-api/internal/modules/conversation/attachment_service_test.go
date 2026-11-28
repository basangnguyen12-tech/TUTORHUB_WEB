package conversation

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/tutorhub-v2/core-api/internal/platform/objectstorage"
)

var (
	pngFixture  = append([]byte("\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR"), make([]byte, 64)...)
	jpegFixture = append([]byte{0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 'J', 'F', 'I', 'F', 0x00}, make([]byte, 64)...)
	gifFixture  = append([]byte("GIF89a"), make([]byte, 64)...)
	webpFixture = append([]byte("RIFF\x24\x00\x00\x00WEBPVP8 "), make([]byte, 64)...)
	pdfFixture  = []byte("%PDF-1.7\n1 0 obj\n<<>>\nendobj\ntrailer\n%%EOF\n")
	zipFixture  = append([]byte("PK\x03\x04\x14\x00\x00\x00"), make([]byte, 64)...)
	oleFixture  = append(append([]byte(nil), oleCompoundSignature...), make([]byte, 64)...)
)

func TestClassifyAttachmentAllowsLessonTypesBySniffedBytes(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name      string
		content   []byte
		kind      AttachmentKind
		mediaType string
	}{
		{"photo.png", pngFixture, AttachmentKindImage, "image/png"},
		{"scan.JPG", jpegFixture, AttachmentKindImage, "image/jpeg"},
		{"anim.gif", gifFixture, AttachmentKindImage, "image/gif"},
		{"board.webp", webpFixture, AttachmentKindImage, "image/webp"},
		// An image is classified by bytes, whatever the client called it.
		{"looks-like.pdf", pngFixture, AttachmentKindImage, "image/png"},
		{"bai-tap.pdf", pdfFixture, AttachmentKindFile, "application/pdf"},
		{"notes.txt", []byte("Bài 3: x^2 - 4 = 0\n"), AttachmentKindFile, "text/plain"},
		{"scores.csv", []byte("name,score\nAn,9\n"), AttachmentKindFile, "text/csv"},
		{"README.md", []byte("# Lesson\n- step\n"), AttachmentKindFile, "text/markdown"},
		{"pack.zip", zipFixture, AttachmentKindFile, "application/zip"},
		{"de-cuong.docx", zipFixture, AttachmentKindFile, "application/vnd.openxmlformats-officedocument.wordprocessingml.document"},
		{"bang-diem.xlsx", zipFixture, AttachmentKindFile, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"},
		{"slides.pptx", zipFixture, AttachmentKindFile, "application/vnd.openxmlformats-officedocument.presentationml.presentation"},
		{"old.doc", oleFixture, AttachmentKindFile, "application/msword"},
		{"old.xls", oleFixture, AttachmentKindFile, "application/vnd.ms-excel"},
		{"old.ppt", oleFixture, AttachmentKindFile, "application/vnd.ms-powerpoint"},
	} {
		kind, mediaType, err := classifyAttachment(tc.name, tc.content)
		if err != nil || kind != tc.kind || mediaType != tc.mediaType {
			t.Fatalf("%s => (%s, %s, %v), want (%s, %s)", tc.name, kind, mediaType, err, tc.kind, tc.mediaType)
		}
	}
}

func TestClassifyAttachmentRejectsActiveContentAndExecutables(t *testing.T) {
	t.Parallel()
	svg := []byte(`<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`)
	for _, tc := range []struct {
		name    string
		content []byte
	}{
		{"icon.svg", svg},
		{"icon.png", svg},
		{"icon.txt", svg},
		{"page.html", []byte("<!DOCTYPE html><html><body>x</body></html>")},
		{"page.txt", []byte("<html><script>alert(1)</script></html>")},
		{"data.xml", []byte(`<?xml version="1.0"?><a/>`)},
		{"notes.md", []byte(`<?xml version="1.0"?><svg/>`)},
		{"app.js", []byte("alert(document.cookie)")},
		{"setup.exe", append([]byte("MZ\x90\x00"), make([]byte, 64)...)},
		{"setup.pdf", append([]byte("MZ\x90\x00"), make([]byte, 64)...)},
		{"macro.doc", zipFixture},
		{"fake.docx", pdfFixture},
		{"binary.txt", []byte{0xff, 0xfe, 0x00, 0x01, 0x02}},
		{"noext", pdfFixture},
	} {
		if _, _, err := classifyAttachment(tc.name, tc.content); !errors.Is(err, ErrAttachmentUnsupported) {
			t.Fatalf("%s => %v, want unsupported", tc.name, err)
		}
	}
	if _, _, err := classifyAttachment("empty.txt", nil); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("empty attachment => %v, want invalid input", err)
	}
}

func TestClassifyAttachmentEnforcesPerKindSizeBounds(t *testing.T) {
	t.Parallel()
	largeImage := append(append([]byte(nil), pngFixture...), make([]byte, MaximumImageAttachmentBytes)...)
	if _, _, err := classifyAttachment("big.png", largeImage); !errors.Is(err, ErrAttachmentTooLarge) {
		t.Fatalf("image above 5 MiB => %v, want too large", err)
	}
	largeFile := append(append([]byte(nil), pdfFixture...), make([]byte, MaximumFileAttachmentBytes)...)
	if _, _, err := classifyAttachment("big.pdf", largeFile); !errors.Is(err, ErrAttachmentTooLarge) {
		t.Fatalf("file above 10 MiB => %v, want too large", err)
	}
	okFile := append(append([]byte(nil), pdfFixture...), make([]byte, MaximumImageAttachmentBytes)...)
	if kind, _, err := classifyAttachment("ok.pdf", okFile); err != nil || kind != AttachmentKindFile {
		t.Fatalf("6 MiB PDF => (%s, %v), want accepted file", kind, err)
	}
}

func TestNormalizeAttachmentNameStripsPathsControlsAndBounds(t *testing.T) {
	t.Parallel()
	for input, want := range map[string]string{
		"../../etc/passwd":          "passwd",
		`C:\Users\hs\Bài tập 1.pdf`: "Bài tập 1.pdf",
		"evil\u202egpj.exe":         "evilgpj.exe",
		"line\nbreak\t.txt":         "linebreak.txt",
		`quote"name.pdf`:            "quotename.pdf",
		"   ":                       "attachment",
		"":                          "attachment",
		"/":                         "attachment",
		"photo.png":                 "photo.png",
	} {
		if got := normalizeAttachmentName(input); got != want {
			t.Fatalf("normalizeAttachmentName(%q)=%q, want %q", input, got, want)
		}
	}
	long := strings.Repeat("ả", 400) + ".pdf"
	got := normalizeAttachmentName(long)
	if len([]rune(got)) != maximumAttachmentNameCharacters || !strings.HasSuffix(got, ".pdf") {
		t.Fatalf("long name was not bounded with its extension: %d runes", len([]rune(got)))
	}
}

type fakeObjectStore struct {
	puts    map[string][]byte
	deletes []string
	putErr  error
}

func (store *fakeObjectStore) Put(_ context.Context, key string, body io.Reader, size int64, _ string) error {
	if store.putErr != nil {
		return store.putErr
	}
	content, _ := io.ReadAll(body)
	if int64(len(content)) != size {
		return errors.New("size mismatch")
	}
	if store.puts == nil {
		store.puts = map[string][]byte{}
	}
	store.puts[key] = content
	return nil
}

func (store *fakeObjectStore) Get(_ context.Context, key string) (objectstorage.Object, error) {
	content, ok := store.puts[key]
	if !ok {
		return objectstorage.Object{}, errors.New("missing")
	}
	return objectstorage.Object{
		Body: io.NopCloser(bytes.NewReader(content)), ContentLength: int64(len(content)),
	}, nil
}

func (store *fakeObjectStore) Delete(_ context.Context, key string) error {
	store.deletes = append(store.deletes, key)
	return nil
}

func TestUploadAttachmentFailsClosedWithoutDataPlane(t *testing.T) {
	t.Parallel()
	repository := &fakeRepository{}
	service, err := NewService(repository)
	if err != nil {
		t.Fatal(err)
	}
	_, err = service.UploadAttachment(context.Background(), testAccess(uuid.New()), uuid.New(), UploadAttachmentInput{
		ClientAttachmentID: uuid.New(), FileName: "a.png", Content: pngFixture,
	})
	if !errors.Is(err, ErrAttachmentsUnavailable) || repository.createCalls != 0 {
		t.Fatalf("upload without storage => %v (calls %d), want unavailable", err, repository.createCalls)
	}
}

func TestUploadAttachmentInlineDevStoresValidatedRecord(t *testing.T) {
	t.Parallel()
	repository := &fakeRepository{createdNew: true}
	service, err := NewService(repository, WithAttachmentStorage(AttachmentStorage{AllowInline: true}))
	if err != nil {
		t.Fatal(err)
	}
	width, height := 640, 480
	result, err := service.UploadAttachment(context.Background(), testAccess(uuid.New()), uuid.New(), UploadAttachmentInput{
		ClientAttachmentID: uuid.New(), FileName: "../anh bai tap.png", Content: pngFixture,
		WidthPx: &width, HeightPx: &height,
	})
	if err != nil || !result.Created {
		t.Fatalf("inline upload => %+v, %v", result, err)
	}
	record := repository.createdRecord
	if record.Backend != attachmentBackendInline || !bytes.Equal(record.InlineBytes, pngFixture) ||
		record.ObjectKey != "" || record.Kind != AttachmentKindImage || record.MediaType != "image/png" ||
		record.DisplayName != "anh bai tap.png" || record.SizeBytes != int64(len(pngFixture)) ||
		len(record.Fingerprint) != 32 || *record.WidthPx != 640 {
		t.Fatalf("unexpected inline record: %+v", record)
	}
	invalid := 0
	if _, err := service.UploadAttachment(context.Background(), testAccess(uuid.New()), uuid.New(), UploadAttachmentInput{
		ClientAttachmentID: uuid.New(), FileName: "a.png", Content: pngFixture, WidthPx: &invalid,
	}); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("zero width => %v, want invalid input", err)
	}
	if _, err := service.UploadAttachment(context.Background(), testAccess(uuid.New()), uuid.New(), UploadAttachmentInput{
		FileName: "a.png", Content: pngFixture,
	}); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("missing client attachment ID => %v, want invalid input", err)
	}
}

func TestUploadAttachmentB2PutsOpaqueKeyAndCleansUpReplayRace(t *testing.T) {
	t.Parallel()
	store := &fakeObjectStore{}
	repository := &fakeRepository{createdNew: true, createdExpiredKeys: []string{"tenants/x/chat-attachments/old"}}
	service, err := NewService(repository, WithAttachmentStorage(AttachmentStorage{Store: store, AllowInline: true}))
	if err != nil {
		t.Fatal(err)
	}
	access := testAccess(uuid.New())
	if _, err := service.UploadAttachment(context.Background(), access, uuid.New(), UploadAttachmentInput{
		ClientAttachmentID: uuid.New(), FileName: "de.pdf", Content: pdfFixture,
	}); err != nil {
		t.Fatal(err)
	}
	record := repository.createdRecord
	wantKey := "tenants/" + access.TenantID.String() + "/chat-attachments/" + record.ID.String()
	if record.Backend != attachmentBackendB2 || record.ObjectKey != wantKey || record.InlineBytes != nil ||
		!bytes.Equal(store.puts[wantKey], pdfFixture) {
		t.Fatalf("unexpected B2 record %+v", record)
	}
	if strings.Contains(record.ObjectKey, "de.pdf") {
		t.Fatal("object key must stay opaque")
	}
	if len(store.deletes) != 1 || store.deletes[0] != "tenants/x/chat-attachments/old" {
		t.Fatalf("expired staged objects were not deleted: %v", store.deletes)
	}

	// A concurrent replay won the idempotency key: drop the duplicate object.
	store.deletes = nil
	repository.createdNew = false
	repository.createdExpiredKeys = nil
	if _, err := service.UploadAttachment(context.Background(), access, uuid.New(), UploadAttachmentInput{
		ClientAttachmentID: uuid.New(), FileName: "de.pdf", Content: pdfFixture,
	}); err != nil {
		t.Fatal(err)
	}
	if len(store.deletes) != 1 || store.deletes[0] != repository.createdRecord.ObjectKey {
		t.Fatalf("duplicate replay object not removed: %v", store.deletes)
	}

	// A committed replay found before upload never touches storage.
	store.puts = nil
	repository.replayFound = true
	calls := repository.createCalls
	if result, err := service.UploadAttachment(context.Background(), access, uuid.New(), UploadAttachmentInput{
		ClientAttachmentID: uuid.New(), FileName: "de.pdf", Content: pdfFixture,
	}); err != nil || result.Created {
		t.Fatalf("replay => %+v %v", result, err)
	}
	if len(store.puts) != 0 || repository.createCalls != calls {
		t.Fatal("replay must not upload or insert again")
	}
}

func TestReadAttachmentContentStreamsInlineAndB2(t *testing.T) {
	t.Parallel()
	store := &fakeObjectStore{puts: map[string][]byte{"k": pdfFixture}}
	repository := &fakeRepository{stored: storedAttachment{
		Attachment: MessageAttachment{SizeBytes: int64(len(pngFixture))},
		Backend:    attachmentBackendInline, InlineBytes: pngFixture,
	}}
	service, _ := NewService(repository, WithAttachmentStorage(AttachmentStorage{Store: store}))
	content, err := service.ReadAttachmentContent(context.Background(), testAccess(uuid.New()), uuid.New(), uuid.New())
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(content.Body)
	if !bytes.Equal(body, pngFixture) {
		t.Fatal("inline content mismatch")
	}
	repository.stored = storedAttachment{
		Attachment: MessageAttachment{SizeBytes: int64(len(pdfFixture))},
		Backend:    attachmentBackendB2, ObjectKey: "k",
	}
	content, err = service.ReadAttachmentContent(context.Background(), testAccess(uuid.New()), uuid.New(), uuid.New())
	if err != nil {
		t.Fatal(err)
	}
	body, _ = io.ReadAll(content.Body)
	if !bytes.Equal(body, pdfFixture) {
		t.Fatal("B2 content mismatch")
	}
	repository.storedError = ErrNotFound
	if _, err := service.ReadAttachmentContent(context.Background(), testAccess(uuid.New()), uuid.New(), uuid.New()); !errors.Is(err, ErrNotFound) {
		t.Fatalf("deleted attachment => %v, want not found", err)
	}
}

func TestDeleteMessageRemovesAttachmentObjectsAfterCommit(t *testing.T) {
	t.Parallel()
	store := &fakeObjectStore{}
	repository := &fakeRepository{deleteObjectKeys: []string{"tenants/t/chat-attachments/a"}}
	service, _ := NewService(repository, WithAttachmentStorage(AttachmentStorage{Store: store}))
	if _, err := service.DeleteMessage(
		context.Background(), testAccess(uuid.New()), uuid.New(), uuid.New(), DeleteMessageInput{ExpectedVersion: 1},
	); err != nil {
		t.Fatal(err)
	}
	if len(store.deletes) != 1 || store.deletes[0] != "tenants/t/chat-attachments/a" {
		t.Fatalf("attachment object not deleted: %v", store.deletes)
	}
}

func TestSendMessageAcceptsAttachmentOnlyAndCanonicalizesIDs(t *testing.T) {
	t.Parallel()
	repository := &fakeRepository{}
	service, _ := NewService(repository)
	access := testAccess(uuid.New())
	first, second := uuid.New(), uuid.New()
	if _, err := service.SendMessage(context.Background(), access, uuid.New(), SendMessageInput{
		ClientMessageID: uuid.New(), Content: "  \r\n ", AttachmentIDs: []uuid.UUID{second, first},
	}); err != nil {
		t.Fatalf("attachment-only send: %v", err)
	}
	if repository.sendInput.Content != "" || len(repository.sendInput.AttachmentIDs) != 2 ||
		bytes.Compare(repository.sendInput.AttachmentIDs[0][:], repository.sendInput.AttachmentIDs[1][:]) > 0 {
		t.Fatalf("unexpected normalized send input: %+v", repository.sendInput)
	}
	for name, ids := range map[string][]uuid.UUID{
		"duplicate": {first, first},
		"nil":       {uuid.Nil},
		"too many":  {uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New()},
	} {
		if _, err := service.SendMessage(context.Background(), access, uuid.New(), SendMessageInput{
			ClientMessageID: uuid.New(), Content: "x", AttachmentIDs: ids,
		}); !errors.Is(err, ErrInvalidInput) {
			t.Fatalf("%s attachment IDs => %v, want invalid", name, err)
		}
	}
	if _, err := service.SendMessage(context.Background(), access, uuid.New(), SendMessageInput{
		ClientMessageID: uuid.New(), Content: "   ",
	}); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("empty text without attachments => %v, want invalid", err)
	}
}

func TestMessageRequestFingerprintKeepsTextOnlyCompatibility(t *testing.T) {
	t.Parallel()
	textOnly := messageRequestFingerprint("Xin chào", nil)
	legacy := sha256Sum("Xin chào")
	if textOnly != legacy {
		t.Fatal("text-only fingerprint changed; committed replays would conflict")
	}
	id := uuid.New()
	if messageRequestFingerprint("Xin chào", []uuid.UUID{id}) == textOnly {
		t.Fatal("attachments must change the fingerprint")
	}
	if messageRequestFingerprint("", []uuid.UUID{id}) == messageRequestFingerprint("", []uuid.UUID{uuid.New()}) {
		t.Fatal("different attachments must not share a fingerprint")
	}
}

func TestServiceDecoratesUploadCapabilityForWritableConversations(t *testing.T) {
	t.Parallel()
	open := "open"
	repository := &fakeRepository{get: Conversation{
		Kind: KindRoom, MediaSpaceStatus: &open,
		ViewerAccess: ViewerAccess{CanPostMessages: true},
	}}
	withStorage, _ := NewService(repository, WithAttachmentStorage(AttachmentStorage{AllowInline: true}))
	item, err := withStorage.Get(context.Background(), testAccess(uuid.New()), uuid.New())
	if err != nil || !item.ViewerAccess.CanUploadAttachments {
		t.Fatalf("writable room with storage => %+v %v", item.ViewerAccess, err)
	}
	withoutStorage, _ := NewService(repository)
	item, _ = withoutStorage.Get(context.Background(), testAccess(uuid.New()), uuid.New())
	if item.ViewerAccess.CanUploadAttachments {
		t.Fatal("upload capability must fail closed without storage")
	}
	repository.get.ViewerAccess.CanPostMessages = false
	item, _ = withStorage.Get(context.Background(), testAccess(uuid.New()), uuid.New())
	if item.ViewerAccess.CanUploadAttachments {
		t.Fatal("read-only room must not allow uploads")
	}
	// MSG-COMPOSER-TOOLS-01 (ADR-0042 amendment): direct and class
	// conversations accept attachments from members who may post.
	for _, kind := range []Kind{KindDirect, KindClass} {
		repository.get = Conversation{Kind: kind, ViewerAccess: ViewerAccess{CanPostMessages: true}}
		item, _ = withStorage.Get(context.Background(), testAccess(uuid.New()), uuid.New())
		if !item.ViewerAccess.CanUploadAttachments {
			t.Fatalf("writable %s conversation must allow uploads", kind)
		}
		item, _ = withoutStorage.Get(context.Background(), testAccess(uuid.New()), uuid.New())
		if item.ViewerAccess.CanUploadAttachments {
			t.Fatalf("%s upload capability must fail closed without storage", kind)
		}
		repository.get.ViewerAccess.CanPostMessages = false
		item, _ = withStorage.Get(context.Background(), testAccess(uuid.New()), uuid.New())
		if item.ViewerAccess.CanUploadAttachments {
			t.Fatalf("read-only %s conversation must not allow uploads", kind)
		}
	}
}

func TestRoomChatMigrationLocksAttachmentAndModerationShape(t *testing.T) {
	t.Parallel()
	up := readMigration(t, "000053_room_chat_moderation_and_attachments.up.sql")
	for _, required := range []string{
		"CREATE TABLE tutorhub.room_conversation_settings",
		"participant_chat_enabled boolean NOT NULL DEFAULT true",
		"REFERENCES tutorhub.conversations (tenant_id, id)",
		"ON DELETE CASCADE",
		"CREATE TABLE tutorhub.message_attachments",
		"UNIQUE (tenant_id, uploader_user_id, client_attachment_id)",
		"REFERENCES tutorhub.messages (tenant_id, conversation_id, id)",
		"kind IN ('image', 'file')",
		"size_bytes BETWEEN 1 AND 10485760",
		"storage_backend IN ('b2', 'inline_dev')",
		"state IN ('staged', 'attached', 'deleted')",
		"state <> 'deleted' OR inline_bytes IS NULL",
		"octet_length(inline_bytes) = size_bytes",
		"object_key IS NOT NULL",
		"messages_content_lifecycle_valid",
		"content = ''",
		"char_length(content) BETWEEN 1 AND 4000",
		"REVOKE ALL ON tutorhub.room_conversation_settings FROM PUBLIC",
		"REVOKE ALL ON tutorhub.message_attachments FROM PUBLIC",
	} {
		if !strings.Contains(up, required) {
			t.Fatalf("000053 up migration is missing %q", required)
		}
	}
	down := readMigration(t, "000053_room_chat_moderation_and_attachments.down.sql")
	for _, sql := range []string{up, down} {
		for _, forbidden := range []string{"GRANT ", "audit_events", "outbox_events"} {
			if strings.Contains(sql, forbidden) {
				t.Fatalf("000053 migration must not contain %q", forbidden)
			}
		}
	}
	dropAttachments := strings.Index(down, "DROP TABLE tutorhub.message_attachments")
	tombstone := strings.Index(down, "WHERE state = 'active' AND content = ''")
	restore := strings.Index(down, "ADD CONSTRAINT messages_content_lifecycle_valid")
	if dropAttachments < 0 || tombstone < 0 || restore < 0 || !(dropAttachments < tombstone && tombstone < restore) {
		t.Fatal("down migration must drop attachments, tombstone empty messages, then restore the constraint")
	}
	if strings.Contains(down[restore:], "content = ''") {
		t.Fatal("down migration must restore the 1..4000 content rule")
	}
}

func TestRoomChatRepositoryKeepsAttachmentSQLIsolatedAndSideEffectFree(t *testing.T) {
	t.Parallel()
	attachmentSource := readP408RepositorySource(t, "postgres_attachment_repository.go")
	messageSource := readP408RepositorySource(t, "postgres_message_repository.go")
	for _, source := range []string{attachmentSource, messageSource} {
		for _, forbidden := range []string{"audit.Append", "audit.Metadata", "outbox.Append", "outbox.Metadata", "logger", "slog."} {
			if strings.Contains(source, forbidden) {
				t.Fatalf("room chat write path must not emit side effects via %q", forbidden)
			}
		}
	}
	if strings.Contains(messageSource, "tutorhub.message_attachments") ||
		strings.Contains(messageSource, "tutorhub.room_conversation_settings") {
		t.Fatal("attachment and room-settings SQL belongs in postgres_attachment_repository.go")
	}
	lock := strings.Index(messageSource, "FROM tutorhub.conversations\nWHERE tenant_id = $1 AND id = $2\nFOR UPDATE")
	posting := strings.Index(messageSource, "requireRoomChatPosting")
	if lock < 0 || posting < 0 || posting < lock {
		t.Fatal("the room posting switch must be read after the conversation row lock")
	}
	for _, required := range []string{
		"attachment.message_id = ANY($3::uuid[])",
		"expires_at > $6",
		"tag.RowsAffected() != int64(len(attachmentIDs))",
		"inline_bytes = NULL",
		"message.state = 'active'",
	} {
		if !strings.Contains(attachmentSource, required) {
			t.Fatalf("attachment repository is missing %q", required)
		}
	}
	settings := strings.Index(attachmentSource, "func (repository *PostgresRepository) UpdateRoomSettings")
	settingsSource := attachmentSource[settings:]
	space := strings.Index(settingsSource, "FROM tutorhub.media_spaces")
	conversationLock := strings.Index(settingsSource, "FROM tutorhub.conversations\nWHERE tenant_id = $1 AND id = $2\nFOR UPDATE")
	upsert := strings.Index(settingsSource, "INSERT INTO tutorhub.room_conversation_settings")
	if space < 0 || conversationLock < 0 || upsert < 0 || !(space < conversationLock && conversationLock < upsert) {
		t.Fatal("room settings must lock MediaSpace, then the conversation, before the upsert")
	}
}

func readMigration(t *testing.T, name string) string {
	t.Helper()
	contents, err := os.ReadFile(filepath.Join("..", "..", "..", "migrations", name))
	if err != nil {
		t.Fatalf("read %s: %v", name, err)
	}
	return string(contents)
}

func sha256Sum(value string) [32]byte {
	return sha256.Sum256([]byte(value))
}
