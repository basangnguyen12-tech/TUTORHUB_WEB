package httpapi

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/tutorhub-v2/core-api/internal/config"
	"github.com/tutorhub-v2/core-api/internal/modules/content"
	"github.com/tutorhub-v2/core-api/internal/modules/featurecontrol"
	"github.com/tutorhub-v2/core-api/internal/modules/identity"
)

func roomDocumentTestHandler(
	identityService identity.ServiceAPI,
	service content.RoomDocumentServiceAPI,
	logs *bytes.Buffer,
) http.Handler {
	options := Options{
		Clock:    func() time.Time { return contentTestHTTPTime },
		Identity: identityService,
	}
	if service != nil {
		options.RoomDocuments = service
	}
	return NewHandlerWithOptions(
		config.Config{
			Environment: "test", Port: "8080", WebOrigin: "http://localhost:5173",
			Authentication: config.AuthenticationConfig{SessionTTL: 8 * time.Hour},
		},
		slog.New(slog.NewTextHandler(logs, nil)),
		options,
	)
}

func roomDocumentRequest(method, path, body string, tenantID uuid.UUID) *http.Request {
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set(csrfHeader, "csrf-token")
	request.Header.Set(fileTenantHeader, tenantID.String())
	addSessionCookie(request)
	request.AddCookie(&http.Cookie{Name: "tutorhub_csrf", Value: "csrf-token"})
	return request
}

func roomDocumentPath(spaceID uuid.UUID, suffix string) string {
	return "/api/v1/media/spaces/" + spaceID.String() + "/documents" + suffix
}

func TestRoomDocumentListBindsTenantRoomAndHidesPrivateFields(t *testing.T) {
	t.Parallel()
	tenantID, userID, spaceID := uuid.New(), uuid.New(), uuid.New()
	pages := 3
	aspect := 0.7071
	service := &fakeRoomDocumentService{listPage: content.RoomDocumentPage{
		Items: []content.RoomDocument{{
			ID: uuid.New(), OwnerKind: content.OwnerKindMediaSpace, MediaSpaceID: &spaceID,
			DisplayName: "worksheet.pdf", DeclaredMediaType: "application/pdf",
			ExpectedSizeBytes: 4096, Status: content.StatusReady, Version: 4,
			PageCount: &pages, FirstPageAspect: &aspect,
			CreatedAt: contentTestHTTPTime, UpdatedAt: contentTestHTTPTime,
			ViewerAccess: content.RoomDocumentViewerAccess{CanView: true},
		}},
		NextCursor: "thrd1_next",
	}}
	logs := &bytes.Buffer{}
	handler := roomDocumentTestHandler(classIdentityService(tenantID, userID, nil), service, logs)
	request := httptest.NewRequest(http.MethodGet, roomDocumentPath(spaceID, "?limit=5&cursor=thrd1_current"), nil)
	request.Header.Set(fileTenantHeader, tenantID.String())
	addSessionCookie(request)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d: %s", response.Code, response.Body.String())
	}
	assertFileHeaders(t, response)
	if service.listSpaceID != spaceID || service.listInput.Limit != 5 ||
		service.listInput.Cursor != "thrd1_current" || service.listAccess.TenantID != tenantID ||
		service.listAccess.ActorID != userID {
		t.Fatalf("unexpected list binding: space=%s input=%+v access=%+v",
			service.listSpaceID, service.listInput, service.listAccess)
	}
	var page map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &page); err != nil {
		t.Fatalf("decode page: %v", err)
	}
	items := page["items"].([]any)
	item := items[0].(map[string]any)
	for _, private := range []string{
		"creator_user_id", "expected_checksum_sha256", "object_key", "storage_version_id", "tenant_id",
	} {
		if _, exposed := item[private]; exposed {
			t.Fatalf("room document exposed %s: %#v", private, item)
		}
	}
	if page["next_cursor"] != "thrd1_next" || item["class_id"] != nil {
		t.Fatalf("unexpected page projection: %#v", page)
	}
}

