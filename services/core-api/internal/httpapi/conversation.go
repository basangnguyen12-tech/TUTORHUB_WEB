package httpapi

import (
	"errors"
	"io"
	"log/slog"
	"mime"
	"net/http"
	"strconv"
	"strings"
	"unicode"

	"github.com/google/uuid"

	"github.com/tutorhub-v2/core-api/internal/modules/conversation"
	"github.com/tutorhub-v2/core-api/internal/modules/identity"
	"github.com/tutorhub-v2/core-api/internal/platform/logsafe"
	"github.com/tutorhub-v2/core-api/internal/policy"
)

const (
	conversationsCollectionPath = "/api/v1/conversations"
	conversationDirectPath      = "/api/v1/conversations/direct"
	conversationResourcePattern = "/api/v1/conversations/{conversation_id}"
	conversationMessagesPattern = "/api/v1/conversations/{conversation_id}/messages"
	conversationMessagePattern  = "/api/v1/conversations/{conversation_id}/messages/{message_id}"
	conversationReadPattern     = "/api/v1/conversations/{conversation_id}/read"
	// ADR-0042 room chat moderation and attachments.
	conversationRoomSettingsPattern      = "/api/v1/conversations/{conversation_id}/room-settings"
	conversationAttachmentsPattern       = "/api/v1/conversations/{conversation_id}/attachments"
	conversationAttachmentContentPattern = "/api/v1/conversations/{conversation_id}/attachments/{attachment_id}/content"
	maximumAttachmentRequestBodySize     = 11 * 1024 * 1024
	maximumAttachmentFieldSize           = 64
	classConversationPattern             = "/api/v1/classes/{class_id}/conversation"
	mediaSpaceConversationPattern        = "/api/v1/media/spaces/{space_id}/conversation"
	conversationTenantHeader             = "X-TutorHub-Expected-Tenant-ID"
	maximumConversationBodySize          = 16 * 1024
	maximumMessageBodySize               = 64 * 1024
)

var errConversationScopeChanged = errors.New("conversation active tenant changed")

type conversationHandlers struct {
	logger  *slog.Logger
	auth    authHandlers
	service conversation.ServiceAPI
}

type createDirectConversationRequest struct {
	TargetMemberEmail *string `json:"target_member_email"`
	// SourceMessageID names a contact card the actor can read
	// (MSG-COMPOSER-TOOLS-01); exactly one target field is allowed.
	SourceMessageID *string `json:"source_message_id"`
}

type sendMessageRequest struct {
	ClientMessageID *string              `json:"client_message_id"`
	Content         *string              `json:"content"`
	AttachmentIDs   []string             `json:"attachment_ids"`
	Embed           *messageEmbedRequest `json:"embed"`
}

type messageEmbedRequest struct {
	Kind         *string `json:"kind"`
	UserID       *string `json:"user_id"`
	MediaSpaceID *string `json:"media_space_id"`
}

// parseMessageEmbed accepts exactly the identifier of the card kind.
func parseMessageEmbed(request *messageEmbedRequest) (*conversation.MessageEmbedInput, bool) {
	if request == nil {
		return nil, true
	}
	if request.Kind == nil {
		return nil, false
	}
	switch conversation.EmbedKind(*request.Kind) {
	case conversation.EmbedKindContactCard:
		if request.UserID == nil || request.MediaSpaceID != nil {
			return nil, false
		}
		userID, ok := parseResourceUUID(*request.UserID)
		if !ok {
			return nil, false
		}
		return &conversation.MessageEmbedInput{
			Kind: conversation.EmbedKindContactCard, UserID: userID,
		}, true
	case conversation.EmbedKindInstantClass:
		if request.MediaSpaceID == nil || request.UserID != nil {
			return nil, false
		}
		spaceID, ok := parseResourceUUID(*request.MediaSpaceID)
		if !ok {
			return nil, false
		}
		return &conversation.MessageEmbedInput{
			Kind: conversation.EmbedKindInstantClass, MediaSpaceID: spaceID,
		}, true
	default:
		return nil, false
	}
}

