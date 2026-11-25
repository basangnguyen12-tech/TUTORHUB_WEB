package collaboration

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/tutorhub-v2/core-api/internal/modules/media"
	"github.com/tutorhub-v2/core-api/internal/policy"
)

const codeTestOrigin = "https://app.example.test"

func TestCodeWorkspaceCreateUsesCodeProviderNamespaceAndManagerMatrix(t *testing.T) {
	t.Parallel()
	workspaceID, spaceID, roomID := uuid.New(), uuid.New(), uuid.New()
	repository := &fakeCodeRepository{createResult: CodeWorkspaceCreateResult{Created: true, Workspace: CodeWorkspace{
		ID: workspaceID, MediaSpaceID: spaceID, Status: DocumentCreated, Version: 1,
		CurrentGeneration: 1, RevokeGeneration: 1,
	}}}
	service := newTestCodeService(t, repository, &fakeSpaceAuthority{space: codeRoomSpace(spaceID, roomID, media.InstanceRoleHost)}, nil, workspaceID)

	result, err := service.Create(context.Background(), testAccess(), CreateInput{
		MediaSpaceID: spaceID, IdempotencyKey: "code-workspace-create-0001",
	})
	if err != nil {
		t.Fatalf("create code workspace: %v", err)
	}
	if !result.Created || repository.createCommand.ProviderDocumentName != "cw_"+strings.ReplaceAll(workspaceID.String(), "-", "") ||
		len(repository.createCommand.Fingerprint) != 32 {
		t.Fatalf("unexpected create command: %+v", repository.createCommand)
	}
	viewer := result.Workspace.Viewer
	if viewer.Capability != CapabilityPresent || !viewer.CanOpen || viewer.CanManageEditorGrants {
		t.Fatalf("unexpected host projection after create: %+v", viewer)
	}

	attendee := testAccess()
	attendee.OrganizationRoles = []policy.OrganizationRole{policy.OrganizationRoleStudent}
	attendeeService := newTestCodeService(t, repository, &fakeSpaceAuthority{space: codeRoomSpace(spaceID, roomID, media.InstanceRoleAttendee)}, nil, workspaceID)
	if _, err := attendeeService.Create(context.Background(), attendee, CreateInput{
		MediaSpaceID: spaceID, IdempotencyKey: "code-workspace-create-0002",
	}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("attendee create error = %v, want concealed not found", err)
	}
}

func TestCodeWorkspaceCapabilityMatrixAndTemporaryEditGrant(t *testing.T) {
	t.Parallel()
	workspaceID, spaceID, roomID := uuid.New(), uuid.New(), uuid.New()
	open := CodeWorkspace{ID: workspaceID, MediaSpaceID: spaceID, Status: DocumentOpen, Version: 2, CurrentGeneration: 1, RevokeGeneration: 1}
	student := testAccess()
	student.OrganizationRoles = []policy.OrganizationRole{policy.OrganizationRoleStudent}

	tests := []struct {
		name       string
		role       media.InstanceRole
		state      CodeWorkspaceViewerState
		access     AccessContext
		capability Capability
		manage     bool
	}{
		{name: "host", role: media.InstanceRoleHost, access: testAccess(), capability: CapabilityPresent, manage: true},
		{name: "co-host", role: media.InstanceRoleCoHost, access: student, capability: CapabilityEdit, manage: true},
		{name: "promoted co-host", role: media.InstanceRoleAttendee, access: student, state: CodeWorkspaceViewerState{DynamicCoHost: true, ActiveParticipant: true}, capability: CapabilityEdit, manage: true},
		{name: "teaching assistant", role: media.InstanceRoleTeachingAssistant, access: student, capability: CapabilityEdit},
		{name: "attendee", role: media.InstanceRoleAttendee, access: student, state: CodeWorkspaceViewerState{ActiveParticipant: true}, capability: CapabilityView},
		{name: "attendee with grant", role: media.InstanceRoleAttendee, access: student, state: CodeWorkspaceViewerState{ActiveParticipant: true, ActiveEditGrant: true}, capability: CapabilityEdit},
		{name: "granted attendee who left", role: media.InstanceRoleAttendee, access: student, state: CodeWorkspaceViewerState{ActiveEditGrant: true}, capability: CapabilityView},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			repository := &fakeCodeRepository{workspace: open, state: test.state}
			space := codeRoomSpace(spaceID, roomID, test.role)
			service := newTestCodeService(t, repository, &fakeSpaceAuthority{space: space}, nil, uuid.New())
			projection, err := service.Resolve(context.Background(), test.access, spaceID)
			if err != nil {
				t.Fatalf("resolve: %v", err)
			}
			viewer := projection.Workspace.Viewer
			if viewer.Capability != test.capability || viewer.CanManageEditorGrants != test.manage ||
				viewer.CanSuspend != test.manage || !viewer.CanExchangeGrant {
				t.Fatalf("viewer = %+v, want capability %s manage %t", viewer, test.capability, test.manage)
			}
		})
	}
}

