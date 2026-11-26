package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/tutorhub-v2/core-api/internal/modules/content"
)

func (s *fakeRoomDocumentService) GetRoomStudyNote(_ context.Context, access content.AccessContext, space, file uuid.UUID) (content.RoomStudyNote, error) {
	s.calls++
	s.studyAccess, s.studySpace, s.studyFile = access, space, file
	return s.studyNote, s.err
}

func (s *fakeRoomDocumentService) PutRoomStudyNote(ctx context.Context, access content.AccessContext, space, file uuid.UUID, input content.PutRoomStudyNoteInput) (content.RoomStudyNote, error) {
	s.studyInput = input
	return s.GetRoomStudyNote(ctx, access, space, file)
}

func (s *fakeRoomDocumentService) SaveRoomChatAttachment(_ context.Context, access content.AccessContext, space uuid.UUID, input content.SaveRoomChatAttachmentInput) (content.SaveRoomChatAttachmentResult, error) {
	s.calls++
	s.chatInput, s.studyAccess, s.studySpace = input, access, space
	return s.chatResult, s.err
}

func TestRoomStudyNotePrivateBindingAndValidation(t *testing.T) {
	t.Parallel()
	tenant, actor, space, file := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	s := &fakeRoomDocumentService{studyNote: content.RoomStudyNote{FileID: file, Entries: []content.StudyNoteEntry{}}}
	handler := roomDocumentTestHandler(classIdentityService(tenant, actor, nil), s, &bytes.Buffer{})
	path := roomDocumentPath(space, "/"+file.String()+"/study-note")
	send := func(method, path, body string) *httptest.ResponseRecorder {
		r := roomDocumentRequest(method, path, body, tenant)
		r.Header.Set(roomDocumentTenantHeader, tenant.String())
		r.Header.Del(fileTenantHeader)
		if method == http.MethodGet {
			r.Header.Del(csrfHeader)
		}
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		return w
	}
	w := send(http.MethodGet, path, "")
	assertFileHeaders(t, w)
	var result map[string]any
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &result) != nil || len(result) != 6 ||
		result["file_id"] != file.String() || result["version"] != float64(0) || result["updated_at"] != nil ||
		result["expires_at"] != nil || !strings.Contains(w.Body.String(), `"entries":[]`) {
		t.Fatalf("unexpected private note response %d %s", w.Code, w.Body)
	}
	w = send(http.MethodPut, path, `{"expected_version":2,"entries":[{"page":1,"text":"x\ud83d\udcda"}]}`)
	if w.Code != 200 || s.studyInput.ExpectedVersion != 2 || len(s.studyInput.Entries) != 1 || s.studyInput.Entries[0].Text != "x📚" ||
		s.studyAccess.ActorID != actor || s.studyAccess.TenantID != tenant || s.studySpace != space || s.studyFile != file {
		t.Fatalf("unexpected note write %d %+v", w.Code, s.studyInput)
	}
	before := s.calls
	for _, body := range []string{
		`{"entries":[]}`, `{"expected_version":0,"entries":null}`, `{"expected_version":0,"entries":[],"owner_user_id":"someone"}`,
		`{"expected_version":1,"entries":[{"page":1}]}`, `{"expected_version":1,"entries":[{"page":1,"text":"\udc00"}]}`,
		`{"expected_version":1,"entries":[{"page":1,"text":"` + string([]byte{0xff}) + `"}]}`,
	} {
		assertFileProblem(t, send(http.MethodPut, path, body), 400, "room_document_invalid")
	}
	assertFileProblem(t, send(http.MethodGet, path+"?user_id="+uuid.NewString(), ""), 400, "room_document_invalid")
	if s.calls != before {
		t.Fatal("invalid or impersonating request reached the note repository")
	}
	s.err = content.ErrVersionConflict
	assertFileProblem(t, send(http.MethodPut, path, `{"expected_version":0,"entries":[]}`), 409, "room_document_version_conflict")
	s.err = content.ErrStudyNoteLimitExceeded
	assertFileProblem(t, send(http.MethodPut, path, `{"expected_version":0,"entries":[]}`), 409, "room_document_note_limit_exceeded")
}