type roomSettingsRequest struct {
	ParticipantChatEnabled *bool `json:"participant_chat_enabled"`
}

type editMessageRequest struct {
	Content         *string `json:"content"`
	ExpectedVersion *int64  `json:"expected_version"`
}

type deleteMessageRequest struct {
	ExpectedVersion *int64 `json:"expected_version"`
}

type markMessagesReadRequest struct {
	MessageID *string `json:"message_id"`
}

func newConversationHandlers(
	logger *slog.Logger,
	auth authHandlers,
	service conversation.ServiceAPI,
) conversationHandlers {
	return conversationHandlers{logger: logger, auth: auth, service: service}
}

func conversationResponseHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Add("Vary", "Cookie")
		w.Header().Add("Vary", conversationTenantHeader)
		next.ServeHTTP(w, r)
	})
}

func (handlers conversationHandlers) collection(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		writeProblem(w, r, http.StatusMethodNotAllowed, "Method not allowed", "The conversation collection supports GET requests.")
		return
	}
	if !handlers.available(w, r) {
		return
	}
	principal, ok := handlers.auth.authenticatedPrincipal(w, r)
	if !ok {
		return
	}
	access, ok := handlers.access(w, r, principal)
	if !ok {
		return
	}
	input, err := parseConversationListInput(r)
	if err != nil {
		handlers.writeProblem(w, r, err)
		return
	}
	page, err := handlers.service.List(r.Context(), access, input)
	if err != nil {
		handlers.writeProblem(w, r, err)
		return
	}
	writeJSON(handlers.logger, w, http.StatusOK, page)
}

func (handlers conversationHandlers) resource(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		writeProblem(w, r, http.StatusMethodNotAllowed, "Method not allowed", "Conversation details support GET requests.")
		return
	}
	if !handlers.available(w, r) {
		return
	}
	principal, ok := handlers.auth.authenticatedPrincipal(w, r)
	if !ok {
		return
	}
	access, ok := handlers.access(w, r, principal)
	if !ok {
		return
	}
	conversationID, ok := parseResourceUUID(r.PathValue("conversation_id"))
	if !ok {
		handlers.writeProblem(w, r, conversation.ErrNotFound)
		return
	}
	item, err := handlers.service.Get(r.Context(), access, conversationID)
	if err != nil {
		handlers.writeProblem(w, r, err)
		return
	}
	writeJSON(handlers.logger, w, http.StatusOK, item)
}

func (handlers conversationHandlers) createDirect(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		writeProblem(w, r, http.StatusMethodNotAllowed, "Method not allowed", "Direct conversation creation supports POST requests.")
		return
	}
	if !handlers.available(w, r) {
		return
	}
	principal, ok := handlers.csrfPrincipal(w, r)
	if !ok {
		return
	}
	access, ok := handlers.access(w, r, principal)
	if !ok {
		return
	}
	var request createDirectConversationRequest
	if err := decodeJSONRequest(
		w, r, &request, maximumConversationBodySize,
	); err != nil || (request.TargetMemberEmail == nil) == (request.SourceMessageID == nil) {
		handlers.writeProblem(w, r, conversation.ErrInvalidInput)
		return
	}
	var result conversation.CreateResult
	var err error
	if request.SourceMessageID != nil {
		sourceMessageID, ok := parseResourceUUID(*request.SourceMessageID)
		if !ok {
			handlers.writeProblem(w, r, conversation.ErrInvalidInput)
			return
		}
		result, err = handlers.service.CreateDirectFromContactCard(
			r.Context(), access, sourceMessageID,
		)
	} else {
		result, err = handlers.service.CreateDirect(
			r.Context(), access, *request.TargetMemberEmail,
		)
	}
	if err != nil {
		handlers.writeProblem(w, r, err)
		return
	}
	status := http.StatusOK
	if result.Created {
		status = http.StatusCreated
	}
	writeJSON(handlers.logger, w, status, result.Conversation)
}

