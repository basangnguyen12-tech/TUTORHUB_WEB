package httpapi

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/tutorhub-v2/core-api/internal/config"
	"github.com/tutorhub-v2/core-api/internal/modules/collaboration"
	"github.com/tutorhub-v2/core-api/internal/modules/identity"
)

func TestCodeLibraryMutationsRequireCSRFAndExactTenantAssertion(t *testing.T) {
	t.Parallel()
	tenantID, actorID, snippetID, spaceID := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	service := newFakeCodeLibraryService(snippetID, spaceID)
	identityService := classIdentityService(tenantID, actorID, nil)
	handler := newCodeLibraryTestHandler(identityService, service)
	createBody := `{"idempotency_key":"code-snippet-create-01","visibility":"personal","title":"Loop","file_name":"main.py","language":"python","content":"print(1)"}`
	routes := []struct {
		method string
		path   string
		body   string
		status int
	}{
		{http.MethodPost, "/api/v1/code-snippets", createBody, http.StatusCreated},
		{http.MethodPatch, "/api/v1/code-snippets/" + snippetID.String(), `{"expected_version":1,"title":"Renamed"}`, http.StatusOK},
		{http.MethodDelete, "/api/v1/code-snippets/" + snippetID.String(), "", http.StatusNoContent},
		{http.MethodPut, "/api/v1/media/spaces/" + spaceID.String() + "/code-scratchpad",
			`{"files":[{"name":"main.py","language":"python","content":"x=1"}],"active_index":0,"stdin":"","expected_version":0}`, http.StatusOK},
		{http.MethodPut, "/api/v1/media/spaces/" + spaceID.String() + "/code-scratchpad/share", `{"shared":true}`, http.StatusOK},
	}
	for _, route := range routes {
		for name, request := range map[string]*http.Request{
			"missing csrf":   whiteboardRequest(route.method, route.path, route.body, tenantID, false),
			"missing tenant": whiteboardRequest(route.method, route.path, route.body, uuid.Nil, true),
			"foreign tenant": whiteboardRequest(route.method, route.path, route.body, uuid.New(), true),
		} {
			before := service.calls
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			if response.Code < 400 || service.calls != before {
				t.Fatalf("%s %s %s must fail closed: status=%d", route.method, route.path, name, response.Code)
			}
		}
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, whiteboardRequest(route.method, route.path, route.body, tenantID, true))
		if response.Code != route.status {
			t.Fatalf("%s %s status=%d body=%s", route.method, route.path, response.Code, response.Body.String())
		}
		assertWhiteboardPrivacyHeaders(t, response)
		assertWhiteboardAccess(t, service.access, identityService.principal)
	}
	if service.createInput.Visibility != collaboration.CodeSnippetPersonal || service.createInput.ClassID != uuid.Nil ||
		service.updateInput.Title == nil || *service.updateInput.Title != "Renamed" || service.updateInput.Content != nil ||
		len(service.putInput.Files) != 1 || service.putInput.Files[0].Name != "main.py" || !service.shared {
		t.Fatalf("decoded inputs: create=%+v update=%+v put=%+v shared=%t", service.createInput, service.updateInput, service.putInput, service.shared)
	}
	foreign := httptest.NewRecorder()
	handler.ServeHTTP(foreign, whiteboardRequest(http.MethodPost, "/api/v1/code-snippets", createBody, uuid.New(), true))
	if foreign.Code != http.StatusConflict || !strings.Contains(foreign.Body.String(), "code_library_scope_changed") {
		t.Fatalf("tenant switch status=%d body=%s", foreign.Code, foreign.Body.String())
	}
}

