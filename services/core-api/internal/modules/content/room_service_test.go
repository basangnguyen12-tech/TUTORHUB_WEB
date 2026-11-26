package content

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"io"
	"net/http"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/tutorhub-v2/core-api/internal/modules/media"
	"github.com/tutorhub-v2/core-api/internal/platform/objectstorage"
)

var roomTestTime = time.Date(2026, time.November, 26, 9, 0, 0, 0, time.UTC)

func roomSpace(viewerRole media.InstanceRole, status media.SpaceStatus, classID *uuid.UUID, active bool) media.MediaSpace {
	space := media.MediaSpace{
		ID: uuid.New(), Status: status, ViewerRole: viewerRole,
		Source: media.SourceReference{Kind: media.SourceStudyMeeting, ClassID: classID},
	}
	if classID != nil {
		space.Source.Kind = media.SourceClassSession
	}
	if active {
		space.ActiveRoomInstance = &media.RoomInstance{ID: uuid.New(), Status: media.RoomInstanceActive}
	}
	return space
}

func TestComputeRoomGrantMatrix(t *testing.T) {
	t.Parallel()
	classID := uuid.New()
	for name, test := range map[string]struct {
		space      media.MediaSpace
		state      RoomViewerState
		manage     bool
		view       bool
		writable   bool
		linkedName uuid.UUID
	}{
		"organization admin":       {roomSpace(media.InstanceRoleAttendee, media.SpaceStatusOpen, nil, true), RoomViewerState{OrganizationAdmin: true}, true, true, true, uuid.Nil},
		"host":                     {roomSpace(media.InstanceRoleHost, media.SpaceStatusScheduled, nil, false), RoomViewerState{}, true, true, true, uuid.Nil},
		"original co-host":         {roomSpace(media.InstanceRoleCoHost, media.SpaceStatusOpen, nil, true), RoomViewerState{RoomActive: true}, true, true, true, uuid.Nil},
		"teaching assistant":       {roomSpace(media.InstanceRoleTeachingAssistant, media.SpaceStatusOpen, &classID, true), RoomViewerState{RoomActive: true}, true, true, true, classID},
		"linked class teacher":     {roomSpace(media.InstanceRoleAttendee, media.SpaceStatusOpen, &classID, true), RoomViewerState{RoomActive: true, ClassStaff: true}, true, true, true, classID},
		"promoted co-host":         {roomSpace(media.InstanceRoleAttendee, media.SpaceStatusOpen, nil, true), RoomViewerState{RoomActive: true, DynamicCoHost: true, ActiveParticipant: true}, true, true, true, uuid.Nil},
		"stale promotion":          {roomSpace(media.InstanceRoleAttendee, media.SpaceStatusOpen, nil, true), RoomViewerState{RoomActive: false, DynamicCoHost: true}, false, false, true, uuid.Nil},
		"admitted student":         {roomSpace(media.InstanceRoleAttendee, media.SpaceStatusOpen, &classID, true), RoomViewerState{RoomActive: true, ActiveParticipant: true}, false, true, true, classID},
		"student not admitted":     {roomSpace(media.InstanceRoleAttendee, media.SpaceStatusOpen, &classID, true), RoomViewerState{RoomActive: true}, false, false, true, classID},
		"student after room ended": {roomSpace(media.InstanceRoleAttendee, media.SpaceStatusEnded, nil, false), RoomViewerState{ActiveParticipant: true}, false, false, false, uuid.Nil},
		"host after room ended":    {roomSpace(media.InstanceRoleHost, media.SpaceStatusEnded, nil, false), RoomViewerState{}, true, true, false, uuid.Nil},
	} {
		grant := computeRoomGrant(test.space, test.state)
		if grant.canManage != test.manage || grant.canView != test.view || grant.writable != test.writable ||
			grant.spaceID != test.space.ID || grant.classID != test.linkedName {
			t.Fatalf("%s: grant=%+v", name, grant)
		}
	}
	operations := roomSpace(media.InstanceRoleAttendee, media.SpaceStatusOpen, nil, false)
	operations.ViewerOperations.CanManageInvites = true
	if grant := computeRoomGrant(operations, RoomViewerState{}); !grant.canManage {
		t.Fatal("study meeting owners who manage invites must manage room documents")
	}
}

