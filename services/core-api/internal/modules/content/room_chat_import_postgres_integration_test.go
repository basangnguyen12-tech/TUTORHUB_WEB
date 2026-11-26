//go:build integration

package content

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/tutorhub-v2/core-api/internal/modules/featurecontrol"
	"github.com/tutorhub-v2/core-api/internal/modules/media"
	"github.com/tutorhub-v2/core-api/internal/policy"
)

type chatImportTestAuthority struct {
	integrationSpaces
	linkedClass *uuid.UUID
}

func (authority *chatImportTestAuthority) GetSpace(ctx context.Context, access media.AccessContext, id uuid.UUID) (media.MediaSpace, error) {
	space, err := authority.integrationSpaces.GetSpace(ctx, access, id)
	space.Source.ClassID = authority.linkedClass
	return space, err
}

func TestPostgresSaveRoomChatAttachment(t *testing.T) {
	owner, runtime, f, room := newRoom03Fixture(t)
	ctx := t.Context()
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := owner.Exec(ctx, sql, args...); err != nil {
			t.Fatal(err)
		}
	}
	controls, err := featurecontrol.NewPostgresRepository(runtime, 10*time.Second, policy.NewEngine(), featurecontrol.NewDefaultCatalog())
	if err != nil {
		t.Fatal(err)
	}
	repo, err := NewPostgresRepository(runtime, 10*time.Second, policy.NewEngine(), controls)
	if err != nil {
		t.Fatal(err)
	}
	store := &chatImportTestStore{}
	service, err := NewService(repo, store)
	if err != nil {
		t.Fatal(err)
	}
	authority := &chatImportTestAuthority{integrationSpaces: integrationSpaces{tenantID: f.tenantID, spaceID: room.spaceID, roomID: room.roomID,
		roles: map[uuid.UUID]media.InstanceRole{f.ownerID: media.InstanceRoleHost, f.studentID: media.InstanceRoleAttendee}}}
	service.UseSpaceAuthority(authority)
	host := integrationContentAccess(f.tenantID, f.ownerID, policy.OrganizationRoleTeacher)
	student := integrationContentAccess(f.tenantID, f.studentID, policy.OrganizationRoleStudent)
	otherRoom := seedRoomDocumentSpace(t, ctx, owner, f)
	type conversation struct{ id, message uuid.UUID }
	seedRoomChat := func(space uuid.UUID) conversation {
		c := conversation{uuid.New(), uuid.New()}
		exec(`INSERT INTO tutorhub.conversations (id,tenant_id,kind,media_space_id,created_by_user_id)
VALUES ($1,$2,'room',$3,$4)`, c.id, f.tenantID, space, f.ownerID)
		exec(`INSERT INTO tutorhub.messages (id,tenant_id,conversation_id,sequence,author_user_id,client_message_id,request_fingerprint,content)
VALUES ($1,$2,$3,1,$4,gen_random_uuid(),decode(repeat('ab',32),'hex'),'worksheet')`, c.message, f.tenantID, c.id, f.studentID)
		return c
	}
	chat, other := seedRoomChat(room.spaceID), seedRoomChat(otherRoom.spaceID)
	seed := func(chat conversation, state, backend string, data []byte) SaveRoomChatAttachmentInput {
		t.Helper()
		id := uuid.New()
		var message, key, inline any
		if state == "attached" {
			message = chat.message
		}
		if backend == "b2" {
			key = fmt.Sprintf("tenants/%s/chat-attachments/%s", f.tenantID, id)
		} else if state != "deleted" {
			inline = data
		}
		exec(`INSERT INTO tutorhub.message_attachments
(id,tenant_id,conversation_id,message_id,uploader_user_id,client_attachment_id,request_fingerprint,kind,display_name,media_type,size_bytes,storage_backend,object_key,inline_bytes,state,expires_at)
VALUES ($1,$2,$3,$4,$5,gen_random_uuid(),decode(repeat('ab',32),'hex'),'file','document.pdf','application/pdf',$6,$7,$8,$9,$10,now()+interval '1 day')`,
			id, f.tenantID, chat.id, message, f.studentID, len(data), backend, key, inline, state)
		return SaveRoomChatAttachmentInput{ConversationID: chat.id, AttachmentID: id, ClientRequestID: uuid.New()}
	}
	pdf := buildPDF(pdfFixtureOptions{pages: 2})
	valid := seed(chat, "attached", "inline_dev", pdf)
	for _, input := range []SaveRoomChatAttachmentInput{seed(chat, "staged", "inline_dev", pdf), seed(chat, "deleted", "inline_dev", pdf), seed(other, "attached", "inline_dev", pdf)} {
		if _, err := service.SaveRoomChatAttachment(ctx, host, room.spaceID, input); !errors.Is(err, ErrNotFound) {
			t.Fatalf("unbound attachment: %v", err)
		}
	}
	if _, err := service.SaveRoomChatAttachment(ctx, student, room.spaceID, valid); !errors.Is(err, ErrNotFound) {
		t.Fatalf("student write: %v", err)
	}
	foreign := integrationContentAccess(f.foreignTenantID, f.foreignOwnerID, policy.OrganizationRoleTeacher)
	if _, err := service.SaveRoomChatAttachment(ctx, foreign, room.spaceID, valid); !errors.Is(err, ErrNotFound) {
		t.Fatalf("cross-tenant room: %v", err)
	}
	if _, err := service.SaveRoomChatAttachment(ctx, host, room.spaceID, seed(chat, "attached", "inline_dev", buildPDF(pdfFixtureOptions{pages: 2, encrypted: true}))); !errors.Is(err, ErrDocumentUnsupported) {
		t.Fatalf("encrypted PDF: %v", err)
	}
	var count int
	if err := owner.QueryRow(ctx, `SELECT count(*) FROM tutorhub.tenant_file_usage WHERE tenant_id=$1`, f.tenantID).Scan(&count); err != nil || count != 0 || store.writes != 0 {
		t.Fatalf("invalid import touched quota/storage: %d, %d, %v", count, store.writes, err)
	}
	type outcome struct {
		SaveRoomChatAttachmentResult
		err error
	}
	outcomes := make(chan outcome, 2)
	for range 2 {
		go func() {
			res, err := service.SaveRoomChatAttachment(ctx, host, room.spaceID, valid)
			outcomes <- outcome{res, err}
		}()
	}
	first, second := <-outcomes, <-outcomes
	if first.err != nil || second.err != nil || first.Created == second.Created || store.writes != 1 ||
		first.Document.ID != second.Document.ID || first.Document.Status != StatusReady || !first.Document.ViewerAccess.CanView ||
		first.Document.PageCount == nil || *first.Document.PageCount != 2 || first.Document.AllowStudentDownload {
		t.Fatalf("concurrent imports: %+v %+v, writes=%d", first, second, store.writes)
	}
	var stored []byte
	if err := owner.QueryRow(ctx, `SELECT stored_checksum_sha256 FROM tutorhub.content_files WHERE tenant_id=$1 AND id=$2`, f.tenantID, first.Document.ID).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(pdf)
	if !bytes.Equal(stored, digest[:]) {
		t.Fatal("import digest differs from source")
	}
	changed := valid
	changed.AllowStudentDownload = boolPointer(true)
	if _, err := service.SaveRoomChatAttachment(ctx, host, room.spaceID, changed); !errors.Is(err, ErrIdempotencyConflict) {
		t.Fatalf("same key with different policy: %v", err)
	}
	checkUsage := func(files, reserved, committed int64) {
		t.Helper()
		var x, y, z int64
		if err := owner.QueryRow(ctx, `SELECT file_count,reserved_bytes,committed_bytes FROM tutorhub.tenant_file_usage WHERE tenant_id=$1`, f.tenantID).Scan(&x, &y, &z); err != nil || x != files || y != reserved || z != committed {
			t.Fatalf("quota: %d,%d,%d err=%v", x, y, z, err)
		}
	}
	size := int64(len(pdf))
	checkUsage(1, 0, size)
	classFile := seed(chat, "attached", "b2", pdf)
	classFile.Scope = OwnerKindClass
	if _, err := service.SaveRoomChatAttachment(ctx, host, room.spaceID, classFile); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("classless source: %v", err)
	}
	authority.linkedClass = &f.classID
	store.source, store.loseResponse = pdf, true
	if _, err := service.SaveRoomChatAttachment(ctx, host, room.spaceID, classFile); !errors.Is(err, ErrStorageUnavailable) {
		t.Fatalf("lost PUT response: %v", err)
	}
	checkUsage(2, size, size)
	recovered, err := service.SaveRoomChatAttachment(ctx, host, room.spaceID, classFile)
	if err != nil || !recovered.Created || recovered.Document.OwnerKind != OwnerKindClass || !recovered.Document.AllowStudentDownload || store.writes != 2 || store.reads != 1 {
		t.Fatalf("class import replay: %+v err=%v writes=%d version reads=%d", recovered, err, store.writes, store.reads)
	}
	checkUsage(2, 0, size*2)
	store.headErr, store.source = errors.New("offline"), nil
	replay, err := service.SaveRoomChatAttachment(ctx, host, room.spaceID, classFile)
	if err != nil || replay.Created || replay.Document.ID != recovered.Document.ID {
		t.Fatalf("ready replay must succeed without the object store: %+v err=%v", replay, err)
	}
	store.headErr = nil
	retracted := seed(chat, "attached", "inline_dev", pdf)
	store.onPut = func() {
		exec(`UPDATE tutorhub.message_attachments SET state='deleted',inline_bytes=NULL WHERE tenant_id=$1 AND id=$2`, f.tenantID, retracted.AttachmentID)
	}
	deletedVersions := 0
	store.onDelete = func(key, version string) error {
		deletedVersions++
		var committed bool
		err := owner.QueryRow(ctx, `SELECT deleted_at IS NOT NULL AND deletion_reason='chat_source_unavailable'
FROM tutorhub.content_files WHERE tenant_id=$1 AND client_request_id=$2 AND object_key=$3`, f.tenantID, retracted.ClientRequestID, key).Scan(&committed)
		if err != nil || !committed || store.metadata[key].VersionID != version {
			t.Fatalf("cleanup must follow a committed tombstone for the exact version: committed=%t err=%v", committed, err)
		}
		return nil
	}
	if _, err := service.SaveRoomChatAttachment(ctx, host, room.spaceID, retracted); !errors.Is(err, ErrNotFound) || deletedVersions != 1 {
		t.Fatalf("source retracted during PUT: err=%v deleted versions=%d", err, deletedVersions)
	}
	checkUsage(2, 0, size*2)
	exec(`UPDATE tutorhub.classes SET status='archived',archived_at=now(),archived_from_status='active' WHERE tenant_id=$1 AND id=$2`, f.tenantID, f.classID)
	if _, err := service.SaveRoomChatAttachment(ctx, host, room.spaceID, valid); !errors.Is(err, ErrReadOnly) {
		t.Fatalf("archived class must make room scope read-only: %v", err)
	}
}
