package httpapi

import (
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"strings"

	"github.com/google/uuid"
	"github.com/tutorhub-v2/core-api/internal/modules/content"
	"github.com/tutorhub-v2/core-api/internal/modules/featurecontrol"
	"github.com/tutorhub-v2/core-api/internal/modules/identity"
	"github.com/tutorhub-v2/core-api/internal/platform/logsafe"
	"github.com/tutorhub-v2/core-api/internal/policy"
)

// ROOM-TOOLS-FILES-01A (ADR-0045 §2): room Documents tool library endpoints.
// View capabilities are bearer URLs: they are returned only in no-store
// responses and never logged (errors log the request ID and path only).
const (
	roomDocumentsPattern            = "/api/v1/media/spaces/{space_id}/documents"
	roomDocumentUploadIntentPattern = "/api/v1/media/spaces/{space_id}/documents/upload-intents"
	roomDocumentViewPattern         = "/api/v1/media/spaces/{space_id}/documents/{file_id}/view-capabilities"
	roomDocumentResourcePattern     = "/api/v1/media/spaces/{space_id}/documents/{file_id}"
)

type roomDocumentHandlers struct {
	logger  *slog.Logger
	files   contentHandlers
	service content.RoomDocumentServiceAPI
}

type createRoomDocumentIntentRequest struct {
	Scope                *string `json:"scope"`
	DisplayName          *string `json:"display_name"`
	DeclaredMediaType    *string `json:"declared_media_type"`
	ExpectedSizeBytes    *int64  `json:"expected_size_bytes"`
	ChecksumSHA256       *string `json:"checksum_sha256"`
	ClientRequestID      *string `json:"client_request_id"`
	AllowStudentDownload *bool   `json:"allow_student_download"`
}

type updateRoomDocumentRequest struct {
	ExpectedVersion      *int64 `json:"expected_version"`
	AllowStudentDownload *bool  `json:"allow_student_download"`
	Deleted              *bool  `json:"deleted"`
}

type roomDocumentPageResponse struct {
	Items        []content.RoomDocument            `json:"items"`
	NextCursor   *string                           `json:"next_cursor"`
	ViewerAccess content.RoomDocumentLibraryAccess `json:"viewer_access"`
}

func newRoomDocumentHandlers(
	logger *slog.Logger,
	auth authHandlers,
	service content.RoomDocumentServiceAPI,
) roomDocumentHandlers {
	return roomDocumentHandlers{
		logger: logger, files: contentHandlers{logger: logger, auth: auth}, service: service,
	}
}

func (handlers roomDocumentHandlers) register(mux *http.ServeMux) {
	mux.Handle(roomDocumentsPattern, fileResponseHeaders(http.HandlerFunc(handlers.list)))
	mux.Handle(roomDocumentUploadIntentPattern, fileResponseHeaders(http.HandlerFunc(handlers.createIntent)))
	mux.Handle(roomDocumentViewPattern, fileResponseHeaders(http.HandlerFunc(handlers.viewCapability)))
	mux.Handle(roomDocumentResourcePattern, fileResponseHeaders(http.HandlerFunc(handlers.update)))
}

func (handlers roomDocumentHandlers) available(w http.ResponseWriter, r *http.Request) bool {
	if !handlers.files.auth.available(w, r) {
		return false
	}
	if handlers.service == nil {
		writeCodedProblem(w, r, http.StatusServiceUnavailable, "feature_disabled",
			"Documents tool disabled", "The classroom Documents tool is not configured for this environment.")
		return false
	}
	return true
}

func (handlers roomDocumentHandlers) readAccess(
	w http.ResponseWriter,
	r *http.Request,
) (content.AccessContext, uuid.UUID, bool) {
	if !handlers.available(w, r) {
		return content.AccessContext{}, uuid.Nil, false
	}
	principal, ok := handlers.files.auth.authenticatedPrincipal(w, r)
	if !ok {
		return content.AccessContext{}, uuid.Nil, false
	}
	return handlers.scopedAccess(w, r, principal)
}

func (handlers roomDocumentHandlers) mutationAccess(
	w http.ResponseWriter,
	r *http.Request,
) (content.AccessContext, uuid.UUID, bool) {
	if !handlers.available(w, r) {
		return content.AccessContext{}, uuid.Nil, false
	}
	principal, ok := handlers.files.csrfPrincipal(w, r)
	if !ok {
		return content.AccessContext{}, uuid.Nil, false
	}
	return handlers.scopedAccess(w, r, principal)
}

