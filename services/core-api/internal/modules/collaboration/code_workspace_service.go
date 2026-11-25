package collaboration

import (
	"context"
	"crypto/sha256"
	"errors"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/tutorhub-v2/core-api/internal/modules/media"
	"github.com/tutorhub-v2/core-api/internal/policy"
)

// CodeWorkspaceService is the server authority for the shared classroom code
// workspace. Every capability is re-derived from the current MediaSpace,
// the active RoomInstance and the temporary edit grants; the browser never
// decides who may write.
type CodeWorkspaceService struct {
	repository  CodeWorkspaceRepository
	spaces      SpaceAuthority
	grants      CodeWorkspaceGrantBroker
	clock       func() time.Time
	newID       func() uuid.UUID
	runtimeMode RuntimeMode
}

type codeWorkspaceViewer struct {
	audience Audience
	manage   bool
	roomID   uuid.UUID
	state    CodeWorkspaceViewerState
}

func NewCodeWorkspaceService(
	repository CodeWorkspaceRepository,
	spaces SpaceAuthority,
	grants CodeWorkspaceGrantBroker,
	configs ...ServiceConfig,
) (*CodeWorkspaceService, error) {
	if repository == nil || spaces == nil {
		return nil, ErrUnavailable
	}
	config := ServiceConfig{Clock: time.Now, NewID: uuid.New, RuntimeMode: RuntimeModeEnabled}
	if len(configs) > 0 {
		if configs[0].Clock != nil {
			config.Clock = configs[0].Clock
		}
		if configs[0].NewID != nil {
			config.NewID = configs[0].NewID
		}
		if configs[0].RuntimeMode != "" {
			config.RuntimeMode = configs[0].RuntimeMode
		}
	}
	if config.RuntimeMode != RuntimeModeEnabled && config.RuntimeMode != RuntimeModeReadOnly &&
		config.RuntimeMode != RuntimeModeOff {
		return nil, ErrUnavailable
	}
	return &CodeWorkspaceService{
		repository: repository, spaces: spaces, grants: grants,
		clock: config.Clock, newID: config.NewID, runtimeMode: config.RuntimeMode,
	}, nil
}

func (service *CodeWorkspaceService) Resolve(
	ctx context.Context,
	access AccessContext,
	mediaSpaceID uuid.UUID,
) (CodeWorkspaceProjection, error) {
	if err := service.requireReadable(); err != nil {
		return CodeWorkspaceProjection{}, err
	}
	if !validAccess(access) || mediaSpaceID == uuid.Nil {
		return CodeWorkspaceProjection{}, ErrInvalidRequest
	}
	space, err := service.authorizeSpace(ctx, access, mediaSpaceID)
	if err != nil {
		return CodeWorkspaceProjection{}, err
	}
	workspace, err := service.repository.GetByMediaSpace(ctx, access, mediaSpaceID)
	if err != nil {
		if !errors.Is(err, ErrNotFound) {
			return CodeWorkspaceProjection{}, normalizeCodeConcealedError(err)
		}
		viewer, viewerErr := service.viewer(ctx, access, space, uuid.Nil)
		if viewerErr != nil {
			return CodeWorkspaceProjection{}, viewerErr
		}
		return CodeWorkspaceProjection{
			CanCreate:          service.runtimeMode == RuntimeModeEnabled && viewer.manage,
			ActiveEditorGrants: []CodeWorkspaceEditorGrant{},
		}, nil
	}
	projected, viewer, err := service.project(ctx, access, space, workspace)
	if err != nil {
		return CodeWorkspaceProjection{}, err
	}
	grants := []CodeWorkspaceEditorGrant{}
	if viewer.roomID != uuid.Nil && workspace.Status == DocumentOpen {
		grants, err = service.repository.ActiveEditorGrants(ctx, access, workspace.ID, space.ID, viewer.roomID)
		if err != nil {
			return CodeWorkspaceProjection{}, normalizeCodeConcealedError(err)
		}
		if grants == nil {
			grants = []CodeWorkspaceEditorGrant{}
		}
	}
	return CodeWorkspaceProjection{Workspace: &projected, ActiveEditorGrants: grants}, nil
}

