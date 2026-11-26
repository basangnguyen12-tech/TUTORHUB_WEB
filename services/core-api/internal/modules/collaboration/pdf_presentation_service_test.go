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

func TestPdfPresentationSwitchIsAtomicAndReturningKeepsGeneration(t *testing.T) {
	t.Parallel()
	spaceID, roomID := uuid.New(), uuid.New()
	fileA, fileB := uuid.New(), uuid.New()
	repository := newFakePdfRepository()
	documents := &fakePdfDocuments{documents: map[uuid.UUID]PdfRoomDocument{
		fileA: pdfTestDocument(fileA, "version-a", 12),
		fileB: pdfTestDocument(fileB, "version-b", 3),
	}}
	broker := &fakeCodeBroker{}
	ids := []uuid.UUID{uuid.New(), uuid.New(), uuid.New()}
	service := newTestPdfService(t, repository, &fakeSpaceAuthority{space: codeRoomSpace(spaceID, roomID, media.InstanceRoleHost)}, documents, broker, ids...)
	access := testAccess()

	first, err := service.Present(context.Background(), access, spaceID, PdfPresentInput{FileID: fileA, IdempotencyKey: "pdf-present-a-000001"})
	if err != nil {
		t.Fatalf("present A: %v", err)
	}
	if !first.Created || first.Presentation.Status != DocumentOpen || first.Presentation.PageCount != 12 ||
		first.Presentation.VersionID != "version-a" || len(first.Suspended) != 0 {
		t.Fatalf("unexpected first presentation: %+v", first)
	}
	if name := repository.commands[0].ProviderDocumentName; name != "pd_"+strings.ReplaceAll(ids[0].String(), "-", "") ||
		!providerNameMatchesKind(name, DocumentKindPDFAnnotations) {
		t.Fatalf("presentation must use the disjoint pd_ namespace: %q", name)
	}
	if first.Presentation.Document == nil || first.Presentation.Document.DisplayName != "worksheet.pdf" ||
		first.Presentation.Viewer.Capability != CapabilityPresent || !first.Presentation.Viewer.CanManage {
		t.Fatalf("presenter projection = %+v", first.Presentation)
	}

	second, err := service.Present(context.Background(), access, spaceID, PdfPresentInput{FileID: fileB, IdempotencyKey: "pdf-present-b-000001"})
	if err != nil {
		t.Fatalf("present B: %v", err)
	}
	if !second.Created || len(second.Suspended) != 1 || second.Suspended[0] != first.Presentation.ID {
		t.Fatalf("switching to B must suspend A: %+v", second)
	}
	if repository.rows[first.Presentation.ID].Status != DocumentSuspended ||
		repository.rows[first.Presentation.ID].RevokeGeneration != 2 {
		t.Fatalf("A must be suspended with a bumped writer fence: %+v", repository.rows[first.Presentation.ID])
	}
	if !containsUUID(broker.revokedDocuments, first.Presentation.ID) {
		t.Fatal("suspending A must revoke its leases immediately")
	}

	back, err := service.Present(context.Background(), access, spaceID, PdfPresentInput{FileID: fileA, IdempotencyKey: "pdf-present-a-000002"})
	if err != nil {
		t.Fatalf("return to A: %v", err)
	}
	if back.Created || back.Presentation.ID != first.Presentation.ID ||
		back.Presentation.CurrentGeneration != first.Presentation.CurrentGeneration ||
		repository.providerNames[back.Presentation.ID] != repository.providerNames[first.Presentation.ID] {
		t.Fatalf("returning to A must reuse the same row, generation and checkpoint: %+v", back)
	}
	if len(back.Suspended) != 1 || back.Suspended[0] != second.Presentation.ID ||
		!containsUUID(broker.revokedDocuments, second.Presentation.ID) {
		t.Fatalf("returning to A must suspend and revoke B: %+v", back)
	}
	if repository.openCount(spaceID) != 1 {
		t.Fatalf("at most one presentation may be open per room, got %d", repository.openCount(spaceID))
	}
}