func TestCodeLibraryReadsAreNoStoreAndNeverProjectOwnerIdentifiers(t *testing.T) {
	t.Parallel()
	tenantID, actorID, snippetID, spaceID := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	service := newFakeCodeLibraryService(snippetID, spaceID)
	handler := newCodeLibraryTestHandler(classIdentityService(tenantID, actorID, nil), service)
	for _, path := range []string{
		"/api/v1/code-snippets?scope=personal",
		"/api/v1/code-snippets/" + snippetID.String(),
		"/api/v1/media/spaces/" + spaceID.String() + "/code-scratchpad",
		"/api/v1/media/spaces/" + spaceID.String() + "/shared-scratchpads",
		"/api/v1/media/spaces/" + spaceID.String() + "/shared-scratchpads/" + service.sharedID.String(),
	} {
		missing := httptest.NewRecorder()
		handler.ServeHTTP(missing, whiteboardRequest(http.MethodGet, path, "", uuid.Nil, false))
		if missing.Code != http.StatusBadRequest {
			t.Fatalf("%s without tenant assertion status=%d", path, missing.Code)
		}
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, whiteboardRequest(http.MethodGet, path, "", tenantID, false))
		if response.Code != http.StatusOK {
			t.Fatalf("%s status=%d body=%s", path, response.Code, response.Body.String())
		}
		assertWhiteboardPrivacyHeaders(t, response)
		body := response.Body.String()
		if strings.Contains(path, "/code-snippets/") && !strings.Contains(body, `"author_display_name":"Giáo viên"`) {
			t.Fatalf("author display name was not projected: %s", body)
		}
		if strings.Contains(body, actorID.String()) || strings.Contains(body, service.ownerID.String()) ||
			strings.Contains(body, "owner_user_id") || strings.Contains(body, "user_id") {
			t.Fatalf("%s leaked a raw user identifier: %s", path, body)
		}
	}
}

func TestCodeLibraryListQueryAndBodiesAreStrict(t *testing.T) {
	t.Parallel()
	tenantID, actorID, classID := uuid.New(), uuid.New(), uuid.New()
	service := newFakeCodeLibraryService(uuid.New(), uuid.New())
	handler := newCodeLibraryTestHandler(classIdentityService(tenantID, actorID, nil), service)
	for _, query := range []string{
		"scope=personal&owner_user_id=" + uuid.NewString(),
		"scope=personal&scope=class",
		"scope=personal&limit=0",
		"scope=personal&limit=51",
		"scope=personal&limit=ten",
		"scope=class&class_id=not-a-uuid",
	} {
		before := service.calls
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, whiteboardRequest(http.MethodGet, "/api/v1/code-snippets?"+query, "", tenantID, false))
		if response.Code != http.StatusBadRequest || service.calls != before ||
			!strings.Contains(response.Body.String(), "code_library_invalid") {
			t.Fatalf("query %q status=%d body=%s", query, response.Code, response.Body.String())
		}
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, whiteboardRequest(http.MethodGet,
		"/api/v1/code-snippets?scope=class&class_id="+classID.String()+"&language=sql&q=50%25_off&limit=5&cursor=thcsv1_abc",
		"", tenantID, false))
	if response.Code != http.StatusOK || service.listInput.Scope != collaboration.CodeSnippetClass ||
		service.listInput.ClassID != classID || service.listInput.Language != "sql" ||
		service.listInput.Query != "50%_off" || service.listInput.Limit != 5 || service.listInput.Cursor != "thcsv1_abc" {
		t.Fatalf("list status=%d input=%+v", response.Code, service.listInput)
	}
	for name, body := range map[string]string{
		"unknown field":   `{"idempotency_key":"code-snippet-create-02","visibility":"personal","title":"x","file_name":"a.py","language":"python","content":"","owner_user_id":"` + uuid.NewString() + `"}`,
		"missing content": `{"idempotency_key":"code-snippet-create-02","visibility":"personal","title":"x","file_name":"a.py","language":"python"}`,
		"duplicate field": `{"idempotency_key":"code-snippet-create-02","visibility":"personal","visibility":"class","title":"x","file_name":"a.py","language":"python","content":""}`,
		"bad class id":    `{"idempotency_key":"code-snippet-create-02","visibility":"class","class_id":"nope","title":"x","file_name":"a.py","language":"python","content":""}`,
	} {
		before := service.calls
		create := httptest.NewRecorder()
		handler.ServeHTTP(create, whiteboardRequest(http.MethodPost, "/api/v1/code-snippets", body, tenantID, true))
		if create.Code != http.StatusBadRequest || service.calls != before {
			t.Fatalf("%s create status=%d body=%s", name, create.Code, create.Body.String())
		}
	}
	spacePath := "/api/v1/media/spaces/" + uuid.NewString() + "/code-scratchpad"
	for name, body := range map[string]string{
		"missing files":        `{"active_index":0}`,
		"missing active index": `{"files":[]}`,
		"file without content": `{"files":[{"name":"a.py","language":"python"}],"active_index":0}`,
		"unknown file field":   `{"files":[{"name":"a.py","language":"python","content":"","path":"../x"}],"active_index":0}`,
	} {
		before := service.calls
		put := httptest.NewRecorder()
		handler.ServeHTTP(put, whiteboardRequest(http.MethodPut, spacePath, body, tenantID, true))
		if put.Code != http.StatusBadRequest || service.calls != before {
			t.Fatalf("%s put status=%d body=%s", name, put.Code, put.Body.String())
		}
	}
	patch := httptest.NewRecorder()
	handler.ServeHTTP(patch, whiteboardRequest(http.MethodPatch, "/api/v1/code-snippets/"+uuid.NewString(), `{"title":"x"}`, tenantID, true))
	if patch.Code != http.StatusBadRequest {
		t.Fatalf("patch without expected_version status=%d", patch.Code)
	}
}