func TestCodeWorkspaceResolveWithoutWorkspaceProjectsCreateAuthority(t *testing.T) {
	t.Parallel()
	spaceID, roomID := uuid.New(), uuid.New()
	repository := &fakeCodeRepository{getError: ErrNotFound}
	service := newTestCodeService(t, repository, &fakeSpaceAuthority{space: codeRoomSpace(spaceID, roomID, media.InstanceRoleHost)}, nil, uuid.New())
	projection, err := service.Resolve(context.Background(), testAccess(), spaceID)
	if err != nil || projection.Workspace != nil || !projection.CanCreate || projection.ActiveEditorGrants == nil {
		t.Fatalf("empty projection = %+v err=%v", projection, err)
	}

	repository.getError = ErrFeatureDisabled
	if _, err := service.Resolve(context.Background(), testAccess(), spaceID); !errors.Is(err, ErrFeatureDisabled) {
		t.Fatalf("feature-off resolve error = %v, want feature disabled", err)
	}

	foreign := newTestCodeService(t, repository, &fakeSpaceAuthority{err: media.ErrSpaceAccessDenied}, nil, uuid.New())
	if _, err := foreign.Resolve(context.Background(), testAccess(), spaceID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("foreign resolve error = %v, want concealed not found", err)
	}
}

