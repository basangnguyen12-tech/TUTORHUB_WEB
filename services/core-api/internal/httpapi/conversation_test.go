package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/tutorhub-v2/core-api/internal/config"
	"github.com/tutorhub-v2/core-api/internal/modules/conversation"
	"github.com/tutorhub-v2/core-api/internal/modules/conversation/stickers"
	"github.com/tutorhub-v2/core-api/internal/modules/featurecontrol"
	"github.com/tutorhub-v2/core-api/internal/modules/identity"
)

var conversationTestTime = time.Date(2026, time.August, 3, 12, 0, 0, 0, time.UTC)

func TestConversationHandlersListUsesExpectedTenantAndOmitsDirectClassFields(t *testing.T) {
	t.Parallel()
	tenantID := uuid.New()
	userID := uuid.New()
	otherID := uuid.New()
	item := conversation.Conversation{
		ID: uuid.New(), TenantID: tenantID, Kind: conversation.KindDirect,
		Title: "Other member",
		Participants: []conversation.Participant{
			{UserID: userID, DisplayName: "Current member"},
			{UserID: otherID, DisplayName: "Other member"},
		},
		ViewerAccess: conversation.ViewerAccess{CanPostMessages: true},
		CreatedAt:    conversationTestTime, UpdatedAt: conversationTestTime,
	}
	service := &fakeConversationService{
		page: conversation.Page{Items: []conversation.Conversation{item}, NextCursor: "next"},
	}
	handler := conversationTestHandler(classIdentityService(tenantID, userID, nil), service)
	request := httptest.NewRequest(
		http.MethodGet,
		conversationsCollectionPath+"?kind=direct&limit=17&cursor=current",
		nil,
	)
	addSessionCookie(request)
	request.Header.Set(conversationTenantHeader, tenantID.String())
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("list status=%d body=%s", response.Code, response.Body.String())
	}
	assertConversationHeaders(t, response)
	if service.listCalls != 1 || service.listAccess.TenantID != tenantID ||
		service.listAccess.ActorID != userID || service.listInput.Limit != 17 ||
		service.listInput.Cursor != "current" || service.listInput.Kind == nil ||
		*service.listInput.Kind != conversation.KindDirect {
		t.Fatalf("unexpected list invocation: %+v", service)
	}
	var body map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode list response: %v", err)
	}
	items, ok := body["items"].([]any)
	if !ok || len(items) != 1 {
		t.Fatalf("unexpected list body: %#v", body)
	}
	projected := items[0].(map[string]any)
	if _, exposed := projected["class_id"]; exposed {
		t.Fatalf("direct conversation exposed class_id: %#v", projected)
	}
	if _, exposed := projected["class_status"]; exposed {
		t.Fatalf("direct conversation exposed class_status: %#v", projected)
	}
	if _, exposed := projected["tenant_id"]; exposed {
		t.Fatalf("conversation exposed tenant_id: %#v", projected)
	}
	projectedParticipants, ok := projected["participants"].([]any)
	if !ok || len(projectedParticipants) != 2 {
		t.Fatalf("unexpected participant projection: %#v", projected)
	}
	for _, participant := range projectedParticipants {
		fields, ok := participant.(map[string]any)
		if !ok {
			t.Fatalf("unexpected participant shape: %#v", participant)
		}
		if _, exposed := fields["email"]; exposed {
			t.Fatalf("conversation participant exposed email: %#v", fields)
		}
	}
}

func TestConversationHandlersCreateDirectClassAndRoomWithCSRF(t *testing.T) {
	t.Parallel()
	tenantID := uuid.New()
	userID := uuid.New()
	classID := uuid.New()
	directID := uuid.New()
	classConversationID := uuid.New()
	mediaSpaceID := uuid.New()
	roomConversationID := uuid.New()
	classStatus := "active"
	mediaSpaceStatus := "open"
	service := &fakeConversationService{
		directResult: conversation.CreateResult{
			Created: true,
			Conversation: conversation.Conversation{
				ID: directID, Kind: conversation.KindDirect, Title: "Student",
				Participants: []conversation.Participant{}, CreatedAt: conversationTestTime,
				UpdatedAt: conversationTestTime,
			},
		},
		classResult: conversation.CreateResult{
			Conversation: conversation.Conversation{
				ID: classConversationID, Kind: conversation.KindClass, ClassID: &classID,
				ClassStatus: &classStatus, Title: "Security class",
				Participants: []conversation.Participant{}, CreatedAt: conversationTestTime,
				UpdatedAt: conversationTestTime,
			},
		},
		roomResult: conversation.CreateResult{
			Created: true,
			Conversation: conversation.Conversation{
				ID: roomConversationID, Kind: conversation.KindRoom,
				MediaSpaceID: &mediaSpaceID, MediaSpaceStatus: &mediaSpaceStatus,
				Title: "Study room", Participants: []conversation.Participant{},
				CreatedAt: conversationTestTime, UpdatedAt: conversationTestTime,
			},
		},
	}
	handler := conversationTestHandler(classIdentityService(tenantID, userID, nil), service)
	direct := conversationMutationRequest(
		conversationDirectPath,
		`{"target_member_email":"student@example.test"}`,
		tenantID,
	)
	directResponse := httptest.NewRecorder()
	handler.ServeHTTP(directResponse, direct)
	if directResponse.Code != http.StatusCreated {
		t.Fatalf("direct status=%d body=%s", directResponse.Code, directResponse.Body.String())
	}
	if service.directCalls != 1 || service.directEmail != "student@example.test" ||
		service.directAccess.ActorID != userID {
		t.Fatalf("unexpected direct invocation: %+v", service)
	}

	classRequest := conversationMutationRequest(
		"/api/v1/classes/"+classID.String()+"/conversation",
		"",
		tenantID,
	)
	classResponse := httptest.NewRecorder()
	handler.ServeHTTP(classResponse, classRequest)
	if classResponse.Code != http.StatusOK {
		t.Fatalf("class status=%d body=%s", classResponse.Code, classResponse.Body.String())
	}
	if service.classCalls != 1 || service.classID != classID ||
		service.classAccess.ActorID != userID {
		t.Fatalf("unexpected class invocation: %+v", service)
	}

	roomRequest := conversationMutationRequest(
		"/api/v1/media/spaces/"+mediaSpaceID.String()+"/conversation",
		"",
		tenantID,
	)
	roomResponse := httptest.NewRecorder()
	handler.ServeHTTP(roomResponse, roomRequest)
	if roomResponse.Code != http.StatusCreated {
		t.Fatalf("room status=%d body=%s", roomResponse.Code, roomResponse.Body.String())
	}
	if service.roomCalls != 1 || service.mediaSpaceID != mediaSpaceID ||
		service.roomAccess.ActorID != userID {
		t.Fatalf("unexpected room invocation: %+v", service)
	}

	missingCSRF := httptest.NewRequest(
		http.MethodPost,
		conversationDirectPath,
		strings.NewReader(`{"target_member_email":"student@example.test"}`),
	)
	missingCSRF.Header.Set("Content-Type", "application/json")
	missingCSRF.Header.Set(conversationTenantHeader, tenantID.String())
	addSessionCookie(missingCSRF)
	missingResponse := httptest.NewRecorder()
	handler.ServeHTTP(missingResponse, missingCSRF)
	if missingResponse.Code != http.StatusForbidden {
		t.Fatalf("missing CSRF status=%d body=%s", missingResponse.Code, missingResponse.Body.String())
	}
	if service.directCalls != 1 {
		t.Fatalf("missing CSRF reached service: calls=%d", service.directCalls)
	}
}

