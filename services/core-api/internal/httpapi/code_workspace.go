package httpapi

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"strings"

	"github.com/google/uuid"
	"github.com/tutorhub-v2/core-api/internal/modules/collaboration"
	"github.com/tutorhub-v2/core-api/internal/modules/identity"
	"github.com/tutorhub-v2/core-api/internal/platform/logsafe"
)

// ROOM-TOOLS-CODE-02A (ADR-0043 §4 Slice 2): public control-plane routes for
// the shared classroom code workspace. MediaSpace-bound routes follow the
// existing `/api/v1/media/spaces/{space_id}/...` convention.
const (
	codeWorkspaceSpacePattern         = "/api/v1/media/spaces/{space_id}/code-workspace"
	codeWorkspaceOpenPattern          = "/api/v1/code-workspaces/{workspace_id}/open"
	codeWorkspaceSuspendPattern       = "/api/v1/code-workspaces/{workspace_id}/suspend"
	codeWorkspaceResumePattern        = "/api/v1/code-workspaces/{workspace_id}/resume"
	codeWorkspaceClosePattern         = "/api/v1/code-workspaces/{workspace_id}/close"
	codeWorkspaceGrantExchangePattern = "/api/v1/code-workspaces/{workspace_id}/grant-exchanges"
	codeWorkspaceActorGrantPattern    = "/api/v1/code-workspaces/{workspace_id}/actor-grants/{participant_key}"
	maximumCodeWorkspaceRequestBytes  = 4 * 1024
)

type codeWorkspaceHandlers struct {
	logger  *slog.Logger
	auth    authHandlers
	service collaboration.CodeWorkspaceServiceAPI
}

type createCodeWorkspaceRequest struct {
	IdempotencyKey *string `json:"idempotency_key"`
}

type codeWorkspaceActorGrantRequest struct {
	TTLSeconds *int64 `json:"ttl_seconds"`
}

func newCodeWorkspaceHandlers(
	logger *slog.Logger,
	auth authHandlers,
	service collaboration.CodeWorkspaceServiceAPI,
) codeWorkspaceHandlers {
	return codeWorkspaceHandlers{logger: logger, auth: auth, service: service}
}

func (handlers codeWorkspaceHandlers) space(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		principal, ok := handlers.principal(w, r, false)
		if !ok {
			return
		}
		spaceID, valid := parseResourceUUID(r.PathValue("space_id"))
		if !valid {
			handlers.writeProblem(w, r, collaboration.ErrInvalidRequest)
			return
		}
		projection, err := handlers.service.Resolve(r.Context(), whiteboardAccess(principal), spaceID)
		if err != nil {
			handlers.writeProblem(w, r, err)
			return
		}
		writeJSON(handlers.logger, w, http.StatusOK, projection)
	case http.MethodPost:
		principal, ok := handlers.principal(w, r, true)
		if !ok {
			return
		}
		spaceID, valid := parseResourceUUID(r.PathValue("space_id"))
		if !valid {
			handlers.writeProblem(w, r, collaboration.ErrInvalidRequest)
			return
		}
		var request createCodeWorkspaceRequest
		if err := decodeJSONRequest(w, r, &request, maximumCodeWorkspaceRequestBytes); err != nil ||
			request.IdempotencyKey == nil {
			handlers.writeProblem(w, r, collaboration.ErrInvalidRequest)
			return
		}
		result, err := handlers.service.Create(r.Context(), whiteboardAccess(principal), collaboration.CreateInput{
			MediaSpaceID: spaceID, IdempotencyKey: *request.IdempotencyKey,
		})
		if err != nil {
			handlers.writeProblem(w, r, err)
			return
		}
		status := http.StatusOK
		if result.Created {
			status = http.StatusCreated
		}
		writeJSON(handlers.logger, w, status, result.Workspace)
	default:
		writeCodeWorkspaceMethodProblem(w, r, http.MethodGet+", "+http.MethodPost)
	}
}

func (handlers codeWorkspaceHandlers) transition(operation string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeCodeWorkspaceMethodProblem(w, r, http.MethodPost)
			return
		}
		principal, workspaceID, ok := handlers.resourcePrincipal(w, r, true)
		if !ok {
			return
		}
		var request whiteboardTransitionRequest
		if err := decodeJSONRequest(w, r, &request, maximumCodeWorkspaceRequestBytes); err != nil ||
			request.ExpectedVersion == nil || request.IdempotencyKey == nil {
			handlers.writeProblem(w, r, collaboration.ErrInvalidRequest)
			return
		}
		input := collaboration.TransitionInput{
			ExpectedVersion: *request.ExpectedVersion, IdempotencyKey: *request.IdempotencyKey,
		}
		access := whiteboardAccess(principal)
		var workspace collaboration.CodeWorkspace
		var err error
		switch operation {
		case "open":
			workspace, err = handlers.service.Open(r.Context(), access, workspaceID, input)
		case "suspend":
			workspace, err = handlers.service.Suspend(r.Context(), access, workspaceID, input)
		case "resume":
			workspace, err = handlers.service.Resume(r.Context(), access, workspaceID, input)
		case "close":
			workspace, err = handlers.service.Close(r.Context(), access, workspaceID, input)
		default:
			err = collaboration.ErrInvalidRequest
		}
		if err != nil {
			handlers.writeProblem(w, r, err)
			return
		}
		writeJSON(handlers.logger, w, http.StatusOK, workspace)
	})
}

