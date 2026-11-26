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

// ROOM-TOOLS-FILES-02A (ADR-0045 §1, §4 Slice 2): public control-plane routes
// for classroom PDF presentation and page-scoped annotations.
const (
	pdfPresentationSpacePattern         = "/api/v1/media/spaces/{space_id}/pdf-presentation"
	pdfPresentationSuspendPattern       = "/api/v1/pdf-presentations/{presentation_id}/suspend"
	pdfPresentationResumePattern        = "/api/v1/pdf-presentations/{presentation_id}/resume"
	pdfPresentationClosePattern         = "/api/v1/pdf-presentations/{presentation_id}/close"
	pdfPresentationGrantExchangePattern = "/api/v1/pdf-presentations/{presentation_id}/grant-exchanges"
	pdfPresentationActorGrantPattern    = "/api/v1/pdf-presentations/{presentation_id}/actor-grants/{participant_key}"
	maximumPdfPresentationRequestBytes  = 4 * 1024
)

type pdfPresentationHandlers struct {
	logger  *slog.Logger
	auth    authHandlers
	service collaboration.PdfPresentationServiceAPI
}

type presentPdfRequest struct {
	FileID         *uuid.UUID `json:"file_id"`
	IdempotencyKey *string    `json:"idempotency_key"`
}

type pdfPresentationActorGrantRequest struct {
	TTLSeconds *int64 `json:"ttl_seconds"`
}

func newPdfPresentationHandlers(
	logger *slog.Logger,
	auth authHandlers,
	service collaboration.PdfPresentationServiceAPI,
) pdfPresentationHandlers {
	return pdfPresentationHandlers{logger: logger, auth: auth, service: service}
}

func (handlers pdfPresentationHandlers) register(mux *http.ServeMux) {
	mux.Handle(pdfPresentationSpacePattern, whiteboardResponseHeaders(http.HandlerFunc(handlers.space)))
	for pattern, operation := range map[string]string{
		pdfPresentationSuspendPattern: "suspend",
		pdfPresentationResumePattern:  "resume",
		pdfPresentationClosePattern:   "close",
	} {
		mux.Handle(pattern, whiteboardResponseHeaders(handlers.transition(operation)))
	}
	mux.Handle(pdfPresentationGrantExchangePattern, whiteboardResponseHeaders(http.HandlerFunc(handlers.grantExchange)))
	mux.Handle(pdfPresentationActorGrantPattern, whiteboardResponseHeaders(http.HandlerFunc(handlers.actorGrant)))
}

func (handlers pdfPresentationHandlers) space(w http.ResponseWriter, r *http.Request) {
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
		var request presentPdfRequest
		if err := decodeJSONRequest(w, r, &request, maximumPdfPresentationRequestBytes); err != nil ||
			request.FileID == nil || request.IdempotencyKey == nil {
			handlers.writeProblem(w, r, collaboration.ErrInvalidRequest)
			return
		}
		result, err := handlers.service.Present(r.Context(), whiteboardAccess(principal), spaceID,
			collaboration.PdfPresentInput{FileID: *request.FileID, IdempotencyKey: *request.IdempotencyKey})
		if err != nil {
			handlers.writeProblem(w, r, err)
			return
		}
		status := http.StatusOK
		if result.Created {
			status = http.StatusCreated
		}
		writeJSON(handlers.logger, w, status, result.Presentation)
	default:
		writePdfPresentationMethodProblem(w, r, http.MethodGet+", "+http.MethodPost)
	}
}