func (service *CodeWorkspaceService) Create(
	ctx context.Context,
	access AccessContext,
	input CreateInput,
) (CodeWorkspaceCreateResult, error) {
	if err := service.requireWritable(); err != nil {
		return CodeWorkspaceCreateResult{}, err
	}
	input.IdempotencyKey = strings.TrimSpace(input.IdempotencyKey)
	if !validAccess(access) || input.MediaSpaceID == uuid.Nil ||
		!idempotencyPattern.MatchString(input.IdempotencyKey) {
		return CodeWorkspaceCreateResult{}, ErrInvalidRequest
	}
	space, err := service.authorizeSpace(ctx, access, input.MediaSpaceID)
	if err != nil {
		return CodeWorkspaceCreateResult{}, err
	}
	viewer, err := service.viewer(ctx, access, space, uuid.Nil)
	if err != nil {
		return CodeWorkspaceCreateResult{}, err
	}
	if !viewer.manage {
		return CodeWorkspaceCreateResult{}, ErrNotFound
	}
	workspaceID := service.newID()
	result, err := service.repository.Create(ctx, access, CodeWorkspaceCreateCommand{
		WorkspaceID: workspaceID, MediaSpaceID: space.ID,
		ProviderDocumentName: opaqueCodeWorkspaceProviderName(workspaceID),
		IdempotencyKey:       input.IdempotencyKey,
		Fingerprint:          codeWorkspaceCreateFingerprint(input),
		OccurredAt:           service.clock().UTC(),
	})
	if err != nil {
		return CodeWorkspaceCreateResult{}, normalizeCodeError(err)
	}
	result.Workspace, _, err = service.project(ctx, access, space, result.Workspace)
	if err != nil {
		return CodeWorkspaceCreateResult{}, err
	}
	return result, nil
}

func (service *CodeWorkspaceService) Get(
	ctx context.Context,
	access AccessContext,
	workspaceID uuid.UUID,
) (CodeWorkspace, error) {
	if err := service.requireReadable(); err != nil {
		return CodeWorkspace{}, err
	}
	workspace, space, err := service.authorizedWorkspace(ctx, access, workspaceID)
	if err != nil {
		return CodeWorkspace{}, err
	}
	projected, _, err := service.project(ctx, access, space, workspace)
	return projected, err
}

func (service *CodeWorkspaceService) Open(ctx context.Context, access AccessContext, id uuid.UUID, input TransitionInput) (CodeWorkspace, error) {
	return service.transition(ctx, access, id, "open", input)
}

func (service *CodeWorkspaceService) Suspend(ctx context.Context, access AccessContext, id uuid.UUID, input TransitionInput) (CodeWorkspace, error) {
	return service.transition(ctx, access, id, "suspend", input)
}

func (service *CodeWorkspaceService) Resume(ctx context.Context, access AccessContext, id uuid.UUID, input TransitionInput) (CodeWorkspace, error) {
	return service.transition(ctx, access, id, "resume", input)
}

func (service *CodeWorkspaceService) Close(ctx context.Context, access AccessContext, id uuid.UUID, input TransitionInput) (CodeWorkspace, error) {
	return service.transition(ctx, access, id, "close", input)
}