func TestRoomDocumentEndpointsRequireExpectedTenantAndCSRF(t *testing.T) {
	t.Parallel()
	tenantID, spaceID := uuid.New(), uuid.New()
	service := &fakeRoomDocumentService{}
	handler := roomDocumentTestHandler(classIdentityService(tenantID, uuid.New(), nil), service, &bytes.Buffer{})

	missingTenant := httptest.NewRequest(http.MethodGet, roomDocumentPath(spaceID, ""), nil)
	addSessionCookie(missingTenant)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, missingTenant)
	assertFileProblem(t, response, http.StatusBadRequest, "room_document_invalid")

	missingCSRF := httptest.NewRequest(http.MethodPost, roomDocumentPath(spaceID, "/"+uuid.NewString()+"/view-capabilities"), nil)
	missingCSRF.Header.Set(fileTenantHeader, tenantID.String())
	addSessionCookie(missingCSRF)
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, missingCSRF)
	if response.Code != http.StatusForbidden {
		t.Fatalf("missing CSRF status=%d", response.Code)
	}

	wrongTenant := roomDocumentRequest(http.MethodPost, roomDocumentPath(spaceID, "/"+uuid.NewString()+"/view-capabilities"), "", uuid.New())
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, wrongTenant)
	assertFileProblem(t, response, http.StatusConflict, "file_scope_changed")
	if service.calls != 0 {
		t.Fatal("rejected requests must not reach the room document service")
	}
}

func TestRoomDocumentFeatureDisabledIs503AndConcealmentIs404(t *testing.T) {
	t.Parallel()
	tenantID, spaceID := uuid.New(), uuid.New()
	for _, test := range []struct {
		err    error
		status int
		code   string
	}{
		{&featurecontrol.FeatureDisabledError{Feature: featurecontrol.FeatureClassroomFilesTool}, http.StatusServiceUnavailable, "feature_disabled"},
		{content.ErrNotFound, http.StatusNotFound, "room_document_not_found"},
		{content.ErrNotReady, http.StatusConflict, "room_document_not_ready"},
		{content.ErrVersionConflict, http.StatusConflict, "room_document_version_conflict"},
		{content.ErrReadOnly, http.StatusConflict, "room_document_read_only"},
		{content.ErrDocumentUnsupported, http.StatusBadRequest, "room_document_unsupported"},
	} {
		service := &fakeRoomDocumentService{err: test.err}
		handler := roomDocumentTestHandler(classIdentityService(tenantID, uuid.New(), nil), service, &bytes.Buffer{})
		request := roomDocumentRequest(http.MethodPost, roomDocumentPath(spaceID, "/"+uuid.NewString()+"/view-capabilities"), "", tenantID)
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		assertFileProblem(t, response, test.status, test.code)
	}
	handler := roomDocumentTestHandler(classIdentityService(tenantID, uuid.New(), nil), nil, &bytes.Buffer{})
	request := httptest.NewRequest(http.MethodGet, roomDocumentPath(spaceID, ""), nil)
	request.Header.Set(fileTenantHeader, tenantID.String())
	addSessionCookie(request)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	assertFileProblem(t, response, http.StatusServiceUnavailable, "feature_disabled")
}

func TestRoomDocumentUploadIntentParsesScopeAndDownloadPolicy(t *testing.T) {
	t.Parallel()
	tenantID, userID, spaceID, fileID := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	requestID := uuid.New()
	service := &fakeRoomDocumentService{createResult: content.CreateIntentResult{
		Created: true,
		File: content.File{
			ID: fileID, OwnerKind: content.OwnerKindMediaSpace, MediaSpaceID: &spaceID,
			CreatorUserID: userID, DisplayName: "worksheet.pdf", DeclaredMediaType: "application/pdf",
			ExpectedSizeBytes: 4096, ExpectedChecksumSHA256: hex.EncodeToString(make([]byte, 32)),
			Status: content.StatusPending, Version: 1,
			UploadExpiresAt: contentTestHTTPTime.Add(15 * time.Minute),
			CreatedAt:       contentTestHTTPTime, UpdatedAt: contentTestHTTPTime,
		},
	}}
	handler := roomDocumentTestHandler(classIdentityService(tenantID, userID, nil), service, &bytes.Buffer{})
	body := `{"scope":"class","display_name":"worksheet.pdf","declared_media_type":"application/pdf","expected_size_bytes":4096,"checksum_sha256":"` +
		hex.EncodeToString(make([]byte, 32)) + `","client_request_id":"` + requestID.String() + `","allow_student_download":false}`
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, roomDocumentRequest(http.MethodPost, roomDocumentPath(spaceID, "/upload-intents"), body, tenantID))
	if response.Code != http.StatusCreated {
		t.Fatalf("status=%d: %s", response.Code, response.Body.String())
	}
	if service.createSpaceID != spaceID || service.createInput.Scope != content.OwnerKindClass ||
		service.createInput.ClientRequestID != requestID || service.createInput.AllowStudentDownload == nil ||
		*service.createInput.AllowStudentDownload {
		t.Fatalf("unexpected intent input: %+v", service.createInput)
	}
	var projected map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &projected); err != nil {
		t.Fatalf("decode intent: %v", err)
	}
	if projected["owner_kind"] != "media_space" || projected["class_id"] != nil ||
		projected["media_space_id"] != spaceID.String() {
		t.Fatalf("intent must expose the owner union: %#v", projected)
	}

	invalid := strings.Replace(body, `"scope":"class"`, `"scope":"tenant"`, 1)
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, roomDocumentRequest(http.MethodPost, roomDocumentPath(spaceID, "/upload-intents"), invalid, tenantID))
	assertFileProblem(t, response, http.StatusBadRequest, "room_document_invalid")
}