func TestRoomDocumentServiceConcealsInaccessibleRooms(t *testing.T) {
	t.Parallel()
	for _, test := range []struct {
		err  error
		want error
	}{
		{media.ErrSpaceNotFound, ErrNotFound},
		{media.ErrSpaceAccessDenied, ErrNotFound},
		{media.ErrSourceUnavailable, ErrNotFound},
		{media.ErrLifecycleUnavailable, ErrUnavailable},
	} {
		service, repository, spaces, _ := newRoomTestService(t)
		spaces.err = test.err
		_, err := service.ListRoomDocuments(context.Background(), testAccess(), uuid.New(), ListFilesInput{})
		if !errors.Is(err, test.want) {
			t.Fatalf("GetSpace %v => %v, want %v", test.err, err, test.want)
		}
		if repository.stateCalls != 0 || repository.listCalls != 0 {
			t.Fatal("inaccessible rooms must not reach the room repository")
		}
	}
	service, _, spaces, _ := newRoomTestService(t)
	spaces.space = roomSpace(media.InstanceRoleHost, media.SpaceStatusOpen, nil, true)
	if _, err := service.ListRoomDocuments(context.Background(), testAccess(), uuid.New(), ListFilesInput{}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("a space projection for another id must be concealed: %v", err)
	}
}

func TestListRoomDocumentsAttachesGrantAndBindsCursorToRoom(t *testing.T) {
	t.Parallel()
	service, repository, spaces, _ := newRoomTestService(t)
	classID := uuid.New()
	spaces.space = roomSpace(media.InstanceRoleAttendee, media.SpaceStatusOpen, &classID, true)
	spaces.match = true
	repository.state = RoomViewerState{RoomActive: true, ActiveParticipant: true}
	first, second := uuid.New(), uuid.New()
	repository.roomList = RoomDocumentListResult{
		Items:   []RoomDocument{{ID: first, CreatedAt: roomTestTime}, {ID: second, CreatedAt: roomTestTime}},
		HasMore: true,
	}
	access := testAccess()
	page, err := service.ListRoomDocuments(context.Background(), access, spaces.space.ID, ListFilesInput{Limit: 2})
	if err != nil {
		t.Fatalf("list room documents: %v", err)
	}
	grant := repository.roomListAccess.room
	if grant == nil || grant.spaceID != spaces.space.ID || grant.canManage || !grant.canView ||
		grant.classID != classID {
		t.Fatalf("list must carry the derived student grant: %+v", grant)
	}
	if repository.stateRoomID != spaces.space.ActiveRoomInstance.ID || repository.stateClassID != classID {
		t.Fatalf("viewer state must use the active RoomInstance and linked class: room=%s class=%s",
			repository.stateRoomID, repository.stateClassID)
	}
	if page.NextCursor == "" {
		t.Fatal("has_more must produce a cursor")
	}
	if _, err := service.ListRoomDocuments(context.Background(), access, spaces.space.ID, ListFilesInput{
		Cursor: page.NextCursor,
	}); err != nil {
		t.Fatalf("cursor must round-trip for the same room: %v", err)
	}
	if repository.roomListParams.After == nil || repository.roomListParams.After.ID != second {
		t.Fatalf("cursor must resume after the last item: %+v", repository.roomListParams.After)
	}
	if _, err := service.ListRoomDocuments(context.Background(), access, uuid.New(), ListFilesInput{
		Cursor: page.NextCursor,
	}); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("a cursor from another room must be rejected: %v", err)
	}
	if _, err := service.ListRoomDocuments(context.Background(), access, spaces.space.ID, ListFilesInput{
		Cursor: "thfi1_class-cursor",
	}); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("a class-file cursor must be rejected: %v", err)
	}
}

