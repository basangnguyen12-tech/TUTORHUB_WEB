package collaboration

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
)

// ROOM-TOOLS-CODE-02A (ADR-0043 §4 Slice 2): the shared classroom code
// workspace control plane. It mirrors the whiteboard lifecycle authority but
// keeps separate tables, a typed `code.workspace.v1` document kind and
// temporary per-actor edit grants addressed only by opaque participant keys.

const (
	CodeWorkspaceMaxActiveEditors   = 3
	CodeWorkspaceDefaultEditorTTL   = 10 * time.Minute
	CodeWorkspaceMinimumEditorTTL   = 60 * time.Second
	CodeWorkspaceMaximumEditorTTL   = 30 * time.Minute
	codeWorkspaceMaximumGrantResult = 50
)

var (
	ErrFeatureDisabled        = errors.New("collaboration feature disabled")
	ErrEditorLimitReached     = errors.New("code workspace editor limit reached")
	ErrGrantTargetIneligible  = errors.New("code workspace grant target ineligible")
	errCodeWorkspaceNoRoomRun = errors.New("code workspace has no active room instance")
)

type CodeWorkspaceViewerCapabilities struct {
	Capability            Capability `json:"capability"`
	CanOpen               bool       `json:"can_open"`
	CanSuspend            bool       `json:"can_suspend"`
	CanResume             bool       `json:"can_resume"`
	CanClose              bool       `json:"can_close"`
	CanManageEditorGrants bool       `json:"can_manage_editor_grants"`
	CanExchangeGrant      bool       `json:"can_exchange_grant"`
}

type CodeWorkspace struct {
	ID                uuid.UUID                       `json:"id"`
	MediaSpaceID      uuid.UUID                       `json:"media_space_id"`
	Status            DocumentStatus                  `json:"status"`
	Version           int64                           `json:"version"`
	CurrentGeneration int64                           `json:"current_generation"`
	RevokeGeneration  int64                           `json:"revoke_generation"`
	Viewer            CodeWorkspaceViewerCapabilities `json:"viewer_capabilities"`
	CreatedAt         time.Time                       `json:"created_at"`
	UpdatedAt         time.Time                       `json:"updated_at"`
}

// CodeWorkspaceEditorGrant is the only public projection of a temporary edit
// grant. The participant key is RoomInstance-scoped; user and session
// identifiers are never projected.
type CodeWorkspaceEditorGrant struct {
	ParticipantKey uuid.UUID `json:"participant_key"`
	ExpiresAt      time.Time `json:"expires_at"`
}

type CodeWorkspaceProjection struct {
	Workspace          *CodeWorkspace             `json:"workspace"`
	CanCreate          bool                       `json:"can_create"`
	ActiveEditorGrants []CodeWorkspaceEditorGrant `json:"active_editor_grants"`
}

type CodeWorkspaceCreateCommand struct {
	WorkspaceID          uuid.UUID
	MediaSpaceID         uuid.UUID
	ProviderDocumentName string
	IdempotencyKey       string
	Fingerprint          []byte
	OccurredAt           time.Time
}

type CodeWorkspaceCreateResult struct {
	Workspace CodeWorkspace
	Created   bool
}

// CodeWorkspaceViewerState is the server-only dynamic authority of one actor
// inside the active RoomInstance: a promoted co-host, a live participant
// session and an unexpired temporary edit grant.
type CodeWorkspaceViewerState struct {
	DynamicCoHost     bool
	ActiveParticipant bool
	ActiveEditGrant   bool
}

type CodeWorkspaceEditorGrantInput struct {
	TTLSeconds *int64
}

type CodeWorkspaceEditorGrantCommand struct {
	WorkspaceID    uuid.UUID
	MediaSpaceID   uuid.UUID
	RoomInstanceID uuid.UUID
	ParticipantKey uuid.UUID
	TTL            time.Duration
	OccurredAt     time.Time
}

type CodeWorkspaceEditorGrantResult struct {
	Grant         CodeWorkspaceEditorGrant
	ActorID       uuid.UUID
	RevokedActors []uuid.UUID
}

type CodeWorkspaceEditorRevokeCommand struct {
	WorkspaceID    uuid.UUID
	MediaSpaceID   uuid.UUID
	RoomInstanceID uuid.UUID
	ParticipantKey uuid.UUID
	OccurredAt     time.Time
}

type CodeWorkspaceEditorRevokeResult struct {
	ActorID uuid.UUID
	Revoked bool
}

type CodeWorkspaceRepository interface {
	Create(context.Context, AccessContext, CodeWorkspaceCreateCommand) (CodeWorkspaceCreateResult, error)
	Get(context.Context, AccessContext, uuid.UUID) (CodeWorkspace, error)
	GetByMediaSpace(context.Context, AccessContext, uuid.UUID) (CodeWorkspace, error)
	GrantAuthority(context.Context, AccessContext, uuid.UUID) (GrantAuthority, error)
	Transition(context.Context, AccessContext, TransitionCommand) (CodeWorkspace, error)
	ViewerState(context.Context, AccessContext, uuid.UUID, uuid.UUID, uuid.UUID) (CodeWorkspaceViewerState, error)
	ActiveEditorGrants(context.Context, AccessContext, uuid.UUID, uuid.UUID, uuid.UUID) ([]CodeWorkspaceEditorGrant, error)
	PutEditorGrant(context.Context, AccessContext, CodeWorkspaceEditorGrantCommand) (CodeWorkspaceEditorGrantResult, error)
	RevokeEditorGrant(context.Context, AccessContext, CodeWorkspaceEditorRevokeCommand) (CodeWorkspaceEditorRevokeResult, error)
}

// CodeWorkspaceGrantBroker is the shared one-time grant broker extended with
// tenant- and actor-scoped lease invalidation.
type CodeWorkspaceGrantBroker interface {
	GrantBroker
	RevokeTenantDocument(tenantID, documentID uuid.UUID)
	RevokeActor(tenantID, documentID, actorID uuid.UUID)
}

type CodeWorkspaceServiceAPI interface {
	Resolve(context.Context, AccessContext, uuid.UUID) (CodeWorkspaceProjection, error)
	Create(context.Context, AccessContext, CreateInput) (CodeWorkspaceCreateResult, error)
	Get(context.Context, AccessContext, uuid.UUID) (CodeWorkspace, error)
	Open(context.Context, AccessContext, uuid.UUID, TransitionInput) (CodeWorkspace, error)
	Suspend(context.Context, AccessContext, uuid.UUID, TransitionInput) (CodeWorkspace, error)
	Resume(context.Context, AccessContext, uuid.UUID, TransitionInput) (CodeWorkspace, error)
	Close(context.Context, AccessContext, uuid.UUID, TransitionInput) (CodeWorkspace, error)
	ExchangeGrant(context.Context, AccessContext, uuid.UUID, GrantExchangeInput) (GrantCredential, error)
	PutEditorGrant(context.Context, AccessContext, uuid.UUID, uuid.UUID, CodeWorkspaceEditorGrantInput) (CodeWorkspaceEditorGrant, error)
	RevokeEditorGrant(context.Context, AccessContext, uuid.UUID, uuid.UUID) error
}
