package httpapi

import (
	"encoding/json"
	"net/http"
	"strconv"
	"unicode/utf16"
	"unicode/utf8"

	"github.com/tutorhub-v2/core-api/internal/modules/content"
)

// encoding/json otherwise silently substitutes U+FFFD for invalid text.
type studyNoteText string

func (value *studyNoteText) UnmarshalJSON(raw []byte) error {
	if !utf8.Valid(raw) {
		return content.ErrInvalidInput
	}
	var decoded string
	if err := json.Unmarshal(raw, &decoded); err != nil {
		return err
	}
	// JSON syntax has already been checked. Validate surrogate pairs in
	// escapes as well, preserving a legitimately entered replacement character.
	for i := 1; i < len(raw)-1; i++ {
		if raw[i] != '\\' {
			continue
		}
		i++
		if raw[i] != 'u' {
			continue
		}
		unit, _ := strconv.ParseUint(string(raw[i+1:i+5]), 16, 16)
		i += 4
		if !utf16.IsSurrogate(rune(unit)) {
			continue
		}
		if i+6 >= len(raw) || string(raw[i+1:i+3]) != "\\u" {
			return content.ErrInvalidInput
		}
		low, _ := strconv.ParseUint(string(raw[i+3:i+7]), 16, 16)
		if utf16.DecodeRune(rune(unit), rune(low)) == utf8.RuneError {
			return content.ErrInvalidInput
		}
		i += 6
	}
	*value = studyNoteText(decoded)
	return nil
}

func (handlers roomDocumentHandlers) studyNote(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodPut {
		w.Header().Set("Allow", "GET, PUT")
		writeProblem(w, r, http.StatusMethodNotAllowed, "Method not allowed", "Study notes support GET and PUT requests.")
		return
	}
	access, spaceID, ok := handlers.access(w, r, roomDocumentTenantHeader)
	if !ok {
		return
	}
	fileID, ok := parseResourceUUID(r.PathValue("file_id"))
	if !ok {
		handlers.writeProblem(w, r, content.ErrNotFound)
		return
	}
	if r.URL.RawQuery != "" || (r.Method == http.MethodGet && r.ContentLength != 0) {
		handlers.writeProblem(w, r, content.ErrInvalidInput)
		return
	}
	var note content.RoomStudyNote
	var err error
	if r.Method == http.MethodGet {
		note, err = handlers.service.GetRoomStudyNote(r.Context(), access, spaceID, fileID)
	} else {
		var request struct {
			ExpectedVersion *int64 `json:"expected_version"`
			Entries         []struct {
				Page *int           `json:"page"`
				Text *studyNoteText `json:"text"`
			} `json:"entries"`
		}
		// Up to six wire bytes per UTF-8 text byte when JSON escapes are used.
		if decodeJSONRequest(w, r, &request, 512<<10) != nil || request.ExpectedVersion == nil ||
			*request.ExpectedVersion < 0 || request.Entries == nil {
			handlers.writeProblem(w, r, content.ErrInvalidInput)
			return
		}
		input := content.PutRoomStudyNoteInput{ExpectedVersion: *request.ExpectedVersion, Entries: make([]content.StudyNoteEntry, 0, len(request.Entries))}
		for _, entry := range request.Entries {
			if entry.Page == nil || entry.Text == nil {
				handlers.writeProblem(w, r, content.ErrInvalidInput)
				return
			}
			input.Entries = append(input.Entries, content.StudyNoteEntry{Page: *entry.Page, Text: string(*entry.Text)})
		}
		note, err = handlers.service.PutRoomStudyNote(r.Context(), access, spaceID, fileID, input)
	}
	if err != nil {
		handlers.writeProblem(w, r, err)
		return
	}
	writeJSON(handlers.logger, w, http.StatusOK, note)
}

func (handlers roomDocumentHandlers) saveChatAttachment(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		writeProblem(w, r, http.StatusMethodNotAllowed, "Method not allowed", "Saving a chat attachment supports POST requests.")
		return
	}
	access, spaceID, ok := handlers.access(w, r, roomDocumentTenantHeader)
	if !ok {
		return
	}
	var request struct {
		ConversationID       string             `json:"conversation_id"`
		AttachmentID         string             `json:"attachment_id"`
		ClientRequestID      string             `json:"client_request_id"`
		Scope                *content.OwnerKind `json:"scope"`
		AllowStudentDownload *bool              `json:"allow_student_download"`
	}
	if err := decodeJSONRequest(w, r, &request, maximumFileBodySize); err != nil || r.URL.RawQuery != "" {
		handlers.writeProblem(w, r, content.ErrInvalidInput)
		return
	}
	conversationID, validConversation := parseResourceUUID(request.ConversationID)
	attachmentID, validAttachment := parseResourceUUID(request.AttachmentID)
	clientID, validClient := parseResourceUUID(request.ClientRequestID)
	scope := content.OwnerKindMediaSpace
	if request.Scope != nil {
		scope = *request.Scope
	}
	if !validConversation || !validAttachment || !validClient || (scope != content.OwnerKindMediaSpace && scope != content.OwnerKindClass) {
		handlers.writeProblem(w, r, content.ErrInvalidInput)
		return
	}
	result, err := handlers.service.SaveRoomChatAttachment(r.Context(), access, spaceID, content.SaveRoomChatAttachmentInput{
		ConversationID: conversationID, AttachmentID: attachmentID, ClientRequestID: clientID,
		Scope: scope, AllowStudentDownload: request.AllowStudentDownload,
	})
	if err != nil {
		handlers.writeProblem(w, r, err)
		return
	}
	status := http.StatusOK
	if result.Created {
		status = http.StatusCreated
	}
	writeJSON(handlers.logger, w, status, result.Document)
}