func (handlers pdfPresentationHandlers) transition(operation string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writePdfPresentationMethodProblem(w, r, http.MethodPost)
			return
		}
		principal, presentationID, ok := handlers.resourcePrincipal(w, r, true)
		if !ok {
			return
		}
		var request whiteboardTransitionRequest
		if err := decodeJSONRequest(w, r, &request, maximumPdfPresentationRequestBytes); err != nil ||
			request.ExpectedVersion == nil || request.IdempotencyKey == nil {
			handlers.writeProblem(w, r, collaboration.ErrInvalidRequest)
			return
		}
		input := collaboration.TransitionInput{
			ExpectedVersion: *request.ExpectedVersion, IdempotencyKey: *request.IdempotencyKey,
		}
		access := whiteboardAccess(principal)
		var presentation collaboration.PdfPresentation
		var err error
		switch operation {
		case "suspend":
			presentation, err = handlers.service.Suspend(r.Context(), access, presentationID, input)
		case "resume":
			presentation, err = handlers.service.Resume(r.Context(), access, presentationID, input)
		case "close":
			presentation, err = handlers.service.Close(r.Context(), access, presentationID, input)
		default:
			err = collaboration.ErrInvalidRequest
		}
		if err != nil {
			handlers.writeProblem(w, r, err)
			return
		}
		writeJSON(handlers.logger, w, http.StatusOK, presentation)
	})
}