func TestCreateRoomDocumentIntentDefaultsBoundsAndScope(t *testing.T) {
	t.Parallel()
	checksum := hex.EncodeToString(make([]byte, 32))
	service, repository, spaces, _ := newRoomTestService(t)
	classID := uuid.New()
	spaces.space = roomSpace(media.InstanceRoleHost, media.SpaceStatusOpen, &classID, true)
	spaces.match = true
	repository.state = RoomViewerState{RoomActive: true}
	input := RoomDocumentIntentInput{
		DisplayName: " worksheet.pdf ", DeclaredMediaType: "application/pdf",
		ExpectedSizeBytes: 4096, ChecksumSHA256: checksum, ClientRequestID: uuid.New(),
	}
	if _, err := service.CreateRoomDocumentIntent(context.Background(), testAccess(), spaces.space.ID, input); err != nil {
		t.Fatalf("create room intent: %v", err)
	}
	command := repository.createCommand
	if command.OwnerKind != OwnerKindMediaSpace || command.MediaSpaceID != spaces.space.ID ||
		command.ClassID != uuid.Nil || !command.DenyStudentDownload || !command.RequireClassroomFiles ||
		command.ExpiresAt == nil || !command.ExpiresAt.Equal(roomTestTime.Add(30*24*time.Hour)) ||
		command.DisplayName != "worksheet.pdf" {
		t.Fatalf("unexpected media_space command: %+v", command)
	}
	if bytes.Equal(command.RequestFingerprint, requestFingerprint(command)) {
		t.Fatal("room intents must use a fingerprint domain separate from class intents")
	}

	input.Scope = OwnerKindClass
	input.ClientRequestID = uuid.New()
	if _, err := service.CreateRoomDocumentIntent(context.Background(), testAccess(), spaces.space.ID, input); err != nil {
		t.Fatalf("create linked class intent: %v", err)
	}
	command = repository.createCommand
	if command.OwnerKind != OwnerKindClass || command.ClassID != classID || command.MediaSpaceID != uuid.Nil ||
		command.DenyStudentDownload || command.ExpiresAt != nil || !command.RequireClassroomFiles {
		t.Fatalf("unexpected class command: %+v", command)
	}

	calls := repository.createCalls
	for name, invalid := range map[string]RoomDocumentIntentInput{
		"zip":             {DisplayName: "a.zip", DeclaredMediaType: "application/zip", ExpectedSizeBytes: 10, ChecksumSHA256: checksum, ClientRequestID: uuid.New()},
		"pdf over 50 MiB": {DisplayName: "a.pdf", DeclaredMediaType: "application/pdf", ExpectedSizeBytes: ViewerPDFMaxBytes + 1, ChecksumSHA256: checksum, ClientRequestID: uuid.New()},
		"png over 10 MiB": {DisplayName: "a.png", DeclaredMediaType: "image/png", ExpectedSizeBytes: ViewerImageMaxBytes + 1, ChecksumSHA256: checksum, ClientRequestID: uuid.New()},
	} {
		if _, err := service.CreateRoomDocumentIntent(context.Background(), testAccess(), spaces.space.ID, invalid); !errors.Is(err, ErrDocumentUnsupported) {
			t.Fatalf("%s must be unsupported: %v", name, err)
		}
	}
	if repository.createCalls != calls {
		t.Fatal("unsupported documents must not reach the repository")
	}

	studyMeeting, studyRepository, studySpaces, _ := newRoomTestService(t)
	studySpaces.space = roomSpace(media.InstanceRoleHost, media.SpaceStatusOpen, nil, true)
	studySpaces.match = true
	input.ClientRequestID = uuid.New()
	if _, err := studyMeeting.CreateRoomDocumentIntent(context.Background(), testAccess(), studySpaces.space.ID, input); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("scope=class needs a linked class: %v", err)
	}
	if studyRepository.createCalls != 0 {
		t.Fatal("invalid class scope must not create an intent")
	}

	attendee, attendeeRepository, attendeeSpaces, _ := newRoomTestService(t)
	attendeeSpaces.space = roomSpace(media.InstanceRoleAttendee, media.SpaceStatusOpen, nil, true)
	attendeeSpaces.match = true
	attendeeRepository.state = RoomViewerState{RoomActive: true, ActiveParticipant: true}
	input.Scope = OwnerKindMediaSpace
	if _, err := attendee.CreateRoomDocumentIntent(context.Background(), testAccess(), attendeeSpaces.space.ID, input); !errors.Is(err, ErrNotFound) {
		t.Fatalf("attendees must not upload room documents: %v", err)
	}
	if attendeeRepository.createCalls != 0 {
		t.Fatal("attendee intent must be concealed before the repository")
	}
}