func (service *CodeWorkspaceService) transition(
	ctx context.Context,
	access AccessContext,
	workspaceID uuid.UUID,
	operation string,
	input TransitionInput,
) (CodeWorkspace, error) {
	if err := service.requireWritable(); err != nil {
		return CodeWorkspace{}, err
	}
	input.IdempotencyKey = strings.TrimSpace(input.IdempotencyKey)
	if workspaceID == uuid.Nil || input.ExpectedVersion < 1 ||
		!idempotencyPattern.MatchString(input.IdempotencyKey) {
		return CodeWorkspace{}, ErrInvalidRequest
	}
	workspace, space, err := service.authorizedWorkspace(ctx, access, workspaceID)
	if err != nil {
		return CodeWorkspace{}, err
	}
	viewer, err := service.viewer(ctx, access, space, workspace.ID)
	if err != nil {
		return CodeWorkspace{}, err
	}
	if !viewer.manage {
		return CodeWorkspace{}, ErrNotFound
	}
	updated, err := service.repository.Transition(ctx, access, TransitionCommand{
		DocumentID: workspace.ID, Operation: operation, ExpectedVersion: input.ExpectedVersion,
		IdempotencyKey: input.IdempotencyKey,
		Fingerprint:    codeWorkspaceTransitionFingerprint(operation, workspace.ID, input.ExpectedVersion),
		OccurredAt:     service.clock().UTC(),
	})
	if err != nil {
		return CodeWorkspace{}, normalizeCodeError(err)
	}
	if service.grants != nil && (operation == "suspend" || operation == "close") {
		service.grants.RevokeTenantDocument(access.TenantID, workspace.ID)
	}
	projected, _, err := service.project(ctx, access, space, updated)
	return projected, err
}

func (service *CodeWorkspaceService) ExchangeGrant(
	ctx context.Context,
	access AccessContext,
	workspaceID uuid.UUID,
	input GrantExchangeInput,
) (GrantCredential, error) {
	if err := service.requireReadable(); err != nil {
		return GrantCredential{}, err
	}
	if service.runtimeMode == RuntimeModeReadOnly {
		input.Capability = CapabilityView
	}
	if !validCapability(input.Capability) || input.ExpectedGeneration < 1 ||
		input.ExpectedRevokeGeneration < 1 || !validOrigin(input.Origin) {
		return GrantCredential{}, ErrInvalidRequest
	}
	workspace, space, err := service.authorizedWorkspace(ctx, access, workspaceID)
	if err != nil {
		return GrantCredential{}, err
	}
	projected, _, err := service.project(ctx, access, space, workspace)
	if err != nil {
		return GrantCredential{}, err
	}
	if workspace.CurrentGeneration != input.ExpectedGeneration ||
		workspace.RevokeGeneration != input.ExpectedRevokeGeneration {
		return GrantCredential{}, ErrVersionConflict
	}
	if !projected.Viewer.CanExchangeGrant ||
		capabilityRank(input.Capability) > capabilityRank(projected.Viewer.Capability) {
		return GrantCredential{}, ErrNotFound
	}
	if service.grants == nil {
		return GrantCredential{}, ErrGrantUnavailable
	}
	authority, err := service.repository.GrantAuthority(ctx, access, workspace.ID)
	if err != nil {
		return GrantCredential{}, normalizeCodeConcealedError(err)
	}
	if authority.Document.Status != DocumentOpen ||
		authority.DocumentKind != DocumentKindCodeWorkspace ||
		authority.Document.CurrentGeneration != input.ExpectedGeneration ||
		authority.Document.RevokeGeneration != input.ExpectedRevokeGeneration ||
		authority.Document.MediaSpaceID != workspace.MediaSpaceID ||
		authority.WriterFence < 1 ||
		!providerNameMatchesKind(authority.ProviderDocumentName, DocumentKindCodeWorkspace) {
		return GrantCredential{}, ErrVersionConflict
	}
	credential, err := service.grants.Issue(ctx, access, authority, input.Capability, input)
	if err != nil {
		return GrantCredential{}, normalizeCodeError(err)
	}
	return credential, nil
}