func TestConversationHandlersRejectScopeAndMapConcealedErrors(t *testing.T) {
	t.Parallel()
	tenantID := uuid.New()
	service := &fakeConversationService{getError: conversation.ErrUnavailable}
	handler := conversationTestHandler(
		classIdentityService(tenantID, uuid.New(), nil), service,
	)
	missing := httptest.NewRequest(http.MethodGet, conversationsCollectionPath, nil)
	addSessionCookie(missing)
	missingResponse := httptest.NewRecorder()
	handler.ServeHTTP(missingResponse, missing)
	assertConversationProblem(t, missingResponse, http.StatusBadRequest, "conversation_invalid")

	stale := httptest.NewRequest(http.MethodGet, conversationsCollectionPath, nil)
	addSessionCookie(stale)
	stale.Header.Set(conversationTenantHeader, uuid.NewString())
	staleResponse := httptest.NewRecorder()
	handler.ServeHTTP(staleResponse, stale)
	assertConversationProblem(t, staleResponse, http.StatusConflict, "conversation_scope_changed")

	resource := httptest.NewRequest(
		http.MethodGet, "/api/v1/conversations/"+uuid.NewString(), nil,
	)
	addSessionCookie(resource)
	resource.Header.Set(conversationTenantHeader, tenantID.String())
	resourceResponse := httptest.NewRecorder()
	handler.ServeHTTP(resourceResponse, resource)
	assertConversationProblem(t, resourceResponse, http.StatusNotFound, "conversation_not_found")
}

func TestConversationMessageHandlersListSendEditDeleteAndMarkRead(t *testing.T) {
	t.Parallel()

	tenantID := uuid.New()
	userID := uuid.New()
	conversationID := uuid.New()
	messageID := uuid.New()
	clientMessageID := uuid.New()
	content := "Private message"
	message := conversation.Message{
		ID:              messageID,
		ConversationID:  conversationID,
		Sequence:        7,
		ClientMessageID: clientMessageID,
		Author: conversation.MessageAuthor{
			UserID: userID, DisplayName: "Teacher",
		},
		Content:   &content,
		State:     conversation.MessageStateActive,
		Version:   1,
		CreatedAt: conversationTestTime,
		UpdatedAt: conversationTestTime,
	}
	service := &fakeConversationService{
		messagePage: conversation.MessagePage{
			Items: []conversation.Message{message}, UnreadCount: 1,
		},
		messageResult: conversation.MessageMutationResult{Message: message, Created: true},
		editResult:    message,
		deleteResult:  message,
		readState: conversation.MessageReadState{
			LastReadMessageID: messageID,
			LastReadSequence:  7,
			UpdatedAt:         conversationTestTime,
		},
	}
	handler := conversationTestHandler(classIdentityService(tenantID, userID, nil), service)
	basePath := "/api/v1/conversations/" + conversationID.String()

	listRequest := httptest.NewRequest(
		http.MethodGet, basePath+"/messages?limit=25&cursor=older", nil,
	)
	addSessionCookie(listRequest)
	listRequest.Header.Set(conversationTenantHeader, tenantID.String())
	listResponse := httptest.NewRecorder()
	handler.ServeHTTP(listResponse, listRequest)
	if listResponse.Code != http.StatusOK {
		t.Fatalf("message list status=%d body=%s", listResponse.Code, listResponse.Body.String())
	}
	assertConversationHeaders(t, listResponse)
	if service.messageListCalls != 1 || service.messageListConversationID != conversationID ||
		service.messageListAccess.ActorID != userID || service.messageListInput.Limit != 25 ||
		service.messageListInput.Cursor != "older" {
		t.Fatalf("unexpected message list invocation: %+v", service)
	}
	var listBody conversation.MessagePage
	if err := json.Unmarshal(listResponse.Body.Bytes(), &listBody); err != nil {
		t.Fatalf("decode message list response: %v", err)
	}
	if len(listBody.Items) != 1 || listBody.Items[0].Content == nil ||
		*listBody.Items[0].Content != content || listBody.UnreadCount != 1 {
		t.Fatalf("unexpected message list body: %+v", listBody)
	}

	sendBody := `{"client_message_id":"` + clientMessageID.String() + `","content":"` + content + `"}`
	sendRequest := conversationAuthenticatedMutationRequest(
		http.MethodPost, basePath+"/messages", sendBody, tenantID,
	)
	sendResponse := httptest.NewRecorder()
	handler.ServeHTTP(sendResponse, sendRequest)
	if sendResponse.Code != http.StatusCreated {
		t.Fatalf("message send status=%d body=%s", sendResponse.Code, sendResponse.Body.String())
	}
	if service.messageCalls != 1 || service.messageConversationID != conversationID ||
		service.messageAccess.ActorID != userID ||
		service.messageInput.ClientMessageID != clientMessageID ||
		service.messageInput.Content != content {
		t.Fatalf("unexpected message send invocation: %+v", service)
	}

	service.messageResult.Created = false
	replayRequest := conversationAuthenticatedMutationRequest(
		http.MethodPost, basePath+"/messages", sendBody, tenantID,
	)
	replayResponse := httptest.NewRecorder()
	handler.ServeHTTP(replayResponse, replayRequest)
	if replayResponse.Code != http.StatusOK {
		t.Fatalf("message replay status=%d body=%s", replayResponse.Code, replayResponse.Body.String())
	}

	resourcePath := basePath + "/messages/" + messageID.String()
	editRequest := conversationAuthenticatedMutationRequest(
		http.MethodPatch,
		resourcePath,
		`{"content":"Edited","expected_version":1}`,
		tenantID,
	)
	editResponse := httptest.NewRecorder()
	handler.ServeHTTP(editResponse, editRequest)
	if editResponse.Code != http.StatusOK {
		t.Fatalf("message edit status=%d body=%s", editResponse.Code, editResponse.Body.String())
	}
	if service.editConversationID != conversationID || service.editMessageID != messageID ||
		service.editAccess.ActorID != userID || service.editInput.Content != "Edited" ||
		service.editInput.ExpectedVersion != 1 {
		t.Fatalf("unexpected message edit invocation: %+v", service)
	}

	deleteRequest := conversationAuthenticatedMutationRequest(
		http.MethodDelete,
		resourcePath,
		`{"expected_version":1}`,
		tenantID,
	)
	deleteResponse := httptest.NewRecorder()
	handler.ServeHTTP(deleteResponse, deleteRequest)
	if deleteResponse.Code != http.StatusOK {
		t.Fatalf("message delete status=%d body=%s", deleteResponse.Code, deleteResponse.Body.String())
	}
	if service.deleteConversationID != conversationID || service.deleteMessageID != messageID ||
		service.deleteAccess.ActorID != userID || service.deleteInput.ExpectedVersion != 1 {
		t.Fatalf("unexpected message delete invocation: %+v", service)
	}

	readRequest := conversationAuthenticatedMutationRequest(
		http.MethodPost,
		basePath+"/read",
		`{"message_id":"`+messageID.String()+`"}`,
		tenantID,
	)
	readResponse := httptest.NewRecorder()
	handler.ServeHTTP(readResponse, readRequest)
	if readResponse.Code != http.StatusOK {
		t.Fatalf("message read status=%d body=%s", readResponse.Code, readResponse.Body.String())
	}
	if service.markReadConversationID != conversationID ||
		service.markReadMessageID != messageID || service.markReadAccess.ActorID != userID {
		t.Fatalf("unexpected mark-read invocation: %+v", service)
	}
}