func TestCodeWorkspaceEditorGrantBoundsAndImmediateLeaseRevocation(t *testing.T) {
	t.Parallel()
	workspaceID, spaceID, roomID := uuid.New(), uuid.New(), uuid.New()
	studentID, participantKey := uuid.New(), uuid.New()
	repository := &fakeCodeRepository{
		workspace: CodeWorkspace{ID: workspaceID, MediaSpaceID: spaceID, Status: DocumentOpen, Version: 2, CurrentGeneration: 1, RevokeGeneration: 1},
		putResult: CodeWorkspaceEditorGrantResult{
			ActorID: studentID, Grant: CodeWorkspaceEditorGrant{ParticipantKey: participantKey, ExpiresAt: collaborationTestTime.Add(10 * time.Minute)},
		},
		revokeResult: CodeWorkspaceEditorRevokeResult{ActorID: studentID, Revoked: true},
	}
	broker := &fakeCodeBroker{}
	service := newTestCodeService(t, repository, &fakeSpaceAuthority{space: codeRoomSpace(spaceID, roomID, media.InstanceRoleHost)}, broker, uuid.New())
	access := testAccess()

	for _, ttl := range []int64{59, 1801} {
		value := ttl
		if _, err := service.PutEditorGrant(context.Background(), access, workspaceID, participantKey, CodeWorkspaceEditorGrantInput{TTLSeconds: &value}); !errors.Is(err, ErrInvalidRequest) {
			t.Fatalf("ttl %d error = %v, want invalid request", ttl, err)
		}
	}
	grant, err := service.PutEditorGrant(context.Background(), access, workspaceID, participantKey, CodeWorkspaceEditorGrantInput{})
	if err != nil || grant.ParticipantKey != participantKey || repository.putCommand.TTL != CodeWorkspaceDefaultEditorTTL ||
		repository.putCommand.RoomInstanceID != roomID {
		t.Fatalf("default grant = %+v command=%+v err=%v", grant, repository.putCommand, err)
	}

	repository.putError = ErrEditorLimitReached
	if _, err := service.PutEditorGrant(context.Background(), access, workspaceID, participantKey, CodeWorkspaceEditorGrantInput{}); !errors.Is(err, ErrEditorLimitReached) {
		t.Fatalf("limit error = %v, want editor limit", err)
	}

	if err := service.RevokeEditorGrant(context.Background(), access, workspaceID, participantKey); err != nil {
		t.Fatalf("revoke grant: %v", err)
	}
	if len(broker.revokedActors) != 1 || broker.revokedActors[0] != studentID || broker.revokedTenant != access.TenantID {
		t.Fatalf("actor lease was not revoked immediately: %+v", broker)
	}

	student := testAccess()
	student.OrganizationRoles = []policy.OrganizationRole{policy.OrganizationRoleStudent}
	attendeeService := newTestCodeService(t, repository, &fakeSpaceAuthority{space: codeRoomSpace(spaceID, roomID, media.InstanceRoleAttendee)}, broker, uuid.New())
	if _, err := attendeeService.PutEditorGrant(context.Background(), student, workspaceID, participantKey, CodeWorkspaceEditorGrantInput{}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("attendee grant error = %v, want concealed not found", err)
	}

	repository.workspace.Status = DocumentSuspended
	if _, err := service.PutEditorGrant(context.Background(), access, workspaceID, participantKey, CodeWorkspaceEditorGrantInput{}); !errors.Is(err, ErrTransitionConflict) {
		t.Fatalf("suspended grant error = %v, want transition conflict", err)
	}
}

func TestCodeWorkspaceSuspendRevokesEveryTenantDocumentLease(t *testing.T) {
	t.Parallel()
	workspaceID, spaceID, roomID := uuid.New(), uuid.New(), uuid.New()
	repository := &fakeCodeRepository{
		workspace:        CodeWorkspace{ID: workspaceID, MediaSpaceID: spaceID, Status: DocumentOpen, Version: 2, CurrentGeneration: 1, RevokeGeneration: 1},
		transitionResult: CodeWorkspace{ID: workspaceID, MediaSpaceID: spaceID, Status: DocumentSuspended, Version: 3, CurrentGeneration: 1, RevokeGeneration: 2},
	}
	broker := &fakeCodeBroker{}
	service := newTestCodeService(t, repository, &fakeSpaceAuthority{space: codeRoomSpace(spaceID, roomID, media.InstanceRoleHost)}, broker, uuid.New())
	access := testAccess()
	updated, err := service.Suspend(context.Background(), access, workspaceID, TransitionInput{ExpectedVersion: 2, IdempotencyKey: "code-workspace-suspend-01"})
	if err != nil || updated.Status != DocumentSuspended || !updated.Viewer.CanResume {
		t.Fatalf("suspend = %+v err=%v", updated, err)
	}
	if len(broker.revokedDocuments) != 1 || broker.revokedDocuments[0] != workspaceID || broker.revokedTenant != access.TenantID {
		t.Fatalf("suspend did not revoke tenant document leases: %+v", broker)
	}
	if repository.transitionCommand.Operation != "suspend" || len(repository.transitionCommand.Fingerprint) != 32 ||
		string(repository.transitionCommand.Fingerprint) == string(transitionFingerprint("suspend", workspaceID, 2)) {
		t.Fatalf("code transition fingerprint must be kind-bound: %+v", repository.transitionCommand)
	}
}