func (service *CodeWorkspaceService) PutEditorGrant(
	ctx context.Context,
	access AccessContext,
	workspaceID uuid.UUID,
	participantKey uuid.UUID,
	input CodeWorkspaceEditorGrantInput,
) (CodeWorkspaceEditorGrant, error) {
	if err := service.requireWritable(); err != nil {
		return CodeWorkspaceEditorGrant{}, err
	}
	ttl := CodeWorkspaceDefaultEditorTTL
	if input.TTLSeconds != nil {
		seconds := *input.TTLSeconds
		if seconds < int64(CodeWorkspaceMinimumEditorTTL/time.Second) ||
			seconds > int64(CodeWorkspaceMaximumEditorTTL/time.Second) {
			return CodeWorkspaceEditorGrant{}, ErrInvalidRequest
		}
		ttl = time.Duration(seconds) * time.Second
	}
	if participantKey == uuid.Nil {
		return CodeWorkspaceEditorGrant{}, ErrInvalidRequest
	}
	workspace, space, viewer, err := service.managedWorkspace(ctx, access, workspaceID)
	if err != nil {
		return CodeWorkspaceEditorGrant{}, err
	}
	if workspace.Status != DocumentOpen || viewer.roomID == uuid.Nil {
		return CodeWorkspaceEditorGrant{}, ErrTransitionConflict
	}
	result, err := service.repository.PutEditorGrant(ctx, access, CodeWorkspaceEditorGrantCommand{
		WorkspaceID: workspace.ID, MediaSpaceID: space.ID, RoomInstanceID: viewer.roomID,
		ParticipantKey: participantKey, TTL: ttl, OccurredAt: service.clock().UTC(),
	})
	if err != nil {
		return CodeWorkspaceEditorGrant{}, normalizeCodeError(err)
	}
	if service.grants != nil {
		for _, actorID := range result.RevokedActors {
			service.grants.RevokeActor(access.TenantID, workspace.ID, actorID)
		}
	}
	return result.Grant, nil
}

func (service *CodeWorkspaceService) RevokeEditorGrant(
	ctx context.Context,
	access AccessContext,
	workspaceID uuid.UUID,
	participantKey uuid.UUID,
) error {
	if err := service.requireWritable(); err != nil {
		return err
	}
	if participantKey == uuid.Nil {
		return ErrInvalidRequest
	}
	workspace, space, viewer, err := service.managedWorkspace(ctx, access, workspaceID)
	if err != nil {
		return err
	}
	if viewer.roomID == uuid.Nil {
		return ErrNotFound
	}
	result, err := service.repository.RevokeEditorGrant(ctx, access, CodeWorkspaceEditorRevokeCommand{
		WorkspaceID: workspace.ID, MediaSpaceID: space.ID, RoomInstanceID: viewer.roomID,
		ParticipantKey: participantKey, OccurredAt: service.clock().UTC(),
	})
	if err != nil {
		return normalizeCodeError(err)
	}
	// The actor's existing provider leases are invalidated immediately so
	// the runtime closes an `edit` connection on its next revalidation and
	// the client reconnects with the downgraded `view` capability.
	if service.grants != nil && result.ActorID != uuid.Nil {
		service.grants.RevokeActor(access.TenantID, workspace.ID, result.ActorID)
	}
	return nil
}

func (service *CodeWorkspaceService) ConsumeGrant(
	ctx context.Context,
	input GrantConsumeInput,
) (GrantScope, error) {
	input.Credential = strings.TrimSpace(input.Credential)
	input.Origin = strings.TrimSpace(input.Origin)
	input.ProviderDocumentName = strings.TrimSpace(input.ProviderDocumentName)
	input.DocumentKind = DocumentKindCodeWorkspace
	if service.grants == nil || !validOrigin(input.Origin) || input.Credential == "" ||
		!providerNameMatchesKind(input.ProviderDocumentName, DocumentKindCodeWorkspace) {
		return GrantScope{}, ErrGrantDenied
	}
	resolution, err := service.grants.Consume(ctx, input)
	if err != nil {
		return GrantScope{}, normalizeCodeError(err)
	}
	if err := service.validateGrantResolution(ctx, resolution); err != nil {
		service.grants.InvalidateLease(resolution.Scope.AuthorityLease)
		return GrantScope{}, ErrGrantDenied
	}
	return resolution.Scope, nil
}