func (handlers conversationHandlers) createClass(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		writeProblem(w, r, http.StatusMethodNotAllowed, "Method not allowed", "Class conversation creation supports POST requests.")
		return
	}
	if !handlers.available(w, r) {
		return
	}
	principal, ok := handlers.csrfPrincipal(w, r)
	if !ok {
		return
	}
	access, ok := handlers.access(w, r, principal)
	if !ok {
		return
	}
	classID, ok := parseResourceUUID(r.PathValue("class_id"))
	if !ok {
		handlers.writeProblem(w, r, conversation.ErrNotFound)
		return
	}
	if r.ContentLength != 0 {
		var request struct{}
		if err := decodeJSONRequest(
			w, r, &request, maximumConversationBodySize,
		); err != nil {
			handlers.writeProblem(w, r, conversation.ErrInvalidInput)
			return
		}
	}
	result, err := handlers.service.CreateClass(r.Context(), access, classID)
	if err != nil {
		handlers.writeProblem(w, r, err)
		return
	}
	status := http.StatusOK
	if result.Created {
		status = http.StatusCreated
	}
	writeJSON(handlers.logger, w, status, result.Conversation)
}

func (handlers conversationHandlers) createRoom(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		writeProblem(w, r, http.StatusMethodNotAllowed, "Method not allowed", "Room conversation creation supports POST requests.")
		return
	}
	if !handlers.available(w, r) {
		return
	}
	principal, ok := handlers.csrfPrincipal(w, r)
	if !ok {
		return
	}
	access, ok := handlers.access(w, r, principal)
	if !ok {
		return
	}
	mediaSpaceID, ok := parseResourceUUID(r.PathValue("space_id"))
	if !ok {
		handlers.writeProblem(w, r, conversation.ErrNotFound)
		return
	}
	if r.ContentLength != 0 {
		var request struct{}
		if err := decodeJSONRequest(
			w, r, &request, maximumConversationBodySize,
		); err != nil {
			handlers.writeProblem(w, r, conversation.ErrInvalidInput)
			return
		}
	}
	result, err := handlers.service.CreateRoom(r.Context(), access, mediaSpaceID)
	if err != nil {
		handlers.writeProblem(w, r, err)
		return
	}
	status := http.StatusOK
	if result.Created {
		status = http.StatusCreated
	}
	writeJSON(handlers.logger, w, status, result.Conversation)
}

func (handlers conversationHandlers) messages(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead && r.Method != http.MethodPost {
		w.Header().Set("Allow", "GET, HEAD, POST")
		writeProblem(w, r, http.StatusMethodNotAllowed, "Method not allowed", "Conversation messages support GET, HEAD, and POST requests.")
		return
	}
	if !handlers.available(w, r) {
		return
	}
	var principal identity.Principal
	var ok bool
	if r.Method == http.MethodPost {
		principal, ok = handlers.csrfPrincipal(w, r)
	} else {
		principal, ok = handlers.auth.authenticatedPrincipal(w, r)
	}
	if !ok {
		return
	}
	access, ok := handlers.access(w, r, principal)
	if !ok {
		return
	}
	conversationID, ok := parseResourceUUID(r.PathValue("conversation_id"))
	if !ok {
		handlers.writeProblem(w, r, conversation.ErrNotFound)
		return
	}
	if r.Method == http.MethodGet || r.Method == http.MethodHead {
		input, err := parseMessageListInput(r)
		if err != nil {
			handlers.writeProblem(w, r, err)
			return
		}
		page, err := handlers.service.ListMessages(
			r.Context(), access, conversationID, input,
		)
		if err != nil {
			handlers.writeProblem(w, r, err)
			return
		}
		writeJSON(handlers.logger, w, http.StatusOK, page)
		return
	}
	var request sendMessageRequest
	if err := decodeJSONRequest(w, r, &request, maximumMessageBodySize); err != nil ||
		request.ClientMessageID == nil || request.Content == nil {
		handlers.writeProblem(w, r, conversation.ErrInvalidInput)
		return
	}
	clientMessageID, ok := parseResourceUUID(*request.ClientMessageID)
	if !ok || len(request.AttachmentIDs) > conversation.MaximumAttachmentsPerMessage {
		handlers.writeProblem(w, r, conversation.ErrInvalidInput)
		return
	}
	attachmentIDs := make([]uuid.UUID, 0, len(request.AttachmentIDs))
	for _, raw := range request.AttachmentIDs {
		attachmentID, ok := parseResourceUUID(raw)
		if !ok {
			handlers.writeProblem(w, r, conversation.ErrInvalidInput)
			return
		}
		attachmentIDs = append(attachmentIDs, attachmentID)
	}
	embed, ok := parseMessageEmbed(request.Embed)
	if !ok {
		handlers.writeProblem(w, r, conversation.ErrInvalidInput)
		return
	}
	result, err := handlers.service.SendMessage(
		r.Context(),
		access,
		conversationID,
		conversation.SendMessageInput{
			ClientMessageID: clientMessageID,
			Content:         *request.Content,
			AttachmentIDs:   attachmentIDs,
			Embed:           embed,
		},
	)
	if err != nil {
		handlers.writeProblem(w, r, err)
		return
	}
	status := http.StatusOK
	if result.Created {
		status = http.StatusCreated
	}
	writeJSON(handlers.logger, w, status, result.Message)
}

