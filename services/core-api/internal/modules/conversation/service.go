package conversation

import (
	"context"
	"fmt"
	"net/mail"
	"strings"

	"github.com/google/uuid"
)

type Service struct {
	repository Repository
	storage    AttachmentStorage
}

// ServiceOption configures optional conversation capabilities.
type ServiceOption func(*Service)

// WithAttachmentStorage enables ADR-0042 chat attachments. Without it every
// conversation reports can_upload_attachments=false and uploads return 503.
func WithAttachmentStorage(storage AttachmentStorage) ServiceOption {
	return func(service *Service) {
		service.storage = storage
	}
}

func NewService(repository Repository, options ...ServiceOption) (*Service, error) {
	if repository == nil {
		return nil, fmt.Errorf("conversation repository is required")
	}
	service := &Service{repository: repository}
	for _, option := range options {
		if option != nil {
			option(service)
		}
	}
	return service, nil
}

func (service *Service) List(
	ctx context.Context,
	access AccessContext,
	input ListInput,
) (Page, error) {
	if service == nil {
		return Page{}, fmt.Errorf("list conversations: service is unavailable")
	}
	if !validAccess(access) {
		return Page{}, ErrAccessDenied
	}
	input.Cursor = strings.TrimSpace(input.Cursor)
	if input.Limit == 0 {
		input.Limit = defaultListLimit
	}
	if input.Limit < 1 || input.Limit > maximumListLimit {
		return Page{}, ErrInvalidInput
	}
	if input.Kind != nil {
		kind := Kind(strings.ToLower(strings.TrimSpace(string(*input.Kind))))
		if !validKind(kind) {
			return Page{}, ErrInvalidInput
		}
		input.Kind = &kind
	}
	cursor, err := decodeCursor(access.TenantID, input)
	if err != nil {
		return Page{}, err
	}
	items, hasMore, err := service.repository.List(ctx, access, input, cursor)
	if err != nil {
		return Page{}, err
	}
	page := Page{Items: service.decorateConversations(items)}
	if page.Items == nil {
		page.Items = []Conversation{}
	}
	if hasMore && len(items) > 0 {
		page.NextCursor, err = encodeCursor(
			access.TenantID,
			input,
			listCursor{UpdatedAt: items[len(items)-1].UpdatedAt, ID: items[len(items)-1].ID},
		)
		if err != nil {
			return Page{}, err
		}
	}
	return page, nil
}

func (service *Service) Get(
	ctx context.Context,
	access AccessContext,
	conversationID uuid.UUID,
) (Conversation, error) {
	if service == nil {
		return Conversation{}, fmt.Errorf("get conversation: service is unavailable")
	}
	if !validAccess(access) {
		return Conversation{}, ErrAccessDenied
	}
	if conversationID == uuid.Nil {
		return Conversation{}, ErrNotFound
	}
	item, err := service.repository.Get(ctx, access, conversationID)
	if err != nil {
		return Conversation{}, err
	}
	return service.decorateConversation(item), nil
}

func (service *Service) CreateDirect(
	ctx context.Context,
	access AccessContext,
	targetMemberEmail string,
) (CreateResult, error) {
	if service == nil {
		return CreateResult{}, fmt.Errorf("create direct conversation: service is unavailable")
	}
	if !validAccess(access) {
		return CreateResult{}, ErrAccessDenied
	}
	email, err := normalizeMemberEmail(targetMemberEmail)
	if err != nil {
		return CreateResult{}, err
	}
	return service.decorateCreateResult(
		service.repository.CreateDirect(ctx, access, email),
	)
}

func (service *Service) CreateClass(
	ctx context.Context,
	access AccessContext,
	classID uuid.UUID,
) (CreateResult, error) {
	if service == nil {
		return CreateResult{}, fmt.Errorf("create class conversation: service is unavailable")
	}
	if !validAccess(access) {
		return CreateResult{}, ErrAccessDenied
	}
	if classID == uuid.Nil {
		return CreateResult{}, ErrNotFound
	}
	return service.decorateCreateResult(
		service.repository.CreateClass(ctx, access, classID),
	)
}

func (service *Service) CreateRoom(
	ctx context.Context,
	access AccessContext,
	mediaSpaceID uuid.UUID,
) (CreateResult, error) {
	if service == nil {
		return CreateResult{}, fmt.Errorf("create room conversation: service is unavailable")
	}
	if !validAccess(access) {
		return CreateResult{}, ErrAccessDenied
	}
	if mediaSpaceID == uuid.Nil {
		return CreateResult{}, ErrNotFound
	}
	return service.decorateCreateResult(
		service.repository.CreateRoom(ctx, access, mediaSpaceID),
	)
}

// decorateConversation applies service-level capabilities the repository
// cannot know, such as whether an attachment data plane exists.
func (service *Service) decorateConversation(item Conversation) Conversation {
	item.ViewerAccess.CanUploadAttachments = item.Kind == KindRoom &&
		item.ViewerAccess.CanPostMessages && service.storage.available()
	return item
}

func (service *Service) decorateConversations(items []Conversation) []Conversation {
	for index := range items {
		items[index] = service.decorateConversation(items[index])
	}
	return items
}

func (service *Service) decorateCreateResult(result CreateResult, err error) (CreateResult, error) {
	if err != nil {
		return CreateResult{}, err
	}
	result.Conversation = service.decorateConversation(result.Conversation)
	return result, nil
}

func validAccess(access AccessContext) bool {
	return access.TenantID != uuid.Nil && access.ActorID != uuid.Nil &&
		access.MembershipActive && len(access.OrganizationRoles) > 0
}

func validKind(kind Kind) bool {
	return kind == KindDirect || kind == KindClass || kind == KindRoom
}

func normalizeMemberEmail(value string) (string, error) {
	value = strings.ToLower(strings.TrimSpace(value))
	address, err := mail.ParseAddress(value)
	if err != nil || address.Address != value || len(value) < 3 || len(value) > 320 {
		return "", ErrInvalidInput
	}
	return value, nil
}