func TestConversationMessageHandlersRequireCSRFAndMapConflictsAndRateLimit(t *testing.T) {
	t.Parallel()

	tenantID := uuid.New()
	conversationID := uuid.New()
	messageID := uuid.New()
	clientMessageID := uuid.New()
	service := &fakeConversationService{}
	handler := conversationTestHandler(
		classIdentityService(tenantID, uuid.New(), nil), service,
	)
	basePath := "/api/v1/conversations/" + conversationID.String()

	missingCSRF := httptest.NewRequest(
		http.MethodPost,
		basePath+"/messages",
		strings.NewReader(`{"client_message_id":"`+clientMessageID.String()+`","content":"secret"}`),
	)
	missingCSRF.Header.Set("Content-Type", "application/json")
	missingCSRF.Header.Set(conversationTenantHeader, tenantID.String())
	addSessionCookie(missingCSRF)
	missingResponse := httptest.NewRecorder()
	handler.ServeHTTP(missingResponse, missingCSRF)
	if missingResponse.Code != http.StatusForbidden || service.messageCalls != 0 {
		t.Fatalf("missing CSRF status=%d calls=%d body=%s",
			missingResponse.Code, service.messageCalls, missingResponse.Body.String())
	}

	service.messageError = conversation.ErrIdempotencyConflict
	conflictRequest := conversationAuthenticatedMutationRequest(
		http.MethodPost,
		basePath+"/messages",
		`{"client_message_id":"`+clientMessageID.String()+`","content":"secret"}`,
		tenantID,
	)
	conflictResponse := httptest.NewRecorder()
	handler.ServeHTTP(conflictResponse, conflictRequest)
	assertConversationProblem(
		t, conflictResponse, http.StatusConflict, "message_idempotency_conflict",
	)
	if strings.Contains(conflictResponse.Body.String(), "secret") {
		t.Fatal("idempotency problem response exposed message content")
	}

	service.editError = conversation.ErrVersionConflict
	editRequest := conversationAuthenticatedMutationRequest(
		http.MethodPatch,
		basePath+"/messages/"+messageID.String(),
		`{"content":"secret edit","expected_version":1}`,
		tenantID,
	)
	editResponse := httptest.NewRecorder()
	handler.ServeHTTP(editResponse, editRequest)
	assertConversationProblem(t, editResponse, http.StatusConflict, "message_version_conflict")
	if strings.Contains(editResponse.Body.String(), "secret edit") {
		t.Fatal("version problem response exposed message content")
	}

	service.messageError = &featurecontrol.QuotaExceededError{
		Quota:      featurecontrol.QuotaMessageSendsPerHour,
		Limit:      60,
		Used:       60,
		RetryAfter: 3 * time.Second,
	}
	rateRequest := conversationAuthenticatedMutationRequest(
		http.MethodPost,
		basePath+"/messages",
		`{"client_message_id":"`+uuid.NewString()+`","content":"bounded"}`,
		tenantID,
	)
	rateResponse := httptest.NewRecorder()
	handler.ServeHTTP(rateResponse, rateRequest)
	assertConversationProblem(t, rateResponse, http.StatusTooManyRequests, "quota_exceeded")
	if rateResponse.Header().Get("Retry-After") != "3" {
		t.Fatalf("Retry-After=%q, want 3", rateResponse.Header().Get("Retry-After"))
	}
}

type fakeConversationService struct {
	cardDirectSourceMessageID uuid.UUID

	page                      conversation.Page
	listError                 error
	listCalls                 int
	listAccess                conversation.AccessContext
	listInput                 conversation.ListInput
	getResult                 conversation.Conversation
	getError                  error
	getCalls                  int
	directResult              conversation.CreateResult
	directError               error
	directCalls               int
	directAccess              conversation.AccessContext
	directEmail               string
	classResult               conversation.CreateResult
	classError                error
	classCalls                int
	classAccess               conversation.AccessContext
	classID                   uuid.UUID
	roomResult                conversation.CreateResult
	roomError                 error
	roomCalls                 int
	roomAccess                conversation.AccessContext
	mediaSpaceID              uuid.UUID
	messagePage               conversation.MessagePage
	messagePageError          error
	messageListAccess         conversation.AccessContext
	messageListConversationID uuid.UUID
	messageListInput          conversation.MessageListInput
	messageListCalls          int
	messageResult             conversation.MessageMutationResult
	messageError              error
	messageAccess             conversation.AccessContext
	messageConversationID     uuid.UUID
	messageInput              conversation.SendMessageInput
	messageCalls              int
	editResult                conversation.Message
	editError                 error
	editAccess                conversation.AccessContext
	editConversationID        uuid.UUID
	editMessageID             uuid.UUID
	editInput                 conversation.EditMessageInput
	editCalls                 int
	deleteResult              conversation.Message
	deleteError               error
	deleteAccess              conversation.AccessContext
	deleteConversationID      uuid.UUID
	deleteMessageID           uuid.UUID
	deleteInput               conversation.DeleteMessageInput
	deleteCalls               int
	readState                 conversation.MessageReadState
	readError                 error
	markReadAccess            conversation.AccessContext
	markReadConversationID    uuid.UUID
	markReadMessageID         uuid.UUID
	markReadCalls             int
	roomChat                  fakeRoomChatService
	stickerPacks              conversation.StickerPacks
	stickerError              error
	stickerAccess             conversation.AccessContext
	stickerCalls              int
}

func (service *fakeConversationService) List(
	_ context.Context,
	access conversation.AccessContext,
	input conversation.ListInput,
) (conversation.Page, error) {
	service.listCalls++
	service.listAccess = access
	service.listInput = input
	return service.page, service.listError
}

func (service *fakeConversationService) Get(
	_ context.Context,
	_ conversation.AccessContext,
	_ uuid.UUID,
) (conversation.Conversation, error) {
	service.getCalls++
	return service.getResult, service.getError
}

func (service *fakeConversationService) CreateDirect(
	_ context.Context,
	access conversation.AccessContext,
	email string,
) (conversation.CreateResult, error) {
	service.directCalls++
	service.directAccess = access
	service.directEmail = email
	return service.directResult, service.directError
}

func (service *fakeConversationService) CreateDirectFromContactCard(
	_ context.Context,
	access conversation.AccessContext,
	sourceMessageID uuid.UUID,
) (conversation.CreateResult, error) {
	service.directCalls++
	service.directAccess = access
	service.cardDirectSourceMessageID = sourceMessageID
	return service.directResult, service.directError
}

func (service *fakeConversationService) CreateClass(
	_ context.Context,
	access conversation.AccessContext,
	classID uuid.UUID,
) (conversation.CreateResult, error) {
	service.classCalls++
	service.classAccess = access
	service.classID = classID
	return service.classResult, service.classError
}

func (service *fakeConversationService) CreateRoom(
	_ context.Context,
	access conversation.AccessContext,
	mediaSpaceID uuid.UUID,
) (conversation.CreateResult, error) {
	service.roomCalls++
	service.roomAccess = access
	service.mediaSpaceID = mediaSpaceID
	return service.roomResult, service.roomError
}

func (service *fakeConversationService) ListMessages(
	_ context.Context,
	access conversation.AccessContext,
	conversationID uuid.UUID,
	input conversation.MessageListInput,
) (conversation.MessagePage, error) {
	service.messageListCalls++
	service.messageListAccess = access
	service.messageListConversationID = conversationID
	service.messageListInput = input
	return service.messagePage, service.messagePageError
}

func (service *fakeConversationService) SendMessage(
	_ context.Context,
	access conversation.AccessContext,
	conversationID uuid.UUID,
	input conversation.SendMessageInput,
) (conversation.MessageMutationResult, error) {
	service.messageCalls++
	service.messageAccess = access
	service.messageConversationID = conversationID
	service.messageInput = input
	return service.messageResult, service.messageError
}

func (service *fakeConversationService) EditMessage(
	_ context.Context,
	access conversation.AccessContext,
	conversationID uuid.UUID,
	messageID uuid.UUID,
	input conversation.EditMessageInput,
) (conversation.Message, error) {
	service.editCalls++
	service.editAccess = access
	service.editConversationID = conversationID
	service.editMessageID = messageID
	service.editInput = input
	return service.editResult, service.editError
}