func (handlers roomDocumentHandlers) scopedAccess(
	w http.ResponseWriter,
	r *http.Request,
	principal identity.Principal,
) (content.AccessContext, uuid.UUID, bool) {
	if principal.ActiveTenant == nil {
		handlers.writeProblem(w, r, content.ErrAccessDenied)
		return content.AccessContext{}, uuid.Nil, false
	}
	expectedTenantID, ok := parseResourceUUID(strings.TrimSpace(r.Header.Get(fileTenantHeader)))
	if !ok {
		handlers.writeProblem(w, r, content.ErrInvalidInput)
		return content.AccessContext{}, uuid.Nil, false
	}
	if expectedTenantID != principal.ActiveTenant.ID {
		handlers.writeProblem(w, r, errFileScopeChanged)
		return content.AccessContext{}, uuid.Nil, false
	}
	spaceID, ok := parseResourceUUID(r.PathValue("space_id"))
	if !ok {
		handlers.writeProblem(w, r, content.ErrNotFound)
		return content.AccessContext{}, uuid.Nil, false
	}
	return content.AccessContext{
		TenantID: principal.ActiveTenant.ID, ActorID: principal.User.ID,
		MembershipActive: principal.ActiveTenant.IsActive,
		OrganizationRoles: []policy.OrganizationRole{
			policy.OrganizationRole(principal.ActiveTenant.Role),
		},
	}, spaceID, true
}

func (handlers roomDocumentHandlers) list(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		writeProblem(w, r, http.StatusMethodNotAllowed, "Method not allowed", "Room document listing supports GET and HEAD requests.")
		return
	}
	access, spaceID, ok := handlers.readAccess(w, r)
	if !ok {
		return
	}
	limit := 0
	if rawLimit := strings.TrimSpace(r.URL.Query().Get("limit")); rawLimit != "" {
		value, err := strconv.Atoi(rawLimit)
		if err != nil {
			handlers.writeProblem(w, r, content.ErrInvalidInput)
			return
		}
		limit = value
	}
	page, err := handlers.service.ListRoomDocuments(r.Context(), access, spaceID, content.ListFilesInput{
		Limit: limit, Cursor: strings.TrimSpace(r.URL.Query().Get("cursor")),
	})
	if err != nil {
		handlers.writeProblem(w, r, err)
		return
	}
	response := roomDocumentPageResponse{Items: page.Items, ViewerAccess: page.ViewerAccess}
	if response.Items == nil {
		response.Items = []content.RoomDocument{}
	}
	if page.NextCursor != "" {
		response.NextCursor = &page.NextCursor
	}
	writeJSON(handlers.logger, w, http.StatusOK, response)
}

func (handlers roomDocumentHandlers) createIntent(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		writeProblem(w, r, http.StatusMethodNotAllowed, "Method not allowed", "Room document upload intents support POST requests.")
		return
	}
	access, spaceID, ok := handlers.mutationAccess(w, r)
	if !ok {
		return
	}
	var request createRoomDocumentIntentRequest
	if err := decodeJSONRequest(w, r, &request, maximumFileBodySize); err != nil ||
		request.DisplayName == nil || request.DeclaredMediaType == nil ||
		request.ExpectedSizeBytes == nil || request.ChecksumSHA256 == nil ||
		request.ClientRequestID == nil {
		handlers.writeProblem(w, r, content.ErrInvalidInput)
		return
	}
	clientRequestID, valid := parseResourceUUID(*request.ClientRequestID)
	if !valid {
		handlers.writeProblem(w, r, content.ErrInvalidInput)
		return
	}
	scope := content.OwnerKindMediaSpace
	if request.Scope != nil {
		switch content.OwnerKind(*request.Scope) {
		case content.OwnerKindMediaSpace, content.OwnerKindClass:
			scope = content.OwnerKind(*request.Scope)
		default:
			handlers.writeProblem(w, r, content.ErrInvalidInput)
			return
		}
	}
	result, err := handlers.service.CreateRoomDocumentIntent(r.Context(), access, spaceID, content.RoomDocumentIntentInput{
		Scope: scope, DisplayName: *request.DisplayName, DeclaredMediaType: *request.DeclaredMediaType,
		ExpectedSizeBytes: *request.ExpectedSizeBytes, ChecksumSHA256: *request.ChecksumSHA256,
		ClientRequestID: clientRequestID, AllowStudentDownload: request.AllowStudentDownload,
	})
	if err != nil {
		handlers.writeProblem(w, r, err)
		return
	}
	status := http.StatusOK
	if result.Created {
		status = http.StatusCreated
	}
	writeJSON(handlers.logger, w, status, result.File)
}

func (handlers roomDocumentHandlers) viewCapability(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		writeProblem(w, r, http.StatusMethodNotAllowed, "Method not allowed", "Room document view capabilities support POST requests.")
		return
	}
	access, spaceID, ok := handlers.mutationAccess(w, r)
	if !ok {
		return
	}
	fileID, ok := parseResourceUUID(r.PathValue("file_id"))
	if !ok {
		handlers.writeProblem(w, r, content.ErrNotFound)
		return
	}
	capability, err := handlers.service.IssueRoomDocumentViewCapability(r.Context(), access, spaceID, fileID)
	if err != nil {
		handlers.writeProblem(w, r, err)
		return
	}
	writeJSON(handlers.logger, w, http.StatusOK, capability)
}