func TestRoomViewCapabilityIsVersionBoundInlineAndShortLived(t *testing.T) {
	t.Parallel()
	service, repository, spaces, storage := newRoomTestService(t)
	spaces.space = roomSpace(media.InstanceRoleAttendee, media.SpaceStatusOpen, nil, true)
	spaces.match = true
	repository.state = RoomViewerState{RoomActive: true, ActiveParticipant: true}
	digest := sha256.Sum256([]byte("pdf"))
	repository.viewTarget = RoomViewTarget{
		ObjectKey: "tenants/t/files/f/original", VersionID: "version-9", MediaType: MediaTypePDF,
		ContentLengthBytes: 3, SHA256: digest[:], PageCount: 2, FirstPageAspect: 0.7071, ActiveContent: true,
	}
	storage.downloadPresigned = objectstorage.PresignedRequest{URL: "https://storage.example/view", Method: http.MethodGet}
	capability, err := service.IssueRoomDocumentViewCapability(context.Background(), testAccess(), spaces.space.ID, uuid.New())
	if err != nil {
		t.Fatalf("issue view capability: %v", err)
	}
	if storage.downloadInput.VersionID != "version-9" || storage.downloadInput.ContentDisposition != "inline" ||
		storage.downloadInput.Expires != 5*time.Minute || storage.downloadInput.ContentType != MediaTypePDF {
		t.Fatalf("unexpected presign input: %+v", storage.downloadInput)
	}
	if capability.SHA256 != hex.EncodeToString(digest[:]) || capability.PageCount != 2 ||
		!capability.ActiveContent || !capability.ExpiresAt.Equal(roomTestTime.Add(5*time.Minute)) {
		t.Fatalf("unexpected view capability: %+v", capability)
	}
	if grant := repository.viewAccess.room; grant == nil || grant.canManage || !grant.canView {
		t.Fatalf("students view with a view-only grant: %+v", grant)
	}
}

func TestFileEndpointsReauthorizeMediaSpaceFilesThroughTheRoom(t *testing.T) {
	t.Parallel()
	service, repository, spaces, _ := newRoomTestService(t)
	spaces.space = roomSpace(media.InstanceRoleHost, media.SpaceStatusOpen, nil, true)
	spaces.match = true
	repository.owner = FileOwner{Kind: OwnerKindMediaSpace, MediaSpaceID: spaces.space.ID}
	if _, err := service.Get(context.Background(), testAccess(), uuid.New()); err != nil {
		t.Fatalf("get room file: %v", err)
	}
	if grant := repository.getAccess.room; grant == nil || grant.spaceID != spaces.space.ID || !grant.canManage {
		t.Fatalf("media_space files must carry the room grant: %+v", grant)
	}
	repository.owner = FileOwner{Kind: OwnerKindClass}
	spaces.calls = 0
	if _, err := service.Get(context.Background(), testAccess(), uuid.New()); err != nil {
		t.Fatalf("get class file: %v", err)
	}
	if repository.getAccess.room != nil || spaces.calls != 0 {
		t.Fatal("class files must keep the class policy path without a room grant")
	}
	repository.owner = FileOwner{Kind: OwnerKindMediaSpace, MediaSpaceID: spaces.space.ID}
	spaces.err = media.ErrSpaceNotFound
	if _, err := service.Get(context.Background(), testAccess(), uuid.New()); err != nil {
		t.Fatalf("get with concealed room: %v", err)
	}
	if repository.getAccess.room != nil {
		t.Fatal("a concealed room must leave no grant so the repository answers 404")
	}
}

