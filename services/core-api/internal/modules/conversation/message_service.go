package conversation

import (
	"bytes"
	"context"
	"crypto/sha256"
	"fmt"
	"slices"
	"strings"
	"unicode/utf8"

	"github.com/google/uuid"
)

func (service *Service) ListMessages(
	ctx context.Context,
	access AccessContext,
	conversationID uuid.UUID,
	input MessageListInput,
) (MessagePage, error) {
	if service == nil {
		return MessagePage{}, fmt.Errorf("list messages: service is unavailable")
	}
	if !validAccess(access) {
		return MessagePage{}, ErrAccessDenied
	}
	if conversationID == uuid.Nil {
		return MessagePage{}, ErrNotFound
	}
	input.Cursor = strings.TrimSpace(input.Cursor)
	if input.Limit == 0 {
		input.Limit = defaultMessageListLimit
	}
	if input.Limit < 1 || input.Limit > maximumMessageListLimit {
		return MessagePage{}, ErrInvalidInput
	}
	cursor, err := decodeMessageCursor(access.TenantID, conversationID, input.Cursor)
	if err != nil {
		return MessagePage{}, err
	}
	result, err := service.repository.ListMessages(
		ctx, access, conversationID, input, cursor,
	)
	if err != nil {
		return MessagePage{}, err
	}
	page := MessagePage{
		Items:             result.Items,
		UnreadCount:       result.UnreadCount,
		UnreadCountCapped: result.UnreadCountCapped,
		ReadState:         result.ReadState,
	}
	if page.Items == nil {
		page.Items = []Message{}
	}
	if result.HasMore && len(page.Items) > 0 {
		page.NextCursor, err = encodeMessageCursor(
			access.TenantID,
			conversationID,
			messageCursor{BeforeSequence: page.Items[len(page.Items)-1].Sequence},
		)
		if err != nil {
			return MessagePage{}, err
		}
	}
	return page, nil
}

func (service *Service) SendMessage(
	ctx context.Context,
	access AccessContext,
	conversationID uuid.UUID,
	input SendMessageInput,
) (MessageMutationResult, error) {
	if service == nil {
		return MessageMutationResult{}, fmt.Errorf("send message: service is unavailable")
	}
	if !validAccess(access) {
		return MessageMutationResult{}, ErrAccessDenied
	}
	if conversationID == uuid.Nil {
		return MessageMutationResult{}, ErrNotFound
	}
	if input.ClientMessageID == uuid.Nil {
		return MessageMutationResult{}, ErrInvalidInput
	}
	attachmentIDs, err := normalizeAttachmentIDs(input.AttachmentIDs)
	if err != nil {
		return MessageMutationResult{}, err
	}
	var content string
	if len(attachmentIDs) > 0 {
		content, err = normalizeOptionalMessageContent(input.Content)
	} else {
		content, err = normalizeMessageContent(input.Content)
	}
	if err != nil {
		return MessageMutationResult{}, err
	}
	input.Content = content
	input.AttachmentIDs = attachmentIDs
	return service.repository.SendMessage(ctx, access, conversationID, input)
}

func (service *Service) EditMessage(
	ctx context.Context,
	access AccessContext,
	conversationID, messageID uuid.UUID,
	input EditMessageInput,
) (Message, error) {
	if service == nil {
		return Message{}, fmt.Errorf("edit message: service is unavailable")
	}
	if !validAccess(access) {
		return Message{}, ErrAccessDenied
	}
	if conversationID == uuid.Nil || messageID == uuid.Nil {
		return Message{}, ErrNotFound
	}
	if input.ExpectedVersion < 1 {
		return Message{}, ErrInvalidInput
	}
	content, err := normalizeMessageContent(input.Content)
	if err != nil {
		return Message{}, err
	}
	input.Content = content
	return service.repository.EditMessage(
		ctx, access, conversationID, messageID, input,
	)
}

func (service *Service) DeleteMessage(
	ctx context.Context,
	access AccessContext,
	conversationID, messageID uuid.UUID,
	input DeleteMessageInput,
) (Message, error) {
	if service == nil {
		return Message{}, fmt.Errorf("delete message: service is unavailable")
	}
	if !validAccess(access) {
		return Message{}, ErrAccessDenied
	}
	if conversationID == uuid.Nil || messageID == uuid.Nil {
		return Message{}, ErrNotFound
	}
	if input.ExpectedVersion < 1 {
		return Message{}, ErrInvalidInput
	}
	item, objectKeys, err := service.repository.DeleteMessage(
		ctx, access, conversationID, messageID, input,
	)
	if err != nil {
		return Message{}, err
	}
	service.deleteAttachmentObjects(ctx, objectKeys)
	return item, nil
}

func (service *Service) MarkRead(
	ctx context.Context,
	access AccessContext,
	conversationID, messageID uuid.UUID,
) (MessageReadState, error) {
	if service == nil {
		return MessageReadState{}, fmt.Errorf("mark messages read: service is unavailable")
	}
	if !validAccess(access) {
		return MessageReadState{}, ErrAccessDenied
	}
	if conversationID == uuid.Nil || messageID == uuid.Nil {
		return MessageReadState{}, ErrNotFound
	}
	return service.repository.MarkRead(ctx, access, conversationID, messageID)
}

// normalizeAttachmentIDs rejects nil, duplicate, or more than four IDs and
// returns them in canonical order for the request fingerprint.
func normalizeAttachmentIDs(values []uuid.UUID) ([]uuid.UUID, error) {
	if len(values) == 0 {
		return nil, nil
	}
	if len(values) > MaximumAttachmentsPerMessage {
		return nil, ErrInvalidInput
	}
	normalized := append([]uuid.UUID(nil), values...)
	slices.SortFunc(normalized, func(left, right uuid.UUID) int {
		return bytes.Compare(left[:], right[:])
	})
	for index, value := range normalized {
		if value == uuid.Nil || (index > 0 && normalized[index-1] == value) {
			return nil, ErrInvalidInput
		}
	}
	return normalized, nil
}

// normalizeOptionalMessageContent allows an empty caption for a message that
// carries attachments; every other bound still applies.
func normalizeOptionalMessageContent(value string) (string, error) {
	if !utf8.ValidString(value) {
		return "", ErrInvalidInput
	}
	if strings.TrimSpace(value) == "" {
		return "", nil
	}
	return normalizeMessageContent(value)
}

// messageRequestFingerprint keeps the pre-attachment fingerprint for
// text-only sends so committed replays stay byte-identical.
func messageRequestFingerprint(content string, attachmentIDs []uuid.UUID) [32]byte {
	if len(attachmentIDs) == 0 {
		return sha256.Sum256([]byte(content))
	}
	payload := make([]byte, 0, len(content)+13+len(attachmentIDs)*16)
	payload = append(payload, content...)
	payload = append(payload, 0)
	payload = append(payload, "attachments:"...)
	for _, attachmentID := range attachmentIDs {
		payload = append(payload, attachmentID[:]...)
	}
	return sha256.Sum256(payload)
}

func normalizeMessageContent(value string) (string, error) {
	if !utf8.ValidString(value) {
		return "", ErrInvalidInput
	}
	value = strings.ReplaceAll(value, "\r\n", "\n")
	value = strings.ReplaceAll(value, "\r", "\n")
	value = strings.TrimSpace(value)
	if value == "" || strings.ContainsRune(value, '\x00') ||
		utf8.RuneCountInString(value) > maximumMessageCharacters ||
		len([]byte(value)) > maximumMessageBytes {
		return "", ErrInvalidInput
	}
	return value, nil
}