func TestPdfPresentationCapabilityMatrix(t *testing.T) {
	t.Parallel()
	spaceID, roomID, fileID := uuid.New(), uuid.New(), uuid.New()
	student := testAccess()
	student.OrganizationRoles = []policy.OrganizationRole{policy.OrganizationRoleStudent}
	admin := testAccess()
	admin.OrganizationRoles = []policy.OrganizationRole{policy.OrganizationRoleAdmin}

	tests := []struct {
		name       string
		role       media.InstanceRole
		state      PdfPresentationViewerState
		access     AccessContext
		capability Capability
		manage     bool
		concealed  bool
	}{
		{name: "organization admin", role: media.InstanceRoleAttendee, access: admin, capability: CapabilityPresent, manage: true},
		{name: "host", role: media.InstanceRoleHost, access: testAccess(), capability: CapabilityPresent, manage: true},
		{name: "co-host", role: media.InstanceRoleCoHost, access: student, capability: CapabilityPresent, manage: true},
		{name: "promoted co-host", role: media.InstanceRoleAttendee, access: student, state: PdfPresentationViewerState{DynamicCoHost: true, ActiveParticipant: true}, capability: CapabilityPresent, manage: true},
		{name: "teaching assistant", role: media.InstanceRoleTeachingAssistant, access: student, capability: CapabilityEdit},
		{name: "admitted attendee", role: media.InstanceRoleAttendee, access: student, state: PdfPresentationViewerState{ActiveParticipant: true}, capability: CapabilityView},
		{name: "attendee with annotate grant", role: media.InstanceRoleAttendee, access: student, state: PdfPresentationViewerState{ActiveParticipant: true, ActiveAnnotateGrant: true}, capability: CapabilityEdit},
		{name: "granted attendee who left", role: media.InstanceRoleAttendee, access: student, state: PdfPresentationViewerState{ActiveAnnotateGrant: true}, concealed: true},
		{name: "attendee not admitted", role: media.InstanceRoleAttendee, access: student, concealed: true},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			repository := newFakePdfRepository()
			presentation := repository.seed(spaceID, fileID, "version-1", DocumentOpen)
			repository.state = test.state
			documents := &fakePdfDocuments{documents: map[uuid.UUID]PdfRoomDocument{fileID: pdfTestDocument(fileID, "version-1", 4)}}
			service := newTestPdfService(t, repository, &fakeSpaceAuthority{space: codeRoomSpace(spaceID, roomID, test.role)}, documents, &fakeCodeBroker{})
			projection, err := service.Resolve(context.Background(), test.access, spaceID)
			if test.concealed {
				if !errors.Is(err, ErrNotFound) {
					t.Fatalf("resolve error = %v, want concealed not found", err)
				}
				return
			}
			if err != nil || projection.Presentation == nil || projection.Presentation.ID != presentation.ID {
				t.Fatalf("resolve = %+v err=%v", projection, err)
			}
			viewer := projection.Presentation.Viewer
			if viewer.Capability != test.capability || viewer.CanManage != test.manage ||
				viewer.CanSuspend != test.manage || viewer.CanManageAnnotatorGrants != test.manage ||
				!viewer.CanExchangeGrant || projection.CanPresent != test.manage {
				t.Fatalf("viewer = %+v can_present=%t, want capability %s manage %t",
					viewer, projection.CanPresent, test.capability, test.manage)
			}
			if projection.Presentation.Document == nil || projection.Presentation.Document.FileID != fileID {
				t.Fatalf("viewers must learn which document is presented: %+v", projection.Presentation.Document)
			}
		})
	}
}

func TestPdfPresentationResolveProjectsSuspendedAndConcealsForeignOrDisabled(t *testing.T) {
	t.Parallel()
	spaceID, roomID, fileID := uuid.New(), uuid.New(), uuid.New()
	repository := newFakePdfRepository()
	documents := &fakePdfDocuments{documents: map[uuid.UUID]PdfRoomDocument{fileID: pdfTestDocument(fileID, "version-1", 4)}}
	service := newTestPdfService(t, repository, &fakeSpaceAuthority{space: codeRoomSpace(spaceID, roomID, media.InstanceRoleHost)}, documents, &fakeCodeBroker{})

	empty, err := service.Resolve(context.Background(), testAccess(), spaceID)
	if err != nil || empty.Presentation != nil || !empty.CanPresent || empty.ActiveAnnotatorGrants == nil {
		t.Fatalf("empty projection = %+v err=%v", empty, err)
	}
	suspended := repository.seed(spaceID, fileID, "version-1", DocumentSuspended)
	projection, err := service.Resolve(context.Background(), testAccess(), spaceID)
	if err != nil || projection.Presentation == nil || projection.Presentation.ID != suspended.ID ||
		!projection.Presentation.Viewer.CanResume || projection.Presentation.Viewer.CanExchangeGrant {
		t.Fatalf("suspended projection = %+v err=%v", projection, err)
	}

	repository.currentErr = ErrFeatureDisabled
	if _, err := service.Resolve(context.Background(), testAccess(), spaceID); !errors.Is(err, ErrFeatureDisabled) {
		t.Fatalf("feature-off resolve error = %v, want feature disabled", err)
	}
	repository.currentErr = nil

	foreign := newTestPdfService(t, repository, &fakeSpaceAuthority{err: media.ErrSpaceAccessDenied}, documents, &fakeCodeBroker{})
	if _, err := foreign.Resolve(context.Background(), testAccess(), spaceID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("foreign resolve error = %v, want concealed not found", err)
	}

	// A document removed from the library hides the presentation from viewers
	// while managers still see it (to close it) with document = null.
	documents.err = ErrNotFound
	managerView, err := service.Resolve(context.Background(), testAccess(), spaceID)
	if err != nil || managerView.Presentation == nil || managerView.Presentation.Document != nil ||
		managerView.Presentation.Viewer.CanExchangeGrant {
		t.Fatalf("manager projection with missing document = %+v err=%v", managerView, err)
	}
	student := testAccess()
	student.OrganizationRoles = []policy.OrganizationRole{policy.OrganizationRoleStudent}
	repository.state = PdfPresentationViewerState{ActiveParticipant: true}
	studentService := newTestPdfService(t, repository, &fakeSpaceAuthority{space: codeRoomSpace(spaceID, roomID, media.InstanceRoleAttendee)}, documents, &fakeCodeBroker{})
	studentView, err := studentService.Resolve(context.Background(), student, spaceID)
	if err != nil || studentView.Presentation != nil {
		t.Fatalf("viewer projection with missing document = %+v err=%v", studentView, err)
	}
}