func TestCodeLibraryErrorMappingIsStableAndPrivacySafe(t *testing.T) {
	t.Parallel()
	tenantID, actorID, snippetID, spaceID := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	service := newFakeCodeLibraryService(snippetID, spaceID)
	handler := newCodeLibraryTestHandler(classIdentityService(tenantID, actorID, nil), service)
	for err, want := range map[error]struct {
		status int
		code   string
	}{
		collaboration.ErrInvalidRequest:                {http.StatusBadRequest, "code_library_invalid"},
		collaboration.ErrNotFound:                      {http.StatusNotFound, "code_library_not_found"},
		collaboration.ErrCodeLibraryForbidden:          {http.StatusForbidden, "code_library_forbidden"},
		collaboration.ErrFeatureDisabled:               {http.StatusServiceUnavailable, "feature_disabled"},
		collaboration.ErrVersionConflict:               {http.StatusConflict, "code_snippet_version_conflict"},
		collaboration.ErrIdempotencyConflict:           {http.StatusConflict, "code_snippet_idempotency_conflict"},
		collaboration.ErrCodeSnippetQuotaExceeded:      {http.StatusConflict, "code_snippet_quota_exceeded"},
		collaboration.ErrCodeStorageQuotaExceeded:      {http.StatusConflict, "code_storage_quota_exceeded"},
		collaboration.ErrCodeScratchpadVersionConflict: {http.StatusConflict, "code_scratchpad_version_conflict"},
		collaboration.ErrCodeScratchpadEmpty:           {http.StatusConflict, "code_scratchpad_empty"},
		collaboration.ErrCodeScratchpadTooLarge:        {http.StatusRequestEntityTooLarge, "code_scratchpad_too_large"},
		collaboration.ErrUnavailable:                   {http.StatusServiceUnavailable, "code_library_unavailable"},
	} {
		service.err = err
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, whiteboardRequest(http.MethodPatch, "/api/v1/code-snippets/"+snippetID.String(),
			`{"expected_version":1,"content":"SECRET_SOURCE_MARKER"}`, tenantID, true))
		if response.Code != want.status || !strings.Contains(response.Body.String(), `"code":"`+want.code+`"`) {
			t.Fatalf("%v mapped to status=%d body=%s", err, response.Code, response.Body.String())
		}
		if strings.Contains(response.Body.String(), "SECRET_SOURCE_MARKER") {
			t.Fatalf("problem body echoed source code: %s", response.Body.String())
		}
	}
}

