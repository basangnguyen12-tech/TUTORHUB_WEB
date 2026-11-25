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

func TestCodeWorkspaceProjectionNeverLeaksActorIdentifiers(t *testing.T) {
	t.Parallel()
	tenantID, actorID, spaceID, workspaceID, participantKey := uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New()
	service := &fakeCodeWorkspaceService{projection: collaboration.CodeWorkspaceProjection{
		Workspace: &collaboration.CodeWorkspace{
			ID: workspaceID, MediaSpaceID: spaceID, Status: collaboration.DocumentOpen,
			Version: 2, CurrentGeneration: 1, RevokeGeneration: 1,
			Viewer:    collaboration.CodeWorkspaceViewerCapabilities{Capability: collaboration.CapabilityPresent, CanManageEditorGrants: true, CanExchangeGrant: true},
			CreatedAt: fixedTime, UpdatedAt: fixedTime,
		},
		ActiveEditorGrants: []collaboration.CodeWorkspaceEditorGrant{{ParticipantKey: participantKey, ExpiresAt: fixedTime.Add(10 * time.Minute)}},
	}}
	identityService := classIdentityService(tenantID, actorID, nil)
	handler := newCodeWorkspaceTestHandler(identityService, service)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, whiteboardRequest(http.MethodGet, "/api/v1/media/spaces/"+spaceID.String()+"/code-workspace", "", tenantID, false))
	if response.Code != http.StatusOK || service.resolveSpace != spaceID {
		t.Fatalf("resolve status=%d body=%s", response.Code, response.Body.String())
	}
	assertWhiteboardPrivacyHeaders(t, response)
	assertWhiteboardAccess(t, service.access, identityService.principal)
	body := response.Body.String()
	if strings.Contains(body, actorID.String()) || strings.Contains(body, "user_id") ||
		strings.Contains(body, "participant_session_id") || strings.Contains(body, "cw_") {
		t.Fatalf("projection leaked a server-only identifier: %s", body)
	}
	var payload map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode projection: %v", err)
	}
	grants, ok := payload["active_editor_grants"].([]any)
	if !ok || len(grants) != 1 || grants[0].(map[string]any)["participant_key"] != participantKey.String() {
		t.Fatalf("unexpected active editor grants: %v", payload["active_editor_grants"])
	}
}

func TestCodeWorkspaceMutationsRequireCSRFTenantAssertionAndStrictBodies(t *testing.T) {
	t.Parallel()
	tenantID, actorID, spaceID, workspaceID := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	service := &fakeCodeWorkspaceService{createResult: collaboration.CodeWorkspaceCreateResult{Created: true, Workspace: collaboration.CodeWorkspace{
		ID: workspaceID, MediaSpaceID: spaceID, Status: collaboration.DocumentCreated, Version: 1, CurrentGeneration: 1, RevokeGeneration: 1,
	}}}
	handler := newCodeWorkspaceTestHandler(classIdentityService(tenantID, actorID, nil), service)
	path := "/api/v1/media/spaces/" + spaceID.String() + "/code-workspace"
	body := `{"idempotency_key":"code-workspace-create-0001"}`

	for name, request := range map[string]*http.Request{
		"missing csrf":   whiteboardRequest(http.MethodPost, path, body, tenantID, false),
		"missing tenant": whiteboardRequest(http.MethodPost, path, body, uuid.Nil, true),
		"unknown field":  whiteboardRequest(http.MethodPost, path, `{"idempotency_key":"code-workspace-create-0001","provider_document_name":"cw_x"}`, tenantID, true),
	} {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code < 400 || service.createCalls != 0 {
			t.Fatalf("%s must fail closed: status=%d calls=%d", name, response.Code, service.createCalls)
		}
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, whiteboardRequest(http.MethodPost, path, body, tenantID, true))
	if response.Code != http.StatusCreated || service.createCalls != 1 || service.createInput.MediaSpaceID != spaceID {
		t.Fatalf("create status=%d calls=%d body=%s", response.Code, service.createCalls, response.Body.String())
	}

	transition := httptest.NewRecorder()
	handler.ServeHTTP(transition, whiteboardRequest(http.MethodPost, "/api/v1/code-workspaces/"+workspaceID.String()+"/suspend",
		`{"expected_version":2,"idempotency_key":"code-workspace-suspend-01"}`, tenantID, true))
	if transition.Code != http.StatusOK || service.lastOperation != "suspend" || service.transitionID != workspaceID {
		t.Fatalf("suspend status=%d op=%s body=%s", transition.Code, service.lastOperation, transition.Body.String())
	}
}