func TestPdfPresentationPresentRequiresPresenterAndReadyViewerDocument(t *testing.T) {
	t.Parallel()
	spaceID, roomID, fileID := uuid.New(), uuid.New(), uuid.New()
	repository := newFakePdfRepository()
	documents := &fakePdfDocuments{documents: map[uuid.UUID]PdfRoomDocument{}}
	service := newTestPdfService(t, repository, &fakeSpaceAuthority{space: codeRoomSpace(spaceID, roomID, media.InstanceRoleHost)}, documents, &fakeCodeBroker{})
	input := PdfPresentInput{FileID: fileID, IdempotencyKey: "pdf-present-guard-0001"}

	for _, invalid := range []PdfPresentInput{
		{FileID: uuid.Nil, IdempotencyKey: input.IdempotencyKey},
		{FileID: fileID, IdempotencyKey: "short"},
	} {
		if _, err := service.Present(context.Background(), testAccess(), spaceID, invalid); !errors.Is(err, ErrInvalidRequest) {
			t.Fatalf("invalid present %+v error = %v", invalid, err)
		}
	}
	documents.err = ErrNotFound
	if _, err := service.Present(context.Background(), testAccess(), spaceID, input); !errors.Is(err, ErrNotFound) {
		t.Fatalf("foreign or deleted file error = %v, want concealed not found", err)
	}
	documents.err = ErrPdfDocumentNotReady
	if _, err := service.Present(context.Background(), testAccess(), spaceID, input); !errors.Is(err, ErrPdfDocumentNotReady) {
		t.Fatalf("non-ready file error = %v, want not ready", err)
	}
	documents.err = nil
	unsupported := pdfTestDocument(fileID, "version-1", 2)
	unsupported.MediaType = "application/zip"
	documents.documents[fileID] = unsupported
	if _, err := service.Present(context.Background(), testAccess(), spaceID, input); !errors.Is(err, ErrPdfDocumentNotReady) {
		t.Fatalf("non-viewer media type error = %v, want not ready", err)
	}
	if len(repository.commands) != 0 {
		t.Fatal("no presentation may be persisted for an unverified document")
	}

	student := testAccess()
	student.OrganizationRoles = []policy.OrganizationRole{policy.OrganizationRoleStudent}
	repository.state = PdfPresentationViewerState{ActiveParticipant: true}
	documents.documents[fileID] = pdfTestDocument(fileID, "version-1", 2)
	for _, role := range []media.InstanceRole{media.InstanceRoleAttendee, media.InstanceRoleTeachingAssistant} {
		limited := newTestPdfService(t, repository, &fakeSpaceAuthority{space: codeRoomSpace(spaceID, roomID, role)}, documents, &fakeCodeBroker{})
		if _, err := limited.Present(context.Background(), student, spaceID, input); !errors.Is(err, ErrNotFound) {
			t.Fatalf("%s present error = %v, want concealed not found", role, err)
		}
	}
}

func TestPdfPresentationResumeSuspendsOtherOpenAndRevokes(t *testing.T) {
	t.Parallel()
	spaceID, roomID := uuid.New(), uuid.New()
	repository := newFakePdfRepository()
	open := repository.seed(spaceID, uuid.New(), "version-1", DocumentOpen)
	paused := repository.seed(spaceID, uuid.New(), "version-2", DocumentSuspended)
	broker := &fakeCodeBroker{}
	service := newTestPdfService(t, repository, &fakeSpaceAuthority{space: codeRoomSpace(spaceID, roomID, media.InstanceRoleHost)}, &fakePdfDocuments{}, broker)

	resumed, err := service.Resume(context.Background(), testAccess(), paused.ID, TransitionInput{ExpectedVersion: paused.Version, IdempotencyKey: "pdf-resume-0000000001"})
	if err != nil || resumed.Status != DocumentOpen {
		t.Fatalf("resume = %+v err=%v", resumed, err)
	}
	if repository.rows[open.ID].Status != DocumentSuspended || !containsUUID(broker.revokedDocuments, open.ID) ||
		repository.openCount(spaceID) != 1 {
		t.Fatal("resume must suspend and revoke the other open presentation")
	}
	if !strings.HasPrefix(string(repository.transitionCommand.Operation), "resume") ||
		len(repository.transitionCommand.Fingerprint) != 32 {
		t.Fatalf("unexpected transition command: %+v", repository.transitionCommand)
	}
	closed, err := service.Close(context.Background(), testAccess(), paused.ID, TransitionInput{ExpectedVersion: resumed.Version, IdempotencyKey: "pdf-close-00000000001"})
	if err != nil || closed.Status != DocumentClosed || !containsUUID(broker.revokedDocuments, paused.ID) {
		t.Fatalf("close = %+v err=%v", closed, err)
	}

	student := testAccess()
	student.OrganizationRoles = []policy.OrganizationRole{policy.OrganizationRoleStudent}
	repository.state = PdfPresentationViewerState{ActiveParticipant: true}
	attendee := newTestPdfService(t, repository, &fakeSpaceAuthority{space: codeRoomSpace(spaceID, roomID, media.InstanceRoleAttendee)}, &fakePdfDocuments{}, broker)
	if _, err := attendee.Suspend(context.Background(), student, open.ID, TransitionInput{ExpectedVersion: 1, IdempotencyKey: "pdf-suspend-000000001"}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("attendee suspend error = %v, want concealed not found", err)
	}
}