func (service *CodeWorkspaceService) ValidateGrant(
	ctx context.Context,
	input GrantValidationInput,
) (bool, error) {
	input.Origin = strings.TrimSpace(input.Origin)
	if service.grants == nil || !validOrigin(input.Origin) {
		return false, ErrGrantDenied
	}
	resolution, err := service.grants.Validate(ctx, input)
	if err != nil {
		return false, normalizeCodeError(err)
	}
	if err := service.validateGrantResolution(ctx, resolution); err != nil {
		service.grants.InvalidateLease(resolution.Scope.AuthorityLease)
		return false, nil
	}
	return true, nil
}

// validateGrantResolution re-derives the actor's current capability on every
// exchange and every runtime revalidation. An expired, revoked or orphaned
// (participant left) edit grant therefore downgrades fail-closed.
func (service *CodeWorkspaceService) validateGrantResolution(
	ctx context.Context,
	resolution GrantResolution,
) error {
	if kind, known := NormalizeDocumentKind(resolution.Scope.DocumentKind); !known ||
		kind != DocumentKindCodeWorkspace {
		return ErrGrantDenied
	}
	if !validAccess(resolution.Access) ||
		resolution.Scope.TenantID != resolution.Access.TenantID ||
		resolution.Scope.ActorID != resolution.Access.ActorID ||
		resolution.Scope.SessionID != resolution.Access.SessionID ||
		!validCapability(resolution.Scope.Capability) {
		return ErrGrantDenied
	}
	authority, err := service.repository.GrantAuthority(ctx, resolution.Access, resolution.Scope.DocumentID)
	if err != nil {
		return err
	}
	space, err := service.authorizeSpace(ctx, resolution.Access, authority.Document.MediaSpaceID)
	if err != nil {
		return err
	}
	workspace := CodeWorkspace{
		ID: authority.Document.ID, MediaSpaceID: authority.Document.MediaSpaceID,
		Status: authority.Document.Status, Version: authority.Document.Version,
		CurrentGeneration: authority.Document.CurrentGeneration,
		RevokeGeneration:  authority.Document.RevokeGeneration,
		CreatedAt:         authority.Document.CreatedAt, UpdatedAt: authority.Document.UpdatedAt,
	}
	projected, _, err := service.project(ctx, resolution.Access, space, workspace)
	if err != nil {
		return err
	}
	if authority.DocumentKind != DocumentKindCodeWorkspace ||
		authority.Document.Status != DocumentOpen || !projected.Viewer.CanExchangeGrant ||
		authority.Document.CurrentGeneration != resolution.Scope.Generation ||
		authority.Document.RevokeGeneration != resolution.Scope.WriterFence ||
		authority.WriterFence != resolution.Scope.WriterFence ||
		authority.ProviderDocumentName != resolution.Scope.ProviderDocumentName ||
		capabilityRank(resolution.Scope.Capability) > capabilityRank(projected.Viewer.Capability) {
		return ErrGrantDenied
	}
	return nil
}

func (service *CodeWorkspaceService) managedWorkspace(
	ctx context.Context,
	access AccessContext,
	workspaceID uuid.UUID,
) (CodeWorkspace, media.MediaSpace, codeWorkspaceViewer, error) {
	workspace, space, err := service.authorizedWorkspace(ctx, access, workspaceID)
	if err != nil {
		return CodeWorkspace{}, media.MediaSpace{}, codeWorkspaceViewer{}, err
	}
	viewer, err := service.viewer(ctx, access, space, workspace.ID)
	if err != nil {
		return CodeWorkspace{}, media.MediaSpace{}, codeWorkspaceViewer{}, err
	}
	if !viewer.manage {
		return CodeWorkspace{}, media.MediaSpace{}, codeWorkspaceViewer{}, ErrNotFound
	}
	return workspace, space, viewer, nil
}

