package httpapi

import (
	"context"
	"encoding/json"
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

func TestPdfPresentationProjectionNeverLeaksActorIdentifiers(t *testing.T) {
	t.Parallel()
	tenantID, actorID, spaceID, presentationID, fileID, participantKey := uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New()
	service := &fakePdfPresentationService{projection: collaboration.PdfPresentationProjection{
		Presentation: &collaboration.PdfPresentation{
			ID: presentationID, MediaSpaceID: spaceID, FileID: fileID, VersionID: "version-7", PageCount: 12,
			Status: collaboration.DocumentOpen, Version: 2, CurrentGeneration: 1, RevokeGeneration: 1,
			Document: &collaboration.PdfRoomDocument{
				FileID: fileID, VersionID: "version-7", DisplayName: "Đề kiểm tra.pdf", MediaType: "application/pdf",
				PageCount: 12, FirstPageAspect: 0.7071,
			},
			Viewer:    collaboration.PdfPresentationViewerCapabilities{Capability: collaboration.CapabilityPresent, CanManage: true, CanExchangeGrant: true},
			CreatedAt: fixedTime, UpdatedAt: fixedTime,
		},
		CanPresent:            true,
		ActiveAnnotatorGrants: []collaboration.PdfAnnotatorGrant{{ParticipantKey: participantKey, ExpiresAt: fixedTime.Add(10 * time.Minute)}},
	}}
	identityService := classIdentityService(tenantID, actorID, nil)
	handler := newPdfPresentationTestHandler(identityService, service)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, whiteboardRequest(http.MethodGet, "/api/v1/media/spaces/"+spaceID.String()+"/pdf-presentation", "", tenantID, false))
	if response.Code != http.StatusOK || service.resolveSpace != spaceID {
		t.Fatalf("resolve status=%d body=%s", response.Code, response.Body.String())
	}
	assertWhiteboardPrivacyHeaders(t, response)
	assertWhiteboardAccess(t, service.access, identityService.principal)
	body := response.Body.String()
	for _, leaked := range []string{actorID.String(), "user_id", "participant_session_id", "pd_", "X-Amz-", "object_key", "url"} {
		if strings.Contains(body, leaked) {
			t.Fatalf("projection leaked %q: %s", leaked, body)
		}
	}
	var payload struct {
		Presentation struct {
			Document struct {
				DisplayName string `json:"display_name"`
				PageCount   int    `json:"page_count"`
			} `json:"document"`
		} `json:"presentation"`
		CanPresent bool `json:"can_present"`
		Grants     []struct {
			ParticipantKey string `json:"participant_key"`
		} `json:"active_annotator_grants"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode projection: %v", err)
	}
	if !payload.CanPresent || payload.Presentation.Document.PageCount != 12 ||
		payload.Presentation.Document.DisplayName != "Đề kiểm tra.pdf" ||
		len(payload.Grants) != 1 || payload.Grants[0].ParticipantKey != participantKey.String() {
		t.Fatalf("unexpected projection payload: %+v", payload)
	}
}

func TestPdfPresentationPresentAndTransitionsRequireCSRFTenantAssertionAndStrictBodies(t *testing.T) {
	t.Parallel()
	tenantID, actorID, spaceID, presentationID, fileID := uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New()
	service := &fakePdfPresentationService{presentResult: collaboration.PdfPresentResult{Created: true, Presentation: collaboration.PdfPresentation{
		ID: presentationID, MediaSpaceID: spaceID, FileID: fileID, VersionID: "v1", PageCount: 3,
		Status: collaboration.DocumentOpen, Version: 1, CurrentGeneration: 1, RevokeGeneration: 1,
	}}}
	handler := newPdfPresentationTestHandler(classIdentityService(tenantID, actorID, nil), service)
	path := "/api/v1/media/spaces/" + spaceID.String() + "/pdf-presentation"
	body := `{"file_id":"` + fileID.String() + `","idempotency_key":"pdf-present-request-0001"}`

	for name, request := range map[string]*http.Request{
		"missing csrf":    whiteboardRequest(http.MethodPost, path, body, tenantID, false),
		"missing tenant":  whiteboardRequest(http.MethodPost, path, body, uuid.Nil, true),
		"missing file":    whiteboardRequest(http.MethodPost, path, `{"idempotency_key":"pdf-present-request-0001"}`, tenantID, true),
		"unknown field":   whiteboardRequest(http.MethodPost, path, `{"file_id":"`+fileID.String()+`","idempotency_key":"pdf-present-request-0001","version_id":"x"}`, tenantID, true),
		"invalid file id": whiteboardRequest(http.MethodPost, path, `{"file_id":"nope","idempotency_key":"pdf-present-request-0001"}`, tenantID, true),
	} {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code < 400 || service.presentCalls != 0 {
			t.Fatalf("%s must fail closed: status=%d calls=%d", name, response.Code, service.presentCalls)
		}
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, whiteboardRequest(http.MethodPost, path, body, tenantID, true))
	if response.Code != http.StatusCreated || service.presentCalls != 1 || service.presentSpace != spaceID ||
		service.presentInput.FileID != fileID {
		t.Fatalf("present status=%d calls=%d body=%s", response.Code, service.presentCalls, response.Body.String())
	}
	service.presentResult.Created = false
	reused := httptest.NewRecorder()
	handler.ServeHTTP(reused, whiteboardRequest(http.MethodPost, path, body, tenantID, true))
	if reused.Code != http.StatusOK {
		t.Fatalf("re-presenting an existing row must answer 200, got %d", reused.Code)
	}

	for _, operation := range []string{"suspend", "resume", "close"} {
		transition := httptest.NewRecorder()
		handler.ServeHTTP(transition, whiteboardRequest(http.MethodPost, "/api/v1/pdf-presentations/"+presentationID.String()+"/"+operation,
			`{"expected_version":2,"idempotency_key":"pdf-transition-request-01"}`, tenantID, true))
		if transition.Code != http.StatusOK || service.lastOperation != operation || service.transitionID != presentationID {
			t.Fatalf("%s status=%d op=%s body=%s", operation, transition.Code, service.lastOperation, transition.Body.String())
		}
	}
	method := httptest.NewRecorder()
	handler.ServeHTTP(method, whiteboardRequest(http.MethodGet, "/api/v1/pdf-presentations/"+presentationID.String()+"/suspend", "", tenantID, false))
	if method.Code != http.StatusMethodNotAllowed {
		t.Fatalf("GET transition status=%d", method.Code)
	}
}

func TestPdfPresentationActorGrantRoutesAndErrorMapping(t *testing.T) {
	t.Parallel()
	tenantID, actorID, presentationID, participantKey := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	service := &fakePdfPresentationService{grant: collaboration.PdfAnnotatorGrant{ParticipantKey: participantKey, ExpiresAt: fixedTime.Add(time.Minute)}}
	handler := newPdfPresentationTestHandler(classIdentityService(tenantID, actorID, nil), service)
	path := "/api/v1/pdf-presentations/" + presentationID.String() + "/actor-grants/" + participantKey.String()

	put := httptest.NewRecorder()
	handler.ServeHTTP(put, whiteboardRequest(http.MethodPut, path, `{"ttl_seconds":900}`, tenantID, true))
	if put.Code != http.StatusOK || service.grantKey != participantKey || service.grantInput.TTLSeconds == nil ||
		*service.grantInput.TTLSeconds != 900 || strings.Contains(put.Body.String(), "user_id") {
		t.Fatalf("put status=%d body=%s input=%+v", put.Code, put.Body.String(), service.grantInput)
	}
	revoke := httptest.NewRecorder()
	handler.ServeHTTP(revoke, whiteboardRequest(http.MethodDelete, path, "", tenantID, true))
	if revoke.Code != http.StatusNoContent || service.revokeKey != participantKey {
		t.Fatalf("delete status=%d body=%s", revoke.Code, revoke.Body.String())
	}

	for err, want := range map[error]struct {
		status int
		code   string
	}{
		collaboration.ErrAnnotatorLimitReached: {http.StatusConflict, "pdf_presentation_annotator_limit"},
		collaboration.ErrGrantTargetIneligible: {http.StatusConflict, "pdf_presentation_grant_target_ineligible"},
		collaboration.ErrFeatureDisabled:       {http.StatusServiceUnavailable, "feature_disabled"},
		collaboration.ErrNotFound:              {http.StatusNotFound, "pdf_presentation_not_found"},
		collaboration.ErrPdfDocumentNotReady:   {http.StatusConflict, "pdf_presentation_document_not_ready"},
		collaboration.ErrTransitionConflict:    {http.StatusConflict, "pdf_presentation_transition_conflict"},
		collaboration.ErrInvalidRequest:        {http.StatusBadRequest, "pdf_presentation_invalid"},
		collaboration.ErrReadOnly:              {http.StatusServiceUnavailable, "pdf_presentation_read_only"},
	} {
		service.grantError = err
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, whiteboardRequest(http.MethodPut, path, `{}`, tenantID, true))
		if response.Code != want.status || !strings.Contains(response.Body.String(), want.code) {
			t.Fatalf("%v mapped to status=%d body=%s", err, response.Code, response.Body.String())
		}
	}
}

func TestPdfPresentationResolveMapsConcealmentAndFeatureOff(t *testing.T) {
	t.Parallel()
	tenantID, actorID, spaceID := uuid.New(), uuid.New(), uuid.New()
	service := &fakePdfPresentationService{}
	handler := newPdfPresentationTestHandler(classIdentityService(tenantID, actorID, nil), service)
	path := "/api/v1/media/spaces/" + spaceID.String() + "/pdf-presentation"
	for err, want := range map[error]struct {
		status int
		code   string
	}{
		collaboration.ErrNotFound:        {http.StatusNotFound, "pdf_presentation_not_found"},
		collaboration.ErrFeatureDisabled: {http.StatusServiceUnavailable, "feature_disabled"},
	} {
		service.resolveError = err
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, whiteboardRequest(http.MethodGet, path, "", tenantID, false))
		if response.Code != want.status || !strings.Contains(response.Body.String(), want.code) {
			t.Fatalf("%v mapped to status=%d body=%s", err, response.Code, response.Body.String())
		}
	}
	foreignTenant := httptest.NewRecorder()
	handler.ServeHTTP(foreignTenant, whiteboardRequest(http.MethodGet, path, "", uuid.New(), false))
	if foreignTenant.Code != http.StatusConflict || !strings.Contains(foreignTenant.Body.String(), "pdf_presentation_scope_changed") {
		t.Fatalf("tenant assertion mismatch status=%d body=%s", foreignTenant.Code, foreignTenant.Body.String())
	}
}

func TestPdfPresentationGrantExchangeRequiresExactWebOrigin(t *testing.T) {
	t.Parallel()
	tenantID, actorID, presentationID := uuid.New(), uuid.New(), uuid.New()
	service := &fakePdfPresentationService{credential: collaboration.GrantCredential{
		Credential: strings.Repeat("c", 43), ProviderURL: "wss://collab.example.test", DocumentID: presentationID,
		Generation: 1, RevokeGeneration: 1, Capability: collaboration.CapabilityView, ExpiresAt: fixedTime.Add(30 * time.Second),
	}}
	handler := newPdfPresentationTestHandler(classIdentityService(tenantID, actorID, nil), service)
	path := "/api/v1/pdf-presentations/" + presentationID.String() + "/grant-exchanges"
	body := `{"capability":"view","expected_generation":1,"expected_revoke_generation":1}`

	foreign := whiteboardRequest(http.MethodPost, path, body, tenantID, true)
	foreign.Header.Set("Origin", "https://evil.example.test")
	foreignResponse := httptest.NewRecorder()
	handler.ServeHTTP(foreignResponse, foreign)
	if foreignResponse.Code != http.StatusForbidden || service.exchangeCalls != 0 {
		t.Fatalf("foreign origin status=%d calls=%d", foreignResponse.Code, service.exchangeCalls)
	}
	request := whiteboardRequest(http.MethodPost, path, body, tenantID, true)
	request.Header.Set("Origin", "http://localhost:5173")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK || service.exchangeCalls != 1 || service.exchangeInput.Origin != "http://localhost:5173" {
		t.Fatalf("exchange status=%d body=%s", response.Code, response.Body.String())
	}
	assertWhiteboardPrivacyHeaders(t, response)
}

func TestPdfPresentationRoutesFailClosedWhenControlPlaneIsAbsent(t *testing.T) {
	t.Parallel()
	tenantID, actorID, spaceID := uuid.New(), uuid.New(), uuid.New()
	handler := newPdfPresentationTestHandler(classIdentityService(tenantID, actorID, nil), nil)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, whiteboardRequest(http.MethodGet, "/api/v1/media/spaces/"+spaceID.String()+"/pdf-presentation", "", tenantID, false))
	if response.Code != http.StatusServiceUnavailable || !strings.Contains(response.Body.String(), "feature_disabled") {
		t.Fatalf("absent control plane status=%d body=%s", response.Code, response.Body.String())
	}
}

// The internal runtime routes keep wb_, cw_ and pd_ credentials disjoint
// through the shared kind router.
func TestCollaborationInternalRoutesKeepPdfAnnotationsDisjoint(t *testing.T) {
	t.Parallel()
	whiteboard := &fakeWhiteboardInternalService{scope: collaboration.GrantScope{DocumentKind: collaboration.DocumentKindWhiteboard}}
	code := &fakeWhiteboardInternalService{scope: collaboration.GrantScope{DocumentKind: collaboration.DocumentKindCodeWorkspace}}
	pdf := &fakeWhiteboardInternalService{scope: collaboration.GrantScope{DocumentKind: collaboration.DocumentKindPDFAnnotations}}
	router := collaboration.NewInternalKindRouter(whiteboard, code).WithPDFAnnotations(pdf)
	handlers := newWhiteboardInternalHandlers(slog.New(slog.NewTextHandler(io.Discard, nil)), router, whiteboardInternalTestToken)
	exchange := func(kind, name string) *httptest.ResponseRecorder {
		body := `{"grant":"` + strings.Repeat("g", 43) + `","origin":"https://app.example.test","provider_document_name":"` + name + `"`
		if kind != "" {
			body += `,"document_kind":"` + kind + `"`
		}
		body += `}`
		request := httptest.NewRequest(http.MethodPost, whiteboardInternalGrantExchangePath, strings.NewReader(body))
		request.Header.Set("Authorization", "Bearer "+whiteboardInternalTestToken)
		request.Header.Set("Content-Type", "application/json")
		response := httptest.NewRecorder()
		handlers.exchangeGrant(response, request)
		return response
	}
	pdName := "pd_" + strings.Repeat("p", 32)
	if response := exchange("pdf.annotations.v1", pdName); response.Code != http.StatusOK ||
		pdf.consumeInput.DocumentKind != collaboration.DocumentKindPDFAnnotations ||
		!strings.Contains(response.Body.String(), `"document_kind":"pdf.annotations.v1"`) {
		t.Fatalf("pd_ exchange status=%d body=%s", response.Code, response.Body.String())
	}
	for _, denied := range []struct{ kind, name string }{
		{"", pdName},
		{"code.workspace.v1", pdName},
		{"whiteboard.excalidraw.v1", pdName},
		{"pdf.annotations.v1", "cw_" + strings.Repeat("c", 32)},
		{"pdf.annotations.v1", "wb_" + strings.Repeat("w", 32)},
	} {
		if response := exchange(denied.kind, denied.name); response.Code != http.StatusConflict ||
			!strings.Contains(response.Body.String(), "grant_denied") {
			t.Fatalf("cross-kind %+v status=%d body=%s", denied, response.Code, response.Body.String())
		}
	}
	if whiteboard.consumeInput.ProviderDocumentName != "" || code.consumeInput.ProviderDocumentName != "" {
		t.Fatal("a pd_ credential must never reach the whiteboard or code control plane")
	}
}

func newPdfPresentationTestHandler(identityService identity.ServiceAPI, service collaboration.PdfPresentationServiceAPI) http.Handler {
	options := Options{Clock: fixedClock, Identity: identityService}
	if service != nil {
		options.PdfPresentations = service
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

type fakePdfPresentationService struct {
	access        collaboration.AccessContext
	projection    collaboration.PdfPresentationProjection
	resolveSpace  uuid.UUID
	resolveError  error
	presentCalls  int
	presentSpace  uuid.UUID
	presentInput  collaboration.PdfPresentInput
	presentResult collaboration.PdfPresentResult
	lastOperation string
	transitionID  uuid.UUID
	credential    collaboration.GrantCredential
	exchangeCalls int
	exchangeInput collaboration.GrantExchangeInput
	grant         collaboration.PdfAnnotatorGrant
	grantKey      uuid.UUID
	grantInput    collaboration.PdfAnnotatorGrantInput
	grantError    error
	revokeKey     uuid.UUID
}

func (service *fakePdfPresentationService) Resolve(_ context.Context, access collaboration.AccessContext, spaceID uuid.UUID) (collaboration.PdfPresentationProjection, error) {
	service.access, service.resolveSpace = access, spaceID
	return service.projection, service.resolveError
}

func (service *fakePdfPresentationService) Present(_ context.Context, access collaboration.AccessContext, spaceID uuid.UUID, input collaboration.PdfPresentInput) (collaboration.PdfPresentResult, error) {
	service.access, service.presentSpace, service.presentInput = access, spaceID, input
	service.presentCalls++
	return service.presentResult, nil
}

func (service *fakePdfPresentationService) record(operation string, id uuid.UUID) (collaboration.PdfPresentation, error) {
	service.lastOperation, service.transitionID = operation, id
	return collaboration.PdfPresentation{ID: id, Status: collaboration.DocumentSuspended, Version: 3, CurrentGeneration: 1, RevokeGeneration: 2}, nil
}

func (service *fakePdfPresentationService) Suspend(_ context.Context, _ collaboration.AccessContext, id uuid.UUID, _ collaboration.TransitionInput) (collaboration.PdfPresentation, error) {
	return service.record("suspend", id)
}

func (service *fakePdfPresentationService) Resume(_ context.Context, _ collaboration.AccessContext, id uuid.UUID, _ collaboration.TransitionInput) (collaboration.PdfPresentation, error) {
	return service.record("resume", id)
}

func (service *fakePdfPresentationService) Close(_ context.Context, _ collaboration.AccessContext, id uuid.UUID, _ collaboration.TransitionInput) (collaboration.PdfPresentation, error) {
	return service.record("close", id)
}

func (service *fakePdfPresentationService) ExchangeGrant(_ context.Context, _ collaboration.AccessContext, _ uuid.UUID, input collaboration.GrantExchangeInput) (collaboration.GrantCredential, error) {
	service.exchangeCalls++
	service.exchangeInput = input
	return service.credential, nil
}

func (service *fakePdfPresentationService) PutAnnotatorGrant(_ context.Context, _ collaboration.AccessContext, _ uuid.UUID, key uuid.UUID, input collaboration.PdfAnnotatorGrantInput) (collaboration.PdfAnnotatorGrant, error) {
	service.grantKey, service.grantInput = key, input
	if service.grantError != nil {
		return collaboration.PdfAnnotatorGrant{}, service.grantError
	}
	return service.grant, nil
}

func (service *fakePdfPresentationService) RevokeAnnotatorGrant(_ context.Context, _ collaboration.AccessContext, _ uuid.UUID, key uuid.UUID) error {
	service.revokeKey = key
	return nil
}
