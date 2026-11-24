package conversation

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"time"

	"github.com/google/uuid"
)

const attachmentObjectTimeout = 30 * time.Second

func (service *Service) UpdateRoomSettings(
	ctx context.Context,
	access AccessContext,
	conversationID uuid.UUID,
	input RoomSettingsInput,
) (Conversation, error) {
	if service == nil {
		return Conversation{}, fmt.Errorf("update room settings: service is unavailable")
	}
	if !validAccess(access) {
		return Conversation{}, ErrAccessDenied
	}
	if conversationID == uuid.Nil {
		return Conversation{}, ErrNotFound
	}
	item, err := service.repository.UpdateRoomSettings(ctx, access, conversationID, input)
	if err != nil {
		return Conversation{}, err
	}
	return service.decorateConversation(item), nil
}

func (service *Service) UploadAttachment(
	ctx context.Context,
	access AccessContext,
	conversationID uuid.UUID,
	input UploadAttachmentInput,
) (AttachmentUploadResult, error) {
	if service == nil {
		return AttachmentUploadResult{}, fmt.Errorf("upload attachment: service is unavailable")
	}
	if !validAccess(access) {
		return AttachmentUploadResult{}, ErrAccessDenied
	}
	if conversationID == uuid.Nil {
		return AttachmentUploadResult{}, ErrNotFound
	}
	if !service.storage.available() {
		return AttachmentUploadResult{}, ErrAttachmentsUnavailable
	}
	if input.ClientAttachmentID == uuid.Nil ||
		!validAttachmentDimension(input.WidthPx) || !validAttachmentDimension(input.HeightPx) {
		return AttachmentUploadResult{}, ErrInvalidInput
	}
	displayName := normalizeAttachmentName(input.FileName)
	kind, mediaType, err := classifyAttachment(displayName, input.Content)
	if err != nil {
		return AttachmentUploadResult{}, err
	}
	if kind != AttachmentKindImage {
		// Pixel dimensions only describe images.
		input.WidthPx, input.HeightPx = nil, nil
	}
	fingerprint := attachmentFingerprint(input, displayName)

	// A replay must not upload the same bytes to object storage twice.
	if existing, found, err := service.repository.FindAttachmentReplay(
		ctx, access, conversationID, input.ClientAttachmentID, fingerprint,
	); err != nil {
		return AttachmentUploadResult{}, err
	} else if found {
		return AttachmentUploadResult{Attachment: existing}, nil
	}

	record := attachmentRecord{
		ID:                 uuid.New(),
		ClientAttachmentID: input.ClientAttachmentID,
		Fingerprint:        fingerprint,
		Kind:               kind,
		DisplayName:        displayName,
		MediaType:          mediaType,
		SizeBytes:          int64(len(input.Content)),
		WidthPx:            input.WidthPx,
		HeightPx:           input.HeightPx,
	}
	if service.storage.Store != nil {
		record.Backend = attachmentBackendB2
		record.ObjectKey = attachmentObjectKey(access.TenantID, record.ID)
		putContext, cancel := context.WithTimeout(ctx, attachmentObjectTimeout)
		err := service.storage.Store.Put(
			putContext, record.ObjectKey, bytes.NewReader(input.Content),
			record.SizeBytes, record.MediaType,
		)
		cancel()
		if err != nil {
			return AttachmentUploadResult{}, fmt.Errorf("store conversation attachment object: %w", err)
		}
	} else {
		record.Backend = attachmentBackendInline
		record.InlineBytes = input.Content
	}

	item, created, expiredKeys, err := service.repository.CreateAttachment(
		ctx, access, conversationID, record,
	)
	service.deleteAttachmentObjects(ctx, expiredKeys)
	if err != nil || !created {
		if record.Backend == attachmentBackendB2 {
			service.deleteAttachmentObjects(ctx, []string{record.ObjectKey})
		}
	}
	if err != nil {
		return AttachmentUploadResult{}, err
	}
	return AttachmentUploadResult{Attachment: item, Created: created}, nil
}

func (service *Service) ReadAttachmentContent(
	ctx context.Context,
	access AccessContext,
	conversationID, attachmentID uuid.UUID,
) (AttachmentContent, error) {
	if service == nil {
		return AttachmentContent{}, fmt.Errorf("read attachment: service is unavailable")
	}
	if !validAccess(access) {
		return AttachmentContent{}, ErrAccessDenied
	}
	if conversationID == uuid.Nil || attachmentID == uuid.Nil {
		return AttachmentContent{}, ErrNotFound
	}
	stored, err := service.repository.ReadAttachment(ctx, access, conversationID, attachmentID)
	if err != nil {
		return AttachmentContent{}, err
	}
	switch stored.Backend {
	case attachmentBackendInline:
		return AttachmentContent{
			Attachment: stored.Attachment,
			Body:       io.NopCloser(bytes.NewReader(stored.InlineBytes)),
		}, nil
	case attachmentBackendB2:
		if service.storage.Store == nil {
			return AttachmentContent{}, ErrAttachmentsUnavailable
		}
		object, err := service.storage.Store.Get(ctx, stored.ObjectKey)
		if err != nil {
			return AttachmentContent{}, fmt.Errorf("read conversation attachment object: %w", err)
		}
		if object.ContentLength >= 0 && object.ContentLength != stored.Attachment.SizeBytes {
			_ = object.Body.Close()
			return AttachmentContent{}, fmt.Errorf("conversation attachment object size mismatch")
		}
		return AttachmentContent{Attachment: stored.Attachment, Body: object.Body}, nil
	default:
		return AttachmentContent{}, fmt.Errorf("unsupported conversation attachment backend")
	}
}

// deleteAttachmentObjects is best effort: a failed delete leaves an
// unreachable opaque object (its row is already tombstoned), never a leak of
// readable content through the API.
func (service *Service) deleteAttachmentObjects(ctx context.Context, keys []string) {
	if service.storage.Store == nil || len(keys) == 0 {
		return
	}
	deleteContext, cancel := context.WithTimeout(
		context.WithoutCancel(ctx), attachmentObjectTimeout,
	)
	defer cancel()
	for _, key := range keys {
		if key == "" {
			continue
		}
		_ = service.storage.Store.Delete(deleteContext, key)
	}
}
