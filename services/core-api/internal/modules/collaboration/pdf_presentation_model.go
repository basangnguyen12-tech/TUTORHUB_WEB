package collaboration

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
)

// ROOM-TOOLS-FILES-02A (ADR-0045 §1, §4 Slice 2): the classroom PDF
// presentation control plane. Each presented (file, version) keeps its own
// lifecycle row, generation and bounded `pdf.annotations.v1` checkpoint, while
// at most one row is `open` per MediaSpace. Students annotate only through
// temporary per-actor grants addressed by opaque participant keys.

const (
	PdfPresentationMaxActiveAnnotators  = 3
	PdfPresentationDefaultAnnotatorTTL  = 10 * time.Minute
	PdfPresentationMinimumAnnotatorTTL  = 60 * time.Second
	PdfPresentationMaximumAnnotatorTTL  = 30 * time.Minute
	PdfPresentationMaximumPages         = 300
	pdfPresentationMaximumGrantResult   = 50
	pdfPresentationMaximumVersionLength = 512
)

var (
	ErrAnnotatorLimitReached    = errors.New("pdf presentation annotator limit reached")
	ErrPdfDocumentNotReady      = errors.New("pdf presentation document not ready")
	errPdfPresentationNoRoomRun = errors.New("pdf presentation has no active room instance")
)

// PdfRoomDocument is the bounded, URL-free metadata of the presented room
// document. It never carries an object key or a presigned URL.
type PdfRoomDocument struct {
	FileID               uuid.UUID `json:"file_id"`
	VersionID            string    `json:"version_id"`
	DisplayName          string    `json:"display_name"`
	MediaType            string    `json:"media_type"`
	PageCount            int       `json:"page_count"`
	FirstPageAspect      float64   `json:"first_page_aspect"`
	ActiveContent        bool      `json:"active_content"`
	AllowStudentDownload bool      `json:"allow_student_download"`
}

// PdfDocumentResolver re-derives document visibility through the room
// document library (content module): the file must belong to the room or its
// linked class, be one of the four viewer media types and be `ready`.
type PdfDocumentResolver interface {
	DescribeRoomDocument(ctx context.Context, access AccessContext, spaceID, fileID uuid.UUID) (PdfRoomDocument, error)
}

type PdfPresentationViewerCapabilities struct {
	Capability               Capability `json:"capability"`
	CanManage                bool       `json:"can_manage"`
	CanSuspend               bool       `json:"can_suspend"`
	CanResume                bool       `json:"can_resume"`
	CanClose                 bool       `json:"can_close"`
	CanManageAnnotatorGrants bool       `json:"can_manage_annotator_grants"`
	CanExchangeGrant         bool       `json:"can_exchange_grant"`
}

type PdfPresentation struct {
	ID                uuid.UUID                         `json:"id"`
	MediaSpaceID      uuid.UUID                         `json:"media_space_id"`
	FileID            uuid.UUID                         `json:"file_id"`
	VersionID         string                            `json:"version_id"`
	PageCount         int                               `json:"page_count"`
	Status            DocumentStatus                    `json:"status"`
	Version           int64                             `json:"version"`
	CurrentGeneration int64                             `json:"current_generation"`
	RevokeGeneration  int64                             `json:"revoke_generation"`
	Document          *PdfRoomDocument                  `json:"document"`
	Viewer            PdfPresentationViewerCapabilities `json:"viewer_capabilities"`
	CreatedAt         time.Time                         `json:"created_at"`
	UpdatedAt         time.Time                         `json:"updated_at"`
}

// PdfAnnotatorGrant is the only public projection of a temporary annotate
// grant; user and session identifiers are never projected.
type PdfAnnotatorGrant struct {
	ParticipantKey uuid.UUID `json:"participant_key"`
	ExpiresAt      time.Time `json:"expires_at"`
}

type PdfPresentationProjection struct {
	Presentation          *PdfPresentation    `json:"presentation"`
	CanPresent            bool                `json:"can_present"`
	ActiveAnnotatorGrants []PdfAnnotatorGrant `json:"active_annotator_grants"`
}

