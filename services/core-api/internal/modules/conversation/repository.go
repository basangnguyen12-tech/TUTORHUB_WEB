package conversation

import (
	"context"

	"github.com/google/uuid"
)

type Repository interface {
	List(context.Context, AccessContext, ListInput, listCursor) ([]Conversation, bool, error)
	Get(context.Context, AccessContext, uuid.UUID) (Conversation, error)
	CreateDirect(context.Context, AccessContext, string) (CreateResult, error)
	CreateDirectFromContactCard(context.Context, AccessContext, uuid.UUID) (CreateResult, error)
	CreateClass(context.Context, AccessContext, uuid.UUID) (CreateResult, error)
	CreateRoom(context.Context, AccessContext, uuid.UUID) (CreateResult, error)
	ListMessages(context.Context, AccessContext, uuid.UUID, MessageListInput, messageCursor) (messageRepositoryPage, error)
	SendMessage(context.Context, AccessContext, uuid.UUID, SendMessageInput) (MessageMutationResult, error)
	EditMessage(context.Context, AccessContext, uuid.UUID, uuid.UUID, EditMessageInput) (Message, error)
	// DeleteMessage also returns object-storage keys of attachments that were
	// tombstoned in the same transaction, for best-effort deletion after commit.
	DeleteMessage(context.Context, AccessContext, uuid.UUID, uuid.UUID, DeleteMessageInput) (Message, []string, error)
	MarkRead(context.Context, AccessContext, uuid.UUID, uuid.UUID) (MessageReadState, error)
	UpdateRoomSettings(context.Context, AccessContext, uuid.UUID, RoomSettingsInput) (Conversation, error)
	FindAttachmentReplay(context.Context, AccessContext, uuid.UUID, uuid.UUID, []byte) (MessageAttachment, bool, error)
	CreateAttachment(context.Context, AccessContext, uuid.UUID, attachmentRecord) (MessageAttachment, bool, []string, error)
	ReadAttachment(context.Context, AccessContext, uuid.UUID, uuid.UUID) (storedAttachment, error)
}
