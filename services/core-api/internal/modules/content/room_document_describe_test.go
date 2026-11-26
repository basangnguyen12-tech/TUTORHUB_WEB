package content

import (
	"context"
	"crypto/sha256"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/tutorhub-v2/core-api/internal/config"
	"github.com/tutorhub-v2/core-api/internal/modules/media"
	"github.com/tutorhub-v2/core-api/internal/platform/objectstorage"
)

// ROOM-TOOLS-FILES-02A: the PDF presentation control plane binds a
// presentation to the exact storage version through DescribeRoomDocument,
// which shares view-capability authorization but never presigns a URL.
func TestDescribeRoomDocumentSharesViewAuthorizationWithoutPresigning(t *testing.T) {
	t.Parallel()
	service, repository, spaces, storage := newRoomTestService(t)
	spaces.space = roomSpace(media.InstanceRoleAttendee, media.SpaceStatusOpen, nil, true)
	spaces.match = true
	repository.state = RoomViewerState{RoomActive: true, ActiveParticipant: true}
	digest := sha256.Sum256([]byte("pdf"))
	repository.viewTarget = RoomViewTarget{
		ObjectKey: "tenants/t/files/f/original", VersionID: "version-9", MediaType: MediaTypePDF,
		ContentLengthBytes: 3, SHA256: digest[:], PageCount: 12, FirstPageAspect: 0.7071,
		ActiveContent: true, DisplayName: "De kiem tra.pdf", AllowStudentDownload: false,
	}
	fileID := uuid.New()
	descriptor, err := service.DescribeRoomDocument(context.Background(), testAccess(), spaces.space.ID, fileID)
	if err != nil {
		t.Fatalf("describe room document: %v", err)
	}
	if descriptor.FileID != fileID || descriptor.VersionID != "version-9" || descriptor.PageCount != 12 ||
		descriptor.DisplayName != "De kiem tra.pdf" || descriptor.AllowStudentDownload ||
		!descriptor.ActiveContent || descriptor.MediaType != MediaTypePDF {
		t.Fatalf("unexpected descriptor: %+v", descriptor)
	}
	if storage.downloadInput.Key != "" {
		t.Fatalf("describe must never presign storage: %+v", storage.downloadInput)
	}
	if grant := repository.viewAccess.room; grant == nil || grant.canManage || !grant.canView {
		t.Fatalf("students describe with a view-only grant: %+v", grant)
	}

	spaces.space = roomSpace(media.InstanceRoleAttendee, media.SpaceStatusOpen, nil, true)
	repository.state = RoomViewerState{RoomActive: true}
	repository.viewAccess = AccessContext{}
	if _, err := service.DescribeRoomDocument(context.Background(), testAccess(), spaces.space.ID, fileID); err == nil &&
		repository.viewAccess.room != nil && repository.viewAccess.room.canView {
		t.Fatal("an attendee outside the RoomInstance must not gain a view grant")
	}
	if _, err := service.DescribeRoomDocument(context.Background(), testAccess(), spaces.space.ID, uuid.Nil); err != ErrNotFound {
		t.Fatalf("nil file must be concealed, got %v", err)
	}
}

// R3 (02B HTTP Range transport): the version-bound room view capability is a
// SigV4 query presign that signs only `host`. Range and Content-Length are not
// signed, so the viewer may issue `Range: bytes=a-b` against the same URL.
func TestRoomViewCapabilityPresignDoesNotPinRangeOrContentLength(t *testing.T) {
	t.Parallel()
	store, err := objectstorage.NewB2(context.Background(), config.ObjectStorageConfig{
		Enabled: true, Endpoint: "https://s3.us-east-005.backblazeb2.com",
		Region: "us-east-005", Bucket: "tutorhub-test",
		KeyID: "test-key-id", ApplicationKey: "test-application-key",
	})
	if err != nil {
		t.Fatalf("create B2 store: %v", err)
	}
	presigned, err := store.PresignDownload(context.Background(), objectstorage.DownloadPresignInput{
		Key: "tenants/t/files/f/original", VersionID: "version-9", ContentType: MediaTypePDF,
		ContentDisposition: "inline", Expires: roomViewCapabilityTTL,
	})
	if err != nil {
		t.Fatalf("presign room view: %v", err)
	}
	parsed, err := url.Parse(presigned.URL)
	if err != nil {
		t.Fatalf("parse presigned URL: %v", err)
	}
	query := parsed.Query()
	if signed := query.Get("X-Amz-SignedHeaders"); signed != "host" {
		t.Fatalf("view capability must sign only host, got %q", signed)
	}
	if query.Get("versionId") != "version-9" || query.Get("X-Amz-Expires") != "300" {
		t.Fatalf("view capability must stay version-bound and short-lived: %v", query)
	}
	lowered := strings.ToLower(presigned.URL)
	for _, pinned := range []string{"range", "content-length"} {
		if strings.Contains(lowered, pinned) {
			t.Fatalf("view capability must not pin %q", pinned)
		}
	}
	for name := range presigned.SignedHeader {
		if strings.EqualFold(name, "Range") || strings.EqualFold(name, "Content-Length") {
			t.Fatalf("view capability must not require signed header %q", name)
		}
	}
	if roomViewCapabilityTTL > 5*time.Minute {
		t.Fatalf("view capability TTL drifted: %s", roomViewCapabilityTTL)
	}
}
