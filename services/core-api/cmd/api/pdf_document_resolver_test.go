package main

import (
	"context"
	"errors"
	"fmt"
	"testing"

	"github.com/google/uuid"
	"github.com/tutorhub-v2/core-api/internal/modules/collaboration"
	"github.com/tutorhub-v2/core-api/internal/modules/content"
	"github.com/tutorhub-v2/core-api/internal/modules/featurecontrol"
	"github.com/tutorhub-v2/core-api/internal/policy"
)

type fakeRoomDocumentDescriber struct {
	descriptor content.RoomDocumentDescriptor
	err        error
	access     content.AccessContext
}

func (describer *fakeRoomDocumentDescriber) DescribeRoomDocument(
	_ context.Context, access content.AccessContext, _ uuid.UUID, _ uuid.UUID,
) (content.RoomDocumentDescriptor, error) {
	describer.access = access
	return describer.descriptor, describer.err
}

func TestPdfRoomDocumentResolverMapsMetadataAndErrors(t *testing.T) {
	t.Parallel()
	fileID := uuid.New()
	describer := &fakeRoomDocumentDescriber{descriptor: content.RoomDocumentDescriptor{
		FileID: fileID, VersionID: "version-3", DisplayName: "worksheet.pdf", MediaType: "application/pdf",
		PageCount: 9, FirstPageAspect: 0.75, ActiveContent: true, AllowStudentDownload: true,
	}}
	resolver := pdfRoomDocumentResolver{documents: describer}
	access := collaboration.AccessContext{
		TenantID: uuid.New(), ActorID: uuid.New(), SessionID: uuid.New(), MembershipActive: true,
		OrganizationRoles: []policy.OrganizationRole{policy.OrganizationRoleTeacher},
	}
	document, err := resolver.DescribeRoomDocument(context.Background(), access, uuid.New(), fileID)
	if err != nil || document.FileID != fileID || document.VersionID != "version-3" || document.PageCount != 9 ||
		!document.ActiveContent || !document.AllowStudentDownload || document.DisplayName != "worksheet.pdf" {
		t.Fatalf("document = %+v err=%v", document, err)
	}
	if describer.access.TenantID != access.TenantID || describer.access.ActorID != access.ActorID {
		t.Fatalf("access was not forwarded: %+v", describer.access)
	}
	for source, want := range map[error]error{
		fmt.Errorf("wrapped: %w", featurecontrol.ErrFeatureDisabled): collaboration.ErrFeatureDisabled,
		content.ErrNotReady:            collaboration.ErrPdfDocumentNotReady,
		content.ErrStorageUnavailable:  collaboration.ErrPdfDocumentNotReady,
		content.ErrDocumentUnsupported: collaboration.ErrPdfDocumentNotReady,
		content.ErrNotFound:            collaboration.ErrNotFound,
		content.ErrAccessDenied:        collaboration.ErrNotFound,
		errors.New("database down"):    collaboration.ErrUnavailable,
	} {
		describer.err = source
		if _, err := resolver.DescribeRoomDocument(context.Background(), access, uuid.New(), fileID); !errors.Is(err, want) {
			t.Fatalf("%v mapped to %v, want %v", source, err, want)
		}
	}
}