func (handlers conversationHandlers) message(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPatch && r.Method != http.MethodDelete {
		w.Header().Set("Allow", "PATCH, DELETE")
		writeProblem(w, r, http.StatusMethodNotAllowed, "Method not allowed", "Message lifecycle supports PATCH and DELETE requests.")
		return
	}
	if !handlers.available(w, r) {
		return
	}
	principal, ok := handlers.csrfPrincipal(w, r)
	if !ok {
		return
	}
	access, ok := handlers.access(w, r, principal)
	if !ok {
		return
	}
	conversationID, conversationOK := parseResourceUUID(r.PathValue("conversation_id"))
	messageID, messageOK := parseResourceUUID(r.PathValue("message_id"))
	if !conversationOK || !messageOK {
		handlers.writeProblem(w, r, conversation.ErrNotFound)
		return
	}
	if r.Method == http.MethodPatch {
		var request editMessageRequest
		if err := decodeJSONRequest(w, r, &request, maximumMessageBodySize); err != nil ||
			request.Content == nil || request.ExpectedVersion == nil {
			handlers.writeProblem(w, r, conversation.ErrInvalidInput)
			return
		}
		item, err := handlers.service.EditMessage(
			r.Context(),
			access,
			conversationID,
			messageID,
			conversation.EditMessageInput{
				Content:         *request.Content,
				ExpectedVersion: *request.ExpectedVersion,
			},
		)
		if err != nil {
			handlers.writeProblem(w, r, err)
			return
		}
		writeJSON(handlers.logger, w, http.StatusOK, item)
		return
	}
	var request deleteMessageRequest
	if err := decodeJSONRequest(w, r, &request, maximumMessageBodySize); err != nil ||
		request.ExpectedVersion == nil {
		handlers.writeProblem(w, r, conversation.ErrInvalidInput)
		return
	}
	item, err := handlers.service.DeleteMessage(
		r.Context(),
		access,
		conversationID,
		messageID,
		conversation.DeleteMessageInput{ExpectedVersion: *request.ExpectedVersion},
	)
	if err != nil {
		handlers.writeProblem(w, r, err)
		return
	}
	writeJSON(handlers.logger, w, http.StatusOK, item)
}