func TestFinalizeVerifiesViewerFilesInOneCall(t *testing.T) {
	t.Parallel()
	service, repository, _, storage := newRoomTestService(t)
	pdf := buildPDF(pdfFixtureOptions{pages: 2})
	digest := sha256.Sum256(pdf)
	fileID := uuid.New()
	repository.finalizeTarget = FinalizeTarget{
		File:      File{ID: fileID, Status: StatusPending, DeclaredMediaType: MediaTypePDF, ExpectedSizeBytes: int64(len(pdf))},
		ObjectKey: "tenants/t/files/f/original",
	}
	storage.metadata = objectstorage.Metadata{
		ContentLength: int64(len(pdf)), ContentType: MediaTypePDF, ETag: "etag", VersionID: "version-1",
	}
	repository.commitFile = File{ID: fileID, Status: StatusUploaded, DeclaredMediaType: MediaTypePDF}
	repository.claimOK = true
	repository.claimTarget = VerificationTarget{
		FileID: fileID, Version: 3, ObjectKey: "tenants/t/files/f/original", StorageVersionID: "version-1",
		DeclaredMediaType: MediaTypePDF, ExpectedSizeBytes: int64(len(pdf)), ExpectedChecksum: digest[:],
	}
	storage.objects = map[string][]byte{"version-1": pdf}
	repository.getFile = File{ID: fileID, Status: StatusReady}
	file, err := service.Finalize(context.Background(), testAccess(), fileID, FinalizeInput{
		ExpectedVersion: 1, StorageVersionID: "version-1",
	})
	if err != nil {
		t.Fatalf("finalize: %v", err)
	}
	if file.Status != StatusReady || len(repository.completed) != 1 || !repository.completed[0].Ready ||
		repository.completed[0].PageCount != 2 || storage.getVersion != "version-1" {
		t.Fatalf("finalize must verify the exact version: file=%+v completed=%+v version=%q",
			file, repository.completed, storage.getVersion)
	}

	storage.getErr = errors.New("storage reset")
	repository.completed = nil
	repository.getFile = File{ID: fileID, Status: StatusProcessing}
	file, err = service.Finalize(context.Background(), testAccess(), fileID, FinalizeInput{
		ExpectedVersion: 1, StorageVersionID: "version-1",
	})
	if err != nil || file.Status != StatusProcessing || len(repository.completed) != 0 {
		t.Fatalf("transient storage failures must leave processing: file=%+v err=%v", file, err)
	}

	storage.getErr = nil
	repository.claimCalls = 0
	repository.commitFile = File{ID: fileID, Status: StatusUploaded, DeclaredMediaType: "application/zip"}
	if _, err := service.Finalize(context.Background(), testAccess(), fileID, FinalizeInput{
		ExpectedVersion: 1, StorageVersionID: "version-1",
	}); err != nil {
		t.Fatalf("finalize non-viewer file: %v", err)
	}
	if repository.claimCalls != 0 {
		t.Fatal("non-viewer class uploads must keep uploaded semantics")
	}
}

func TestFinalizeReplayAfterVerificationReturnsCurrentState(t *testing.T) {
	t.Parallel()
	service, repository, _, storage := newRoomTestService(t)
	repository.finalizeTarget = FinalizeTarget{
		File: File{ID: uuid.New(), Status: StatusReady}, StorageVersionID: "version-1",
	}
	file, err := service.Finalize(context.Background(), testAccess(), uuid.New(), FinalizeInput{
		ExpectedVersion: 1, StorageVersionID: "version-1",
	})
	if err != nil || file.Status != StatusReady || storage.calls != 0 || repository.commitCalls != 0 {
		t.Fatalf("replay must not re-head or re-commit: file=%+v err=%v", file, err)
	}
	if _, err := service.Finalize(context.Background(), testAccess(), uuid.New(), FinalizeInput{
		ExpectedVersion: 1, StorageVersionID: "version-2",
	}); !errors.Is(err, ErrVersionConflict) {
		t.Fatalf("replay for another stored version must conflict: %v", err)
	}
}