func TestCodeWorkspaceValidateDowngradesExpiredOrRevokedEditGrant(t *testing.T) {
	t.Parallel()
	workspaceID, spaceID, roomID := uuid.New(), uuid.New(), uuid.New()
	student := testAccess()
	student.OrganizationRoles = []policy.OrganizationRole{policy.OrganizationRoleStudent}
	providerName := opaqueCodeWorkspaceProviderName(workspaceID)
	repository := &fakeCodeRepository{
		workspace: CodeWorkspace{ID: workspaceID, MediaSpaceID: spaceID, Status: DocumentOpen, Version: 2, CurrentGeneration: 1, RevokeGeneration: 1},
		authority: GrantAuthority{
			Document:     Document{ID: workspaceID, MediaSpaceID: spaceID, Status: DocumentOpen, Version: 2, CurrentGeneration: 1, RevokeGeneration: 1},
			DocumentKind: DocumentKindCodeWorkspace, ProviderDocumentName: providerName, WriterFence: 1,
		},
		state: CodeWorkspaceViewerState{ActiveParticipant: true, ActiveEditGrant: true},
	}
	scope := GrantScope{
		AuthorityLease: strings.Repeat("a", 43), ActorID: student.ActorID, Capability: CapabilityEdit,
		DocumentID: workspaceID, DocumentKind: DocumentKindCodeWorkspace, Generation: 1,
		ProviderDocumentName: providerName, SessionID: student.SessionID, TenantID: student.TenantID, WriterFence: 1,
	}
	broker := &fakeCodeBroker{fakeGrantBroker: fakeGrantBroker{resolution: GrantResolution{Access: student, Scope: scope}}}
	service := newTestCodeService(t, repository, &fakeSpaceAuthority{space: codeRoomSpace(spaceID, roomID, media.InstanceRoleAttendee)}, broker, uuid.New())

	valid, err := service.ValidateGrant(context.Background(), GrantValidationInput{Origin: codeTestOrigin, Scope: scope})
	if err != nil || !valid {
		t.Fatalf("active edit grant validation = %t err=%v", valid, err)
	}
	repository.state.ActiveEditGrant = false
	valid, err = service.ValidateGrant(context.Background(), GrantValidationInput{Origin: codeTestOrigin, Scope: scope})
	if err != nil || valid || len(broker.invalidated) != 1 {
		t.Fatalf("expired edit grant must invalidate the lease: valid=%t err=%v broker=%+v", valid, err, broker)
	}

	broker.resolution.Scope.DocumentKind = DocumentKindWhiteboard
	repository.state.ActiveEditGrant = true
	if valid, _ := service.ValidateGrant(context.Background(), GrantValidationInput{Origin: codeTestOrigin, Scope: scope}); valid {
		t.Fatal("a whiteboard-kind lease must never validate against the code control plane")
	}
}

func TestCodeWorkspaceGrantExchangeRequiresOpenCodeAuthority(t *testing.T) {
	t.Parallel()
	workspaceID, spaceID, roomID := uuid.New(), uuid.New(), uuid.New()
	repository := &fakeCodeRepository{
		workspace: CodeWorkspace{ID: workspaceID, MediaSpaceID: spaceID, Status: DocumentOpen, Version: 2, CurrentGeneration: 1, RevokeGeneration: 1},
		authority: GrantAuthority{
			Document:     Document{ID: workspaceID, MediaSpaceID: spaceID, Status: DocumentOpen, CurrentGeneration: 1, RevokeGeneration: 1},
			DocumentKind: DocumentKindCodeWorkspace, ProviderDocumentName: opaqueCodeWorkspaceProviderName(workspaceID), WriterFence: 1,
		},
	}
	broker := &fakeCodeBroker{fakeGrantBroker: fakeGrantBroker{credential: GrantCredential{Credential: strings.Repeat("c", 43)}}}
	service := newTestCodeService(t, repository, &fakeSpaceAuthority{space: codeRoomSpace(spaceID, roomID, media.InstanceRoleHost)}, broker, uuid.New())
	input := GrantExchangeInput{Capability: CapabilityPresent, ExpectedGeneration: 1, ExpectedRevokeGeneration: 1, Origin: codeTestOrigin}
	if _, err := service.ExchangeGrant(context.Background(), testAccess(), workspaceID, input); err != nil || broker.issueCalls != 1 {
		t.Fatalf("exchange: err=%v calls=%d", err, broker.issueCalls)
	}
	repository.authority.ProviderDocumentName = opaqueProviderDocumentName(workspaceID)
	if _, err := service.ExchangeGrant(context.Background(), testAccess(), workspaceID, input); !errors.Is(err, ErrVersionConflict) {
		t.Fatalf("cross-kind provider name error = %v, want version conflict", err)
	}
	input.Origin = "javascript:alert(1)"
	if _, err := service.ExchangeGrant(context.Background(), testAccess(), workspaceID, input); !errors.Is(err, ErrInvalidRequest) {
		t.Fatalf("bad origin error = %v, want invalid request", err)
	}
}