func (handlers codeWorkspaceHandlers) grantExchange(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeCodeWorkspaceMethodProblem(w, r, http.MethodPost)
		return
	}
	principal, workspaceID, ok := handlers.resourcePrincipal(w, r, true)
	if !ok {
		return
	}
	origin := strings.TrimSpace(r.Header.Get("Origin"))
	allowed := strings.TrimRight(strings.TrimSpace(handlers.auth.config.WebOrigin), "/")
	if origin == "" || allowed == "" || origin != allowed {
		writeCodedProblem(w, r, http.StatusForbidden, "code_workspace_origin_denied",
			"Origin not allowed", "Collaboration credentials are only issued to the TutorHub web origin.")
		return
	}
	var request whiteboardGrantExchangeRequest
	if err := decodeJSONRequest(w, r, &request, maximumCodeWorkspaceRequestBytes); err != nil ||
		request.Capability == nil || request.ExpectedGeneration == nil ||
		request.ExpectedRevokeGeneration == nil {
		handlers.writeProblem(w, r, collaboration.ErrInvalidRequest)
		return
	}
	credential, err := handlers.service.ExchangeGrant(r.Context(), whiteboardAccess(principal), workspaceID,
		collaboration.GrantExchangeInput{
			Capability: *request.Capability, ExpectedGeneration: *request.ExpectedGeneration,
			ExpectedRevokeGeneration: *request.ExpectedRevokeGeneration, Origin: origin,
		})
	if err != nil {
		handlers.writeProblem(w, r, err)
		return
	}
	writeJSON(handlers.logger, w, http.StatusOK, credential)
}