func (service *fakeConversationService) DeleteMessage(
	_ context.Context,
	access conversation.AccessContext,
	conversationID uuid.UUID,
	messageID uuid.UUID,
	input conversation.DeleteMessageInput,
) (conversation.Message, error) {
	service.deleteCalls++
	service.deleteAccess = access
	service.deleteConversationID = conversationID
	service.deleteMessageID = messageID
	service.deleteInput = input
	return service.deleteResult, service.deleteError
}

func (service *fakeConversationService) MarkRead(
	_ context.Context,
	access conversation.AccessContext,
	conversationID uuid.UUID,
	messageID uuid.UUID,
) (conversation.MessageReadState, error) {
	service.markReadCalls++
	service.markReadAccess = access
	service.markReadConversationID = conversationID
	service.markReadMessageID = messageID
	return service.readState, service.readError
}

func (service *fakeConversationService) ListStickerPacks(
	_ context.Context,
	access conversation.AccessContext,
) (conversation.StickerPacks, error) {
	service.stickerCalls++
	service.stickerAccess = access
	return service.stickerPacks, service.stickerError
}

func conversationTestHandler(
	identityService identity.ServiceAPI,
	service conversation.ServiceAPI,
) http.Handler {
	return NewHandlerWithOptions(
		config.Config{
			Environment: "test", Port: "8080", WebOrigin: "http://localhost:5173",
			Authentication: config.AuthenticationConfig{SessionTTL: 8 * time.Hour},
		},
		slog.New(slog.NewTextHandler(io.Discard, nil)),
		Options{
			Clock:    func() time.Time { return conversationTestTime },
			Identity: identityService, Conversations: service,
		},
	)
}

func conversationMutationRequest(path, body string, tenantID uuid.UUID) *http.Request {
	return conversationAuthenticatedMutationRequest(http.MethodPost, path, body, tenantID)
}

func conversationAuthenticatedMutationRequest(
	method, path, body string,
	tenantID uuid.UUID,
) *http.Request {
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	if body != "" {
		request.Header.Set("Content-Type", "application/json")
	}
	request.Header.Set(csrfHeader, "csrf-token")
	request.Header.Set(conversationTenantHeader, tenantID.String())
	addSessionCookie(request)
	request.AddCookie(&http.Cookie{Name: "tutorhub_csrf", Value: "csrf-token"})
	return request
}

func assertConversationHeaders(t *testing.T, response *httptest.ResponseRecorder) {
	t.Helper()
	if response.Header().Get("Cache-Control") != "no-store" ||
		response.Header().Get("Referrer-Policy") != "no-referrer" ||
		!headerContainsValue(response.Header().Values("Vary"), "Cookie") ||
		!headerContainsValue(response.Header().Values("Vary"), conversationTenantHeader) {
		t.Fatalf("unexpected conversation headers: %v", response.Header())
	}
}

func assertConversationProblem(
	t *testing.T,
	response *httptest.ResponseRecorder,
	status int,
	code string,
) {
	t.Helper()
	if response.Code != status {
		t.Fatalf("status=%d, want %d: %s", response.Code, status, response.Body.String())
	}
	assertConversationHeaders(t, response)
	var problem Problem
	if err := json.Unmarshal(response.Body.Bytes(), &problem); err != nil {
		t.Fatalf("decode problem: %v", err)
	}
	if problem.Code != code {
		t.Fatalf("problem=%+v, want code %q", problem, code)
	}
}

var _ conversation.ServiceAPI = (*fakeConversationService)(nil)

type fakeRoomChatService struct {
	roomSettingsInput  conversation.RoomSettingsInput
	roomSettingsCalls  int
	roomSettingsResult conversation.Conversation
	roomSettingsError  error
	uploadInput        conversation.UploadAttachmentInput
	uploadCalls        int
	uploadResult       conversation.AttachmentUploadResult
	uploadError        error
	contentCalls       int
	contentAttachment  conversation.MessageAttachment
	contentBytes       []byte
	contentError       error
}

func (service *fakeConversationService) UpdateRoomSettings(
	_ context.Context,
	_ conversation.AccessContext,
	_ uuid.UUID,
	input conversation.RoomSettingsInput,
) (conversation.Conversation, error) {
	service.roomChat.roomSettingsCalls++
	service.roomChat.roomSettingsInput = input
	return service.roomChat.roomSettingsResult, service.roomChat.roomSettingsError
}

func (service *fakeConversationService) UploadAttachment(
	_ context.Context,
	_ conversation.AccessContext,
	_ uuid.UUID,
	input conversation.UploadAttachmentInput,
) (conversation.AttachmentUploadResult, error) {
	service.roomChat.uploadCalls++
	service.roomChat.uploadInput = input
	return service.roomChat.uploadResult, service.roomChat.uploadError
}

func (service *fakeConversationService) ReadAttachmentContent(
	_ context.Context,
	_ conversation.AccessContext,
	_ uuid.UUID,
	_ uuid.UUID,
) (conversation.AttachmentContent, error) {
	service.roomChat.contentCalls++
	if service.roomChat.contentError != nil {
		return conversation.AttachmentContent{}, service.roomChat.contentError
	}
	return conversation.AttachmentContent{
		Attachment: service.roomChat.contentAttachment,
		Body:       io.NopCloser(bytes.NewReader(service.roomChat.contentBytes)),
	}, nil
}

type multipartField struct {
	name, fileName string
	content        []byte
}