func TestRoomStudyAndImportRequireTenantAndMutationsRequireCSRF(t *testing.T) {
	t.Parallel()
	tenant, space := uuid.New(), uuid.New()
	s := &fakeRoomDocumentService{}
	handler := roomDocumentTestHandler(classIdentityService(tenant, uuid.New(), nil), s, &bytes.Buffer{})
	path := roomDocumentPath(space, "/"+uuid.NewString()+"/study-note")
	for _, operation := range []struct{ method, path string }{{"GET", path}, {"PUT", path}, {"POST", roomDocumentPath(space, "/from-chat-attachment")}} {
		r := roomDocumentRequest(operation.method, operation.path, "", tenant)
		w := httptest.NewRecorder()
		anonymous := r.Clone(r.Context())
		anonymous.Header.Del("Cookie")
		handler.ServeHTTP(w, anonymous)
		if w.Code != http.StatusUnauthorized {
			t.Fatalf("anonymous %s returned %d", operation.method, w.Code)
		}
		w = httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		assertFileProblem(t, w, 400, "room_document_invalid")
		r.Header.Set(roomDocumentTenantHeader, uuid.NewString())
		w = httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		assertFileProblem(t, w, 404, "room_document_not_found")
		if operation.method != http.MethodGet {
			r.Header.Set(roomDocumentTenantHeader, tenant.String())
			r.Header.Del(csrfHeader)
			w = httptest.NewRecorder()
			handler.ServeHTTP(w, r)
			if w.Code != 403 {
				t.Fatalf("missing CSRF for %s: %d", operation.path, w.Code)
			}
		}
	}
	if s.calls != 0 {
		t.Fatal("unauthorized operation reached the service")
	}
}

func TestRoomChatAttachmentCreationAndReplay(t *testing.T) {
	t.Parallel()
	tenant, actor, space, conversation, attachment, client := uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New()
	s := &fakeRoomDocumentService{chatResult: content.SaveRoomChatAttachmentResult{Document: content.RoomDocument{ID: uuid.New(), Status: content.StatusReady}, Created: true}}
	handler := roomDocumentTestHandler(classIdentityService(tenant, actor, nil), s, &bytes.Buffer{})
	body := `{"conversation_id":"` + conversation.String() + `","attachment_id":"` + attachment.String() + `","client_request_id":"` + client.String() + `"}`
	send := func(body string) *httptest.ResponseRecorder {
		r := roomDocumentRequest(http.MethodPost, roomDocumentPath(space, "/from-chat-attachment"), body, tenant)
		r.Header.Set(roomDocumentTenantHeader, tenant.String())
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		return w
	}
	w := send(body)
	assertFileHeaders(t, w)
	if w.Code != 201 || !strings.Contains(w.Body.String(), `"viewer_access"`) || !strings.Contains(w.Body.String(), `"status":"ready"`) ||
		s.chatInput.AttachmentID != attachment || s.chatInput.ConversationID != conversation || s.chatInput.ClientRequestID != client ||
		s.chatInput.Scope != content.OwnerKindMediaSpace || s.chatInput.AllowStudentDownload != nil || s.studyAccess.ActorID != actor || s.studySpace != space {
		t.Fatalf("unexpected import %d %s %+v", w.Code, w.Body, s.chatInput)
	}
	s.chatResult.Created = false
	if w = send(body); w.Code != 200 {
		t.Fatalf("replay returned %d", w.Code)
	}
	for _, bad := range []string{strings.Replace(body, client.String(), "invalid", 1), strings.Replace(body, "}", `,"scope":"other"}`, 1), strings.Replace(body, "}", `,"object_key":"key"}`, 1)} {
		assertFileProblem(t, send(bad), 400, "room_document_invalid")
	}
	s.err = content.ErrIdempotencyConflict
	assertFileProblem(t, send(body), 409, "file_idempotency_conflict")
	s.err = content.ErrDocumentUnsupported
	assertFileProblem(t, send(body), 400, "room_document_unsupported")
}