func TestInternalKindRouterRejectsCrossKindProviderNames(t *testing.T) {
	t.Parallel()
	whiteboard := &recordingInternalService{}
	code := &recordingInternalService{}
	router := NewInternalKindRouter(whiteboard, code)
	id := uuid.New()

	if _, err := router.ConsumeGrant(context.Background(), GrantConsumeInput{
		ProviderDocumentName: opaqueProviderDocumentName(id),
	}); err != nil || whiteboard.consumed != 1 || code.consumed != 0 {
		t.Fatalf("legacy whiteboard request must default to the whiteboard plane: err=%v", err)
	}
	if _, err := router.ConsumeGrant(context.Background(), GrantConsumeInput{
		DocumentKind: DocumentKindCodeWorkspace, ProviderDocumentName: opaqueCodeWorkspaceProviderName(id),
	}); err != nil || code.consumed != 1 {
		t.Fatalf("code request was not routed: err=%v", err)
	}
	for _, input := range []GrantConsumeInput{
		{ProviderDocumentName: opaqueCodeWorkspaceProviderName(id)},
		{DocumentKind: DocumentKindCodeWorkspace, ProviderDocumentName: opaqueProviderDocumentName(id)},
		{DocumentKind: "code.workspace.v2", ProviderDocumentName: opaqueCodeWorkspaceProviderName(id)},
	} {
		if _, err := router.ConsumeGrant(context.Background(), input); !errors.Is(err, ErrGrantDenied) {
			t.Fatalf("cross-kind consume %+v error = %v, want denied", input, err)
		}
	}
	if valid, err := router.ValidateGrant(context.Background(), GrantValidationInput{Scope: GrantScope{
		DocumentKind: DocumentKindWhiteboard, ProviderDocumentName: opaqueCodeWorkspaceProviderName(id),
	}}); valid || !errors.Is(err, ErrGrantDenied) {
		t.Fatalf("cross-kind validate = %t err=%v", valid, err)
	}
	if whiteboard.consumed != 1 || code.consumed != 1 {
		t.Fatal("a rejected cross-kind request must not reach either control plane")
	}
}