func TestVerifyPendingBatchRecoversStaleFiles(t *testing.T) {
	t.Parallel()
	service, repository, _, storage := newRoomTestService(t)
	png := pngBytes(t, 4, 2)
	digest := sha256.Sum256(png)
	wrong := sha256.Sum256([]byte("other"))
	repository.staleTargets = []VerificationTarget{
		{FileID: uuid.New(), Version: 4, ObjectKey: "k1", StorageVersionID: "v-png", DeclaredMediaType: MediaTypePNG,
			ExpectedSizeBytes: int64(len(png)), ExpectedChecksum: digest[:]},
		{FileID: uuid.New(), Version: 4, ObjectKey: "k2", StorageVersionID: "v-bad", DeclaredMediaType: MediaTypePNG,
			ExpectedSizeBytes: int64(len(png)), ExpectedChecksum: wrong[:]},
		{FileID: uuid.New(), Version: 4, ObjectKey: "k3", StorageVersionID: "v-big", DeclaredMediaType: MediaTypePDF,
			ExpectedSizeBytes: ViewerPDFMaxBytes + 1, ExpectedChecksum: digest[:]},
	}
	storage.objects = map[string][]byte{"v-png": png, "v-bad": png}
	completed, err := service.VerifyPendingBatch(context.Background(), 10)
	if err != nil || completed != 3 {
		t.Fatalf("batch completed=%d err=%v", completed, err)
	}
	if !repository.staleBefore.Equal(roomTestTime.Add(-2*time.Minute)) || repository.staleLimit != 10 {
		t.Fatalf("stale claim window: before=%s limit=%d", repository.staleBefore, repository.staleLimit)
	}
	if !repository.completed[0].Ready || repository.completed[1].RejectionReason != RejectChecksumMismatch ||
		repository.completed[2].RejectionReason != RejectFileTooLargeForViewer {
		t.Fatalf("unexpected recovery outcomes: %+v", repository.completed)
	}
	if storage.getCalls != 2 {
		t.Fatalf("oversized files must be rejected without reading storage: calls=%d", storage.getCalls)
	}
}

func TestUpdateRoomDocumentValidatesBeforeAuthority(t *testing.T) {
	t.Parallel()
	service, repository, spaces, _ := newRoomTestService(t)
	allow := true
	for _, input := range []UpdateRoomDocumentInput{
		{ExpectedVersion: 1},
		{ExpectedVersion: 1, Deleted: true, AllowStudentDownload: &allow},
		{ExpectedVersion: 0, AllowStudentDownload: &allow},
	} {
		if _, err := service.UpdateRoomDocument(context.Background(), testAccess(), uuid.New(), uuid.New(), input); !errors.Is(err, ErrInvalidInput) {
			t.Fatalf("input %+v must be invalid: %v", input, err)
		}
	}
	if spaces.calls != 0 {
		t.Fatal("invalid updates must not resolve the room")
	}
	spaces.space = roomSpace(media.InstanceRoleAttendee, media.SpaceStatusOpen, nil, true)
	spaces.match = true
	repository.state = RoomViewerState{RoomActive: true, ActiveParticipant: true}
	if _, err := service.UpdateRoomDocument(context.Background(), testAccess(), spaces.space.ID, uuid.New(),
		UpdateRoomDocumentInput{ExpectedVersion: 1, Deleted: true}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("attendees must not manage room documents: %v", err)
	}
	if repository.updateCalls != 0 {
		t.Fatal("attendee updates must be concealed before the repository")
	}
}