func TestCodeWorkspaceActorGrantRoutesAndErrorMapping(t *testing.T) {
	t.Parallel()
	tenantID, actorID, workspaceID, participantKey := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	service := &fakeCodeWorkspaceService{grant: collaboration.CodeWorkspaceEditorGrant{ParticipantKey: participantKey, ExpiresAt: fixedTime.Add(time.Minute)}}
	handler := newCodeWorkspaceTestHandler(classIdentityService(tenantID, actorID, nil), service)
	path := "/api/v1/code-workspaces/" + workspaceID.String() + "/actor-grants/" + participantKey.String()

	put := httptest.NewRecorder()
	handler.ServeHTTP(put, whiteboardRequest(http.MethodPut, path, `{"ttl_seconds":600}`, tenantID, true))
	if put.Code != http.StatusOK || service.grantKey != participantKey || service.grantInput.TTLSeconds == nil || *service.grantInput.TTLSeconds != 600 {
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
		collaboration.ErrEditorLimitReached:    {http.StatusConflict, "code_workspace_editor_limit"},
		collaboration.ErrGrantTargetIneligible: {http.StatusConflict, "code_workspace_grant_target_ineligible"},
		collaboration.ErrFeatureDisabled:       {http.StatusServiceUnavailable, "feature_disabled"},
		collaboration.ErrNotFound:              {http.StatusNotFound, "code_workspace_not_found"},
	} {
		service.grantError = err
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, whiteboardRequest(http.MethodPut, path, `{}`, tenantID, true))
		if response.Code != want.status || !strings.Contains(response.Body.String(), want.code) {
			t.Fatalf("%v mapped to status=%d body=%s", err, response.Code, response.Body.String())
		}
	}
}

func TestCodeWorkspaceGrantExchangeRequiresExactWebOrigin(t *testing.T) {
	t.Parallel()
	tenantID, actorID, workspaceID := uuid.New(), uuid.New(), uuid.New()
	service := &fakeCodeWorkspaceService{credential: collaboration.GrantCredential{
		Credential: strings.Repeat("c", 43), ProviderURL: "wss://collab.example.test", DocumentID: workspaceID,
		Generation: 1, RevokeGeneration: 1, Capability: collaboration.CapabilityView, ExpiresAt: fixedTime.Add(30 * time.Second),
	}}
	handler := newCodeWorkspaceTestHandler(classIdentityService(tenantID, actorID, nil), service)
	path := "/api/v1/code-workspaces/" + workspaceID.String() + "/grant-exchanges"
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

func TestCodeWorkspaceRoutesFailClosedWhenControlPlaneIsAbsent(t *testing.T) {
	t.Parallel()
	tenantID, actorID, spaceID := uuid.New(), uuid.New(), uuid.New()
	handler := newCodeWorkspaceTestHandler(classIdentityService(tenantID, actorID, nil), nil)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, whiteboardRequest(http.MethodGet, "/api/v1/media/spaces/"+spaceID.String()+"/code-workspace", "", tenantID, false))
	if response.Code != http.StatusServiceUnavailable || !strings.Contains(response.Body.String(), "feature_disabled") {
		t.Fatalf("absent control plane status=%d body=%s", response.Code, response.Body.String())
	}
}