func TestMemoryGrantBrokerBindsDocumentKindAndRevokesActorLeases(t *testing.T) {
	t.Parallel()
	broker, access, authority, _ := newGrantBrokerFixture(t, MemoryGrantBrokerConfig{})
	authority.DocumentKind = DocumentKindCodeWorkspace
	authority.ProviderDocumentName = opaqueCodeWorkspaceProviderName(authority.Document.ID)

	credential := issueTestGrant(t, broker, access, authority)
	if _, err := broker.Consume(context.Background(), GrantConsumeInput{
		Credential: credential.Credential, Origin: codeTestOrigin,
		ProviderDocumentName: authority.ProviderDocumentName,
	}); !errors.Is(err, ErrGrantDenied) {
		t.Fatalf("whiteboard-kind consume of a code grant error = %v, want denied", err)
	}

	credential = issueTestGrant(t, broker, access, authority)
	resolution, err := broker.Consume(context.Background(), GrantConsumeInput{
		Credential: credential.Credential, DocumentKind: DocumentKindCodeWorkspace,
		Origin: codeTestOrigin, ProviderDocumentName: authority.ProviderDocumentName,
	})
	if err != nil || resolution.Scope.DocumentKind != DocumentKindCodeWorkspace {
		t.Fatalf("code consume = %+v err=%v", resolution.Scope, err)
	}
	other := access
	other.ActorID = uuid.New()
	otherCredential := issueTestGrant(t, broker, other, authority)
	otherResolution, err := broker.Consume(context.Background(), GrantConsumeInput{
		Credential: otherCredential.Credential, DocumentKind: DocumentKindCodeWorkspace,
		Origin: codeTestOrigin, ProviderDocumentName: authority.ProviderDocumentName,
	})
	if err != nil {
		t.Fatalf("consume other actor: %v", err)
	}

	broker.RevokeActor(access.TenantID, authority.Document.ID, access.ActorID)
	if _, err := broker.Validate(context.Background(), GrantValidationInput{Origin: codeTestOrigin, Scope: resolution.Scope}); !errors.Is(err, ErrGrantDenied) {
		t.Fatalf("revoked actor lease error = %v, want denied", err)
	}
	if _, err := broker.Validate(context.Background(), GrantValidationInput{Origin: codeTestOrigin, Scope: otherResolution.Scope}); err != nil {
		t.Fatalf("other actor lease must survive an actor revoke: %v", err)
	}
	broker.RevokeTenantDocument(uuid.New(), authority.Document.ID)
	if _, err := broker.Validate(context.Background(), GrantValidationInput{Origin: codeTestOrigin, Scope: otherResolution.Scope}); err != nil {
		t.Fatalf("a foreign-tenant revoke must not touch this tenant: %v", err)
	}
	broker.RevokeTenantDocument(access.TenantID, authority.Document.ID)
	if _, err := broker.Validate(context.Background(), GrantValidationInput{Origin: codeTestOrigin, Scope: otherResolution.Scope}); !errors.Is(err, ErrGrantDenied) {
		t.Fatalf("tenant document revoke error = %v, want denied", err)
	}

	mismatched := authority
	mismatched.DocumentKind = DocumentKindWhiteboard
	if _, err := broker.Issue(context.Background(), access, mismatched, CapabilityView, GrantExchangeInput{Origin: codeTestOrigin}); !errors.Is(err, ErrGrantDenied) {
		t.Fatalf("issue with kind/prefix mismatch error = %v, want denied", err)
	}
}

func newTestCodeService(
	t *testing.T,
	repository CodeWorkspaceRepository,
	spaces SpaceAuthority,
	grants CodeWorkspaceGrantBroker,
	newID uuid.UUID,
) *CodeWorkspaceService {
	t.Helper()
	service, err := NewCodeWorkspaceService(repository, spaces, grants, ServiceConfig{
		Clock: func() time.Time { return collaborationTestTime },
		NewID: func() uuid.UUID { return newID },
	})
	if err != nil {
		t.Fatalf("new code workspace service: %v", err)
	}
	return service
}

func codeRoomSpace(spaceID, roomID uuid.UUID, role media.InstanceRole) media.MediaSpace {
	space := media.MediaSpace{
		ID: spaceID, ViewerRole: role,
		ActiveRoomInstance: &media.RoomInstance{ID: roomID, Status: media.RoomInstanceActive},
	}
	if role == media.InstanceRoleHost {
		space.ViewerOperations = media.ViewerOperations{CanEnd: true}
	}
	return space
}