func TestStudentCanViewButNotDownloadWhenDownloadsDisabled(t *testing.T) {
	t.Parallel()
	student := testAccess()
	row := fileRow{
		ID: uuid.New(), CreatorUserID: uuid.New(), Status: StatusReady, OwnerKind: OwnerKindMediaSpace,
		MediaSpaceID: uuid.NullUUID{UUID: uuid.New(), Valid: true}, AllowStudentDownload: false,
		DeclaredMediaType: MediaTypePDF, PageCount: sql.NullInt32{Int32: 2, Valid: true},
		FirstPageAspect: sql.NullFloat64{Float64: 0.7071, Valid: true},
		UploadExpiresAt: roomTestTime,
	}
	grant := &roomGrant{spaceID: row.MediaSpaceID.UUID, canView: true}
	document := projectRoomDocument(row, student, grant, roomClassAuthorization{}, roomTestTime)
	if !document.ViewerAccess.CanView || document.ViewerAccess.CanDownloadOriginal || document.ViewerAccess.CanManage {
		t.Fatalf("student viewer access = %+v", document.ViewerAccess)
	}
	if projectFile(row, student, fileAuthorization{}).ViewerAccess.CanDownload {
		t.Fatal("raw download must stay disabled for students when allow_student_download=false")
	}
	if !projectFile(row, student, fileAuthorization{staff: true}).ViewerAccess.CanDownload {
		t.Fatal("teaching staff may always download the original")
	}
	creator := student
	creator.ActorID = row.CreatorUserID
	if !canDownloadOriginal(row, creator, fileAuthorization{}) {
		t.Fatal("the uploader may always download the original")
	}
	row.AllowStudentDownload = true
	if !projectRoomDocument(row, student, grant, roomClassAuthorization{}, roomTestTime).ViewerAccess.CanDownloadOriginal {
		t.Fatal("allowed downloads must be visible to students")
	}
	row.OwnerKind, row.MediaSpaceID = OwnerKindClass, uuid.NullUUID{}
	row.ClassID = uuid.NullUUID{UUID: uuid.New(), Valid: true}
	classDocument := projectRoomDocument(row, student, grant, roomClassAuthorization{view: false}, roomTestTime)
	if classDocument.ViewerAccess.CanView {
		t.Fatal("class files require class file.view inside the room")
	}
	if projected := projectFile(row, student, fileAuthorization{}); projected.MediaSpaceID != nil ||
		projected.ClassID == nil || *projected.ClassID != row.ClassID.UUID {
		t.Fatalf("owner union projection = %+v", projected)
	}
}

func newRoomTestService(t *testing.T) (*Service, *fakeRoomRepository, *fakeSpaces, *fakeVersionStorage) {
	t.Helper()
	repository := &fakeRoomRepository{fakeRepository: &fakeRepository{}}
	storage := &fakeVersionStorage{fakeMetadataReader: &fakeMetadataReader{}}
	service, err := NewService(repository, storage)
	if err != nil {
		t.Fatalf("new service: %v", err)
	}
	service.now = func() time.Time { return roomTestTime }
	spaces := &fakeSpaces{}
	service.UseSpaceAuthority(spaces)
	if service.rooms == nil || service.verifications == nil || service.versions == nil {
		t.Fatal("room and verifier surfaces must be detected from the implementations")
	}
	return service, repository, spaces, storage
}

type fakeSpaces struct {
	space media.MediaSpace
	err   error
	match bool
	calls int
}

func (spaces *fakeSpaces) GetSpace(_ context.Context, access media.AccessContext, spaceID uuid.UUID) (media.MediaSpace, error) {
	spaces.calls++
	if spaces.err != nil {
		return media.MediaSpace{}, spaces.err
	}
	if access.TenantID == uuid.Nil || len(access.OrganizationRoles) == 0 {
		return media.MediaSpace{}, media.ErrSpaceAccessDenied
	}
	space := spaces.space
	if spaces.match {
		space.ID = spaceID
		spaces.space.ID = spaceID
	}
	return space, nil
}

