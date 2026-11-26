package main

import (
	"context"
	"errors"

	"github.com/google/uuid"
	"github.com/tutorhub-v2/core-api/internal/modules/collaboration"
	"github.com/tutorhub-v2/core-api/internal/modules/content"
	"github.com/tutorhub-v2/core-api/internal/modules/featurecontrol"
)

// pdfRoomDocumentResolver adapts the room document library (content) to the
// PDF presentation control plane (ROOM-TOOLS-FILES-02A). Document visibility
// and readiness are always re-derived by content; collaboration only receives
// URL-free metadata bound to the exact storage version.
type pdfRoomDocumentResolver struct {
	documents content.RoomDocumentDescriber
}

func (resolver pdfRoomDocumentResolver) DescribeRoomDocument(
	ctx context.Context,
	access collaboration.AccessContext,
	spaceID uuid.UUID,
	fileID uuid.UUID,
) (collaboration.PdfRoomDocument, error) {
	if resolver.documents == nil {
		return collaboration.PdfRoomDocument{}, collaboration.ErrUnavailable
	}
	descriptor, err := resolver.documents.DescribeRoomDocument(ctx, content.AccessContext{
		TenantID: access.TenantID, ActorID: access.ActorID,
		MembershipActive: access.MembershipActive, OrganizationRoles: access.OrganizationRoles,
	}, spaceID, fileID)
	if err != nil {
		return collaboration.PdfRoomDocument{}, pdfRoomDocumentError(err)
	}
	return collaboration.PdfRoomDocument{
		FileID: descriptor.FileID, VersionID: descriptor.VersionID,
		DisplayName: descriptor.DisplayName, MediaType: descriptor.MediaType,
		PageCount: descriptor.PageCount, FirstPageAspect: descriptor.FirstPageAspect,
		ActiveContent: descriptor.ActiveContent, AllowStudentDownload: descriptor.AllowStudentDownload,
	}, nil
}

func pdfRoomDocumentError(err error) error {
	switch {
	case errors.Is(err, featurecontrol.ErrFeatureDisabled):
		return collaboration.ErrFeatureDisabled
	case errors.Is(err, content.ErrNotReady), errors.Is(err, content.ErrStorageUnavailable),
		errors.Is(err, content.ErrDocumentUnsupported):
		return collaboration.ErrPdfDocumentNotReady
	case errors.Is(err, content.ErrNotFound), errors.Is(err, content.ErrAccessDenied),
		errors.Is(err, content.ErrInvalidInput), errors.Is(err, featurecontrol.ErrAccessDenied),
		errors.Is(err, featurecontrol.ErrTenantNotFound):
		return collaboration.ErrNotFound
	default:
		return collaboration.ErrUnavailable
	}
}
