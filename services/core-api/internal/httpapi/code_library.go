package httpapi

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"strings"

	"github.com/google/uuid"
	"github.com/tutorhub-v2/core-api/internal/modules/collaboration"
	"github.com/tutorhub-v2/core-api/internal/modules/identity"
	"github.com/tutorhub-v2/core-api/internal/platform/logsafe"
)

// ROOM-TOOLS-CODE-03A (ADR-0043 §4 Slice 3): public routes for the durable
// snippet library and per-room scratchpads. Bodies are strict JSON; source
// code, stdin and file names are never logged.
const (
	codeSnippetsCollectionPath        = "/api/v1/code-snippets"
	codeSnippetResourcePattern        = "/api/v1/code-snippets/{snippet_id}"
	codeScratchpadPattern             = "/api/v1/media/spaces/{space_id}/code-scratchpad"
	codeScratchpadSharePattern        = "/api/v1/media/spaces/{space_id}/code-scratchpad/share"
	codeSharedScratchpadsPattern      = "/api/v1/media/spaces/{space_id}/shared-scratchpads"
	codeSharedScratchpadPattern       = "/api/v1/media/spaces/{space_id}/shared-scratchpads/{scratchpad_id}"
	maximumCodeSnippetRequestBytes    = 512 * 1024
	maximumCodeScratchpadRequestBytes = 2 * 1024 * 1024
	maximumCodeShareRequestBytes      = 1024
)

type codeLibraryHandlers struct {
	logger  *slog.Logger
	auth    authHandlers
	service collaboration.CodeLibraryServiceAPI
}

type createCodeSnippetRequest struct {
	IdempotencyKey *string `json:"idempotency_key"`
	Visibility     *string `json:"visibility"`
	ClassID        *string `json:"class_id"`
	Title          *string `json:"title"`
	Description    *string `json:"description"`
	FileName       *string `json:"file_name"`
	Language       *string `json:"language"`
	Content        *string `json:"content"`
}

type updateCodeSnippetRequest struct {
	ExpectedVersion *int64  `json:"expected_version"`
	Title           *string `json:"title"`
	Description     *string `json:"description"`
	FileName        *string `json:"file_name"`
	Language        *string `json:"language"`
	Content         *string `json:"content"`
}

type codeScratchpadFileRequest struct {
	Name     *string `json:"name"`
	Language *string `json:"language"`
	Content  *string `json:"content"`
}

type putCodeScratchpadRequest struct {
	Files           *[]codeScratchpadFileRequest `json:"files"`
	ActiveIndex     *int                         `json:"active_index"`
	Stdin           *string                      `json:"stdin"`
	ExpectedVersion *int64                       `json:"expected_version"`
}

type shareCodeScratchpadRequest struct {
	Shared *bool `json:"shared"`
}

func newCodeLibraryHandlers(
	logger *slog.Logger,
	auth authHandlers,
	service collaboration.CodeLibraryServiceAPI,
) codeLibraryHandlers {
	return codeLibraryHandlers{logger: logger, auth: auth, service: service}
}

func (handlers codeLibraryHandlers) snippets(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		principal, ok := handlers.principal(w, r, false)
		if !ok {
			return
		}
		input, valid := parseCodeSnippetListQuery(r)
		if !valid {
			handlers.writeProblem(w, r, collaboration.ErrInvalidRequest)
			return
		}
		list, err := handlers.service.ListSnippets(r.Context(), whiteboardAccess(principal), input)
		if err != nil {
			handlers.writeProblem(w, r, err)
			return
		}
		writeJSON(handlers.logger, w, http.StatusOK, list)
	case http.MethodPost:
		principal, ok := handlers.principal(w, r, true)
		if !ok {
			return
		}
		var request createCodeSnippetRequest
		if err := decodeJSONRequest(w, r, &request, maximumCodeSnippetRequestBytes); err != nil ||
			request.IdempotencyKey == nil || request.Visibility == nil || request.Title == nil ||
			request.FileName == nil || request.Language == nil || request.Content == nil {
			handlers.writeProblem(w, r, collaboration.ErrInvalidRequest)
			return
		}
		input := collaboration.CodeSnippetCreateInput{
			IdempotencyKey: *request.IdempotencyKey,
			Visibility:     collaboration.CodeSnippetVisibility(*request.Visibility),
			Title:          *request.Title, FileName: *request.FileName,
			Language: *request.Language, Content: *request.Content,
		}
		if request.Description != nil {
			input.Description = *request.Description
		}
		if request.ClassID != nil {
			classID, valid := parseResourceUUID(*request.ClassID)
			if !valid {
				handlers.writeProblem(w, r, collaboration.ErrInvalidRequest)
				return
			}
			input.ClassID = classID
		}
		result, err := handlers.service.CreateSnippet(r.Context(), whiteboardAccess(principal), input)
		if err != nil {
			handlers.writeProblem(w, r, err)
			return
		}
		status := http.StatusOK
		if result.Created {
			status = http.StatusCreated
		}
		writeJSON(handlers.logger, w, status, result.Snippet)
	default:
		writeCodeLibraryMethodProblem(w, r, http.MethodGet+", "+http.MethodPost)
	}
}