type fakeRoomRepository struct {
	*fakeRepository
	owner          FileOwner
	state          RoomViewerState
	stateCalls     int
	stateRoomID    uuid.UUID
	stateClassID   uuid.UUID
	roomList       RoomDocumentListResult
	roomListAccess AccessContext
	roomListParams RoomDocumentListParams
	listCalls      int
	viewTarget     RoomViewTarget
	viewAccess     AccessContext
	updateCalls    int
	getAccess      AccessContext
	claimOK        bool
	claimTarget    VerificationTarget
	claimCalls     int
	completed      []VerificationResult
	staleTargets   []VerificationTarget
	staleBefore    time.Time
	staleLimit     int
}

func (repository *fakeRoomRepository) Get(_ context.Context, access AccessContext, _ uuid.UUID) (File, error) {
	repository.getAccess = access
	return repository.getFile, repository.getErr
}

func (repository *fakeRoomRepository) CreateIntent(_ context.Context, access AccessContext, command CreateCommand) (CreateIntentResult, error) {
	repository.createCalls++
	repository.createCommand = command
	if command.OwnerKind == OwnerKindMediaSpace && (access.room == nil || access.room.spaceID != command.MediaSpaceID) {
		return CreateIntentResult{}, ErrNotFound
	}
	return CreateIntentResult{Created: true}, nil
}

func (repository *fakeRoomRepository) FileOwner(context.Context, uuid.UUID, uuid.UUID) (FileOwner, error) {
	if repository.owner.Kind == "" {
		return FileOwner{}, ErrNotFound
	}
	return repository.owner, nil
}

func (repository *fakeRoomRepository) RoomViewerState(
	_ context.Context, _ AccessContext, _ uuid.UUID, roomID uuid.UUID, classID uuid.UUID,
) (RoomViewerState, error) {
	repository.stateCalls++
	repository.stateRoomID, repository.stateClassID = roomID, classID
	return repository.state, nil
}

func (repository *fakeRoomRepository) ListRoomDocuments(
	_ context.Context, access AccessContext, params RoomDocumentListParams,
) (RoomDocumentListResult, error) {
	repository.listCalls++
	repository.roomListAccess, repository.roomListParams = access, params
	return repository.roomList, nil
}

func (repository *fakeRoomRepository) PrepareRoomView(
	_ context.Context, access AccessContext, _ uuid.UUID, _ uuid.UUID, _ time.Time,
) (RoomViewTarget, error) {
	repository.viewAccess = access
	return repository.viewTarget, nil
}

func (repository *fakeRoomRepository) UpdateRoomDocument(
	context.Context, AccessContext, uuid.UUID, uuid.UUID, UpdateRoomDocumentInput, time.Time,
) (UpdateRoomDocumentResult, error) {
	repository.updateCalls++
	return UpdateRoomDocumentResult{}, nil
}

func (repository *fakeRoomRepository) ClaimVerification(
	context.Context, uuid.UUID, uuid.UUID, time.Time,
) (VerificationTarget, bool, error) {
	repository.claimCalls++
	return repository.claimTarget, repository.claimOK, nil
}

func (repository *fakeRoomRepository) CompleteVerification(
	_ context.Context, _ VerificationTarget, result VerificationResult, _ time.Time,
) (bool, error) {
	repository.completed = append(repository.completed, result)
	return true, nil
}

func (repository *fakeRoomRepository) ClaimStaleVerifications(
	_ context.Context, limit int, staleBefore time.Time, _ time.Time,
) ([]VerificationTarget, error) {
	repository.staleLimit, repository.staleBefore = limit, staleBefore
	return repository.staleTargets, nil
}

type fakeVersionStorage struct {
	*fakeMetadataReader
	objects    map[string][]byte
	getErr     error
	getVersion string
	getCalls   int
}

func (storage *fakeVersionStorage) GetVersion(_ context.Context, _ string, versionID string) (objectstorage.Object, error) {
	storage.getCalls++
	storage.getVersion = versionID
	if storage.getErr != nil {
		return objectstorage.Object{}, storage.getErr
	}
	body, ok := storage.objects[versionID]
	if !ok {
		return objectstorage.Object{}, errors.New("missing version")
	}
	return objectstorage.Object{
		Body: io.NopCloser(bytes.NewReader(body)), ContentLength: int64(len(body)), VersionID: versionID,
	}, nil
}