func attachmentUploadRequest(
	t *testing.T,
	path string,
	tenantID uuid.UUID,
	fields []multipartField,
) *http.Request {
	t.Helper()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	for _, field := range fields {
		var part io.Writer
		var err error
		if field.fileName != "" {
			part, err = writer.CreateFormFile(field.name, field.fileName)
		} else {
			part, err = writer.CreateFormField(field.name)
		}
		if err != nil {
			t.Fatal(err)
		}
		if _, err := part.Write(field.content); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	request := conversationAuthenticatedMutationRequest(http.MethodPost, path, "", tenantID)
	request.Body = io.NopCloser(bytes.NewReader(body.Bytes()))
	request.ContentLength = int64(body.Len())
	request.Header.Set("Content-Type", writer.FormDataContentType())
	return request
}

func TestConversationRoomSettingsHandlerRequiresCSRFAndMapsModeration(t *testing.T) {
	t.Parallel()
	tenantID := uuid.New()
	conversationID := uuid.New()
	open := "open"
	service := &fakeConversationService{}
	service.roomChat.roomSettingsResult = conversation.Conversation{
		ID: conversationID, Kind: conversation.KindRoom, MediaSpaceStatus: &open,
		Title: "Lớp Toán", Participants: []conversation.Participant{},
		ViewerAccess: conversation.ViewerAccess{
			CanPostMessages: true, CanModerateChat: true, CanUploadAttachments: true,
		},
		CreatedAt: conversationTestTime, UpdatedAt: conversationTestTime,
	}
	handler := conversationTestHandler(classIdentityService(tenantID, uuid.New(), nil), service)
	path := "/api/v1/conversations/" + conversationID.String() + "/room-settings"

	missingCSRF := httptest.NewRequest(http.MethodPatch, path, strings.NewReader(`{"participant_chat_enabled":false}`))
	missingCSRF.Header.Set("Content-Type", "application/json")
	missingCSRF.Header.Set(conversationTenantHeader, tenantID.String())
	addSessionCookie(missingCSRF)
	missingResponse := httptest.NewRecorder()
	handler.ServeHTTP(missingResponse, missingCSRF)
	if missingResponse.Code != http.StatusForbidden || service.roomChat.roomSettingsCalls != 0 {
		t.Fatalf("missing CSRF status=%d calls=%d", missingResponse.Code, service.roomChat.roomSettingsCalls)
	}

	response := httptest.NewRecorder()
	handler.ServeHTTP(response, conversationAuthenticatedMutationRequest(
		http.MethodPatch, path, `{"participant_chat_enabled":false}`, tenantID,
	))
	if response.Code != http.StatusOK || service.roomChat.roomSettingsInput.ParticipantChatEnabled {
		t.Fatalf("room settings status=%d input=%+v body=%s",
			response.Code, service.roomChat.roomSettingsInput, response.Body.String())
	}
	assertConversationHeaders(t, response)
	var body map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	access, _ := body["viewer_access"].(map[string]any)
	if body["participant_chat_enabled"] != false || access["can_moderate_chat"] != true ||
		access["can_upload_attachments"] != true {
		t.Fatalf("unexpected room settings projection: %#v", body)
	}

	missing := httptest.NewRecorder()
	handler.ServeHTTP(missing, conversationAuthenticatedMutationRequest(http.MethodPatch, path, `{}`, tenantID))
	assertConversationProblem(t, missing, http.StatusBadRequest, "conversation_invalid")

	service.roomChat.roomSettingsError = conversation.ErrAccessDenied
	denied := httptest.NewRecorder()
	handler.ServeHTTP(denied, conversationAuthenticatedMutationRequest(
		http.MethodPatch, path, `{"participant_chat_enabled":true}`, tenantID,
	))
	assertConversationProblem(t, denied, http.StatusForbidden, "conversation_forbidden")

	service.roomChat.roomSettingsError = conversation.ErrReadOnly
	ended := httptest.NewRecorder()
	handler.ServeHTTP(ended, conversationAuthenticatedMutationRequest(
		http.MethodPatch, path, `{"participant_chat_enabled":true}`, tenantID,
	))
	assertConversationProblem(t, ended, http.StatusConflict, "conversation_read_only")

	wrongMethod := httptest.NewRecorder()
	handler.ServeHTTP(wrongMethod, conversationAuthenticatedMutationRequest(http.MethodPost, path, `{}`, tenantID))
	if wrongMethod.Code != http.StatusMethodNotAllowed {
		t.Fatalf("POST room settings status=%d, want 405", wrongMethod.Code)
	}
}

func TestConversationAttachmentUploadHandlerParsesBoundedMultipart(t *testing.T) {
	t.Parallel()
	tenantID := uuid.New()
	conversationID := uuid.New()
	clientAttachmentID := uuid.New()
	attachmentID := uuid.New()
	width, height := 1280, 720
	service := &fakeConversationService{}
	service.roomChat.uploadResult = conversation.AttachmentUploadResult{
		Created: true,
		Attachment: conversation.MessageAttachment{
			ID: attachmentID, ConversationID: conversationID, Kind: conversation.AttachmentKindImage,
			DisplayName: "bai-tap.png", MediaType: "image/png", SizeBytes: 9,
			WidthPx: &width, HeightPx: &height, CreatedAt: conversationTestTime,
		},
	}
	handler := conversationTestHandler(classIdentityService(tenantID, uuid.New(), nil), service)
	path := "/api/v1/conversations/" + conversationID.String() + "/attachments"
	png := []byte("\x89PNG\r\n\x1a\nX")

	response := httptest.NewRecorder()
	handler.ServeHTTP(response, attachmentUploadRequest(t, path, tenantID, []multipartField{
		{name: "client_attachment_id", content: []byte(clientAttachmentID.String())},
		{name: "width_px", content: []byte("1280")},
		{name: "height_px", content: []byte("720")},
		{name: "file", fileName: "bai-tap.png", content: png},
	}))
	if response.Code != http.StatusCreated {
		t.Fatalf("upload status=%d body=%s", response.Code, response.Body.String())
	}
	assertConversationHeaders(t, response)
	input := service.roomChat.uploadInput
	if input.ClientAttachmentID != clientAttachmentID || input.FileName != "bai-tap.png" ||
		!bytes.Equal(input.Content, png) || input.WidthPx == nil || *input.WidthPx != 1280 ||
		input.HeightPx == nil || *input.HeightPx != 720 {
		t.Fatalf("unexpected upload input: %+v", input)
	}
	var projected map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &projected); err != nil {
		t.Fatal(err)
	}
	for _, hidden := range []string{"object_key", "inline_bytes", "storage_backend", "tenant_id", "uploader_user_id"} {
		if _, exposed := projected[hidden]; exposed {
			t.Fatalf("attachment projection exposed %q", hidden)
		}
	}

	calls := service.roomChat.uploadCalls
	for name, fields := range map[string][]multipartField{
		"missing file": {{name: "client_attachment_id", content: []byte(uuid.NewString())}},
		"missing id":   {{name: "file", fileName: "a.png", content: png}},
		"bad id":       {{name: "client_attachment_id", content: []byte("nope")}, {name: "file", fileName: "a.png", content: png}},
		"bad width":    {{name: "client_attachment_id", content: []byte(uuid.NewString())}, {name: "width_px", content: []byte("wide")}, {name: "file", fileName: "a.png", content: png}},
		"two files": {
			{name: "client_attachment_id", content: []byte(uuid.NewString())},
			{name: "file", fileName: "a.png", content: png},
			{name: "file", fileName: "b.png", content: png},
		},
		"unknown part": {
			{name: "client_attachment_id", content: []byte(uuid.NewString())},
			{name: "media_type", content: []byte("image/svg+xml")},
			{name: "file", fileName: "a.png", content: png},
		},
	} {
		invalid := httptest.NewRecorder()
		handler.ServeHTTP(invalid, attachmentUploadRequest(t, path, tenantID, fields))
		assertConversationProblem(t, invalid, http.StatusBadRequest, "conversation_invalid")
		if service.roomChat.uploadCalls != calls {
			t.Fatalf("%s reached the service", name)
		}
	}

	jsonUpload := httptest.NewRecorder()
	handler.ServeHTTP(jsonUpload, conversationAuthenticatedMutationRequest(http.MethodPost, path, `{"file":"x"}`, tenantID))
	assertConversationProblem(t, jsonUpload, http.StatusBadRequest, "conversation_invalid")

	oversized := httptest.NewRecorder()
	handler.ServeHTTP(oversized, attachmentUploadRequest(t, path, tenantID, []multipartField{
		{name: "client_attachment_id", content: []byte(uuid.NewString())},
		{name: "file", fileName: "big.pdf", content: bytes.Repeat([]byte("a"), conversation.MaximumFileAttachmentBytes+1)},
	}))
	assertConversationProblem(t, oversized, http.StatusRequestEntityTooLarge, "conversation_attachment_too_large")
	if service.roomChat.uploadCalls != calls {
		t.Fatal("oversized upload reached the service")
	}

	service.roomChat.uploadError = conversation.ErrAttachmentUnsupported
	svg := httptest.NewRecorder()
	handler.ServeHTTP(svg, attachmentUploadRequest(t, path, tenantID, []multipartField{
		{name: "client_attachment_id", content: []byte(uuid.NewString())},
		{name: "file", fileName: "x.svg", content: []byte("<svg onload=alert(1)>")},
	}))
	assertConversationProblem(t, svg, http.StatusUnsupportedMediaType, "conversation_attachment_unsupported")
	if strings.Contains(svg.Body.String(), "x.svg") || strings.Contains(svg.Body.String(), "onload") {
		t.Fatal("unsupported problem echoed the file name or content")
	}

	service.roomChat.uploadError = conversation.ErrReadOnly
	paused := httptest.NewRecorder()
	handler.ServeHTTP(paused, attachmentUploadRequest(t, path, tenantID, []multipartField{
		{name: "client_attachment_id", content: []byte(uuid.NewString())},
		{name: "file", fileName: "a.png", content: png},
	}))
	assertConversationProblem(t, paused, http.StatusConflict, "conversation_read_only")

	service.roomChat.uploadError = conversation.ErrAttachmentsUnavailable
	unavailable := httptest.NewRecorder()
	handler.ServeHTTP(unavailable, attachmentUploadRequest(t, path, tenantID, []multipartField{
		{name: "client_attachment_id", content: []byte(uuid.NewString())},
		{name: "file", fileName: "a.png", content: png},
	}))
	assertConversationProblem(t, unavailable, http.StatusServiceUnavailable, "conversation_attachments_unavailable")
}