func newCodeWorkspaceTestHandler(identityService identity.ServiceAPI, service collaboration.CodeWorkspaceServiceAPI) http.Handler {
	options := Options{Clock: fixedClock, Identity: identityService}
	if service != nil {
		options.CodeWorkspaces = service
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

type fakeCodeWorkspaceService struct {
	access        collaboration.AccessContext
	projection    collaboration.CodeWorkspaceProjection
	resolveSpace  uuid.UUID
	createCalls   int
	createInput   collaboration.CreateInput
	createResult  collaboration.CodeWorkspaceCreateResult
	lastOperation string
	transitionID  uuid.UUID
	credential    collaboration.GrantCredential
	exchangeCalls int
	exchangeInput collaboration.GrantExchangeInput
	grant         collaboration.CodeWorkspaceEditorGrant
	grantKey      uuid.UUID
	grantInput    collaboration.CodeWorkspaceEditorGrantInput
	grantError    error
	revokeKey     uuid.UUID
}

func (service *fakeCodeWorkspaceService) Resolve(_ context.Context, access collaboration.AccessContext, spaceID uuid.UUID) (collaboration.CodeWorkspaceProjection, error) {
	service.access, service.resolveSpace = access, spaceID
	return service.projection, nil
}

func (service *fakeCodeWorkspaceService) Create(_ context.Context, access collaboration.AccessContext, input collaboration.CreateInput) (collaboration.CodeWorkspaceCreateResult, error) {
	service.access, service.createInput = access, input
	service.createCalls++
	return service.createResult, nil
}

func (service *fakeCodeWorkspaceService) Get(context.Context, collaboration.AccessContext, uuid.UUID) (collaboration.CodeWorkspace, error) {
	return collaboration.CodeWorkspace{}, nil
}

func (service *fakeCodeWorkspaceService) record(operation string, id uuid.UUID) (collaboration.CodeWorkspace, error) {
	service.lastOperation, service.transitionID = operation, id
	return collaboration.CodeWorkspace{ID: id, Status: collaboration.DocumentSuspended, Version: 3, CurrentGeneration: 1, RevokeGeneration: 2}, nil
}

func (service *fakeCodeWorkspaceService) Open(_ context.Context, _ collaboration.AccessContext, id uuid.UUID, _ collaboration.TransitionInput) (collaboration.CodeWorkspace, error) {
	return service.record("open", id)
}

func (service *fakeCodeWorkspaceService) Suspend(_ context.Context, _ collaboration.AccessContext, id uuid.UUID, _ collaboration.TransitionInput) (collaboration.CodeWorkspace, error) {
	return service.record("suspend", id)
}

func (service *fakeCodeWorkspaceService) Resume(_ context.Context, _ collaboration.AccessContext, id uuid.UUID, _ collaboration.TransitionInput) (collaboration.CodeWorkspace, error) {
	return service.record("resume", id)
}

func (service *fakeCodeWorkspaceService) Close(_ context.Context, _ collaboration.AccessContext, id uuid.UUID, _ collaboration.TransitionInput) (collaboration.CodeWorkspace, error) {
	return service.record("close", id)
}

func (service *fakeCodeWorkspaceService) ExchangeGrant(_ context.Context, _ collaboration.AccessContext, _ uuid.UUID, input collaboration.GrantExchangeInput) (collaboration.GrantCredential, error) {
	service.exchangeCalls++
	service.exchangeInput = input
	return service.credential, nil
}

func (service *fakeCodeWorkspaceService) PutEditorGrant(_ context.Context, _ collaboration.AccessContext, _ uuid.UUID, key uuid.UUID, input collaboration.CodeWorkspaceEditorGrantInput) (collaboration.CodeWorkspaceEditorGrant, error) {
	service.grantKey, service.grantInput = key, input
	if service.grantError != nil {
		return collaboration.CodeWorkspaceEditorGrant{}, service.grantError
	}
	return service.grant, nil
}

func (service *fakeCodeWorkspaceService) RevokeEditorGrant(_ context.Context, _ collaboration.AccessContext, _ uuid.UUID, key uuid.UUID) error {
	service.revokeKey = key
	return nil
}

func TestCollaborationInternalExchangeForwardsTypedDocumentKind(t *testing.T) {
	t.Parallel()
	service := &fakeWhiteboardInternalService{scope: collaboration.GrantScope{DocumentKind: collaboration.DocumentKindCodeWorkspace}}
	handlers := newWhiteboardInternalHandlers(slog.New(slog.NewTextHandler(io.Discard, nil)), service, whiteboardInternalTestToken)
	body := `{"document_kind":"code.workspace.v1","grant":"` + strings.Repeat("g", 43) +
		`","origin":"https://app.example.test","provider_document_name":"cw_` + strings.Repeat("a", 32) + `"}`
	request := httptest.NewRequest(http.MethodPost, whiteboardInternalGrantExchangePath, strings.NewReader(body))
	request.Header.Set("Authorization", "Bearer "+whiteboardInternalTestToken)
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	handlers.exchangeGrant(response, request)
	if response.Code != http.StatusOK || service.consumeInput.DocumentKind != collaboration.DocumentKindCodeWorkspace ||
		!strings.Contains(response.Body.String(), `"document_kind":"code.workspace.v1"`) {
		t.Fatalf("exchange status=%d input=%+v body=%s", response.Code, service.consumeInput, response.Body.String())
	}
}