func (handlers codeLibraryHandlers) snippet(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodPatch && r.Method != http.MethodDelete {
		writeCodeLibraryMethodProblem(w, r, http.MethodGet+", "+http.MethodPatch+", "+http.MethodDelete)
		return
	}
	principal, ok := handlers.principal(w, r, r.Method != http.MethodGet)
	if !ok {
		return
	}
	snippetID, valid := parseResourceUUID(r.PathValue("snippet_id"))
	if !valid {
		handlers.writeProblem(w, r, collaboration.ErrInvalidRequest)
		return
	}
	access := whiteboardAccess(principal)
	switch r.Method {
	case http.MethodGet:
		snippet, err := handlers.service.GetSnippet(r.Context(), access, snippetID)
		if err != nil {
			handlers.writeProblem(w, r, err)
			return
		}
		writeJSON(handlers.logger, w, http.StatusOK, snippet)
	case http.MethodPatch:
		var request updateCodeSnippetRequest
		if err := decodeJSONRequest(w, r, &request, maximumCodeSnippetRequestBytes); err != nil ||
			request.ExpectedVersion == nil {
			handlers.writeProblem(w, r, collaboration.ErrInvalidRequest)
			return
		}
		snippet, err := handlers.service.UpdateSnippet(r.Context(), access, snippetID, collaboration.CodeSnippetUpdateInput{
			ExpectedVersion: *request.ExpectedVersion, Title: request.Title,
			Description: request.Description, FileName: request.FileName,
			Language: request.Language, Content: request.Content,
		})
		if err != nil {
			handlers.writeProblem(w, r, err)
			return
		}
		writeJSON(handlers.logger, w, http.StatusOK, snippet)
	case http.MethodDelete:
		if err := handlers.service.DeleteSnippet(r.Context(), access, snippetID); err != nil {
			handlers.writeProblem(w, r, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

func (handlers codeLibraryHandlers) scratchpad(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodPut {
		writeCodeLibraryMethodProblem(w, r, http.MethodGet+", "+http.MethodPut)
		return
	}
	principal, spaceID, ok := handlers.spacePrincipal(w, r, r.Method == http.MethodPut)
	if !ok {
		return
	}
	access := whiteboardAccess(principal)
	if r.Method == http.MethodGet {
		projection, err := handlers.service.GetScratchpad(r.Context(), access, spaceID)
		if err != nil {
			handlers.writeProblem(w, r, err)
			return
		}
		writeJSON(handlers.logger, w, http.StatusOK, projection)
		return
	}
	var request putCodeScratchpadRequest
	if err := decodeJSONRequest(w, r, &request, maximumCodeScratchpadRequestBytes); err != nil ||
		request.Files == nil || request.ActiveIndex == nil {
		handlers.writeProblem(w, r, collaboration.ErrInvalidRequest)
		return
	}
	input := collaboration.CodeScratchpadPutInput{
		ActiveIndex: *request.ActiveIndex,
		Files:       make([]collaboration.CodeScratchpadFile, 0, len(*request.Files)),
	}
	for _, file := range *request.Files {
		if file.Name == nil || file.Language == nil || file.Content == nil {
			handlers.writeProblem(w, r, collaboration.ErrInvalidRequest)
			return
		}
		input.Files = append(input.Files, collaboration.CodeScratchpadFile{
			Name: *file.Name, Language: *file.Language, Content: *file.Content,
		})
	}
	if request.Stdin != nil {
		input.Stdin = *request.Stdin
	}
	if request.ExpectedVersion != nil {
		input.ExpectedVersion = *request.ExpectedVersion
	}
	scratchpad, err := handlers.service.PutScratchpad(r.Context(), access, spaceID, input)
	if err != nil {
		handlers.writeProblem(w, r, err)
		return
	}
	writeJSON(handlers.logger, w, http.StatusOK, scratchpad)
}

func (handlers codeLibraryHandlers) shareScratchpad(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPut {
		writeCodeLibraryMethodProblem(w, r, http.MethodPut)
		return
	}
	principal, spaceID, ok := handlers.spacePrincipal(w, r, true)
	if !ok {
		return
	}
	var request shareCodeScratchpadRequest
	if err := decodeJSONRequest(w, r, &request, maximumCodeShareRequestBytes); err != nil || request.Shared == nil {
		handlers.writeProblem(w, r, collaboration.ErrInvalidRequest)
		return
	}
	projection, err := handlers.service.ShareScratchpad(r.Context(), whiteboardAccess(principal), spaceID, *request.Shared)
	if err != nil {
		handlers.writeProblem(w, r, err)
		return
	}
	writeJSON(handlers.logger, w, http.StatusOK, projection)
}

func (handlers codeLibraryHandlers) sharedScratchpads(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeCodeLibraryMethodProblem(w, r, http.MethodGet)
		return
	}
	principal, spaceID, ok := handlers.spacePrincipal(w, r, false)
	if !ok {
		return
	}
	list, err := handlers.service.ListSharedScratchpads(r.Context(), whiteboardAccess(principal), spaceID)
	if err != nil {
		handlers.writeProblem(w, r, err)
		return
	}
	writeJSON(handlers.logger, w, http.StatusOK, list)
}

func (handlers codeLibraryHandlers) sharedScratchpad(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeCodeLibraryMethodProblem(w, r, http.MethodGet)
		return
	}
	principal, spaceID, ok := handlers.spacePrincipal(w, r, false)
	if !ok {
		return
	}
	scratchpadID, valid := parseResourceUUID(r.PathValue("scratchpad_id"))
	if !valid {
		handlers.writeProblem(w, r, collaboration.ErrInvalidRequest)
		return
	}
	scratchpad, err := handlers.service.GetSharedScratchpad(r.Context(), whiteboardAccess(principal), spaceID, scratchpadID)
	if err != nil {
		handlers.writeProblem(w, r, err)
		return
	}
	writeJSON(handlers.logger, w, http.StatusOK, scratchpad)
}

// parseCodeSnippetListQuery accepts each known parameter at most once and
// rejects anything else, so an ambiguous filter never reaches the service.
func parseCodeSnippetListQuery(r *http.Request) (collaboration.CodeSnippetListInput, bool) {
	query := r.URL.Query()
	allowed := map[string]struct{}{
		"scope": {}, "class_id": {}, "language": {}, "q": {}, "cursor": {}, "limit": {},
	}
	for key, values := range query {
		if _, known := allowed[key]; !known || len(values) != 1 {
			return collaboration.CodeSnippetListInput{}, false
		}
	}
	input := collaboration.CodeSnippetListInput{
		Scope:    collaboration.CodeSnippetVisibility(query.Get("scope")),
		Language: query.Get("language"),
		Query:    query.Get("q"),
		Cursor:   query.Get("cursor"),
	}
	if raw, present := query["class_id"]; present {
		classID, valid := parseResourceUUID(raw[0])
		if !valid {
			return collaboration.CodeSnippetListInput{}, false
		}
		input.ClassID = classID
	}
	if raw, present := query["limit"]; present {
		limit, err := strconv.Atoi(raw[0])
		if err != nil || limit < 1 || limit > collaboration.CodeSnippetMaxPageSize {
			return collaboration.CodeSnippetListInput{}, false
		}
		input.Limit = limit
	}
	return input, true
}

func (handlers codeLibraryHandlers) spacePrincipal(
	w http.ResponseWriter,
	r *http.Request,
	csrf bool,
) (identity.Principal, uuid.UUID, bool) {
	principal, ok := handlers.principal(w, r, csrf)
	if !ok {
		return identity.Principal{}, uuid.Nil, false
	}
	spaceID, valid := parseResourceUUID(r.PathValue("space_id"))
	if !valid {
		handlers.writeProblem(w, r, collaboration.ErrInvalidRequest)
		return identity.Principal{}, uuid.Nil, false
	}
	return principal, spaceID, true
}

func (handlers codeLibraryHandlers) principal(
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

func (handlers codeLibraryHandlers) writeProblem(w http.ResponseWriter, r *http.Request, err error) {
	status, code := http.StatusServiceUnavailable, "code_library_unavailable"
	title, detail := "Code library unavailable", "The code library request could not be completed safely."
	switch {
	case errors.Is(err, collaboration.ErrInvalidRequest):
		status, code = http.StatusBadRequest, "code_library_invalid"
		title, detail = "Invalid code library request", "Review the tenant assertion, opaque identifiers, filters, cursor, bounded fields, and optimistic versions."
	case errors.Is(err, collaboration.ErrNotFound):
		status, code = http.StatusNotFound, "code_library_not_found"
		title, detail = "Code resource unavailable", "The code resource is unavailable in the active workspace."
	case errors.Is(err, collaboration.ErrCodeLibraryForbidden):
		status, code = http.StatusForbidden, "code_library_forbidden"
		title, detail = "Code library action not permitted", "Only class teaching staff and organization admins can manage class snippets."
	case errors.Is(err, collaboration.ErrFeatureDisabled):
		status, code = http.StatusServiceUnavailable, "feature_disabled"
		title, detail = "Code library disabled", "The durable code library is not enabled for this workspace."
	case errors.Is(err, collaboration.ErrVersionConflict):
		status, code = http.StatusConflict, "code_snippet_version_conflict"
		title, detail = "Snippet changed", "Reload the current snippet before retrying."
	case errors.Is(err, collaboration.ErrIdempotencyConflict):
		status, code = http.StatusConflict, "code_snippet_idempotency_conflict"
		title, detail = "Snippet retry conflict", "Use a new idempotency key after changing the snippet."
	case errors.Is(err, collaboration.ErrCodeSnippetQuotaExceeded):
		status, code = http.StatusConflict, "code_snippet_quota_exceeded"
		title, detail = "Snippet limit reached", "Delete an existing snippet before saving another one."
	case errors.Is(err, collaboration.ErrCodeStorageQuotaExceeded):
		status, code = http.StatusConflict, "code_storage_quota_exceeded"
		title, detail = "Code storage limit reached", "The workspace code storage quota has been reached."
	case errors.Is(err, collaboration.ErrQuotaExceeded):
		status, code = http.StatusConflict, "code_library_quota_exceeded"
		title, detail = "Code library quota reached", "A workspace quota has been reached."
	case errors.Is(err, collaboration.ErrCodeScratchpadVersionConflict):
		status, code = http.StatusConflict, "code_scratchpad_version_conflict"
		title, detail = "Draft changed", "Reload the latest saved draft and resolve the conflict before saving again."
	case errors.Is(err, collaboration.ErrCodeScratchpadEmpty):
		status, code = http.StatusConflict, "code_scratchpad_empty"
		title, detail = "No saved draft", "Save a draft in this room before sharing it with teachers."
	case errors.Is(err, collaboration.ErrCodeScratchpadTooLarge):
		status, code = http.StatusRequestEntityTooLarge, "code_scratchpad_too_large"
		title, detail = "Draft too large", "Reduce the draft size before saving."
	case errors.Is(err, errWhiteboardScopeChanged):
		status, code = http.StatusConflict, "code_library_scope_changed"
		title, detail = "Active workspace changed", "Reload the current workspace before retrying."
	case errors.Is(err, collaboration.ErrUnavailable), errors.Is(err, context.DeadlineExceeded):
		// Keep the privacy-safe default.
	default:
		handlers.logger.Error(
			"code library request failed",
			"request_id", RequestIDFromContext(r.Context()),
			"path", logsafe.String(requestTelemetryPath(r.URL.Path)),
			"error", logsafe.Error(err),
		)
	}
	writeCodedProblem(w, r, status, code, title, detail)
}

func writeCodeLibraryMethodProblem(w http.ResponseWriter, r *http.Request, allow string) {
	w.Header().Set("Allow", allow)
	writeProblem(w, r, http.StatusMethodNotAllowed, "Method not allowed", "The code library resource does not support this HTTP method.")
}