func (service *CodeWorkspaceService) authorizedWorkspace(
	ctx context.Context,
	access AccessContext,
	workspaceID uuid.UUID,
) (CodeWorkspace, media.MediaSpace, error) {
	if !validAccess(access) || workspaceID == uuid.Nil {
		return CodeWorkspace{}, media.MediaSpace{}, ErrInvalidRequest
	}
	workspace, err := service.repository.Get(ctx, access, workspaceID)
	if err != nil {
		return CodeWorkspace{}, media.MediaSpace{}, normalizeCodeConcealedError(err)
	}
	space, err := service.authorizeSpace(ctx, access, workspace.MediaSpaceID)
	if err != nil {
		return CodeWorkspace{}, media.MediaSpace{}, err
	}
	return workspace, space, nil
}

func (service *CodeWorkspaceService) authorizeSpace(
	ctx context.Context,
	access AccessContext,
	spaceID uuid.UUID,
) (media.MediaSpace, error) {
	space, err := service.spaces.GetSpace(ctx, media.AccessContext{
		TenantID: access.TenantID, ActorID: access.ActorID, SessionID: access.SessionID,
		MembershipActive: access.MembershipActive, OrganizationRoles: access.OrganizationRoles,
	}, spaceID)
	if err != nil {
		if errors.Is(err, media.ErrSpaceNotFound) || errors.Is(err, media.ErrSpaceAccessDenied) ||
			errors.Is(err, media.ErrSourceUnavailable) {
			return media.MediaSpace{}, ErrNotFound
		}
		return media.MediaSpace{}, ErrUnavailable
	}
	if space.ID != spaceID {
		return media.MediaSpace{}, ErrNotFound
	}
	return space, nil
}

func (service *CodeWorkspaceService) viewer(
	ctx context.Context,
	access AccessContext,
	space media.MediaSpace,
	workspaceID uuid.UUID,
) (codeWorkspaceViewer, error) {
	viewer := codeWorkspaceViewer{roomID: activeRoomInstanceID(space)}
	if viewer.roomID != uuid.Nil {
		state, err := service.repository.ViewerState(ctx, access, workspaceID, space.ID, viewer.roomID)
		if err != nil {
			if errors.Is(err, errCodeWorkspaceNoRoomRun) {
				viewer.roomID = uuid.Nil
			} else {
				return codeWorkspaceViewer{}, normalizeCodeConcealedError(err)
			}
		} else {
			viewer.state = state
		}
	}
	viewer.audience = codeWorkspaceAudience(access, space, viewer.state)
	viewer.manage = canManageSpace(access, space) || viewer.audience == AudienceOrganizationAdmin ||
		viewer.audience == AudienceHost || viewer.audience == AudienceCoHost
	return viewer, nil
}

func (service *CodeWorkspaceService) project(
	ctx context.Context,
	access AccessContext,
	space media.MediaSpace,
	workspace CodeWorkspace,
) (CodeWorkspace, codeWorkspaceViewer, error) {
	viewer, err := service.viewer(ctx, access, space, workspace.ID)
	if err != nil {
		return CodeWorkspace{}, codeWorkspaceViewer{}, err
	}
	capability := codeWorkspaceCapability(viewer, workspace.Status)
	if service.runtimeMode == RuntimeModeReadOnly {
		capability = CapabilityView
	}
	enabled := service.runtimeMode == RuntimeModeEnabled
	workspace.Viewer = CodeWorkspaceViewerCapabilities{
		Capability:            capability,
		CanOpen:               enabled && viewer.manage && workspace.Status == DocumentCreated,
		CanSuspend:            enabled && viewer.manage && workspace.Status == DocumentOpen,
		CanResume:             enabled && viewer.manage && workspace.Status == DocumentSuspended,
		CanClose:              enabled && viewer.manage && workspace.Status != DocumentClosed,
		CanManageEditorGrants: enabled && viewer.manage && workspace.Status == DocumentOpen && viewer.roomID != uuid.Nil,
		CanExchangeGrant:      workspace.Status == DocumentOpen,
	}
	return workspace, viewer, nil
}