type PdfPresentInput struct {
	FileID         uuid.UUID
	IdempotencyKey string
}

type PdfPresentCommand struct {
	PresentationID       uuid.UUID
	MediaSpaceID         uuid.UUID
	FileID               uuid.UUID
	VersionID            string
	PageCount            int
	ProviderDocumentName string
	IdempotencyKey       string
	Fingerprint          []byte
	OccurredAt           time.Time
}

// PdfPresentResult reports the opened presentation and every presentation of
// the same room that the atomic switch suspended (their leases are revoked).
type PdfPresentResult struct {
	Presentation PdfPresentation
	Created      bool
	Suspended    []uuid.UUID
}

type PdfPresentationTransitionResult struct {
	Presentation PdfPresentation
	Suspended    []uuid.UUID
}

// PdfPresentationViewerState is the server-only dynamic authority of one actor
// inside the active RoomInstance.
type PdfPresentationViewerState struct {
	DynamicCoHost       bool
	ActiveParticipant   bool
	ActiveAnnotateGrant bool
}

type PdfAnnotatorGrantInput struct {
	TTLSeconds *int64
}

type PdfAnnotatorGrantCommand struct {
	PresentationID uuid.UUID
	MediaSpaceID   uuid.UUID
	RoomInstanceID uuid.UUID
	ParticipantKey uuid.UUID
	TTL            time.Duration
	OccurredAt     time.Time
}

type PdfAnnotatorGrantResult struct {
	Grant         PdfAnnotatorGrant
	ActorID       uuid.UUID
	RevokedActors []uuid.UUID
}

type PdfAnnotatorRevokeCommand struct {
	PresentationID uuid.UUID
	MediaSpaceID   uuid.UUID
	RoomInstanceID uuid.UUID
	ParticipantKey uuid.UUID
	OccurredAt     time.Time
}

type PdfAnnotatorRevokeResult struct {
	ActorID uuid.UUID
	Revoked bool
}

type PdfPresentationRepository interface {
	Present(context.Context, AccessContext, PdfPresentCommand) (PdfPresentResult, error)
	Get(context.Context, AccessContext, uuid.UUID) (PdfPresentation, error)
	Current(context.Context, AccessContext, uuid.UUID) (PdfPresentation, error)
	GrantAuthority(context.Context, AccessContext, uuid.UUID) (GrantAuthority, error)
	Transition(context.Context, AccessContext, TransitionCommand) (PdfPresentationTransitionResult, error)
	ViewerState(context.Context, AccessContext, uuid.UUID, uuid.UUID, uuid.UUID) (PdfPresentationViewerState, error)
	ActiveAnnotatorGrants(context.Context, AccessContext, uuid.UUID, uuid.UUID, uuid.UUID) ([]PdfAnnotatorGrant, error)
	PutAnnotatorGrant(context.Context, AccessContext, PdfAnnotatorGrantCommand) (PdfAnnotatorGrantResult, error)
	RevokeAnnotatorGrant(context.Context, AccessContext, PdfAnnotatorRevokeCommand) (PdfAnnotatorRevokeResult, error)
}

type PdfPresentationServiceAPI interface {
	Resolve(context.Context, AccessContext, uuid.UUID) (PdfPresentationProjection, error)
	Present(context.Context, AccessContext, uuid.UUID, PdfPresentInput) (PdfPresentResult, error)
	Suspend(context.Context, AccessContext, uuid.UUID, TransitionInput) (PdfPresentation, error)
	Resume(context.Context, AccessContext, uuid.UUID, TransitionInput) (PdfPresentation, error)
	Close(context.Context, AccessContext, uuid.UUID, TransitionInput) (PdfPresentation, error)
	ExchangeGrant(context.Context, AccessContext, uuid.UUID, GrantExchangeInput) (GrantCredential, error)
	PutAnnotatorGrant(context.Context, AccessContext, uuid.UUID, uuid.UUID, PdfAnnotatorGrantInput) (PdfAnnotatorGrant, error)
	RevokeAnnotatorGrant(context.Context, AccessContext, uuid.UUID, uuid.UUID) error
}