func TestPdfPresentationAnnotatorGrantsAreBoundedAndRevokeImmediately(t *testing.T) {
	t.Parallel()
	spaceID, roomID := uuid.New(), uuid.New()
	studentID, departedID, participantKey := uuid.New(), uuid.New(), uuid.New()
	repository := newFakePdfRepository()
	presentation := repository.seed(spaceID, uuid.New(), "version-1", DocumentOpen)
	repository.putResult = PdfAnnotatorGrantResult{
		Grant:   PdfAnnotatorGrant{ParticipantKey: participantKey, ExpiresAt: collaborationTestTime.Add(10 * time.Minute)},
		ActorID: studentID, RevokedActors: []uuid.UUID{departedID},
	}
	repository.revokeResult = PdfAnnotatorRevokeResult{ActorID: studentID, Revoked: true}
	broker := &fakeCodeBroker{}
	service := newTestPdfService(t, repository, &fakeSpaceAuthority{space: codeRoomSpace(spaceID, roomID, media.InstanceRoleHost)}, &fakePdfDocuments{}, broker)

	for _, ttl := range []int64{59, 1801} {
		value := ttl
		if _, err := service.PutAnnotatorGrant(context.Background(), testAccess(), presentation.ID, participantKey, PdfAnnotatorGrantInput{TTLSeconds: &value}); !errors.Is(err, ErrInvalidRequest) {
			t.Fatalf("ttl %d error = %v, want invalid", ttl, err)
		}
	}
	grant, err := service.PutAnnotatorGrant(context.Background(), testAccess(), presentation.ID, participantKey, PdfAnnotatorGrantInput{})
	if err != nil || grant.ParticipantKey != participantKey {
		t.Fatalf("put grant = %+v err=%v", grant, err)
	}
	if repository.putCommand.TTL != 600*time.Second || repository.putCommand.RoomInstanceID != roomID {
		t.Fatalf("default TTL must be 600 seconds within the active room: %+v", repository.putCommand)
	}
	if !containsUUID(broker.revokedActors, departedID) {
		t.Fatal("grants of students who left must be revoked before counting")
	}

	repository.putErr = ErrAnnotatorLimitReached
	if _, err := service.PutAnnotatorGrant(context.Background(), testAccess(), presentation.ID, participantKey, PdfAnnotatorGrantInput{}); !errors.Is(err, ErrAnnotatorLimitReached) {
		t.Fatalf("fourth annotator error = %v, want limit", err)
	}
	if err := service.RevokeAnnotatorGrant(context.Background(), testAccess(), presentation.ID, participantKey); err != nil {
		t.Fatalf("revoke grant: %v", err)
	}
	if broker.revokedActors[len(broker.revokedActors)-1] != studentID {
		t.Fatal("DELETE must invalidate the student's provider leases immediately")
	}

	repository.rows[presentation.ID] = withStatus(repository.rows[presentation.ID], DocumentSuspended)
	repository.putErr = nil
	if _, err := service.PutAnnotatorGrant(context.Background(), testAccess(), presentation.ID, participantKey, PdfAnnotatorGrantInput{}); !errors.Is(err, ErrTransitionConflict) {
		t.Fatalf("grant on suspended presentation error = %v, want transition conflict", err)
	}
}

func TestPdfPresentationValidateDowngradesWhenGrantEndsOrStudentLeaves(t *testing.T) {
	t.Parallel()
	spaceID, roomID, fileID := uuid.New(), uuid.New(), uuid.New()
	student := testAccess()
	student.OrganizationRoles = []policy.OrganizationRole{policy.OrganizationRoleStudent}
	repository := newFakePdfRepository()
	presentation := repository.seed(spaceID, fileID, "version-1", DocumentOpen)
	documents := &fakePdfDocuments{documents: map[uuid.UUID]PdfRoomDocument{
		fileID: pdfTestDocument(fileID, "version-1", 4),
	}}
	scope := GrantScope{
		AuthorityLease: strings.Repeat("l", 43), ActorID: student.ActorID, Capability: CapabilityEdit,
		DocumentID: presentation.ID, DocumentKind: DocumentKindPDFAnnotations, Generation: 1,
		ProviderDocumentName: repository.providerNames[presentation.ID], SessionID: student.SessionID,
		TenantID: student.TenantID, WriterFence: 1,
	}
	broker := &fakeCodeBroker{fakeGrantBroker: fakeGrantBroker{resolution: GrantResolution{Access: student, Scope: scope}}}
	service := newTestPdfService(t, repository, &fakeSpaceAuthority{space: codeRoomSpace(spaceID, roomID, media.InstanceRoleAttendee)}, documents, broker)
	validate := func() bool {
		valid, err := service.ValidateGrant(context.Background(), GrantValidationInput{Scope: scope, Origin: codeTestOrigin})
		if err != nil {
			t.Fatalf("validate: %v", err)
		}
		return valid
	}

	repository.state = PdfPresentationViewerState{ActiveParticipant: true, ActiveAnnotateGrant: true}
	if !validate() {
		t.Fatal("a live annotate grant must validate")
	}
	repository.state = PdfPresentationViewerState{ActiveParticipant: true}
	if validate() || len(broker.invalidated) != 1 {
		t.Fatal("an expired or revoked annotate grant must downgrade the edit lease")
	}
	viewScope := scope
	viewScope.Capability = CapabilityView
	broker.resolution.Scope = viewScope
	if valid, _ := service.ValidateGrant(context.Background(), GrantValidationInput{Scope: viewScope, Origin: codeTestOrigin}); !valid {
		t.Fatal("an admitted student keeps view access")
	}
	repository.state = PdfPresentationViewerState{}
	if valid, _ := service.ValidateGrant(context.Background(), GrantValidationInput{Scope: viewScope, Origin: codeTestOrigin}); valid {
		t.Fatal("a student who left the RoomInstance must lose even view access")
	}
	repository.state = PdfPresentationViewerState{ActiveParticipant: true}
	delete(documents.documents, fileID)
	if valid, _ := service.ValidateGrant(context.Background(), GrantValidationInput{Scope: viewScope, Origin: codeTestOrigin}); valid {
		t.Fatal("soft-deleting or unsharing the underlying document must revoke active annotation leases")
	}
	documents.documents[fileID] = pdfTestDocument(fileID, "version-1", 4)
	codeScope := viewScope
	codeScope.DocumentKind = DocumentKindCodeWorkspace
	broker.resolution.Scope = codeScope
	if valid, _ := service.ValidateGrant(context.Background(), GrantValidationInput{Scope: codeScope, Origin: codeTestOrigin}); valid {
		t.Fatal("a cw_ resolution must never validate against the PDF control plane")
	}
}