func (service *CodeWorkspaceService) requireReadable() error {
	if service.runtimeMode == RuntimeModeOff {
		return ErrNotFound
	}
	return nil
}

func (service *CodeWorkspaceService) requireWritable() error {
	if service.runtimeMode == RuntimeModeOff {
		return ErrNotFound
	}
	if service.runtimeMode == RuntimeModeReadOnly {
		return ErrReadOnly
	}
	return nil
}

func codeWorkspaceAudience(
	access AccessContext,
	space media.MediaSpace,
	state CodeWorkspaceViewerState,
) Audience {
	for _, role := range access.OrganizationRoles {
		if role == policy.OrganizationRoleAdmin {
			return AudienceOrganizationAdmin
		}
	}
	switch space.ViewerRole {
	case media.InstanceRoleHost:
		return AudienceHost
	case media.InstanceRoleCoHost:
		return AudienceCoHost
	case media.InstanceRoleTeachingAssistant:
		return AudienceTeachingAssistant
	}
	if state.DynamicCoHost {
		return AudienceCoHost
	}
	if space.ViewerRole == media.InstanceRoleAttendee {
		return AudienceAttendee
	}
	if canManageSpace(access, space) {
		return AudienceHost
	}
	return AudienceAttendee
}

// codeWorkspaceCapability is the fixed Slice 2 matrix (ADR-0043 §4,
// RESEARCH-00 §2.6): hosts present, co-hosts and teaching assistants edit,
// attendees view unless an unexpired temporary grant exists while they are
// connected to the active RoomInstance.
func codeWorkspaceCapability(viewer codeWorkspaceViewer, status DocumentStatus) Capability {
	switch viewer.audience {
	case AudienceOrganizationAdmin, AudienceHost:
		return CapabilityPresent
	case AudienceCoHost, AudienceTeachingAssistant:
		return CapabilityEdit
	}
	if status == DocumentOpen && viewer.roomID != uuid.Nil &&
		viewer.state.ActiveParticipant && viewer.state.ActiveEditGrant {
		return CapabilityEdit
	}
	return CapabilityView
}

func activeRoomInstanceID(space media.MediaSpace) uuid.UUID {
	if space.ActiveRoomInstance == nil || space.ActiveRoomInstance.Status != media.RoomInstanceActive {
		return uuid.Nil
	}
	return space.ActiveRoomInstance.ID
}

func opaqueCodeWorkspaceProviderName(id uuid.UUID) string {
	return codeWorkspaceProviderPrefix + strings.ReplaceAll(id.String(), "-", "")
}

func codeWorkspaceCreateFingerprint(input CreateInput) []byte {
	digest := sha256.New()
	_, _ = digest.Write([]byte(DocumentKindCodeWorkspace))
	_, _ = digest.Write(input.MediaSpaceID[:])
	return digest.Sum(nil)
}

func codeWorkspaceTransitionFingerprint(operation string, workspaceID uuid.UUID, expectedVersion int64) []byte {
	digest := sha256.New()
	_, _ = digest.Write([]byte(DocumentKindCodeWorkspace))
	_, _ = digest.Write(transitionFingerprint(operation, workspaceID, expectedVersion))
	return digest.Sum(nil)
}

func normalizeCodeConcealedError(err error) error {
	if errors.Is(err, ErrNotFound) {
		return ErrNotFound
	}
	return normalizeCodeError(err)
}

func normalizeCodeError(err error) error {
	for _, candidate := range []error{ErrFeatureDisabled, ErrEditorLimitReached, ErrGrantTargetIneligible} {
		if errors.Is(err, candidate) {
			return candidate
		}
	}
	return normalizeError(err)
}