func (handlers conversationHandlers) markRead(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		writeProblem(w, r, http.StatusMethodNotAllowed, "Method not allowed", "Conversation read state supports POST requests.")
		return
	}
	if !handlers.available(w, r) {
		return
	}
	principal, ok := handlers.csrfPrincipal(w, r)
	if !ok {
		return
	}
	access, ok := handlers.access(w, r, principal)
	if !ok {
		return
	}
	conversationID, ok := parseResourceUUID(r.PathValue("conversation_id"))
	if !ok {
		handlers.writeProblem(w, r, conversation.ErrNotFound)
		return
	}
	var request markMessagesReadRequest
	if err := decodeJSONRequest(w, r, &request, maximumMessageBodySize); err != nil ||
		request.MessageID == nil {
		handlers.writeProblem(w, r, conversation.ErrInvalidInput)
		return
	}
	messageID, ok := parseResourceUUID(*request.MessageID)
	if !ok {
		handlers.writeProblem(w, r, conversation.ErrInvalidInput)
		return
	}
	state, err := handlers.service.MarkRead(
		r.Context(), access, conversationID, messageID,
	)
	if err != nil {
		handlers.writeProblem(w, r, err)
		return
	}
	writeJSON(handlers.logger, w, http.StatusOK, state)
}

func parseConversationListInput(r *http.Request) (conversation.ListInput, error) {
	query := r.URL.Query()
	input := conversation.ListInput{Cursor: strings.TrimSpace(query.Get("cursor"))}
	if raw := strings.TrimSpace(query.Get("kind")); raw != "" {
		kind := conversation.Kind(raw)
		input.Kind = &kind
	}
	if raw := strings.TrimSpace(query.Get("limit")); raw != "" {
		limit, err := strconv.Atoi(raw)
		if err != nil {
			return conversation.ListInput{}, conversation.ErrInvalidInput
		}
		input.Limit = limit
	}
	return input, nil
}

func parseMessageListInput(r *http.Request) (conversation.MessageListInput, error) {
	query := r.URL.Query()
	input := conversation.MessageListInput{Cursor: strings.TrimSpace(query.Get("cursor"))}
	if raw := strings.TrimSpace(query.Get("limit")); raw != "" {
		limit, err := strconv.Atoi(raw)
		if err != nil {
			return conversation.MessageListInput{}, conversation.ErrInvalidInput
		}
		input.Limit = limit
	}
	return input, nil
}

func (handlers conversationHandlers) access(
	w http.ResponseWriter,
	r *http.Request,
	principal identity.Principal,
) (conversation.AccessContext, bool) {
	if principal.ActiveTenant == nil {
		handlers.writeProblem(w, r, conversation.ErrAccessDenied)
		return conversation.AccessContext{}, false
	}
	expectedTenantID, ok := parseResourceUUID(
		strings.TrimSpace(r.Header.Get(conversationTenantHeader)),
	)
	if !ok {
		handlers.writeProblem(w, r, conversation.ErrInvalidInput)
		return conversation.AccessContext{}, false
	}
	if expectedTenantID != principal.ActiveTenant.ID {
		handlers.writeProblem(w, r, errConversationScopeChanged)
		return conversation.AccessContext{}, false
	}
	return conversation.AccessContext{
		TenantID:          principal.ActiveTenant.ID,
		ActorID:           principal.User.ID,
		MembershipActive:  principal.ActiveTenant.IsActive,
		OrganizationRoles: []policy.OrganizationRole{policy.OrganizationRole(principal.ActiveTenant.Role)},
	}, true
}

func (handlers conversationHandlers) csrfPrincipal(
	w http.ResponseWriter,
	r *http.Request,
) (identity.Principal, bool) {
	sessionToken, ok := handlers.auth.sessionToken(w, r)
	if !ok {
		return identity.Principal{}, false
	}
	return handlers.auth.csrfPrincipal(w, r, sessionToken)
}

func (handlers conversationHandlers) available(w http.ResponseWriter, r *http.Request) bool {
	if !handlers.auth.available(w, r) {
		return false
	}
	if handlers.service == nil {
		writeCodedProblem(w, r, http.StatusServiceUnavailable, "conversation_unavailable", "Conversations unavailable", "Conversations are not configured for this environment.")
		return false
	}
	return true
}