func TestConversationAttachmentContentHandlerForcesSafeDownload(t *testing.T) {
	t.Parallel()
	tenantID := uuid.New()
	conversationID := uuid.New()
	attachmentID := uuid.New()
	pdf := []byte("%PDF-1.7\n%%EOF\n")
	service := &fakeConversationService{}
	service.roomChat.contentAttachment = conversation.MessageAttachment{
		ID: attachmentID, ConversationID: conversationID, Kind: conversation.AttachmentKindFile,
		DisplayName: `Đề "cương"; ôn tập.pdf`, MediaType: "application/pdf",
		SizeBytes: int64(len(pdf)), CreatedAt: conversationTestTime,
	}
	service.roomChat.contentBytes = pdf
	handler := conversationTestHandler(classIdentityService(tenantID, uuid.New(), nil), service)
	path := "/api/v1/conversations/" + conversationID.String() + "/attachments/" + attachmentID.String() + "/content"

	missingTenant := httptest.NewRequest(http.MethodGet, path, nil)
	addSessionCookie(missingTenant)
	missingResponse := httptest.NewRecorder()
	handler.ServeHTTP(missingResponse, missingTenant)
	if missingResponse.Code != http.StatusBadRequest || service.roomChat.contentCalls != 0 {
		t.Fatalf("missing tenant header status=%d calls=%d", missingResponse.Code, service.roomChat.contentCalls)
	}

	request := httptest.NewRequest(http.MethodGet, path, nil)
	addSessionCookie(request)
	request.Header.Set(conversationTenantHeader, tenantID.String())
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK || !bytes.Equal(response.Body.Bytes(), pdf) {
		t.Fatalf("content status=%d body=%q", response.Code, response.Body.String())
	}
	header := response.Header()
	if header.Get("Content-Type") != "application/pdf" ||
		header.Get("Cache-Control") != "private, no-store" ||
		header.Get("X-Content-Type-Options") != "nosniff" ||
		header.Get("Content-Security-Policy") != "default-src 'none'" ||
		header.Get("Content-Length") != strconv.Itoa(len(pdf)) {
		t.Fatalf("unsafe attachment headers: %v", header)
	}
	disposition := header.Get("Content-Disposition")
	if !strings.HasPrefix(disposition, `attachment; filename="`) ||
		!strings.Contains(disposition, "filename*=UTF-8''%C4%90%E1%BB%81%20%22c%C6%B0%C6%A1ng%22%3B%20%C3%B4n%20t%E1%BA%ADp.pdf") ||
		strings.Contains(disposition, "inline") || strings.Count(disposition, ";") != 2 {
		t.Fatalf("unexpected Content-Disposition %q", disposition)
	}

	head := httptest.NewRequest(http.MethodHead, path, nil)
	addSessionCookie(head)
	head.Header.Set(conversationTenantHeader, tenantID.String())
	headResponse := httptest.NewRecorder()
	handler.ServeHTTP(headResponse, head)
	if headResponse.Code != http.StatusOK || headResponse.Body.Len() != 0 {
		t.Fatalf("HEAD status=%d body length=%d", headResponse.Code, headResponse.Body.Len())
	}

	service.roomChat.contentError = conversation.ErrNotFound
	deleted := httptest.NewRequest(http.MethodGet, path, nil)
	addSessionCookie(deleted)
	deleted.Header.Set(conversationTenantHeader, tenantID.String())
	deletedResponse := httptest.NewRecorder()
	handler.ServeHTTP(deletedResponse, deleted)
	assertConversationProblem(t, deletedResponse, http.StatusNotFound, "conversation_not_found")
}

func TestConversationSendMessageHandlerForwardsBoundedAttachmentIDs(t *testing.T) {
	t.Parallel()
	tenantID := uuid.New()
	conversationID := uuid.New()
	service := &fakeConversationService{}
	handler := conversationTestHandler(classIdentityService(tenantID, uuid.New(), nil), service)
	path := "/api/v1/conversations/" + conversationID.String() + "/messages"
	first, second := uuid.New(), uuid.New()
	empty := []conversation.MessageAttachment{}
	content := ""
	service.messageResult = conversation.MessageMutationResult{Created: true, Message: conversation.Message{
		ID: uuid.New(), ConversationID: conversationID, Sequence: 1, ClientMessageID: uuid.New(),
		Content: &content, State: conversation.MessageStateActive, Version: 1,
		Attachments: &empty, CreatedAt: conversationTestTime, UpdatedAt: conversationTestTime,
	}}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, conversationAuthenticatedMutationRequest(http.MethodPost, path,
		`{"client_message_id":"`+uuid.NewString()+`","content":"","attachment_ids":["`+first.String()+`","`+second.String()+`"]}`,
		tenantID,
	))
	if response.Code != http.StatusCreated || len(service.messageInput.AttachmentIDs) != 2 ||
		service.messageInput.AttachmentIDs[0] != first || service.messageInput.AttachmentIDs[1] != second {
		t.Fatalf("send with attachments status=%d input=%+v", response.Code, service.messageInput)
	}
	if !strings.Contains(response.Body.String(), `"attachments":[]`) {
		t.Fatalf("active message must project an attachments array: %s", response.Body.String())
	}
	calls := service.messageCalls
	for name, ids := range map[string]string{
		"too many": `"` + strings.Repeat(uuid.NewString()+`","`, 4) + uuid.NewString() + `"`,
		"invalid":  `"not-a-uuid"`,
	} {
		invalid := httptest.NewRecorder()
		handler.ServeHTTP(invalid, conversationAuthenticatedMutationRequest(http.MethodPost, path,
			`{"client_message_id":"`+uuid.NewString()+`","content":"x","attachment_ids":[`+ids+`]}`, tenantID,
		))
		assertConversationProblem(t, invalid, http.StatusBadRequest, "conversation_invalid")
		if service.messageCalls != calls {
			t.Fatalf("%s attachment IDs reached the service", name)
		}
	}
	service.messageError = conversation.ErrReadOnly
	paused := httptest.NewRecorder()
	handler.ServeHTTP(paused, conversationAuthenticatedMutationRequest(http.MethodPost, path,
		`{"client_message_id":"`+uuid.NewString()+`","content":"hi"}`, tenantID,
	))
	assertConversationProblem(t, paused, http.StatusConflict, "conversation_read_only")
	service.messageError = conversation.ErrAttachmentUnavailable
	expired := httptest.NewRecorder()
	handler.ServeHTTP(expired, conversationAuthenticatedMutationRequest(http.MethodPost, path,
		`{"client_message_id":"`+uuid.NewString()+`","content":"","attachment_ids":["`+first.String()+`"]}`, tenantID,
	))
	assertConversationProblem(t, expired, http.StatusConflict, "conversation_attachment_unavailable")
}

func TestAttachmentContentDispositionEncodesRFC5987(t *testing.T) {
	t.Parallel()
	for name, want := range map[string]string{
		"report.pdf":   `attachment; filename="report.pdf"; filename*=UTF-8''report.pdf`,
		"a'b(c).txt":   `attachment; filename="a'b(c).txt"; filename*=UTF-8''a%27b%28c%29.txt`,
		"Bài\r\n.docx": `attachment; filename="B_i__.docx"; filename*=UTF-8''B%C3%A0i%0D%0A.docx`,
	} {
		if got := attachmentContentDisposition(name); got != want {
			t.Fatalf("attachmentContentDisposition(%q)=%q, want %q", name, got, want)
		}
	}
}

