package conversation

import (
	"time"

	"github.com/google/uuid"
)

const (
	MessageStateActive  MessageState = "active"
	MessageStateDeleted MessageState = "deleted"

	defaultMessageListLimit    = 50
	maximumMessageListLimit    = 100
	maximumMessageCursorLength = 1024
	maximumMessageCharacters   = 4000
	maximumMessageBytes        = 16 * 1024
	maximumUnreadCount         = 100
	actorMessageRateLimit      = 60
)

type MessageState string

type MessageAuthor struct {
	UserID      uuid.UUID `json:"user_id"`
	DisplayName string    `json:"display_name"`
}

type Message struct {
	ID              uuid.UUID     `json:"id"`
	ConversationID  uuid.UUID     `json:"conversation_id"`
	Sequence        int64         `json:"sequence"`
	ClientMessageID uuid.UUID     `json:"client_message_id"`
	Author          MessageAuthor `json:"author"`
	Content         *string       `json:"content,omitempty"`
	State           MessageState  `json:"state"`
	Version         int64         `json:"version"`
	CreatedAt       time.Time     `json:"created_at"`
	UpdatedAt       time.Time     `json:"updated_at"`
	EditedAt        *time.Time    `json:"edited_at,omitempty"`
	DeletedAt       *time.Time    `json:"deleted_at,omitempty"`
	// Attachments is non-nil (possibly empty) for active messages and nil for
	// tombstones, whose public projection never exposes attachments.
	Attachments *[]MessageAttachment `json:"attachments,omitempty"`
	// Embed is the reader-specific projection of a server-authored card on an
	// active message; tombstones never expose it.
	Embed *MessageEmbed `json:"embed,omitempty"`
}

// EmbedKind names a server-authored card (MSG-COMPOSER-TOOLS-01).
type EmbedKind string

const (
	EmbedKindContactCard  EmbedKind = "contact_card"
	EmbedKindInstantClass EmbedKind = "instant_class"
)

// MessageEmbedInput is the card a sender asks the server to attach; exactly
// one identifier is set for its kind.
type MessageEmbedInput struct {
	Kind         EmbedKind
	UserID       uuid.UUID
	MediaSpaceID uuid.UUID
}

// MessageEmbed is resolved for each reader at read time. A contact card
// exposes only the member's display name and ID, and only while the member
// is still active; an instant class exposes its title, window and status.
type MessageEmbed struct {
	Kind EmbedKind `json:"kind"`
	// contact_card
	Available   *bool      `json:"available,omitempty"`
	UserID      *uuid.UUID `json:"user_id,omitempty"`
	DisplayName *string    `json:"display_name,omitempty"`
	// instant_class
	MediaSpaceID     *uuid.UUID `json:"media_space_id,omitempty"`
	Title            *string    `json:"title,omitempty"`
	Status           *string    `json:"status,omitempty"`
	EndsAt           *time.Time `json:"ends_at,omitempty"`
	RemainingSeconds *int64     `json:"remaining_seconds,omitempty"`
	ViewerCanJoin    *bool      `json:"viewer_can_join,omitempty"`
}

type MessageListInput struct {
	Limit  int
	Cursor string
}

type MessageReadState struct {
	LastReadMessageID uuid.UUID `json:"last_read_message_id"`
	LastReadSequence  int64     `json:"last_read_sequence"`
	UpdatedAt         time.Time `json:"updated_at"`
}

type MessagePage struct {
	Items             []Message         `json:"items"`
	NextCursor        string            `json:"next_cursor,omitempty"`
	UnreadCount       int               `json:"unread_count"`
	UnreadCountCapped bool              `json:"unread_count_capped"`
	ReadState         *MessageReadState `json:"read_state"`
}

type SendMessageInput struct {
	ClientMessageID uuid.UUID
	Content         string
	// AttachmentIDs are staged uploads owned by the actor in this
	// conversation; content may be empty only when at least one is present.
	AttachmentIDs []uuid.UUID
	// Embed is a server-validated card; such a message has empty content and
	// no attachments.
	Embed *MessageEmbedInput
}

type EditMessageInput struct {
	Content         string
	ExpectedVersion int64
}

type DeleteMessageInput struct {
	ExpectedVersion int64
}

type MessageMutationResult struct {
	Message Message
	Created bool
}

type messageRepositoryPage struct {
	Items             []Message
	HasMore           bool
	UnreadCount       int
	UnreadCountCapped bool
	ReadState         *MessageReadState
}