func (handlers conversationHandlers) writeProblem(w http.ResponseWriter, r *http.Request, err error) {
	if writeFeatureControlEnforcementProblem(w, r, err) {
		return
	}
	status, code := http.StatusServiceUnavailable, "conversation_unavailable"
	title, detail := "Conversation request failed", "The conversation request could not be completed safely."
	switch {
	case errors.Is(err, conversation.ErrInvalidInput):
		status, code = http.StatusBadRequest, "conversation_invalid"
		title, detail = "Invalid conversation request", "Review the conversation kind, pagination, or target member."
	case errors.Is(err, conversation.ErrAccessDenied):
		status, code = http.StatusForbidden, "conversation_forbidden"
		title, detail = "Conversation access denied", "The active workspace cannot authorize this conversation request."
	case errors.Is(err, conversation.ErrNotFound), errors.Is(err, conversation.ErrUnavailable):
		status, code = http.StatusNotFound, "conversation_not_found"
		title, detail = "Conversation unavailable", "The conversation or member is unavailable in the active workspace."
	case errors.Is(err, conversation.ErrReadOnly):
		status, code = http.StatusConflict, "conversation_read_only"
		title, detail = "Conversation is read only", "Archived classes and ended rooms keep authorized history but cannot create or receive new conversation content."
	case errors.Is(err, conversation.ErrIdempotencyConflict):
		status, code = http.StatusConflict, "message_idempotency_conflict"
		title, detail = "Message retry conflict", "Use a new client message identifier after changing the conversation or message content."
	case errors.Is(err, conversation.ErrVersionConflict):
		status, code = http.StatusConflict, "message_version_conflict"
		title, detail = "Message changed", "Reload the latest message state before retrying this change."
	case errors.Is(err, conversation.ErrMessageNotEditable):
		status, code = http.StatusConflict, "message_not_editable"
		title, detail = "Message cannot be edited", "Contact cards and class cards keep their content; unsend and send a new one instead."
	case errors.Is(err, conversation.ErrEmbedUnavailable):
		status, code = http.StatusConflict, "message_embed_unavailable"
		title, detail = "Card unavailable", "The contact or class can no longer be shared in this conversation."
	case errors.Is(err, conversation.ErrAttachmentUnsupported):
		status, code = http.StatusUnsupportedMediaType, "conversation_attachment_unsupported"
		title, detail = "Attachment type not allowed", "Send PNG, JPEG, WebP or GIF images, or PDF, Office, text, CSV, Markdown or ZIP lesson files."
	case errors.Is(err, conversation.ErrAttachmentTooLarge):
		status, code = http.StatusRequestEntityTooLarge, "conversation_attachment_too_large"
		title, detail = "Attachment too large", "Images may be up to 5 MiB and files up to 10 MiB."
	case errors.Is(err, conversation.ErrAttachmentsUnavailable):
		status, code = http.StatusServiceUnavailable, "conversation_attachments_unavailable"
		title, detail = "Attachments unavailable", "Attachments are not available for this conversation in this environment."
	case errors.Is(err, conversation.ErrAttachmentUnavailable):
		status, code = http.StatusConflict, "conversation_attachment_unavailable"
		title, detail = "Attachment unavailable", "Upload the attachment again; it expired, was already sent, or belongs to another conversation."
	case errors.Is(err, errConversationScopeChanged):
		status, code = http.StatusConflict, "conversation_scope_changed"
		title, detail = "Active workspace changed", "Reload the current session before retrying the conversation request."
	default:
		handlers.logger.Error(
			"conversation request failed",
			"request_id", RequestIDFromContext(r.Context()),
			"path", logsafe.String(r.URL.Path),
			"error", logsafe.Error(err),
		)
	}
	writeCodedProblem(w, r, status, code, title, detail)
}

