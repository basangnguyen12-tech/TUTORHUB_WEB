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

// PdfPresentationService is the server authority for classroom PDF
// presentation and page-scoped annotations (`pdf.annotations.v1`). Every
// capability is re-derived from the current MediaSpace, the active
// RoomInstance and the temporary annotate grants on each Resolve, Exchange and
// runtime Validate; the browser never decides who may present or write.
type PdfPresentationService struct {
	repository  PdfPresentationRepository
	spaces      SpaceAuthority
	documents   PdfDocumentResolver
	grants      CodeWorkspaceGrantBroker
	clock       func() time.Time
	newID       func() uuid.UUID
	runtimeMode RuntimeMode
}

type pdfPresentationViewer struct {
	audience Audience
	present  bool
	manage   bool
	access   bool
	roomID   uuid.UUID
	state    PdfPresentationViewerState
}

var pdfViewerMediaTypes = map[string]bool{
	"application/pdf": true,
	"image/png":       true,
	"image/jpeg":      true,
	"image/webp":      true,
}

func NewPdfPresentationService(
	repository PdfPresentationRepository,
	spaces SpaceAuthority,
	documents PdfDocumentResolver,
	grants CodeWorkspaceGrantBroker,
	configs ...ServiceConfig,
) (*PdfPresentationService, error) {
	if repository == nil || spaces == nil || documents == nil {
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
	return &PdfPresentationService{
		repository: repository, spaces: spaces, documents: documents, grants: grants,
		clock: config.Clock, newID: config.NewID, runtimeMode: config.RuntimeMode,
	}, nil
}

// Resolve returns the room's current presentation: the `open` one, or the
// most recently updated `suspended` one. Attendees who are not admitted to the
// active RoomInstance receive the same concealed 404 as cross-tenant callers.
func (service *PdfPresentationService) Resolve(
	ctx context.Context,
	access AccessContext,
	mediaSpaceID uuid.UUID,
) (PdfPresentationProjection, error) {
	if err := service.requireReadable(); err != nil {
		return PdfPresentationProjection{}, err
	}
	if !validAccess(access) || mediaSpaceID == uuid.Nil {
		return PdfPresentationProjection{}, ErrInvalidRequest
	}
	space, err := service.authorizeSpace(ctx, access, mediaSpaceID)
	if err != nil {
		return PdfPresentationProjection{}, err
	}
	presentation, err := service.repository.Current(ctx, access, space.ID)
	found := err == nil
	if err != nil && !errors.Is(err, ErrNotFound) {
		return PdfPresentationProjection{}, normalizePdfConcealedError(err)
	}
	presentationID := uuid.Nil
	if found {
		presentationID = presentation.ID
	}
	viewer, err := service.viewer(ctx, access, space, presentationID)
	if err != nil {
		return PdfPresentationProjection{}, err
	}
	if !viewer.access {
		return PdfPresentationProjection{}, ErrNotFound
	}
	projection := PdfPresentationProjection{
		CanPresent:            service.runtimeMode == RuntimeModeEnabled && viewer.present,
		ActiveAnnotatorGrants: []PdfAnnotatorGrant{},
	}
	if !found {
		return projection, nil
	}
	document, err := service.describe(ctx, access, space.ID, presentation)
	if err != nil {
		return PdfPresentationProjection{}, err
	}
	if document == nil && !viewer.manage {
		// The document left the room library (deleted, expired or no longer
		// visible to this viewer); only managers still see the row to close it.
		return projection, nil
	}
	presentation.Document = document
	projected := service.project(viewer, presentation)
	projection.Presentation = &projected
	if viewer.roomID != uuid.Nil && presentation.Status == DocumentOpen {
		grants, err := service.repository.ActiveAnnotatorGrants(ctx, access, presentation.ID, space.ID, viewer.roomID)
		if err != nil {
			return PdfPresentationProjection{}, normalizePdfConcealedError(err)
		}
		if grants != nil {
			projection.ActiveAnnotatorGrants = grants
		}
	}
	return projection, nil
}

// Present is the one-tap atomic open/switch: it verifies the room document,
// suspends any other open presentation of the room and creates or reopens the
// presentation of (space, file, storage version) in a single transaction.
func (service *PdfPresentationService) Present(
	ctx context.Context,
	access AccessContext,
	mediaSpaceID uuid.UUID,
	input PdfPresentInput,
) (PdfPresentResult, error) {
	if err := service.requireWritable(); err != nil {
		return PdfPresentResult{}, err
	}
	input.IdempotencyKey = strings.TrimSpace(input.IdempotencyKey)
	if !validAccess(access) || mediaSpaceID == uuid.Nil || input.FileID == uuid.Nil ||
		!idempotencyPattern.MatchString(input.IdempotencyKey) {
		return PdfPresentResult{}, ErrInvalidRequest
	}
	space, err := service.authorizeSpace(ctx, access, mediaSpaceID)
	if err != nil {
		return PdfPresentResult{}, err
	}
	viewer, err := service.viewer(ctx, access, space, uuid.Nil)
	if err != nil {
		return PdfPresentResult{}, err
	}
	if !viewer.present {
		return PdfPresentResult{}, ErrNotFound
	}
	document, err := service.documents.DescribeRoomDocument(ctx, access, space.ID, input.FileID)
	if err != nil {
		return PdfPresentResult{}, normalizePdfConcealedError(err)
	}
	if !validPdfRoomDocument(document, input.FileID) {
		return PdfPresentResult{}, ErrPdfDocumentNotReady
	}
	presentationID := service.newID()
	result, err := service.repository.Present(ctx, access, PdfPresentCommand{
		PresentationID: presentationID, MediaSpaceID: space.ID, FileID: document.FileID,
		VersionID: document.VersionID, PageCount: document.PageCount,
		ProviderDocumentName: opaquePdfAnnotationsProviderName(presentationID),
		IdempotencyKey:       input.IdempotencyKey,
		Fingerprint:          pdfPresentFingerprint(space.ID, input.FileID),
		OccurredAt:           service.clock().UTC(),
	})
	if err != nil {
		return PdfPresentResult{}, normalizePdfError(err)
	}
	service.revokeDocuments(access.TenantID, result.Suspended)
	result.Presentation.Document = documentForPresentation(document, result.Presentation)
	viewer, err = service.viewer(ctx, access, space, result.Presentation.ID)
	if err != nil {
		return PdfPresentResult{}, err
	}
	result.Presentation = service.project(viewer, result.Presentation)
	return result, nil
}

func (service *PdfPresentationService) Suspend(ctx context.Context, access AccessContext, id uuid.UUID, input TransitionInput) (PdfPresentation, error) {
	return service.transition(ctx, access, id, "suspend", input)
}

func (service *PdfPresentationService) Resume(ctx context.Context, access AccessContext, id uuid.UUID, input TransitionInput) (PdfPresentation, error) {
	return service.transition(ctx, access, id, "resume", input)
}

func (service *PdfPresentationService) Close(ctx context.Context, access AccessContext, id uuid.UUID, input TransitionInput) (PdfPresentation, error) {
	return service.transition(ctx, access, id, "close", input)
}

func (service *PdfPresentationService) transition(
	ctx context.Context,
	access AccessContext,
	presentationID uuid.UUID,
	operation string,
	input TransitionInput,
) (PdfPresentation, error) {
	if err := service.requireWritable(); err != nil {
		return PdfPresentation{}, err
	}
	input.IdempotencyKey = strings.TrimSpace(input.IdempotencyKey)
	if presentationID == uuid.Nil || input.ExpectedVersion < 1 ||
		!idempotencyPattern.MatchString(input.IdempotencyKey) {
		return PdfPresentation{}, ErrInvalidRequest
	}
	presentation, space, viewer, err := service.managedPresentation(ctx, access, presentationID)
	if err != nil {
		return PdfPresentation{}, err
	}
	if !viewer.present {
		return PdfPresentation{}, ErrNotFound
	}
	result, err := service.repository.Transition(ctx, access, TransitionCommand{
		DocumentID: presentation.ID, Operation: operation, ExpectedVersion: input.ExpectedVersion,
		IdempotencyKey: input.IdempotencyKey,
		Fingerprint:    pdfTransitionFingerprint(operation, presentation.ID, input.ExpectedVersion),
		OccurredAt:     service.clock().UTC(),
	})
	if err != nil {
		return PdfPresentation{}, normalizePdfError(err)
	}
	if operation == "suspend" || operation == "close" {
		service.revokeDocuments(access.TenantID, []uuid.UUID{presentation.ID})
	}
	service.revokeDocuments(access.TenantID, result.Suspended)
	document, err := service.describe(ctx, access, space.ID, result.Presentation)
	if err != nil {
		return PdfPresentation{}, err
	}
	result.Presentation.Document = document
	viewer, err = service.viewer(ctx, access, space, result.Presentation.ID)
	if err != nil {
		return PdfPresentation{}, err
	}
	return service.project(viewer, result.Presentation), nil
}

func (service *PdfPresentationService) ExchangeGrant(
	ctx context.Context,
	access AccessContext,
	presentationID uuid.UUID,
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
	presentation, space, viewer, err := service.authorizedPresentation(ctx, access, presentationID)
	if err != nil {
		return GrantCredential{}, err
	}
	document, err := service.describe(ctx, access, space.ID, presentation)
	if err != nil {
		return GrantCredential{}, err
	}
	presentation.Document = document
	projected := service.project(viewer, presentation)
	if presentation.CurrentGeneration != input.ExpectedGeneration ||
		presentation.RevokeGeneration != input.ExpectedRevokeGeneration {
		return GrantCredential{}, ErrVersionConflict
	}
	if !projected.Viewer.CanExchangeGrant ||
		capabilityRank(input.Capability) > capabilityRank(projected.Viewer.Capability) {
		return GrantCredential{}, ErrNotFound
	}
	if service.grants == nil {
		return GrantCredential{}, ErrGrantUnavailable
	}
	authority, err := service.repository.GrantAuthority(ctx, access, presentation.ID)
	if err != nil {
		return GrantCredential{}, normalizePdfConcealedError(err)
	}
	if authority.Document.Status != DocumentOpen ||
		authority.DocumentKind != DocumentKindPDFAnnotations ||
		authority.Document.CurrentGeneration != input.ExpectedGeneration ||
		authority.Document.RevokeGeneration != input.ExpectedRevokeGeneration ||
		authority.Document.MediaSpaceID != presentation.MediaSpaceID ||
		authority.WriterFence < 1 ||
		!providerNameMatchesKind(authority.ProviderDocumentName, DocumentKindPDFAnnotations) {
		return GrantCredential{}, ErrVersionConflict
	}
	credential, err := service.grants.Issue(ctx, access, authority, input.Capability, input)
	if err != nil {
		return GrantCredential{}, normalizePdfError(err)
	}
	return credential, nil
}

func (service *PdfPresentationService) PutAnnotatorGrant(
	ctx context.Context,
	access AccessContext,
	presentationID uuid.UUID,
	participantKey uuid.UUID,
	input PdfAnnotatorGrantInput,
) (PdfAnnotatorGrant, error) {
	if err := service.requireWritable(); err != nil {
		return PdfAnnotatorGrant{}, err
	}
	ttl := PdfPresentationDefaultAnnotatorTTL
	if input.TTLSeconds != nil {
		seconds := *input.TTLSeconds
		if seconds < int64(PdfPresentationMinimumAnnotatorTTL/time.Second) ||
			seconds > int64(PdfPresentationMaximumAnnotatorTTL/time.Second) {
			return PdfAnnotatorGrant{}, ErrInvalidRequest
		}
		ttl = time.Duration(seconds) * time.Second
	}
	if participantKey == uuid.Nil {
		return PdfAnnotatorGrant{}, ErrInvalidRequest
	}
	presentation, space, viewer, err := service.managedPresentation(ctx, access, presentationID)
	if err != nil {
		return PdfAnnotatorGrant{}, err
	}
	if presentation.Status != DocumentOpen || viewer.roomID == uuid.Nil {
		return PdfAnnotatorGrant{}, ErrTransitionConflict
	}
	result, err := service.repository.PutAnnotatorGrant(ctx, access, PdfAnnotatorGrantCommand{
		PresentationID: presentation.ID, MediaSpaceID: space.ID, RoomInstanceID: viewer.roomID,
		ParticipantKey: participantKey, TTL: ttl, OccurredAt: service.clock().UTC(),
	})
	if err != nil {
		return PdfAnnotatorGrant{}, normalizePdfError(err)
	}
	if service.grants != nil {
		for _, actorID := range result.RevokedActors {
			service.grants.RevokeActor(access.TenantID, presentation.ID, actorID)
		}
	}
	return result.Grant, nil
}

func (service *PdfPresentationService) RevokeAnnotatorGrant(
	ctx context.Context,
	access AccessContext,
	presentationID uuid.UUID,
	participantKey uuid.UUID,
) error {
	if err := service.requireWritable(); err != nil {
		return err
	}
	if participantKey == uuid.Nil {
		return ErrInvalidRequest
	}
	presentation, space, viewer, err := service.managedPresentation(ctx, access, presentationID)
	if err != nil {
		return err
	}
	if viewer.roomID == uuid.Nil {
		return ErrNotFound
	}
	result, err := service.repository.RevokeAnnotatorGrant(ctx, access, PdfAnnotatorRevokeCommand{
		PresentationID: presentation.ID, MediaSpaceID: space.ID, RoomInstanceID: viewer.roomID,
		ParticipantKey: participantKey, OccurredAt: service.clock().UTC(),
	})
	if err != nil {
		return normalizePdfError(err)
	}
	// Existing provider leases are invalidated immediately: the runtime closes
	// the `edit` connection on its next revalidation and the client reconnects
	// with the downgraded `view` capability.
	if service.grants != nil && result.ActorID != uuid.Nil {
		service.grants.RevokeActor(access.TenantID, presentation.ID, result.ActorID)
	}
	return nil
}

func (service *PdfPresentationService) ConsumeGrant(
	ctx context.Context,
	input GrantConsumeInput,
) (GrantScope, error) {
	input.Credential = strings.TrimSpace(input.Credential)
	input.Origin = strings.TrimSpace(input.Origin)
	input.ProviderDocumentName = strings.TrimSpace(input.ProviderDocumentName)
	input.DocumentKind = DocumentKindPDFAnnotations
	if service.grants == nil || !validOrigin(input.Origin) || input.Credential == "" ||
		!providerNameMatchesKind(input.ProviderDocumentName, DocumentKindPDFAnnotations) {
		return GrantScope{}, ErrGrantDenied
	}
	resolution, err := service.grants.Consume(ctx, input)
	if err != nil {
		return GrantScope{}, normalizePdfError(err)
	}
	if err := service.validateGrantResolution(ctx, resolution); err != nil {
		service.grants.InvalidateLease(resolution.Scope.AuthorityLease)
		return GrantScope{}, ErrGrantDenied
	}
	return resolution.Scope, nil
}

func (service *PdfPresentationService) ValidateGrant(
	ctx context.Context,
	input GrantValidationInput,
) (bool, error) {
	input.Origin = strings.TrimSpace(input.Origin)
	if service.grants == nil || !validOrigin(input.Origin) {
		return false, ErrGrantDenied
	}
	resolution, err := service.grants.Validate(ctx, input)
	if err != nil {
		return false, normalizePdfError(err)
	}
	if err := service.validateGrantResolution(ctx, resolution); err != nil {
		service.grants.InvalidateLease(resolution.Scope.AuthorityLease)
		return false, nil
	}
	return true, nil
}

// validateGrantResolution re-derives the actor's current capability on every
// exchange and runtime revalidation: leaving the RoomInstance, an expired or
// revoked annotate grant, a switch to another document or a suspend/close all
// downgrade or deny fail-closed.
func (service *PdfPresentationService) validateGrantResolution(
	ctx context.Context,
	resolution GrantResolution,
) error {
	if kind, known := NormalizeDocumentKind(resolution.Scope.DocumentKind); !known ||
		kind != DocumentKindPDFAnnotations {
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
	presentation, err := service.repository.Get(ctx, resolution.Access, authority.Document.ID)
	if err != nil {
		return err
	}
	space, err := service.authorizeSpace(ctx, resolution.Access, authority.Document.MediaSpaceID)
	if err != nil {
		return err
	}
	document, err := service.describe(ctx, resolution.Access, space.ID, presentation)
	if err != nil {
		return err
	}
	presentation.Document = document
	viewer, err := service.viewer(ctx, resolution.Access, space, authority.Document.ID)
	if err != nil {
		return err
	}
	projected := service.project(viewer, presentation)
	if !viewer.access || authority.DocumentKind != DocumentKindPDFAnnotations ||
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

func (service *PdfPresentationService) managedPresentation(
	ctx context.Context,
	access AccessContext,
	presentationID uuid.UUID,
) (PdfPresentation, media.MediaSpace, pdfPresentationViewer, error) {
	presentation, space, viewer, err := service.authorizedPresentation(ctx, access, presentationID)
	if err != nil {
		return PdfPresentation{}, media.MediaSpace{}, pdfPresentationViewer{}, err
	}
	if !viewer.manage {
		return PdfPresentation{}, media.MediaSpace{}, pdfPresentationViewer{}, ErrNotFound
	}
	return presentation, space, viewer, nil
}

func (service *PdfPresentationService) authorizedPresentation(
	ctx context.Context,
	access AccessContext,
	presentationID uuid.UUID,
) (PdfPresentation, media.MediaSpace, pdfPresentationViewer, error) {
	if !validAccess(access) || presentationID == uuid.Nil {
		return PdfPresentation{}, media.MediaSpace{}, pdfPresentationViewer{}, ErrInvalidRequest
	}
	presentation, err := service.repository.Get(ctx, access, presentationID)
	if err != nil {
		return PdfPresentation{}, media.MediaSpace{}, pdfPresentationViewer{}, normalizePdfConcealedError(err)
	}
	space, err := service.authorizeSpace(ctx, access, presentation.MediaSpaceID)
	if err != nil {
		return PdfPresentation{}, media.MediaSpace{}, pdfPresentationViewer{}, err
	}
	viewer, err := service.viewer(ctx, access, space, presentation.ID)
	if err != nil {
		return PdfPresentation{}, media.MediaSpace{}, pdfPresentationViewer{}, err
	}
	if !viewer.access {
		return PdfPresentation{}, media.MediaSpace{}, pdfPresentationViewer{}, ErrNotFound
	}
	return presentation, space, viewer, nil
}

func (service *PdfPresentationService) authorizeSpace(
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
			errors.Is(err, media.ErrSourceUnavailable) || errors.Is(err, media.ErrInvalidSpaceRequest) {
			return media.MediaSpace{}, ErrNotFound
		}
		return media.MediaSpace{}, ErrUnavailable
	}
	if space.ID != spaceID {
		return media.MediaSpace{}, ErrNotFound
	}
	return space, nil
}

// viewer computes the fixed ADR-0045 Slice 2 matrix: organization admins,
// hosts and co-hosts (original or promoted in the active RoomInstance)
// present and manage; teaching assistants annotate; attendees view only while
// admitted to the active RoomInstance and annotate only with an unexpired
// temporary grant. Linked-class owners and co-teachers already resolve to
// host/co-host through the MediaSpace projection.
func (service *PdfPresentationService) viewer(
	ctx context.Context,
	access AccessContext,
	space media.MediaSpace,
	presentationID uuid.UUID,
) (pdfPresentationViewer, error) {
	viewer := pdfPresentationViewer{roomID: activeRoomInstanceID(space)}
	if viewer.roomID != uuid.Nil {
		state, err := service.repository.ViewerState(ctx, access, presentationID, space.ID, viewer.roomID)
		if err != nil {
			if errors.Is(err, errPdfPresentationNoRoomRun) {
				viewer.roomID = uuid.Nil
			} else {
				return pdfPresentationViewer{}, normalizePdfConcealedError(err)
			}
		} else {
			viewer.state = state
		}
	}
	viewer.audience = pdfPresentationAudience(access, space, viewer.state)
	switch viewer.audience {
	case AudienceOrganizationAdmin, AudienceHost, AudienceCoHost:
		viewer.present, viewer.manage, viewer.access = true, true, true
	case AudienceTeachingAssistant:
		viewer.access = true
	default:
		viewer.access = viewer.roomID != uuid.Nil && viewer.state.ActiveParticipant
	}
	return viewer, nil
}

func (service *PdfPresentationService) project(
	viewer pdfPresentationViewer,
	presentation PdfPresentation,
) PdfPresentation {
	capability := pdfPresentationCapability(viewer, presentation.Status)
	if service.runtimeMode == RuntimeModeReadOnly {
		capability = CapabilityView
	}
	enabled := service.runtimeMode == RuntimeModeEnabled
	presentation.Viewer = PdfPresentationViewerCapabilities{
		Capability:               capability,
		CanManage:                enabled && viewer.manage,
		CanSuspend:               enabled && viewer.present && presentation.Status == DocumentOpen,
		CanResume:                enabled && viewer.present && presentation.Status == DocumentSuspended,
		CanClose:                 enabled && viewer.present && presentation.Status != DocumentClosed,
		CanManageAnnotatorGrants: enabled && viewer.manage && presentation.Status == DocumentOpen && viewer.roomID != uuid.Nil,
		CanExchangeGrant:         viewer.access && presentation.Status == DocumentOpen && presentation.Document != nil,
	}
	return presentation
}

// describe resolves the presented document through the room library. A
// document that is no longer visible (deleted, expired, version replaced) is
// projected as nil instead of failing the whole projection.
func (service *PdfPresentationService) describe(
	ctx context.Context,
	access AccessContext,
	spaceID uuid.UUID,
	presentation PdfPresentation,
) (*PdfRoomDocument, error) {
	document, err := service.documents.DescribeRoomDocument(ctx, access, spaceID, presentation.FileID)
	if err != nil {
		normalized := normalizePdfConcealedError(err)
		if errors.Is(normalized, ErrNotFound) || errors.Is(normalized, ErrPdfDocumentNotReady) {
			return nil, nil
		}
		return nil, normalized
	}
	if !validPdfRoomDocument(document, presentation.FileID) {
		return nil, nil
	}
	return documentForPresentation(document, presentation), nil
}

func (service *PdfPresentationService) revokeDocuments(tenantID uuid.UUID, presentationIDs []uuid.UUID) {
	if service.grants == nil {
		return
	}
	for _, id := range presentationIDs {
		service.grants.RevokeTenantDocument(tenantID, id)
	}
}

func (service *PdfPresentationService) requireReadable() error {
	if service.runtimeMode == RuntimeModeOff {
		return ErrNotFound
	}
	return nil
}

func (service *PdfPresentationService) requireWritable() error {
	if service.runtimeMode == RuntimeModeOff {
		return ErrNotFound
	}
	if service.runtimeMode == RuntimeModeReadOnly {
		return ErrReadOnly
	}
	return nil
}

func pdfPresentationAudience(
	access AccessContext,
	space media.MediaSpace,
	state PdfPresentationViewerState,
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
	}
	if state.DynamicCoHost {
		return AudienceCoHost
	}
	if space.ViewerRole == media.InstanceRoleTeachingAssistant {
		return AudienceTeachingAssistant
	}
	if space.ViewerRole != media.InstanceRoleAttendee && canManageSpace(access, space) {
		return AudienceHost
	}
	return AudienceAttendee
}

func pdfPresentationCapability(viewer pdfPresentationViewer, status DocumentStatus) Capability {
	switch viewer.audience {
	case AudienceOrganizationAdmin, AudienceHost, AudienceCoHost:
		return CapabilityPresent
	case AudienceTeachingAssistant:
		return CapabilityEdit
	}
	if status == DocumentOpen && viewer.access && viewer.roomID != uuid.Nil &&
		viewer.state.ActiveParticipant && viewer.state.ActiveAnnotateGrant {
		return CapabilityEdit
	}
	return CapabilityView
}

func validPdfRoomDocument(document PdfRoomDocument, fileID uuid.UUID) bool {
	version := strings.TrimSpace(document.VersionID)
	return document.FileID == fileID && version != "" &&
		len(version) <= pdfPresentationMaximumVersionLength &&
		document.PageCount >= 1 && document.PageCount <= PdfPresentationMaximumPages &&
		pdfViewerMediaTypes[document.MediaType]
}

// documentForPresentation binds the resolved document metadata to the exact
// presented version; a replaced version is never projected as the old one.
func documentForPresentation(document PdfRoomDocument, presentation PdfPresentation) *PdfRoomDocument {
	if presentation.FileID != uuid.Nil && (document.FileID != presentation.FileID ||
		strings.TrimSpace(document.VersionID) != presentation.VersionID) {
		return nil
	}
	document.VersionID = strings.TrimSpace(document.VersionID)
	return &document
}

func opaquePdfAnnotationsProviderName(id uuid.UUID) string {
	return pdfAnnotationsProviderPrefix + strings.ReplaceAll(id.String(), "-", "")
}

func pdfPresentFingerprint(spaceID, fileID uuid.UUID) []byte {
	digest := sha256.New()
	_, _ = digest.Write([]byte(DocumentKindPDFAnnotations))
	_, _ = digest.Write([]byte("\x00present\x00"))
	_, _ = digest.Write(spaceID[:])
	_, _ = digest.Write(fileID[:])
	return digest.Sum(nil)
}

func pdfTransitionFingerprint(operation string, presentationID uuid.UUID, expectedVersion int64) []byte {
	digest := sha256.New()
	_, _ = digest.Write([]byte(DocumentKindPDFAnnotations))
	_, _ = digest.Write(transitionFingerprint(operation, presentationID, expectedVersion))
	return digest.Sum(nil)
}

func normalizePdfConcealedError(err error) error {
	if errors.Is(err, ErrNotFound) {
		return ErrNotFound
	}
	return normalizePdfError(err)
}

func normalizePdfError(err error) error {
	for _, candidate := range []error{
		ErrFeatureDisabled, ErrAnnotatorLimitReached, ErrGrantTargetIneligible, ErrPdfDocumentNotReady,
	} {
		if errors.Is(err, candidate) {
			return candidate
		}
	}
	return normalizeError(err)
}