func (handlers roomDocumentHandlers) update(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPatch {
		w.Header().Set("Allow", http.MethodPatch)
		writeProblem(w, r, http.StatusMethodNotAllowed, "Method not allowed", "Room documents support PATCH requests.")
		return
	}
	access, spaceID, ok := handlers.mutationAccess(w, r)
	if !ok {
		return
	}
	fileID, ok := parseResourceUUID(r.PathValue("file_id"))
	if !ok {
		handlers.writeProblem(w, r, content.ErrNotFound)
		return
	}
	var request updateRoomDocumentRequest
	if err := decodeJSONRequest(w, r, &request, maximumFileBodySize); err != nil ||
		request.ExpectedVersion == nil ||
		(request.Deleted != nil && !*request.Deleted) ||
		((request.Deleted != nil) == (request.AllowStudentDownload != nil)) {
		handlers.writeProblem(w, r, content.ErrInvalidInput)
		return
	}
	result, err := handlers.service.UpdateRoomDocument(r.Context(), access, spaceID, fileID, content.UpdateRoomDocumentInput{
		ExpectedVersion: *request.ExpectedVersion, AllowStudentDownload: request.AllowStudentDownload,
		Deleted: request.Deleted != nil && *request.Deleted,
	})
	if err != nil {
		handlers.writeProblem(w, r, err)
		return
	}
	if result.Deleted {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	writeJSON(handlers.logger, w, http.StatusOK, result.Document)
}

func (handlers roomDocumentHandlers) writeProblem(w http.ResponseWriter, r *http.Request, err error) {
	if errors.Is(err, featurecontrol.ErrFeatureDisabled) {
		writeCodedProblem(w, r, http.StatusServiceUnavailable, "feature_disabled",
			"Documents tool disabled", "The classroom Documents tool is not enabled for this workspace.")
		return
	}
	if writeFeatureControlEnforcementProblem(w, r, err) {
		return
	}
	status, code := http.StatusServiceUnavailable, "room_document_unavailable"
	title, detail := "Room document request failed", "The room document request could not be completed safely."
	switch {
	case errors.Is(err, content.ErrDocumentUnsupported):
		status, code = http.StatusBadRequest, "room_document_unsupported"
		title, detail = "Unsupported document", "The Documents tool accepts PDF up to 50 MiB and PNG, JPEG or WebP images up to 10 MiB."
	case errors.Is(err, content.ErrInvalidInput):
		status, code = http.StatusBadRequest, "room_document_invalid"
		title, detail = "Invalid room document request", "Review the room, scope, filename, media type, byte length, checksum, version and request identifier."
	case errors.Is(err, content.ErrAccessDenied):
		status, code = http.StatusForbidden, "room_document_forbidden"
		title, detail = "Room document access denied", "The active workspace cannot authorize this room document request."
	case errors.Is(err, content.ErrNotFound):
		status, code = http.StatusNotFound, "room_document_not_found"
		title, detail = "Document unavailable", "The document is unavailable in this room."
	case errors.Is(err, content.ErrReadOnly):
		status, code = http.StatusConflict, "room_document_read_only"
		title, detail = "Room is read only", "Ended or cancelled rooms and archived classes cannot receive new documents."
	case errors.Is(err, content.ErrIdempotencyConflict):
		status, code = http.StatusConflict, "file_idempotency_conflict"
		title, detail = "Upload retry conflict", "Use a new client request identifier after changing document metadata."
	case errors.Is(err, content.ErrIntentExpired):
		status, code = http.StatusConflict, "file_intent_expired"
		title, detail = "Upload intent expired", "Create a new upload intent before retrying the transfer."
	case errors.Is(err, content.ErrNotReady):
		status, code = http.StatusConflict, "room_document_not_ready"
		title, detail = "Document is not ready", "Wait for document verification to finish before opening it."
	case errors.Is(err, content.ErrVersionConflict):
		status, code = http.StatusConflict, "room_document_version_conflict"
		title, detail = "Document changed", "Reload the room documents before retrying."
	case errors.Is(err, errFileScopeChanged):
		status, code = http.StatusConflict, "file_scope_changed"
		title, detail = "Active workspace changed", "Reload the current session before retrying the document request."
	default:
		// Never log raw error text here: storage errors could embed object keys
		// or signed URLs. Only a bounded classification is recorded.
		handlers.logger.Error(
			"room document request failed",
			"request_id", RequestIDFromContext(r.Context()),
			"path", logsafe.String(r.URL.Path),
			"error_code", roomDocumentErrorClass(err),
		)
	}
	writeCodedProblem(w, r, status, code, title, detail)
}

func roomDocumentErrorClass(err error) string {
	switch {
	case errors.Is(err, content.ErrStorageUnavailable):
		return "storage_unavailable"
	case errors.Is(err, content.ErrStorageMismatch):
		return "storage_mismatch"
	case errors.Is(err, content.ErrUnavailable):
		return "metadata_unavailable"
	default:
		return "unclassified"
	}
}