func (handlers pdfPresentationHandlers) grantExchange(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writePdfPresentationMethodProblem(w, r, http.MethodPost)
		return
	}
	principal, presentationID, ok := handlers.resourcePrincipal(w, r, true)
	if !ok {
		return
	}
	origin := strings.TrimSpace(r.Header.Get("Origin"))
	allowed := strings.TrimRight(strings.TrimSpace(handlers.auth.config.WebOrigin), "/")
	if origin == "" || allowed == "" || origin != allowed {
		writeCodedProblem(w, r, http.StatusForbidden, "pdf_presentation_origin_denied",
			"Origin not allowed", "Collaboration credentials are only issued to the TutorHub web origin.")
		return
	}
	var request whiteboardGrantExchangeRequest
	if err := decodeJSONRequest(w, r, &request, maximumPdfPresentationRequestBytes); err != nil ||
		request.Capability == nil || request.ExpectedGeneration == nil ||
		request.ExpectedRevokeGeneration == nil {
		handlers.writeProblem(w, r, collaboration.ErrInvalidRequest)
		return
	}
	credential, err := handlers.service.ExchangeGrant(r.Context(), whiteboardAccess(principal), presentationID,
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

func (handlers pdfPresentationHandlers) actorGrant(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPut && r.Method != http.MethodDelete {
		writePdfPresentationMethodProblem(w, r, http.MethodPut+", "+http.MethodDelete)
		return
	}
	principal, presentationID, ok := handlers.resourcePrincipal(w, r, true)
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
		if err := handlers.service.RevokeAnnotatorGrant(r.Context(), access, presentationID, participantKey); err != nil {
			handlers.writeProblem(w, r, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
		return
	}
	var request pdfPresentationActorGrantRequest
	if err := decodeJSONRequest(w, r, &request, maximumPdfPresentationRequestBytes); err != nil {
		handlers.writeProblem(w, r, collaboration.ErrInvalidRequest)
		return
	}
	grant, err := handlers.service.PutAnnotatorGrant(r.Context(), access, presentationID, participantKey,
		collaboration.PdfAnnotatorGrantInput{TTLSeconds: request.TTLSeconds})
	if err != nil {
		handlers.writeProblem(w, r, err)
		return
	}
	writeJSON(handlers.logger, w, http.StatusOK, grant)
}

func (handlers pdfPresentationHandlers) resourcePrincipal(
	w http.ResponseWriter,
	r *http.Request,
	csrf bool,
) (identity.Principal, uuid.UUID, bool) {
	principal, ok := handlers.principal(w, r, csrf)
	if !ok {
		return identity.Principal{}, uuid.Nil, false
	}
	presentationID, valid := parseResourceUUID(r.PathValue("presentation_id"))
	if !valid {
		handlers.writeProblem(w, r, collaboration.ErrInvalidRequest)
		return identity.Principal{}, uuid.Nil, false
	}
	return principal, presentationID, true
}

func (handlers pdfPresentationHandlers) principal(
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

func (handlers pdfPresentationHandlers) writeProblem(w http.ResponseWriter, r *http.Request, err error) {
	status, code := http.StatusServiceUnavailable, "pdf_presentation_unavailable"
	title, detail := "PDF presentation unavailable", "The PDF presentation request could not be completed safely."
	switch {
	case errors.Is(err, collaboration.ErrInvalidRequest):
		status, code = http.StatusBadRequest, "pdf_presentation_invalid"
		title, detail = "Invalid PDF presentation request", "Review the tenant assertion, opaque identifiers, bounded fields, and optimistic versions."
	case errors.Is(err, collaboration.ErrNotFound), errors.Is(err, collaboration.ErrGrantDenied):
		status, code = http.StatusNotFound, "pdf_presentation_not_found"
		title, detail = "PDF presentation unavailable", "The PDF presentation is unavailable in the active workspace."
	case errors.Is(err, collaboration.ErrFeatureDisabled):
		status, code = http.StatusServiceUnavailable, "feature_disabled"
		title, detail = "PDF collaboration disabled", "Classroom PDF presentation is not enabled for this workspace."
	case errors.Is(err, collaboration.ErrPdfDocumentNotReady):
		status, code = http.StatusConflict, "pdf_presentation_document_not_ready"
		title, detail = "Document not ready", "Only verified PDF or image room documents can be presented."
	case errors.Is(err, collaboration.ErrVersionConflict):
		status, code = http.StatusConflict, "stale_version"
		title, detail = "PDF presentation changed", "Reload the current PDF presentation before retrying."
	case errors.Is(err, collaboration.ErrIdempotencyConflict):
		status, code = http.StatusConflict, "pdf_presentation_idempotency_conflict"
		title, detail = "PDF presentation retry conflict", "Use a new idempotency key after changing the command."
	case errors.Is(err, collaboration.ErrTransitionConflict):
		status, code = http.StatusConflict, "pdf_presentation_transition_conflict"
		title, detail = "PDF presentation transition unavailable", "Reload the PDF presentation before choosing another action."
	case errors.Is(err, collaboration.ErrAnnotatorLimitReached):
		status, code = http.StatusConflict, "pdf_presentation_annotator_limit"
		title, detail = "Annotator limit reached", "At most three students can hold temporary annotation access at once."
	case errors.Is(err, collaboration.ErrGrantTargetIneligible):
		status, code = http.StatusConflict, "pdf_presentation_grant_target_ineligible"
		title, detail = "Participant cannot receive annotation access", "Temporary annotation access is only granted to connected attendees."
	case errors.Is(err, errWhiteboardScopeChanged):
		status, code = http.StatusConflict, "pdf_presentation_scope_changed"
		title, detail = "Active workspace changed", "Reload the current workspace before retrying."
	case errors.Is(err, collaboration.ErrGrantUnavailable):
		status, code = http.StatusServiceUnavailable, "pdf_presentation_grant_unavailable"
		title, detail = "PDF presentation grant unavailable", "Credential exchange is not available in this environment."
	case errors.Is(err, collaboration.ErrGrantRateLimited):
		status, code = http.StatusTooManyRequests, "pdf_presentation_grant_rate_limited"
		title, detail = "PDF presentation grant rate limited", "Wait briefly before requesting another collaboration credential."
	case errors.Is(err, collaboration.ErrQuotaExceeded):
		status, code = http.StatusTooManyRequests, "pdf_presentation_quota_exceeded"
		title, detail = "PDF presentation quota reached", "The workspace collaboration quota has been reached."
	case errors.Is(err, collaboration.ErrReadOnly):
		status, code = http.StatusServiceUnavailable, "pdf_presentation_read_only"
		title, detail = "PDF presentation is read only", "Presenting and annotating are temporarily disabled."
	case errors.Is(err, collaboration.ErrUnavailable), errors.Is(err, context.DeadlineExceeded):
		// Keep the privacy-safe default.
	default:
		handlers.logger.Error(
			"pdf presentation request failed",
			"request_id", RequestIDFromContext(r.Context()),
			"path", logsafe.String(r.URL.Path),
			"error", logsafe.Error(err),
		)
	}
	writeCodedProblem(w, r, status, code, title, detail)
}

func writePdfPresentationMethodProblem(w http.ResponseWriter, r *http.Request, allow string) {
	w.Header().Set("Allow", allow)
	writeProblem(w, r, http.StatusMethodNotAllowed, "Method not allowed", "The PDF presentation resource does not support this HTTP method.")
}