func TestPdfPresentationGrantExchangeRequiresOpenPdfAuthority(t *testing.T) {
	t.Parallel()
	spaceID, roomID, fileID := uuid.New(), uuid.New(), uuid.New()
	repository := newFakePdfRepository()
	presentation := repository.seed(spaceID, fileID, "version-1", DocumentOpen)
	documents := &fakePdfDocuments{documents: map[uuid.UUID]PdfRoomDocument{
		fileID: pdfTestDocument(fileID, "version-1", 4),
	}}
	broker := &fakeCodeBroker{fakeGrantBroker: fakeGrantBroker{credential: GrantCredential{Credential: "credential"}}}
	service := newTestPdfService(t, repository, &fakeSpaceAuthority{space: codeRoomSpace(spaceID, roomID, media.InstanceRoleHost)}, documents, broker)
	input := GrantExchangeInput{Capability: CapabilityPresent, ExpectedGeneration: 1, ExpectedRevokeGeneration: 1, Origin: codeTestOrigin}

	if _, err := service.ExchangeGrant(context.Background(), testAccess(), presentation.ID, input); err != nil || broker.issueCalls != 1 {
		t.Fatalf("present exchange err=%v calls=%d", err, broker.issueCalls)
	}
	stale := input
	stale.ExpectedRevokeGeneration = 2
	if _, err := service.ExchangeGrant(context.Background(), testAccess(), presentation.ID, stale); !errors.Is(err, ErrVersionConflict) {
		t.Fatalf("stale exchange error = %v, want conflict", err)
	}
	repository.authorityKind = DocumentKindCodeWorkspace
	if _, err := service.ExchangeGrant(context.Background(), testAccess(), presentation.ID, input); !errors.Is(err, ErrVersionConflict) {
		t.Fatalf("cross-kind authority error = %v, want conflict", err)
	}
	repository.authorityKind = ""

	student := testAccess()
	student.OrganizationRoles = []policy.OrganizationRole{policy.OrganizationRoleStudent}
	repository.state = PdfPresentationViewerState{ActiveParticipant: true}
	attendee := newTestPdfService(t, repository, &fakeSpaceAuthority{space: codeRoomSpace(spaceID, roomID, media.InstanceRoleAttendee)}, documents, broker)
	if _, err := attendee.ExchangeGrant(context.Background(), student, presentation.ID, GrantExchangeInput{
		Capability: CapabilityEdit, ExpectedGeneration: 1, ExpectedRevokeGeneration: 1, Origin: codeTestOrigin,
	}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("view-only student requesting edit error = %v, want concealed", err)
	}
	viewInput := input
	viewInput.Capability = CapabilityView
	if _, err := attendee.ExchangeGrant(context.Background(), student, presentation.ID, viewInput); err != nil {
		t.Fatalf("admitted student view exchange: %v", err)
	}
	repository.state = PdfPresentationViewerState{}
	if _, err := attendee.ExchangeGrant(context.Background(), student, presentation.ID, viewInput); !errors.Is(err, ErrNotFound) {
		t.Fatalf("non-admitted student exchange error = %v, want concealed", err)
	}
	delete(documents.documents, fileID)
	if _, err := service.ExchangeGrant(context.Background(), testAccess(), presentation.ID, input); !errors.Is(err, ErrNotFound) {
		t.Fatalf("deleted or expired document exchange error = %v, want concealed", err)
	}
}