func TestCodeLibraryRoutesFailClosedWhenServiceIsAbsent(t *testing.T) {
	t.Parallel()
	tenantID, actorID := uuid.New(), uuid.New()
	handler := newCodeLibraryTestHandler(classIdentityService(tenantID, actorID, nil), nil)
	for _, path := range []string{
		"/api/v1/code-snippets?scope=personal",
		"/api/v1/media/spaces/" + uuid.NewString() + "/shared-scratchpads",
	} {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, whiteboardRequest(http.MethodGet, path, "", tenantID, false))
		if response.Code != http.StatusServiceUnavailable || !strings.Contains(response.Body.String(), "feature_disabled") {
			t.Fatalf("%s absent service status=%d body=%s", path, response.Code, response.Body.String())
		}
	}
	method := httptest.NewRecorder()
	handler.ServeHTTP(method, whiteboardRequest(http.MethodPost, "/api/v1/media/spaces/"+uuid.NewString()+"/shared-scratchpads", `{}`, tenantID, true))
	if method.Code != http.StatusMethodNotAllowed || method.Header().Get("Allow") != http.MethodGet {
		t.Fatalf("shared scratchpads must be read-only: status=%d allow=%q", method.Code, method.Header().Get("Allow"))
	}
}

func newCodeLibraryTestHandler(identityService identity.ServiceAPI, service collaboration.CodeLibraryServiceAPI) http.Handler {
	options := Options{Clock: fixedClock, Identity: identityService}
	if service != nil {
		options.CodeLibrary = service
	}
	return NewHandlerWithOptions(
		config.Config{
			Environment: "test", Port: "8080", WebOrigin: "http://localhost:5173",
			Authentication: config.AuthenticationConfig{SessionTTL: 8 * time.Hour},
		},
		slog.New(slog.NewTextHandler(io.Discard, nil)),
		options,
	)
}

type fakeCodeLibraryService struct {
	access      collaboration.AccessContext
	calls       int
	err         error
	snippetID   uuid.UUID
	spaceID     uuid.UUID
	sharedID    uuid.UUID
	ownerID     uuid.UUID
	listInput   collaboration.CodeSnippetListInput
	createInput collaboration.CodeSnippetCreateInput
	updateInput collaboration.CodeSnippetUpdateInput
	putInput    collaboration.CodeScratchpadPutInput
	shared      bool
}

func newFakeCodeLibraryService(snippetID, spaceID uuid.UUID) *fakeCodeLibraryService {
	return &fakeCodeLibraryService{snippetID: snippetID, spaceID: spaceID, sharedID: uuid.New(), ownerID: uuid.New()}
}

func (service *fakeCodeLibraryService) record(access collaboration.AccessContext) error {
	service.access = access
	service.calls++
	return service.err
}

func (service *fakeCodeLibraryService) snippet() collaboration.CodeSnippet {
	return collaboration.CodeSnippet{
		CodeSnippetSummary: collaboration.CodeSnippetSummary{
			ID: service.snippetID, Visibility: collaboration.CodeSnippetPersonal, Title: "Loop",
			FileName: "main.py", Language: "python", ByteLength: 8, Version: 1,
			AuthorDisplayName: "Giáo viên",
			Viewer:            collaboration.CodeSnippetViewerCapabilities{CanEdit: true, CanDelete: true},
			CreatedAt:         fixedTime, UpdatedAt: fixedTime,
		},
		Content:       "print(1)",
		ContentSHA256: "sha256:" + strings.Repeat("0", 64),
	}
}

func (service *fakeCodeLibraryService) scratchpad() collaboration.CodeScratchpad {
	return collaboration.CodeScratchpad{
		ID: uuid.New(), MediaSpaceID: service.spaceID,
		Files:   []collaboration.CodeScratchpadFile{{Name: "main.py", Language: "python", Content: "x=1"}},
		Version: 1, ByteLength: 3, CreatedAt: fixedTime, UpdatedAt: fixedTime, ExpiresAt: fixedTime.Add(30 * 24 * time.Hour),
	}
}

func (service *fakeCodeLibraryService) ListSnippets(_ context.Context, access collaboration.AccessContext, input collaboration.CodeSnippetListInput) (collaboration.CodeSnippetList, error) {
	service.listInput = input
	if err := service.record(access); err != nil {
		return collaboration.CodeSnippetList{}, err
	}
	return collaboration.CodeSnippetList{Items: []collaboration.CodeSnippetSummary{service.snippet().CodeSnippetSummary}}, nil
}