func TestRoomDocumentViewCapabilityNeverLogsTheBearerURL(t *testing.T) {
	t.Parallel()
	tenantID, spaceID, fileID := uuid.New(), uuid.New(), uuid.New()
	secretURL := "https://storage.example.test/object?X-Amz-Signature=super-secret"
	service := &fakeRoomDocumentService{viewCapability: content.RoomDocumentViewCapability{
		Method: http.MethodGet, URL: secretURL, ExpiresAt: contentTestHTTPTime.Add(5 * time.Minute),
		VersionID: "version-1", ContentLengthBytes: 4096, SHA256: hex.EncodeToString(make([]byte, 32)),
		MediaType: "application/pdf", PageCount: 3, FirstPageAspect: 0.7071, ActiveContent: true,
	}}
	logs := &bytes.Buffer{}
	handler := roomDocumentTestHandler(classIdentityService(tenantID, uuid.New(), nil), service, logs)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, roomDocumentRequest(http.MethodPost, roomDocumentPath(spaceID, "/"+fileID.String()+"/view-capabilities"), "", tenantID))
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d: %s", response.Code, response.Body.String())
	}
	assertFileHeaders(t, response)
	if service.viewSpaceID != spaceID || service.viewFileID != fileID {
		t.Fatalf("unexpected view binding: space=%s file=%s", service.viewSpaceID, service.viewFileID)
	}
	if !strings.Contains(response.Body.String(), "super-secret") {
		t.Fatal("capability response must carry the bearer URL")
	}
	service.err = errUnexpectedRoomFailure
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, roomDocumentRequest(http.MethodPost, roomDocumentPath(spaceID, "/"+fileID.String()+"/view-capabilities"), "", tenantID))
	assertFileProblem(t, response, http.StatusServiceUnavailable, "room_document_unavailable")
	if strings.Contains(logs.String(), "super-secret") || strings.Contains(logs.String(), "X-Amz") {
		t.Fatal("room document logs must never include capability URLs")
	}
}