func TestConversationCardHandlersParseEmbedsAndContactCardDirects(t *testing.T) {
	t.Parallel()
	tenantID := uuid.New()
	conversationID := uuid.New()
	service := &fakeConversationService{}
	handler := conversationTestHandler(classIdentityService(tenantID, uuid.New(), nil), service)
	path := "/api/v1/conversations/" + conversationID.String() + "/messages"
	cardUserID := uuid.New()
	displayName := "TutorHub Student"
	available := true
	content := ""
	service.messageResult = conversation.MessageMutationResult{Created: true, Message: conversation.Message{
		ID: uuid.New(), ConversationID: conversationID, Sequence: 1, ClientMessageID: uuid.New(),
		Content: &content, State: conversation.MessageStateActive, Version: 1,
		Embed: &conversation.MessageEmbed{
			Kind: conversation.EmbedKindContactCard, Available: &available,
			UserID: &cardUserID, DisplayName: &displayName,
		},
		CreatedAt: conversationTestTime, UpdatedAt: conversationTestTime,
	}}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, conversationAuthenticatedMutationRequest(http.MethodPost, path,
		`{"client_message_id":"`+uuid.NewString()+`","content":"","embed":{"kind":"contact_card","user_id":"`+cardUserID.String()+`"}}`,
		tenantID,
	))
	embed := service.messageInput.Embed
	if response.Code != http.StatusCreated || embed == nil ||
		embed.Kind != conversation.EmbedKindContactCard || embed.UserID != cardUserID ||
		embed.MediaSpaceID != uuid.Nil {
		t.Fatalf("contact card send status=%d input=%+v", response.Code, service.messageInput)
	}
	if !strings.Contains(response.Body.String(), `"embed":{"kind":"contact_card","available":true`) {
		t.Fatalf("card response must project the embed: %s", response.Body.String())
	}
	spaceID := uuid.New()
	handler.ServeHTTP(httptest.NewRecorder(), conversationAuthenticatedMutationRequest(http.MethodPost, path,
		`{"client_message_id":"`+uuid.NewString()+`","content":"","embed":{"kind":"instant_class","media_space_id":"`+spaceID.String()+`"}}`,
		tenantID,
	))
	if embed := service.messageInput.Embed; embed == nil ||
		embed.Kind != conversation.EmbedKindInstantClass || embed.MediaSpaceID != spaceID {
		t.Fatalf("instant class send input=%+v", service.messageInput)
	}

	calls := service.messageCalls
	for name, body := range map[string]string{
		"missing kind":       `{"user_id":"` + cardUserID.String() + `"}`,
		"unknown kind":       `{"kind":"poll","user_id":"` + cardUserID.String() + `"}`,
		"contact with space": `{"kind":"contact_card","user_id":"` + cardUserID.String() + `","media_space_id":"` + spaceID.String() + `"}`,
		"class with user":    `{"kind":"instant_class","user_id":"` + cardUserID.String() + `","media_space_id":"` + spaceID.String() + `"}`,
		"bad user id":        `{"kind":"contact_card","user_id":"nope"}`,
		"unknown field":      `{"kind":"contact_card","user_id":"` + cardUserID.String() + `","email":"x@example.test"}`,
	} {
		invalid := httptest.NewRecorder()
		handler.ServeHTTP(invalid, conversationAuthenticatedMutationRequest(http.MethodPost, path,
			`{"client_message_id":"`+uuid.NewString()+`","content":"","embed":`+body+`}`, tenantID,
		))
		assertConversationProblem(t, invalid, http.StatusBadRequest, "conversation_invalid")
		if service.messageCalls != calls {
			t.Fatalf("%s embed reached the service", name)
		}
	}

	service.messageError = conversation.ErrEmbedUnavailable
	unavailable := httptest.NewRecorder()
	handler.ServeHTTP(unavailable, conversationAuthenticatedMutationRequest(http.MethodPost, path,
		`{"client_message_id":"`+uuid.NewString()+`","content":"","embed":{"kind":"contact_card","user_id":"`+cardUserID.String()+`"}}`,
		tenantID,
	))
	assertConversationProblem(t, unavailable, http.StatusConflict, "message_embed_unavailable")

	service.editError = conversation.ErrMessageNotEditable
	edit := httptest.NewRecorder()
	handler.ServeHTTP(edit, conversationAuthenticatedMutationRequest(http.MethodPatch,
		path+"/"+uuid.NewString(), `{"content":"x","expected_version":1}`, tenantID,
	))
	assertConversationProblem(t, edit, http.StatusConflict, "message_not_editable")

	directID := uuid.New()
	service.directResult = conversation.CreateResult{Created: true, Conversation: conversation.Conversation{
		ID: directID, Kind: conversation.KindDirect, Title: displayName,
		Participants: []conversation.Participant{}, CreatedAt: conversationTestTime, UpdatedAt: conversationTestTime,
	}}
	sourceID := uuid.New()
	direct := httptest.NewRecorder()
	handler.ServeHTTP(direct, conversationAuthenticatedMutationRequest(http.MethodPost, conversationDirectPath,
		`{"source_message_id":"`+sourceID.String()+`"}`, tenantID,
	))
	if direct.Code != http.StatusCreated || service.cardDirectSourceMessageID != sourceID ||
		service.directEmail != "" {
		t.Fatalf("card direct status=%d source=%s email=%q", direct.Code, service.cardDirectSourceMessageID, service.directEmail)
	}
	directCalls := service.directCalls
	for name, body := range map[string]string{
		"both targets": `{"target_member_email":"a@example.test","source_message_id":"` + sourceID.String() + `"}`,
		"no target":    `{}`,
		"bad source":   `{"source_message_id":"nope"}`,
	} {
		invalid := httptest.NewRecorder()
		handler.ServeHTTP(invalid, conversationAuthenticatedMutationRequest(http.MethodPost, conversationDirectPath, body, tenantID))
		assertConversationProblem(t, invalid, http.StatusBadRequest, "conversation_invalid")
		if service.directCalls != directCalls {
			t.Fatalf("%s direct request reached the service", name)
		}
	}
}