type fakeCodeRepository struct {
	workspace         CodeWorkspace
	getError          error
	createResult      CodeWorkspaceCreateResult
	createCommand     CodeWorkspaceCreateCommand
	transitionResult  CodeWorkspace
	transitionCommand TransitionCommand
	authority         GrantAuthority
	state             CodeWorkspaceViewerState
	grants            []CodeWorkspaceEditorGrant
	putResult         CodeWorkspaceEditorGrantResult
	putCommand        CodeWorkspaceEditorGrantCommand
	putError          error
	revokeResult      CodeWorkspaceEditorRevokeResult
}

func (repository *fakeCodeRepository) Create(_ context.Context, _ AccessContext, command CodeWorkspaceCreateCommand) (CodeWorkspaceCreateResult, error) {
	repository.createCommand = command
	return repository.createResult, nil
}

func (repository *fakeCodeRepository) Get(_ context.Context, _ AccessContext, _ uuid.UUID) (CodeWorkspace, error) {
	return repository.workspace, repository.getError
}

func (repository *fakeCodeRepository) GetByMediaSpace(_ context.Context, _ AccessContext, _ uuid.UUID) (CodeWorkspace, error) {
	return repository.workspace, repository.getError
}

func (repository *fakeCodeRepository) GrantAuthority(_ context.Context, _ AccessContext, _ uuid.UUID) (GrantAuthority, error) {
	return repository.authority, nil
}

func (repository *fakeCodeRepository) Transition(_ context.Context, _ AccessContext, command TransitionCommand) (CodeWorkspace, error) {
	repository.transitionCommand = command
	return repository.transitionResult, nil
}

func (repository *fakeCodeRepository) ViewerState(_ context.Context, _ AccessContext, _, _, _ uuid.UUID) (CodeWorkspaceViewerState, error) {
	return repository.state, nil
}

func (repository *fakeCodeRepository) ActiveEditorGrants(_ context.Context, _ AccessContext, _, _, _ uuid.UUID) ([]CodeWorkspaceEditorGrant, error) {
	return repository.grants, nil
}

func (repository *fakeCodeRepository) PutEditorGrant(_ context.Context, _ AccessContext, command CodeWorkspaceEditorGrantCommand) (CodeWorkspaceEditorGrantResult, error) {
	repository.putCommand = command
	if repository.putError != nil {
		return CodeWorkspaceEditorGrantResult{}, repository.putError
	}
	return repository.putResult, nil
}

func (repository *fakeCodeRepository) RevokeEditorGrant(_ context.Context, _ AccessContext, _ CodeWorkspaceEditorRevokeCommand) (CodeWorkspaceEditorRevokeResult, error) {
	return repository.revokeResult, nil
}

type fakeCodeBroker struct {
	fakeGrantBroker
	issueCalls       int
	revokedTenant    uuid.UUID
	revokedDocuments []uuid.UUID
	revokedActors    []uuid.UUID
}

func (broker *fakeCodeBroker) Issue(ctx context.Context, access AccessContext, authority GrantAuthority, capability Capability, input GrantExchangeInput) (GrantCredential, error) {
	broker.issueCalls++
	return broker.fakeGrantBroker.Issue(ctx, access, authority, capability, input)
}

func (broker *fakeCodeBroker) RevokeTenantDocument(tenantID, documentID uuid.UUID) {
	broker.revokedTenant = tenantID
	broker.revokedDocuments = append(broker.revokedDocuments, documentID)
}

func (broker *fakeCodeBroker) RevokeActor(tenantID, _ uuid.UUID, actorID uuid.UUID) {
	broker.revokedTenant = tenantID
	broker.revokedActors = append(broker.revokedActors, actorID)
}

type recordingInternalService struct {
	consumed  int
	validated int
}

func (service *recordingInternalService) ConsumeGrant(context.Context, GrantConsumeInput) (GrantScope, error) {
	service.consumed++
	return GrantScope{}, nil
}

func (service *recordingInternalService) ValidateGrant(context.Context, GrantValidationInput) (bool, error) {
	service.validated++
	return true, nil
}