func (handlers conversationHandlers) roomSettings(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPatch {
		w.Header().Set("Allow", http.MethodPatch)
		writeProblem(w, r, http.StatusMethodNotAllowed, "Method not allowed", "Room chat settings support PATCH requests.")
		return
	}
	if !handlers.available(w, r) {
		return
	}
	principal, ok := handlers.csrfPrincipal(w, r)
	if !ok {
		return
	}
	access, ok := handlers.access(w, r, principal)
	if !ok {
		return
	}
	conversationID, ok := parseResourceUUID(r.PathValue("conversation_id"))
	if !ok {
		handlers.writeProblem(w, r, conversation.ErrNotFound)
		return
	}
	var request roomSettingsRequest
	if err := decodeJSONRequest(w, r, &request, maximumConversationBodySize); err != nil ||
		request.ParticipantChatEnabled == nil {
		handlers.writeProblem(w, r, conversation.ErrInvalidInput)
		return
	}
	item, err := handlers.service.UpdateRoomSettings(
		r.Context(), access, conversationID,
		conversation.RoomSettingsInput{ParticipantChatEnabled: *request.ParticipantChatEnabled},
	)
	if err != nil {
		handlers.writeProblem(w, r, err)
		return
	}
	writeJSON(handlers.logger, w, http.StatusOK, item)
}

func (handlers conversationHandlers) attachments(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		writeProblem(w, r, http.StatusMethodNotAllowed, "Method not allowed", "Conversation attachments support POST uploads.")
		return
	}
	if !handlers.available(w, r) {
		return
	}
	principal, ok := handlers.csrfPrincipal(w, r)
	if !ok {
		return
	}
	access, ok := handlers.access(w, r, principal)
	if !ok {
		return
	}
	conversationID, ok := parseResourceUUID(r.PathValue("conversation_id"))
	if !ok {
		handlers.writeProblem(w, r, conversation.ErrNotFound)
		return
	}
	input, err := parseAttachmentUpload(w, r)
	if err != nil {
		handlers.writeProblem(w, r, err)
		return
	}
	result, err := handlers.service.UploadAttachment(r.Context(), access, conversationID, input)
	if err != nil {
		handlers.writeProblem(w, r, err)
		return
	}
	status := http.StatusOK
	if result.Created {
		status = http.StatusCreated
	}
	writeJSON(handlers.logger, w, status, result.Attachment)
}

// parseAttachmentUpload streams a bounded multipart body without temporary
// files: one UUID field, optional pixel dimensions, and exactly one file part.
func parseAttachmentUpload(
	w http.ResponseWriter,
	r *http.Request,
) (conversation.UploadAttachmentInput, error) {
	mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || mediaType != "multipart/form-data" {
		return conversation.UploadAttachmentInput{}, conversation.ErrInvalidInput
	}
	r.Body = http.MaxBytesReader(w, r.Body, maximumAttachmentRequestBodySize)
	reader, err := r.MultipartReader()
	if err != nil {
		return conversation.UploadAttachmentInput{}, conversation.ErrInvalidInput
	}
	var input conversation.UploadAttachmentInput
	fileSeen := false
	for {
		part, err := reader.NextPart()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return conversation.UploadAttachmentInput{}, multipartError(err)
		}
		name := part.FormName()
		switch name {
		case "client_attachment_id", "width_px", "height_px":
			if part.FileName() != "" {
				_ = part.Close()
				return conversation.UploadAttachmentInput{}, conversation.ErrInvalidInput
			}
			raw, err := io.ReadAll(io.LimitReader(part, maximumAttachmentFieldSize+1))
			_ = part.Close()
			if err != nil {
				return conversation.UploadAttachmentInput{}, multipartError(err)
			}
			if len(raw) > maximumAttachmentFieldSize {
				return conversation.UploadAttachmentInput{}, conversation.ErrInvalidInput
			}
			value := strings.TrimSpace(string(raw))
			if name == "client_attachment_id" {
				id, ok := parseResourceUUID(value)
				if !ok || input.ClientAttachmentID != uuid.Nil {
					return conversation.UploadAttachmentInput{}, conversation.ErrInvalidInput
				}
				input.ClientAttachmentID = id
				continue
			}
			dimension, err := strconv.Atoi(value)
			if err != nil {
				return conversation.UploadAttachmentInput{}, conversation.ErrInvalidInput
			}
			if name == "width_px" {
				input.WidthPx = &dimension
			} else {
				input.HeightPx = &dimension
			}
		case "file":
			if fileSeen {
				_ = part.Close()
				return conversation.UploadAttachmentInput{}, conversation.ErrInvalidInput
			}
			fileSeen = true
			input.FileName = part.FileName()
			content, err := io.ReadAll(io.LimitReader(part, conversation.MaximumFileAttachmentBytes+1))
			_ = part.Close()
			if err != nil {
				return conversation.UploadAttachmentInput{}, multipartError(err)
			}
			if len(content) > conversation.MaximumFileAttachmentBytes {
				return conversation.UploadAttachmentInput{}, conversation.ErrAttachmentTooLarge
			}
			input.Content = content
		default:
			_ = part.Close()
			return conversation.UploadAttachmentInput{}, conversation.ErrInvalidInput
		}
	}
	if !fileSeen || len(input.Content) == 0 || input.ClientAttachmentID == uuid.Nil {
		return conversation.UploadAttachmentInput{}, conversation.ErrInvalidInput
	}
	return input, nil
}