func TestPdfPresentationOffAndReadOnlyModes(t *testing.T) {
	t.Parallel()
	spaceID, roomID := uuid.New(), uuid.New()
	repository := newFakePdfRepository()
	presentation := repository.seed(spaceID, uuid.New(), "version-1", DocumentOpen)
	spaces := &fakeSpaceAuthority{space: codeRoomSpace(spaceID, roomID, media.InstanceRoleHost)}
	off, err := NewPdfPresentationService(repository, spaces, &fakePdfDocuments{}, &fakeCodeBroker{}, ServiceConfig{RuntimeMode: RuntimeModeOff})
	if err != nil {
		t.Fatalf("new off service: %v", err)
	}
	if _, err := off.Resolve(context.Background(), testAccess(), spaceID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("off resolve error = %v", err)
	}
	readOnly, err := NewPdfPresentationService(repository, spaces, &fakePdfDocuments{}, &fakeCodeBroker{}, ServiceConfig{RuntimeMode: RuntimeModeReadOnly})
	if err != nil {
		t.Fatalf("new read-only service: %v", err)
	}
	if _, err := readOnly.Suspend(context.Background(), testAccess(), presentation.ID, TransitionInput{ExpectedVersion: 1, IdempotencyKey: "pdf-suspend-readonly-1"}); !errors.Is(err, ErrReadOnly) {
		t.Fatalf("read-only suspend error = %v", err)
	}
	projection, err := readOnly.Resolve(context.Background(), testAccess(), spaceID)
	if err != nil || projection.CanPresent || projection.Presentation.Viewer.Capability != CapabilityView {
		t.Fatalf("read-only projection = %+v err=%v", projection, err)
	}
}

func TestInternalKindRouterIsolatesPdfAnnotations(t *testing.T) {
	t.Parallel()
	whiteboard, code, pdf := &recordingInternalService{}, &recordingInternalService{}, &recordingInternalService{}
	id := uuid.New()
	withoutPDF := NewInternalKindRouter(whiteboard, code)
	if _, err := withoutPDF.ConsumeGrant(context.Background(), GrantConsumeInput{
		DocumentKind: DocumentKindPDFAnnotations, ProviderDocumentName: opaquePdfAnnotationsProviderName(id),
	}); !errors.Is(err, ErrGrantDenied) {
		t.Fatalf("router without a PDF plane must deny pd_: %v", err)
	}
	router := NewInternalKindRouter(whiteboard, code).WithPDFAnnotations(pdf)
	if _, err := router.ConsumeGrant(context.Background(), GrantConsumeInput{
		DocumentKind: DocumentKindPDFAnnotations, ProviderDocumentName: opaquePdfAnnotationsProviderName(id),
	}); err != nil || pdf.consumed != 1 {
		t.Fatalf("pd_ request was not routed to the PDF plane: err=%v", err)
	}
	for _, input := range []GrantConsumeInput{
		{ProviderDocumentName: opaquePdfAnnotationsProviderName(id)},
		{DocumentKind: DocumentKindCodeWorkspace, ProviderDocumentName: opaquePdfAnnotationsProviderName(id)},
		{DocumentKind: DocumentKindWhiteboard, ProviderDocumentName: opaquePdfAnnotationsProviderName(id)},
		{DocumentKind: DocumentKindPDFAnnotations, ProviderDocumentName: opaqueCodeWorkspaceProviderName(id)},
		{DocumentKind: DocumentKindPDFAnnotations, ProviderDocumentName: opaqueProviderDocumentName(id)},
		{DocumentKind: "pdf.annotations.v2", ProviderDocumentName: opaquePdfAnnotationsProviderName(id)},
	} {
		if _, err := router.ConsumeGrant(context.Background(), input); !errors.Is(err, ErrGrantDenied) {
			t.Fatalf("cross-kind consume %+v error = %v, want denied", input, err)
		}
	}
	if valid, err := router.ValidateGrant(context.Background(), GrantValidationInput{Scope: GrantScope{
		DocumentKind: DocumentKindPDFAnnotations, ProviderDocumentName: opaqueCodeWorkspaceProviderName(id),
	}}); valid || !errors.Is(err, ErrGrantDenied) {
		t.Fatalf("cross-kind validate = %t err=%v", valid, err)
	}
	if whiteboard.consumed != 0 || code.consumed != 0 || pdf.consumed != 1 {
		t.Fatal("rejected cross-kind requests must not reach any control plane")
	}
}