// MSG-STICKER-01 (ADR-0047): sticker catalog and sticker sends.
func TestConversationStickerPacksHandlerCachesPrivatelyWithETag(t *testing.T) {
	t.Parallel()
	tenantID := uuid.New()
	service := &fakeConversationService{}
	handler := conversationTestHandler(classIdentityService(tenantID, uuid.New(), nil), service)
	catalog, err := stickers.Default()
	if err != nil {
		t.Fatalf("embedded catalog: %v", err)
	}
	service.stickerPacks = conversation.StickerPacks{Catalog: catalog.Published(), ETag: catalog.ETag()}

	request := func(method string, mutate func(*http.Request)) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, conversationStickerPacksPath, nil)
		r.Header.Set(conversationTenantHeader, tenantID.String())
		addSessionCookie(r)
		if mutate != nil {
			mutate(r)
		}
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, r)
		return response
	}

	ok := request(http.MethodGet, nil)
	if ok.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", ok.Code, ok.Body.String())
	}
	if ok.Header().Get("Cache-Control") != "private, max-age=300" ||
		ok.Header().Get("ETag") != catalog.ETag() ||
		!headerContainsValue(ok.Header().Values("Vary"), "Cookie") ||
		!headerContainsValue(ok.Header().Values("Vary"), conversationTenantHeader) {
		t.Fatalf("unexpected catalog headers: %v", ok.Header())
	}
	if service.stickerAccess.TenantID != tenantID || service.stickerCalls != 1 {
		t.Fatalf("catalog access = %+v calls=%d", service.stickerAccess, service.stickerCalls)
	}
	var body struct {
		CatalogVersion string `json:"catalog_version"`
		Packs          []struct {
			ID          string `json:"id"`
			Attribution struct {
				License     string `json:"license"`
				NoticesPath string `json:"notices_path"`
			} `json:"attribution"`
			Stickers []struct {
				ID     string `json:"id"`
				Status string `json:"status"`
				Asset  struct {
					AnimatedURL string `json:"animated_url"`
					StaticURL   string `json:"static_url"`
				} `json:"asset"`
			} `json:"stickers"`
		} `json:"packs"`
	}
	if err := json.Unmarshal(ok.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode catalog: %v", err)
	}
	if body.CatalogVersion != catalog.Version() || len(body.Packs) != 1 ||
		body.Packs[0].Attribution.License != "CC BY 4.0" ||
		body.Packs[0].Attribution.NoticesPath != "/THIRD_PARTY_NOTICES.txt" ||
		len(body.Packs[0].Stickers) < 80 ||
		!strings.HasPrefix(body.Packs[0].Stickers[0].Asset.AnimatedURL, "/stickers/noto_animated/v1/") ||
		body.Packs[0].Stickers[0].Status != "" {
		t.Fatalf("unexpected catalog body: %.200s", ok.Body.String())
	}

	for _, header := range []string{catalog.ETag(), "W/" + catalog.ETag(), `"other", ` + catalog.ETag(), "*"} {
		notModified := request(http.MethodGet, func(r *http.Request) { r.Header.Set("If-None-Match", header) })
		if notModified.Code != http.StatusNotModified || notModified.Body.Len() != 0 ||
			notModified.Header().Get("ETag") != catalog.ETag() ||
			notModified.Header().Get("Cache-Control") != "private, max-age=300" {
			t.Fatalf("If-None-Match %q => %d %v", header, notModified.Code, notModified.Header())
		}
	}
	changed := request(http.MethodGet, func(r *http.Request) { r.Header.Set("If-None-Match", `"stickers-stale"`) })
	if changed.Code != http.StatusOK {
		t.Fatalf("stale validator => %d", changed.Code)
	}

	service.stickerError = &featurecontrol.FeatureDisabledError{Feature: featurecontrol.FeatureChatStickers}
	disabled := request(http.MethodGet, nil)
	assertConversationProblem(t, disabled, http.StatusForbidden, "feature_disabled")
	if disabled.Header().Get("ETag") != "" {
		t.Fatal("a disabled catalog must not expose a validator")
	}
	service.stickerError = conversation.ErrAccessDenied
	assertConversationProblem(t, request(http.MethodGet, nil), http.StatusForbidden, "conversation_forbidden")
	service.stickerError = nil

	calls := service.stickerCalls
	post := request(http.MethodPost, nil)
	if post.Code != http.StatusMethodNotAllowed || post.Header().Get("Allow") != "GET, HEAD" {
		t.Fatalf("POST => %d allow=%q", post.Code, post.Header().Get("Allow"))
	}
	missingTenant := request(http.MethodGet, func(r *http.Request) { r.Header.Del(conversationTenantHeader) })
	assertConversationProblem(t, missingTenant, http.StatusBadRequest, "conversation_invalid")
	if service.stickerCalls != calls {
		t.Fatal("rejected catalog requests must not reach the service")
	}
}

func TestConversationStickerHandlersParseStickerEmbeds(t *testing.T) {
	t.Parallel()
	tenantID := uuid.New()
	conversationID := uuid.New()
	service := &fakeConversationService{}
	handler := conversationTestHandler(classIdentityService(tenantID, uuid.New(), nil), service)
	path := "/api/v1/conversations/" + conversationID.String() + "/messages"
	available := true
	content := ""
	stickerID, packID := "noto_animated:1f602", "noto_animated"
	service.messageResult = conversation.MessageMutationResult{Created: true, Message: conversation.Message{
		ID: uuid.New(), ConversationID: conversationID, Sequence: 1, ClientMessageID: uuid.New(),
		Content: &content, State: conversation.MessageStateActive, Version: 1,
		Embed: &conversation.MessageEmbed{
			Kind: conversation.EmbedKindSticker, Available: &available,
			StickerID: &stickerID, PackID: &packID,
			Labels: &stickers.LocalizedText{VI: "Cười ra nước mắt", EN: "Tears of joy"},
			Asset: &stickers.Asset{
				AnimatedURL: "/stickers/noto_animated/v1/1f602.webp",
				StaticURL:   "/stickers/noto_animated/v1/1f602.static.webp", Width: 160, Height: 160,
			},
		},
		CreatedAt: conversationTestTime, UpdatedAt: conversationTestTime,
	}}
	sendSticker := `{"client_message_id":"` + uuid.NewString() +
		`","content":"","embed":{"kind":"sticker","sticker_id":"noto_animated:1f602"}}`
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, conversationAuthenticatedMutationRequest(http.MethodPost, path, sendSticker, tenantID))
	embed := service.messageInput.Embed
	if response.Code != http.StatusCreated || embed == nil || embed.Kind != conversation.EmbedKindSticker ||
		embed.StickerID != stickerID || embed.UserID != uuid.Nil || embed.MediaSpaceID != uuid.Nil {
		t.Fatalf("sticker send status=%d input=%+v", response.Code, service.messageInput)
	}
	if !strings.Contains(response.Body.String(), `"embed":{"kind":"sticker","available":true,"sticker_id":"noto_animated:1f602","pack_id":"noto_animated"`) ||
		!strings.Contains(response.Body.String(), `"static_url":"/stickers/noto_animated/v1/1f602.static.webp"`) {
		t.Fatalf("sticker response must project the embed: %s", response.Body.String())
	}

	otherID := uuid.NewString()
	calls := service.messageCalls
	for name, body := range map[string]string{
		"missing sticker id":   `{"kind":"sticker"}`,
		"null sticker id":      `{"kind":"sticker","sticker_id":null}`,
		"malformed sticker id": `{"kind":"sticker","sticker_id":"NOTO:1F602"}`,
		"traversal sticker id": `{"kind":"sticker","sticker_id":"noto:../../x"}`,
		"sticker with user":    `{"kind":"sticker","sticker_id":"noto_animated:1f602","user_id":"` + otherID + `"}`,
		"contact with sticker": `{"kind":"contact_card","user_id":"` + otherID + `","sticker_id":"noto_animated:1f602"}`,
		"class with sticker":   `{"kind":"instant_class","media_space_id":"` + otherID + `","sticker_id":"noto_animated:1f602"}`,
	} {
		invalid := httptest.NewRecorder()
		handler.ServeHTTP(invalid, conversationAuthenticatedMutationRequest(http.MethodPost, path,
			`{"client_message_id":"`+uuid.NewString()+`","content":"","embed":`+body+`}`, tenantID,
		))
		assertConversationProblem(t, invalid, http.StatusBadRequest, "conversation_invalid")
		if service.messageCalls != calls {
			t.Fatalf("%s embed reached the service", name)
		}
	}

	for _, test := range []struct {
		err    error
		status int
		code   string
	}{
		{conversation.ErrEmbedUnavailable, http.StatusConflict, "message_embed_unavailable"},
		{conversation.ErrReadOnly, http.StatusConflict, "conversation_read_only"},
		{&featurecontrol.FeatureDisabledError{Feature: featurecontrol.FeatureChatStickers}, http.StatusForbidden, "feature_disabled"},
		{conversation.ErrIdempotencyConflict, http.StatusConflict, "message_idempotency_conflict"},
	} {
		service.messageError = test.err
		failed := httptest.NewRecorder()
		handler.ServeHTTP(failed, conversationAuthenticatedMutationRequest(http.MethodPost, path, sendSticker, tenantID))
		assertConversationProblem(t, failed, test.status, test.code)
	}
}