func TestRoomDocumentPatchTogglesDownloadOrSoftDeletes(t *testing.T) {
	t.Parallel()
	tenantID, spaceID, fileID := uuid.New(), uuid.New(), uuid.New()
	service := &fakeRoomDocumentService{updateResult: content.UpdateRoomDocumentResult{
		Document: content.RoomDocument{ID: fileID, OwnerKind: content.OwnerKindMediaSpace, Version: 5,
			AllowStudentDownload: true, Status: content.StatusReady},
	}}
	handler := roomDocumentTestHandler(classIdentityService(tenantID, uuid.New(), nil), service, &bytes.Buffer{})
	path := roomDocumentPath(spaceID, "/"+fileID.String())
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, roomDocumentRequest(http.MethodPatch, path, `{"expected_version":4,"allow_student_download":true}`, tenantID))
	if response.Code != http.StatusOK || service.updateInput.ExpectedVersion != 4 ||
		service.updateInput.AllowStudentDownload == nil || !*service.updateInput.AllowStudentDownload ||
		service.updateInput.Deleted {
		t.Fatalf("toggle status=%d input=%+v body=%s", response.Code, service.updateInput, response.Body.String())
	}

	service.updateResult = content.UpdateRoomDocumentResult{Deleted: true}
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, roomDocumentRequest(http.MethodPatch, path, `{"expected_version":5,"deleted":true}`, tenantID))
	if response.Code != http.StatusNoContent || !service.updateInput.Deleted || response.Body.Len() != 0 {
		t.Fatalf("delete status=%d input=%+v", response.Code, service.updateInput)
	}

	calls := service.calls
	for _, body := range []string{
		`{"expected_version":5}`,
		`{"expected_version":5,"deleted":false}`,
		`{"expected_version":5,"deleted":true,"allow_student_download":false}`,
		`{"allow_student_download":true}`,
		`{"expected_version":5,"deleted":true,"unknown":1}`,
	} {
		response = httptest.NewRecorder()
		handler.ServeHTTP(response, roomDocumentRequest(http.MethodPatch, path, body, tenantID))
		assertFileProblem(t, response, http.StatusBadRequest, "room_document_invalid")
	}
	if service.calls != calls {
		t.Fatal("invalid PATCH bodies must not reach the service")
	}

	response = httptest.NewRecorder()
	handler.ServeHTTP(response, roomDocumentRequest(http.MethodDelete, path, "", tenantID))
	if response.Code != http.StatusMethodNotAllowed || response.Header().Get("Allow") != http.MethodPatch {
		t.Fatalf("DELETE status=%d allow=%q", response.Code, response.Header().Get("Allow"))
	}
}

var errUnexpectedRoomFailure = &roomFailure{}

type roomFailure struct{}

func (*roomFailure) Error() string {
	return "storage failed for https://storage.example.test/object?X-Amz-Signature=super-secret"
}

type fakeRoomDocumentService struct {
	studyAccess           content.AccessContext
	studySpace, studyFile uuid.UUID
	studyInput            content.PutRoomStudyNoteInput
	studyNote             content.RoomStudyNote
	chatInput             content.SaveRoomChatAttachmentInput
	chatResult            content.SaveRoomChatAttachmentResult
	err                   error
	calls                 int
	listPage              content.RoomDocumentPage
	listAccess            content.AccessContext
	listSpaceID           uuid.UUID
	listInput             content.ListFilesInput
	createResult          content.CreateIntentResult
	createSpaceID         uuid.UUID
	createInput           content.RoomDocumentIntentInput
	viewCapability        content.RoomDocumentViewCapability
	viewSpaceID           uuid.UUID
	viewFileID            uuid.UUID
	updateResult          content.UpdateRoomDocumentResult
	updateInput           content.UpdateRoomDocumentInput
}

func (service *fakeRoomDocumentService) ListRoomDocuments(
	_ context.Context, access content.AccessContext, spaceID uuid.UUID, input content.ListFilesInput,
) (content.RoomDocumentPage, error) {
	service.calls++
	service.listAccess, service.listSpaceID, service.listInput = access, spaceID, input
	return service.listPage, service.err
}

func (service *fakeRoomDocumentService) CreateRoomDocumentIntent(
	_ context.Context, _ content.AccessContext, spaceID uuid.UUID, input content.RoomDocumentIntentInput,
) (content.CreateIntentResult, error) {
	service.calls++
	service.createSpaceID, service.createInput = spaceID, input
	return service.createResult, service.err
}

func (service *fakeRoomDocumentService) IssueRoomDocumentViewCapability(
	_ context.Context, _ content.AccessContext, spaceID uuid.UUID, fileID uuid.UUID,
) (content.RoomDocumentViewCapability, error) {
	service.calls++
	service.viewSpaceID, service.viewFileID = spaceID, fileID
	if service.err != nil {
		return content.RoomDocumentViewCapability{}, service.err
	}
	return service.viewCapability, nil
}

func (service *fakeRoomDocumentService) UpdateRoomDocument(
	_ context.Context, _ content.AccessContext, _ uuid.UUID, _ uuid.UUID, input content.UpdateRoomDocumentInput,
) (content.UpdateRoomDocumentResult, error) {
	service.calls++
	service.updateInput = input
	return service.updateResult, service.err
}