func TestMemoryGrantBrokerBindsPdfAnnotationsKind(t *testing.T) {
	t.Parallel()
	broker, access, authority, _ := newGrantBrokerFixture(t, MemoryGrantBrokerConfig{})
	authority.DocumentKind = DocumentKindPDFAnnotations
	authority.ProviderDocumentName = opaquePdfAnnotationsProviderName(authority.Document.ID)

	for _, kind := range []DocumentKind{"", DocumentKindWhiteboard, DocumentKindCodeWorkspace} {
		credential := issueTestGrant(t, broker, access, authority)
		if _, err := broker.Consume(context.Background(), GrantConsumeInput{
			Credential: credential.Credential, DocumentKind: kind, Origin: codeTestOrigin,
			ProviderDocumentName: authority.ProviderDocumentName,
		}); !errors.Is(err, ErrGrantDenied) {
			t.Fatalf("%q consume of a pd_ grant error = %v, want denied", kind, err)
		}
	}
	credential := issueTestGrant(t, broker, access, authority)
	resolution, err := broker.Consume(context.Background(), GrantConsumeInput{
		Credential: credential.Credential, DocumentKind: DocumentKindPDFAnnotations,
		Origin: codeTestOrigin, ProviderDocumentName: authority.ProviderDocumentName,
	})
	if err != nil || resolution.Scope.DocumentKind != DocumentKindPDFAnnotations {
		t.Fatalf("pdf consume = %+v err=%v", resolution.Scope, err)
	}
	broker.RevokeActor(access.TenantID, authority.Document.ID, access.ActorID)
	if _, err := broker.Validate(context.Background(), GrantValidationInput{Origin: codeTestOrigin, Scope: resolution.Scope}); !errors.Is(err, ErrGrantDenied) {
		t.Fatalf("revoked pd_ actor lease error = %v, want denied", err)
	}
	mismatched := authority
	mismatched.ProviderDocumentName = opaqueCodeWorkspaceProviderName(authority.Document.ID)
	if _, err := broker.Issue(context.Background(), access, mismatched, CapabilityView, GrantExchangeInput{Origin: codeTestOrigin}); !errors.Is(err, ErrGrantDenied) {
		t.Fatalf("issue with pdf kind and cw_ name error = %v, want denied", err)
	}
}

func newTestPdfService(
	t *testing.T,
	repository PdfPresentationRepository,
	spaces SpaceAuthority,
	documents PdfDocumentResolver,
	grants CodeWorkspaceGrantBroker,
	ids ...uuid.UUID,
) *PdfPresentationService {
	t.Helper()
	next := 0
	service, err := NewPdfPresentationService(repository, spaces, documents, grants, ServiceConfig{
		Clock: func() time.Time { return collaborationTestTime },
		NewID: func() uuid.UUID {
			if next < len(ids) {
				next++
				return ids[next-1]
			}
			return uuid.New()
		},
	})
	if err != nil {
		t.Fatalf("new pdf presentation service: %v", err)
	}
	return service
}

func pdfTestDocument(fileID uuid.UUID, version string, pages int) PdfRoomDocument {
	return PdfRoomDocument{
		FileID: fileID, VersionID: version, DisplayName: "worksheet.pdf", MediaType: "application/pdf",
		PageCount: pages, FirstPageAspect: 0.7071, AllowStudentDownload: false,
	}
}

func containsUUID(values []uuid.UUID, target uuid.UUID) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}

func withStatus(presentation PdfPresentation, status DocumentStatus) PdfPresentation {
	presentation.Status = status
	return presentation
}

type fakePdfDocuments struct {
	documents map[uuid.UUID]PdfRoomDocument
	err       error
}

func (documents *fakePdfDocuments) DescribeRoomDocument(_ context.Context, _ AccessContext, _, fileID uuid.UUID) (PdfRoomDocument, error) {
	if documents.err != nil {
		return PdfRoomDocument{}, documents.err
	}
	document, ok := documents.documents[fileID]
	if !ok {
		return PdfRoomDocument{}, ErrNotFound
	}
	return document, nil
}

// fakePdfRepository models the PostgreSQL invariants of 000057: one row per
// (space, file, version), stable generation and provider name, at most one
// open row per space.
type fakePdfRepository struct {
	rows              map[uuid.UUID]PdfPresentation
	providerNames     map[uuid.UUID]string
	order             []uuid.UUID
	commands          []PdfPresentCommand
	state             PdfPresentationViewerState
	currentErr        error
	authorityKind     DocumentKind
	transitionCommand TransitionCommand
	putCommand        PdfAnnotatorGrantCommand
	putResult         PdfAnnotatorGrantResult
	putErr            error
	revokeResult      PdfAnnotatorRevokeResult
}

func newFakePdfRepository() *fakePdfRepository {
	return &fakePdfRepository{rows: map[uuid.UUID]PdfPresentation{}, providerNames: map[uuid.UUID]string{}}
}

func (repository *fakePdfRepository) seed(spaceID, fileID uuid.UUID, version string, status DocumentStatus) PdfPresentation {
	id := uuid.New()
	presentation := PdfPresentation{
		ID: id, MediaSpaceID: spaceID, FileID: fileID, VersionID: version, PageCount: 4,
		Status: status, Version: 1, CurrentGeneration: 1, RevokeGeneration: 1,
		CreatedAt: collaborationTestTime, UpdatedAt: collaborationTestTime,
	}
	repository.rows[id] = presentation
	repository.providerNames[id] = opaquePdfAnnotationsProviderName(id)
	repository.order = append(repository.order, id)
	return presentation
}

func (repository *fakePdfRepository) openCount(spaceID uuid.UUID) int {
	count := 0
	for _, row := range repository.rows {
		if row.MediaSpaceID == spaceID && row.Status == DocumentOpen {
			count++
		}
	}
	return count
}

func (repository *fakePdfRepository) suspendOthers(spaceID, keep uuid.UUID) []uuid.UUID {
	suspended := []uuid.UUID{}
	for _, id := range repository.order {
		row := repository.rows[id]
		if row.MediaSpaceID == spaceID && row.Status == DocumentOpen && id != keep {
			row.Status, row.Version, row.RevokeGeneration = DocumentSuspended, row.Version+1, row.RevokeGeneration+1
			repository.rows[id] = row
			suspended = append(suspended, id)
		}
	}
	return suspended
}