func (handlers codeWorkspaceHandlers) actorGrant(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPut && r.Method != http.MethodDelete {
		writeCodeWorkspaceMethodProblem(w, r, http.MethodPut+", "+http.MethodDelete)
		return
	}
	principal, workspaceID, ok := handlers.resourcePrincipal(w, r, true)
	if !ok {
		return
	}
	participantKey, valid := parseResourceUUID(r.PathValue("participant_key"))
	if !valid {
		handlers.writeProblem(w, r, collaboration.ErrInvalidRequest)
		return
	}
	access := whiteboardAccess(principal)
	if r.Method == http.MethodDelete {
		if err := handlers.service.RevokeEditorGrant(r.Context(), access, workspaceID, participantKey); err != nil {
			handlers.writeProblem(w, r, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
		return
	}
	var request codeWorkspaceActorGrantRequest
	if err := decodeJSONRequest(w, r, &request, maximumCodeWorkspaceRequestBytes); err != nil {
		handlers.writeProblem(w, r, collaboration.ErrInvalidRequest)
		return
	}
	grant, err := handlers.service.PutEditorGrant(r.Context(), access, workspaceID, participantKey,
		collaboration.CodeWorkspaceEditorGrantInput{TTLSeconds: request.TTLSeconds})
	if err != nil {
		handlers.writeProblem(w, r, err)
		return
	}
	writeJSON(handlers.logger, w, http.StatusOK, grant)
}

func (handlers codeWorkspaceHandlers) resourcePrincipal(
	w http.ResponseWriter,
	r *http.Request,
	csrf bool,
) (identity.Principal, uuid.UUID, bool) {
	principal, ok := handlers.principal(w, r, csrf)
	if !ok {
		return identity.Principal{}, uuid.Nil, false
	}
	workspaceID, valid := parseResourceUUID(r.PathValue("workspace_id"))
	if !valid {
		handlers.writeProblem(w, r, collaboration.ErrInvalidRequest)
		return identity.Principal{}, uuid.Nil, false
	}
	return principal, workspaceID, true
}

func (handlers codeWorkspaceHandlers) principal(
	w http.ResponseWriter,
	r *http.Request,
	csrf bool,
) (identity.Principal, bool) {
	if !handlers.auth.available(w, r) {
		return identity.Principal{}, false
	}
	var principal identity.Principal
	var ok bool
	if csrf {
		sessionToken, sessionOK := handlers.auth.sessionToken(w, r)
		if !sessionOK {
			return identity.Principal{}, false
		}
		principal, ok = handlers.auth.csrfPrincipal(w, r, sessionToken)
	} else {
		principal, ok = handlers.auth.authenticatedPrincipal(w, r)
	}
	if !ok {
		return identity.Principal{}, false
	}
	if principal.ActiveTenant == nil || !principal.ActiveTenant.IsActive {
		handlers.writeProblem(w, r, collaboration.ErrNotFound)
		return identity.Principal{}, false
	}
	expectedTenantID, valid := parseResourceUUID(strings.TrimSpace(r.Header.Get(whiteboardExpectedTenantHeader)))
	if !valid {
		handlers.writeProblem(w, r, collaboration.ErrInvalidRequest)
		return identity.Principal{}, false
	}
	if expectedTenantID != principal.ActiveTenant.ID {
		handlers.writeProblem(w, r, errWhiteboardScopeChanged)
		return identity.Principal{}, false
	}
	if handlers.service == nil {
		handlers.writeProblem(w, r, collaboration.ErrFeatureDisabled)
		return identity.Principal{}, false
	}
	return principal, true
}

func (handlers codeWorkspaceHandlers) writeProblem(w http.ResponseWriter, r *http.Request, err error) {
	status, code := http.StatusServiceUnavailable, "code_workspace_unavailable"
	title, detail := "Code workspace unavailable", "The code workspace request could not be completed safely."
	switch {
	case errors.Is(err, collaboration.ErrInvalidRequest):
		status, code = http.StatusBadRequest, "code_workspace_invalid"
		title, detail = "Invalid code workspace request", "Review the tenant assertion, opaque identifiers, bounded fields, and optimistic versions."
	case errors.Is(err, collaboration.ErrNotFound), errors.Is(err, collaboration.ErrGrantDenied):
		status, code = http.StatusNotFound, "code_workspace_not_found"
		title, detail = "Code workspace unavailable", "The code workspace is unavailable in the active workspace."
	case errors.Is(err, collaboration.ErrFeatureDisabled):
		status, code = http.StatusServiceUnavailable, "feature_disabled"
		title, detail = "Shared code workspace disabled", "Collaborative code editing is not enabled for this workspace."
	case errors.Is(err, collaboration.ErrVersionConflict):
		status, code = http.StatusConflict, "stale_version"
		title, detail = "Code workspace changed", "Reload the current code workspace authority before retrying."
	case errors.Is(err, collaboration.ErrIdempotencyConflict):
		status, code = http.StatusConflict, "code_workspace_idempotency_conflict"
		title, detail = "Code workspace retry conflict", "Use a new idempotency key after changing the command."
	case errors.Is(err, collaboration.ErrTransitionConflict):
		status, code = http.StatusConflict, "code_workspace_transition_conflict"
		title, detail = "Code workspace transition unavailable", "Reload the code workspace before choosing another action."
	case errors.Is(err, collaboration.ErrEditorLimitReached):
		status, code = http.StatusConflict, "code_workspace_editor_limit"
		title, detail = "Editor limit reached", "At most three participants can hold temporary edit access at once."
	case errors.Is(err, collaboration.ErrGrantTargetIneligible):
		status, code = http.StatusConflict, "code_workspace_grant_target_ineligible"
		title, detail = "Participant cannot receive edit access", "Temporary edit access is only granted to connected attendees."
	case errors.Is(err, errWhiteboardScopeChanged):
		status, code = http.StatusConflict, "code_workspace_scope_changed"
		title, detail = "Active workspace changed", "Reload the current workspace before retrying."
	case errors.Is(err, collaboration.ErrGrantUnavailable):
		status, code = http.StatusServiceUnavailable, "code_workspace_grant_unavailable"
		title, detail = "Code workspace grant unavailable", "Credential exchange is not available in this environment."
	case errors.Is(err, collaboration.ErrGrantRateLimited):
		status, code = http.StatusTooManyRequests, "code_workspace_grant_rate_limited"
		title, detail = "Code workspace grant rate limited", "Wait briefly before requesting another collaboration credential."
	case errors.Is(err, collaboration.ErrQuotaExceeded):
		status, code = http.StatusTooManyRequests, "code_workspace_quota_exceeded"
		title, detail = "Code workspace quota reached", "The workspace collaboration quota has been reached."
	case errors.Is(err, collaboration.ErrReadOnly):
		status, code = http.StatusServiceUnavailable, "code_workspace_read_only"
		title, detail = "Code workspace is read only", "Editing is temporarily disabled."
	case errors.Is(err, collaboration.ErrUnavailable), errors.Is(err, context.DeadlineExceeded):
		// Keep the privacy-safe default.
	default:
		handlers.logger.Error(
			"code workspace request failed",
			"request_id", RequestIDFromContext(r.Context()),
			"path", logsafe.String(r.URL.Path),
			"error", logsafe.Error(err),
		)
	}
	writeCodedProblem(w, r, status, code, title, detail)
}

func writeCodeWorkspaceMethodProblem(w http.ResponseWriter, r *http.Request, allow string) {
	w.Header().Set("Allow", allow)
	writeProblem(w, r, http.StatusMethodNotAllowed, "Method not allowed", "The code workspace resource does not support this HTTP method.")
}