func (service *fakeCodeLibraryService) CreateSnippet(_ context.Context, access collaboration.AccessContext, input collaboration.CodeSnippetCreateInput) (collaboration.CodeSnippetCreateResult, error) {
	service.createInput = input
	if err := service.record(access); err != nil {
		return collaboration.CodeSnippetCreateResult{}, err
	}
	return collaboration.CodeSnippetCreateResult{Snippet: service.snippet(), Created: true}, nil
}

func (service *fakeCodeLibraryService) GetSnippet(_ context.Context, access collaboration.AccessContext, _ uuid.UUID) (collaboration.CodeSnippet, error) {
	if err := service.record(access); err != nil {
		return collaboration.CodeSnippet{}, err
	}
	return service.snippet(), nil
}

func (service *fakeCodeLibraryService) UpdateSnippet(_ context.Context, access collaboration.AccessContext, _ uuid.UUID, input collaboration.CodeSnippetUpdateInput) (collaboration.CodeSnippet, error) {
	service.updateInput = input
	if err := service.record(access); err != nil {
		return collaboration.CodeSnippet{}, err
	}
	return service.snippet(), nil
}

func (service *fakeCodeLibraryService) DeleteSnippet(_ context.Context, access collaboration.AccessContext, _ uuid.UUID) error {
	return service.record(access)
}

func (service *fakeCodeLibraryService) GetScratchpad(_ context.Context, access collaboration.AccessContext, _ uuid.UUID) (collaboration.CodeScratchpadProjection, error) {
	if err := service.record(access); err != nil {
		return collaboration.CodeScratchpadProjection{}, err
	}
	scratchpad := service.scratchpad()
	return collaboration.CodeScratchpadProjection{Scratchpad: &scratchpad}, nil
}

func (service *fakeCodeLibraryService) PutScratchpad(_ context.Context, access collaboration.AccessContext, _ uuid.UUID, input collaboration.CodeScratchpadPutInput) (collaboration.CodeScratchpad, error) {
	service.putInput = input
	if err := service.record(access); err != nil {
		return collaboration.CodeScratchpad{}, err
	}
	return service.scratchpad(), nil
}

func (service *fakeCodeLibraryService) ShareScratchpad(_ context.Context, access collaboration.AccessContext, _ uuid.UUID, shared bool) (collaboration.CodeScratchpadProjection, error) {
	service.shared = shared
	if err := service.record(access); err != nil {
		return collaboration.CodeScratchpadProjection{}, err
	}
	scratchpad := service.scratchpad()
	scratchpad.SharedWithStaff = shared
	if shared {
		sharedAt := fixedTime
		scratchpad.SharedAt = &sharedAt
	}
	return collaboration.CodeScratchpadProjection{Scratchpad: &scratchpad}, nil
}

func (service *fakeCodeLibraryService) sharedSummary() collaboration.CodeSharedScratchpadSummary {
	participantKey := uuid.New()
	return collaboration.CodeSharedScratchpadSummary{
		ID: service.sharedID, AuthorDisplayName: "Học sinh A", ParticipantKey: &participantKey,
		FileCount: 1, ActiveFileName: "main.py", ActiveLanguage: "python", ByteLength: 3,
		SharedAt: fixedTime, UpdatedAt: fixedTime,
	}
}

func (service *fakeCodeLibraryService) ListSharedScratchpads(_ context.Context, access collaboration.AccessContext, _ uuid.UUID) (collaboration.CodeSharedScratchpadList, error) {
	if err := service.record(access); err != nil {
		return collaboration.CodeSharedScratchpadList{}, err
	}
	return collaboration.CodeSharedScratchpadList{Items: []collaboration.CodeSharedScratchpadSummary{service.sharedSummary()}}, nil
}

func (service *fakeCodeLibraryService) GetSharedScratchpad(_ context.Context, access collaboration.AccessContext, _ uuid.UUID, _ uuid.UUID) (collaboration.CodeSharedScratchpad, error) {
	if err := service.record(access); err != nil {
		return collaboration.CodeSharedScratchpad{}, err
	}
	return collaboration.CodeSharedScratchpad{
		CodeSharedScratchpadSummary: service.sharedSummary(),
		Files:                       []collaboration.CodeScratchpadFile{{Name: "main.py", Language: "python", Content: "x=1"}},
	}, nil
}