func multipartError(err error) error {
	var maxBytes *http.MaxBytesError
	if errors.As(err, &maxBytes) {
		return conversation.ErrAttachmentTooLarge
	}
	return conversation.ErrInvalidInput
}

func (handlers conversationHandlers) attachmentContent(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		writeProblem(w, r, http.StatusMethodNotAllowed, "Method not allowed", "Attachment content supports GET requests.")
		return
	}
	if !handlers.available(w, r) {
		return
	}
	principal, ok := handlers.auth.authenticatedPrincipal(w, r)
	if !ok {
		return
	}
	access, ok := handlers.access(w, r, principal)
	if !ok {
		return
	}
	conversationID, conversationOK := parseResourceUUID(r.PathValue("conversation_id"))
	attachmentID, attachmentOK := parseResourceUUID(r.PathValue("attachment_id"))
	if !conversationOK || !attachmentOK {
		handlers.writeProblem(w, r, conversation.ErrNotFound)
		return
	}
	content, err := handlers.service.ReadAttachmentContent(r.Context(), access, conversationID, attachmentID)
	if err != nil {
		handlers.writeProblem(w, r, err)
		return
	}
	defer func() { _ = content.Body.Close() }()
	header := w.Header()
	header.Set("Content-Type", content.Attachment.MediaType)
	header.Set("Content-Length", strconv.FormatInt(content.Attachment.SizeBytes, 10))
	header.Set("Cache-Control", "private, no-store")
	header.Set("X-Content-Type-Options", "nosniff")
	header.Set("Content-Security-Policy", "default-src 'none'")
	header.Set("Content-Disposition", attachmentContentDisposition(content.Attachment.DisplayName))
	w.WriteHeader(http.StatusOK)
	if r.Method == http.MethodHead {
		return
	}
	_, _ = io.CopyN(w, content.Body, content.Attachment.SizeBytes)
}

// attachmentContentDisposition always forces a download (never inline) with
// an ASCII fallback and an RFC 5987 UTF-8 filename.
func attachmentContentDisposition(name string) string {
	fallback := strings.Map(func(character rune) rune {
		if character > unicode.MaxASCII || character < 0x20 || character == 0x7f ||
			character == '"' || character == '\\' || character == ';' {
			return '_'
		}
		return character
	}, name)
	if strings.TrimSpace(fallback) == "" {
		fallback = "attachment"
	}
	return `attachment; filename="` + fallback + `"; filename*=UTF-8''` + rfc5987Encode(name)
}

// rfc5987Encode percent-encodes every byte outside RFC 5987 attr-char.
func rfc5987Encode(value string) string {
	const hex = "0123456789ABCDEF"
	var builder strings.Builder
	for index := 0; index < len(value); index++ {
		character := value[index]
		if (character >= 'a' && character <= 'z') || (character >= 'A' && character <= 'Z') ||
			(character >= '0' && character <= '9') || strings.IndexByte("!#$&+-.^_`|~", character) >= 0 {
			builder.WriteByte(character)
			continue
		}
		builder.WriteByte('%')
		builder.WriteByte(hex[character>>4])
		builder.WriteByte(hex[character&0x0f])
	}
	return builder.String()
}
