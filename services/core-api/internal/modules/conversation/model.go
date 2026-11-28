package conversation

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/tutorhub-v2/core-api/internal/policy"
)

const (
	KindDirect Kind = "direct"
	KindClass  Kind = "class"
	KindRoom   Kind = "room"

	defaultListLimit    = 30
	maximumListLimit    = 100
	maximumCursorLength = 1024
)

var (
	ErrInvalidInput        = errors.New("invalid conversation input")
	ErrAccessDenied        = errors.New("conversation access denied")
	ErrNotFound            = errors.New("conversation not found")
	ErrUnavailable         = errors.New("conversation target unavailable")
	ErrReadOnly            = errors.New("conversation is read only")
	ErrIdempotencyConflict = errors.New("message idempotency conflict")
	ErrVersionConflict     = errors.New("message version conflict")
	// ErrMessageNotEditable rejects edits of server-authored card messages.
	ErrMessageNotEditable = errors.New("message is not editable")
	// ErrEmbedUnavailable conceals why a contact card or instant class cannot
	// be shared or opened (unknown, not visible, not owned, ended).
	ErrEmbedUnavailable = errors.New("message embed unavailable")
)

type Kind string

type AccessContext struct {
	TenantID          uuid.UUID
	ActorID           uuid.UUID
	MembershipActive  bool
	OrganizationRoles []policy.OrganizationRole
}

type Participant struct {
	UserID      uuid.UUID `json:"user_id"`
	DisplayName string    `json:"display_name"`
}

type ViewerAccess struct {
	CanPostMessages bool `json:"can_post_messages"`
	// CanModerateChat is true only on an open room conversation for the class
	// teacher/owner/organization admin, the StudyMeeting owner, or a live
	// host/co-host of the active RoomInstance (ADR-0042).
	CanModerateChat bool `json:"can_moderate_chat"`
	// CanUploadAttachments requires current posting authority on the
	// conversation and a configured attachment data plane.
	CanUploadAttachments bool `json:"can_upload_attachments"`
}

type Conversation struct {
	ID               uuid.UUID     `json:"id"`
	TenantID         uuid.UUID     `json:"-"`
	Kind             Kind          `json:"kind"`
	ClassID          *uuid.UUID    `json:"class_id,omitempty"`
	ClassStatus      *string       `json:"class_status,omitempty"`
	MediaSpaceID     *uuid.UUID    `json:"media_space_id,omitempty"`
	MediaSpaceStatus *string       `json:"media_space_status,omitempty"`
	Title            string        `json:"title"`
	Participants     []Participant `json:"participants"`
	ViewerAccess     ViewerAccess  `json:"viewer_access"`
	// ParticipantChatEnabled is the room host posting switch; it is always
	// true for direct and class conversations.
	ParticipantChatEnabled bool      `json:"participant_chat_enabled"`
	UnreadCount            int       `json:"unread_count"`
	UnreadCountCapped      bool      `json:"unread_count_capped"`
	CreatedAt              time.Time `json:"created_at"`
	UpdatedAt              time.Time `json:"updated_at"`

	// roomSourceModerator records durable source moderation authority found
	// while projecting a room row; it is never serialized.
	roomSourceModerator bool
}

type ListInput struct {
	Kind   *Kind
	Limit  int
	Cursor string
}

type Page struct {
	Items      []Conversation `json:"items"`
	NextCursor string         `json:"next_cursor,omitempty"`
}

type CreateResult struct {
	Conversation Conversation
	Created      bool
}

type ServiceAPI interface {
	List(context.Context, AccessContext, ListInput) (Page, error)
	Get(context.Context, AccessContext, uuid.UUID) (Conversation, error)
	CreateDirect(context.Context, AccessContext, string) (CreateResult, error)
	CreateDirectFromContactCard(context.Context, AccessContext, uuid.UUID) (CreateResult, error)
	CreateClass(context.Context, AccessContext, uuid.UUID) (CreateResult, error)
	CreateRoom(context.Context, AccessContext, uuid.UUID) (CreateResult, error)
	ListMessages(context.Context, AccessContext, uuid.UUID, MessageListInput) (MessagePage, error)
	SendMessage(context.Context, AccessContext, uuid.UUID, SendMessageInput) (MessageMutationResult, error)
	EditMessage(context.Context, AccessContext, uuid.UUID, uuid.UUID, EditMessageInput) (Message, error)
	DeleteMessage(context.Context, AccessContext, uuid.UUID, uuid.UUID, DeleteMessageInput) (Message, error)
	MarkRead(context.Context, AccessContext, uuid.UUID, uuid.UUID) (MessageReadState, error)
	UpdateRoomSettings(context.Context, AccessContext, uuid.UUID, RoomSettingsInput) (Conversation, error)
	UploadAttachment(context.Context, AccessContext, uuid.UUID, UploadAttachmentInput) (AttachmentUploadResult, error)
	ReadAttachmentContent(context.Context, AccessContext, uuid.UUID, uuid.UUID) (AttachmentContent, error)
}