func (repository *fakePdfRepository) Present(_ context.Context, _ AccessContext, command PdfPresentCommand) (PdfPresentResult, error) {
	repository.commands = append(repository.commands, command)
	var target *PdfPresentation
	for _, id := range repository.order {
		row := repository.rows[id]
		if row.MediaSpaceID == command.MediaSpaceID && row.FileID == command.FileID && row.VersionID == command.VersionID {
			target = &row
		}
	}
	keep := uuid.Nil
	if target != nil {
		keep = target.ID
	}
	result := PdfPresentResult{Suspended: repository.suspendOthers(command.MediaSpaceID, keep)}
	if target == nil {
		row := PdfPresentation{
			ID: command.PresentationID, MediaSpaceID: command.MediaSpaceID, FileID: command.FileID,
			VersionID: command.VersionID, PageCount: command.PageCount, Status: DocumentOpen,
			Version: 1, CurrentGeneration: 1, RevokeGeneration: 1,
		}
		repository.rows[row.ID] = row
		repository.providerNames[row.ID] = command.ProviderDocumentName
		repository.order = append(repository.order, row.ID)
		result.Presentation, result.Created = row, true
		return result, nil
	}
	if target.Status != DocumentOpen {
		target.Status, target.Version = DocumentOpen, target.Version+1
		repository.rows[target.ID] = *target
	}
	result.Presentation = *target
	return result, nil
}

func (repository *fakePdfRepository) Get(_ context.Context, _ AccessContext, id uuid.UUID) (PdfPresentation, error) {
	row, ok := repository.rows[id]
	if !ok {
		return PdfPresentation{}, ErrNotFound
	}
	return row, nil
}

func (repository *fakePdfRepository) Current(_ context.Context, _ AccessContext, spaceID uuid.UUID) (PdfPresentation, error) {
	if repository.currentErr != nil {
		return PdfPresentation{}, repository.currentErr
	}
	var current *PdfPresentation
	for _, id := range repository.order {
		row := repository.rows[id]
		if row.MediaSpaceID != spaceID {
			continue
		}
		if row.Status == DocumentOpen {
			return row, nil
		}
		if row.Status == DocumentSuspended {
			current = &row
		}
	}
	if current == nil {
		return PdfPresentation{}, ErrNotFound
	}
	return *current, nil
}

func (repository *fakePdfRepository) GrantAuthority(_ context.Context, _ AccessContext, id uuid.UUID) (GrantAuthority, error) {
	row, ok := repository.rows[id]
	if !ok {
		return GrantAuthority{}, ErrNotFound
	}
	kind := repository.authorityKind
	if kind == "" {
		kind = DocumentKindPDFAnnotations
	}
	return GrantAuthority{
		Document: Document{
			ID: row.ID, MediaSpaceID: row.MediaSpaceID, Status: row.Status, Version: row.Version,
			CurrentGeneration: row.CurrentGeneration, RevokeGeneration: row.RevokeGeneration,
		},
		DocumentKind: kind, ProviderDocumentName: repository.providerNames[id], WriterFence: row.RevokeGeneration,
	}, nil
}

func (repository *fakePdfRepository) Transition(_ context.Context, _ AccessContext, command TransitionCommand) (PdfPresentationTransitionResult, error) {
	repository.transitionCommand = command
	row, ok := repository.rows[command.DocumentID]
	if !ok {
		return PdfPresentationTransitionResult{}, ErrNotFound
	}
	if row.Version != command.ExpectedVersion {
		return PdfPresentationTransitionResult{}, ErrVersionConflict
	}
	next, valid := pdfTransitionStatus(row.Status, command.Operation)
	if !valid {
		return PdfPresentationTransitionResult{}, ErrTransitionConflict
	}
	result := PdfPresentationTransitionResult{}
	if command.Operation == "resume" {
		result.Suspended = repository.suspendOthers(row.MediaSpaceID, row.ID)
	}
	row.Status, row.Version = next, row.Version+1
	if command.Operation != "resume" {
		row.RevokeGeneration++
	}
	repository.rows[row.ID] = row
	result.Presentation = row
	return result, nil
}

func (repository *fakePdfRepository) ViewerState(_ context.Context, _ AccessContext, _, _, _ uuid.UUID) (PdfPresentationViewerState, error) {
	return repository.state, nil
}

func (repository *fakePdfRepository) ActiveAnnotatorGrants(_ context.Context, _ AccessContext, _, _, _ uuid.UUID) ([]PdfAnnotatorGrant, error) {
	return nil, nil
}

func (repository *fakePdfRepository) PutAnnotatorGrant(_ context.Context, _ AccessContext, command PdfAnnotatorGrantCommand) (PdfAnnotatorGrantResult, error) {
	repository.putCommand = command
	if repository.putErr != nil {
		return PdfAnnotatorGrantResult{}, repository.putErr
	}
	return repository.putResult, nil
}

func (repository *fakePdfRepository) RevokeAnnotatorGrant(_ context.Context, _ AccessContext, _ PdfAnnotatorRevokeCommand) (PdfAnnotatorRevokeResult, error) {
	return repository.revokeResult, nil
}
