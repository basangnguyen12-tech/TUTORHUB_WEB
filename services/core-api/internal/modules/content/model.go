package content

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/tutorhub-v2/core-api/internal/modules/media"
	"github.com/tutorhub-v2/core-api/internal/platform/objectstorage"
	"github.com/tutorhub-v2/core-api/internal/policy"
)

const (
	StatusPending    Status = "pending"
	StatusUploaded   Status = "uploaded"
	StatusProcessing Status = "processing"
	StatusReady      Status = "ready"
	StatusRejected   Status = "rejected"
)

var (
	ErrInvalidInput        = errors.New("invalid file input")
	ErrAccessDenied        = errors.New("file access denied")
	ErrNotFound            = errors.New("file not found")
	ErrReadOnly            = errors.New("file class is read only")
	ErrIdempotencyConflict = errors.New("file upload intent idempotency conflict")
	ErrIntentExpired       = errors.New("file upload intent expired")
	ErrQuotaExceeded       = errors.New("file quota exceeded")
	ErrRateLimited         = errors.New("file upload intent rate limited")
	ErrStorageMismatch     = errors.New("stored file metadata mismatch")
	ErrStorageUnavailable  = errors.New("stored file metadata unavailable")
	ErrNotReady            = errors.New("file is not ready for download")
	ErrVersionConflict     = errors.New("file version conflict")
	ErrMultipartConflict   = errors.New("file multipart upload conflict")
	ErrMultipartExpired    = errors.New("file multipart upload expired")
	ErrUnavailable         = errors.New("file metadata unavailable")
	// ErrDocumentUnsupported rejects room document intents outside the four
	// viewer media types or their viewer size bounds (ADR-0045 §2).
	ErrDocumentUnsupported = errors.New("room document media type or size unsupported")
)

type Status string

// OwnerKind is the content_files owner union introduced by migration 000056.
type OwnerKind string

const (
	OwnerKindClass      OwnerKind = "class"
	OwnerKindMediaSpace OwnerKind = "media_space"
)

type AccessContext struct {
	TenantID          uuid.UUID
	ActorID           uuid.UUID
	MembershipActive  bool
	OrganizationRoles []policy.OrganizationRole
	// room is derived by Service from the current MediaSpace, RoomInstance and
	// class roles on every request. It is unexported so transport adapters can
	// never assert room authority themselves.
	room *roomGrant
}

// roomGrant is the server-derived room authority for one MediaSpace.
type roomGrant struct {
	spaceID uuid.UUID
	// classID is the linked class of a class_session room, or uuid.Nil.
	classID   uuid.UUID
	canManage bool
	canView   bool
	writable  bool
}

type File struct {
	ID                     uuid.UUID        `json:"id"`
	ClassID                *uuid.UUID       `json:"class_id"`
	CreatorUserID          uuid.UUID        `json:"creator_user_id"`
	DisplayName            string           `json:"display_name"`
	DeclaredMediaType      string           `json:"declared_media_type"`
	ExpectedSizeBytes      int64            `json:"expected_size_bytes"`
	ExpectedChecksumSHA256 string           `json:"expected_checksum_sha256"`
	Status                 Status           `json:"status"`
	Version                int64            `json:"version"`
	UploadExpiresAt        time.Time        `json:"upload_expires_at"`
	UploadedAt             *time.Time       `json:"uploaded_at,omitempty"`
	CreatedAt              time.Time        `json:"created_at"`
	UpdatedAt              time.Time        `json:"updated_at"`
	OwnerKind              OwnerKind        `json:"owner_kind"`
	MediaSpaceID           *uuid.UUID       `json:"media_space_id"`
	AllowStudentDownload   bool             `json:"allow_student_download"`
	ExpiresAt              *time.Time       `json:"expires_at"`
	PageCount              *int             `json:"page_count"`
	FirstPageAspect        *float64         `json:"first_page_aspect"`
	ActiveContent          bool             `json:"active_content"`
	RejectionReason        *string          `json:"rejection_reason"`
	ViewerAccess           FileViewerAccess `json:"viewer_access"`
}

type FileViewerAccess struct {
	CanDownload    bool `json:"can_download"`
	CanRetryUpload bool `json:"can_retry_upload"`
}

type FileCursor struct {
	CreatedAt time.Time
	ID        uuid.UUID
}

type ListFilesParams struct {
	ClassID uuid.UUID
	Limit   int
	After   *FileCursor
}

type ListFilesResult struct {
	Items     []File
	HasMore   bool
	CanUpload bool
}

type ListFilesInput struct {
	Limit  int
	Cursor string
}

type FilePage struct {
	Items        []File                 `json:"items"`
	NextCursor   string                 `json:"next_cursor,omitempty"`
	ViewerAccess ClassFilesViewerAccess `json:"viewer_access"`
}

type ClassFilesViewerAccess struct {
	CanUpload bool `json:"can_upload"`
}

type CreateIntentInput struct {
	ClassID           uuid.UUID `json:"class_id"`
	DisplayName       string    `json:"display_name"`
	DeclaredMediaType string    `json:"declared_media_type"`
	ExpectedSizeBytes int64     `json:"expected_size_bytes"`
	ChecksumSHA256    string    `json:"checksum_sha256"`
	ClientRequestID   uuid.UUID `json:"client_request_id"`
}

type CreateIntentResult struct {
	File    File
	Created bool
}

type FinalizeInput struct {
	ExpectedVersion  int64  `json:"expected_version"`
	StorageVersionID string `json:"storage_version_id"`
}

type UploadCapabilityInput struct {
	ExpectedVersion int64 `json:"expected_version"`
}

type UploadCapability struct {
	Method             string            `json:"method"`
	URL                string            `json:"url"`
	ExpiresAt          time.Time         `json:"expires_at"`
	ContentLengthBytes int64             `json:"content_length_bytes"`
	RequiredHeaders    map[string]string `json:"required_headers"`
}

type DownloadCapability struct {
	Method    string    `json:"method"`
	URL       string    `json:"url"`
	ExpiresAt time.Time `json:"expires_at"`
}

type MultipartStatus string

const (
	MultipartStatusActive     MultipartStatus = "active"
	MultipartStatusCompleting MultipartStatus = "completing"
	MultipartStatusCompleted  MultipartStatus = "completed"
	MultipartStatusAborted    MultipartStatus = "aborted"
	MultipartStatusExpired    MultipartStatus = "expired"
)

type MultipartUpload struct {
	ID        uuid.UUID       `json:"id"`
	FileID    uuid.UUID       `json:"file_id"`
	Status    MultipartStatus `json:"status"`
	ExpiresAt time.Time       `json:"expires_at"`
}

type CreateMultipartInput struct {
	ExpectedVersion int64 `json:"expected_version"`
}

type MultipartPartCapabilityInput struct {
	ExpectedVersion    int64 `json:"expected_version"`
	ContentLengthBytes int64 `json:"content_length_bytes"`
}

type MultipartPartCapability struct {
	Method             string            `json:"method"`
	URL                string            `json:"url"`
	ExpiresAt          time.Time         `json:"expires_at"`
	PartNumber         int32             `json:"part_number"`
	ContentLengthBytes int64             `json:"content_length_bytes"`
	RequiredHeaders    map[string]string `json:"required_headers"`
}

type MultipartCompletedPart struct {
	PartNumber int32  `json:"part_number"`
	ETag       string `json:"etag"`
}

type CompleteMultipartInput struct {
	ExpectedVersion int64                    `json:"expected_version"`
	Parts           []MultipartCompletedPart `json:"parts"`
}

type CompleteMultipartResult struct {
	Upload           MultipartUpload `json:"upload"`
	StorageVersionID string          `json:"storage_version_id"`
	ETag             string          `json:"etag"`
}

type AbortMultipartInput struct {
	ExpectedVersion int64 `json:"expected_version"`
}

type CreateCommand struct {
	ID                 uuid.UUID
	ClassID            uuid.UUID
	DisplayName        string
	DeclaredMediaType  string
	ExpectedSizeBytes  int64
	ChecksumSHA256     []byte
	ClientRequestID    uuid.UUID
	RequestFingerprint []byte
	ObjectKey          string
	CreatedAt          time.Time
	UploadExpiresAt    time.Time
	// Room document intents (ADR-0045). The zero value is a plain class
	// intent: owner_kind=class, allow_student_download=true, no expiry.
	OwnerKind             OwnerKind
	MediaSpaceID          uuid.UUID
	DenyStudentDownload   bool
	ExpiresAt             *time.Time
	RequireClassroomFiles bool
}

type FinalizeTarget struct {
	File             File
	ObjectKey        string
	StorageVersionID string
}

type FinalizeProof struct {
	ExpectedVersion int64
	ContentLength   int64
	ContentType     string
	ETag            string
	VersionID       string
	FinalizedAt     time.Time
}

type UploadTarget struct {
	File      File
	ObjectKey string
}

type DownloadTarget struct {
	File            File
	ObjectKey       string
	VersionID       string
	StoredMediaType string
}

type MultipartCreateCommand struct {
	ID               uuid.UUID
	FileID           uuid.UUID
	ProviderUploadID string
	ExpectedVersion  int64
	ExpiresAt        time.Time
	CreatedAt        time.Time
}

type MultipartTarget struct {
	Upload             MultipartUpload
	File               File
	ObjectKey          string
	ProviderUploadID   string
	IssuedParts        []MultipartIssuedPart
	CompletedVersionID string
	CompletedETag      string
}

type MultipartIssuedPart struct {
	PartNumber         int32
	ContentLengthBytes int64
}

type MultipartCompleteProof struct {
	VersionID   string
	ETag        string
	CompletedAt time.Time
}

type Repository interface {
	CreateIntent(context.Context, AccessContext, CreateCommand) (CreateIntentResult, error)
	Get(context.Context, AccessContext, uuid.UUID) (File, error)
	List(context.Context, AccessContext, ListFilesParams) (ListFilesResult, error)
	PrepareUpload(context.Context, AccessContext, uuid.UUID, int64, time.Time) (UploadTarget, error)
	PrepareDownload(context.Context, AccessContext, uuid.UUID) (DownloadTarget, error)
	PrepareFinalize(context.Context, AccessContext, uuid.UUID, int64, time.Time) (FinalizeTarget, error)
	CommitFinalize(context.Context, AccessContext, uuid.UUID, FinalizeProof) (File, error)
	PrepareMultipartCreate(context.Context, AccessContext, uuid.UUID, int64, time.Time) (UploadTarget, error)
	CreateMultipart(context.Context, AccessContext, MultipartCreateCommand) (MultipartUpload, error)
	PrepareMultipartPart(context.Context, AccessContext, uuid.UUID, uuid.UUID, int64, int32, int64, time.Time) (MultipartTarget, error)
	PrepareMultipartComplete(context.Context, AccessContext, uuid.UUID, uuid.UUID, int64, []MultipartCompletedPart, time.Time) (MultipartTarget, error)
	ReleaseMultipartComplete(context.Context, AccessContext, uuid.UUID, uuid.UUID) error
	CommitMultipartComplete(context.Context, AccessContext, uuid.UUID, uuid.UUID, MultipartCompleteProof) (MultipartTarget, error)
	PrepareMultipartAbort(context.Context, AccessContext, uuid.UUID, uuid.UUID, int64, time.Time) (MultipartTarget, error)
	CommitMultipartAbort(context.Context, AccessContext, uuid.UUID, uuid.UUID, MultipartStatus, time.Time) (MultipartUpload, error)
}

type ServiceAPI interface {
	CreateIntent(context.Context, AccessContext, CreateIntentInput) (CreateIntentResult, error)
	Get(context.Context, AccessContext, uuid.UUID) (File, error)
	List(context.Context, AccessContext, uuid.UUID, ListFilesInput) (FilePage, error)
	IssueUploadCapability(context.Context, AccessContext, uuid.UUID, UploadCapabilityInput) (UploadCapability, error)
	IssueDownloadCapability(context.Context, AccessContext, uuid.UUID) (DownloadCapability, error)
	Finalize(context.Context, AccessContext, uuid.UUID, FinalizeInput) (File, error)
	CreateMultipart(context.Context, AccessContext, uuid.UUID, CreateMultipartInput) (MultipartUpload, error)
	IssueMultipartPartCapability(context.Context, AccessContext, uuid.UUID, uuid.UUID, int32, MultipartPartCapabilityInput) (MultipartPartCapability, error)
	CompleteMultipart(context.Context, AccessContext, uuid.UUID, uuid.UUID, CompleteMultipartInput) (CompleteMultipartResult, error)
	AbortMultipart(context.Context, AccessContext, uuid.UUID, uuid.UUID, AbortMultipartInput) (MultipartUpload, error)
}

type ObjectStorage interface {
	objectstorage.MetadataReader
	objectstorage.TransferPresigner
	objectstorage.MultipartTransfer
}

// ROOM-TOOLS-FILES-01A (ADR-0045 §2): room document library projections. They
// deliberately omit creator identifiers, object keys and checksums.
type RoomDocumentViewerAccess struct {
	CanView             bool `json:"can_view"`
	CanDownloadOriginal bool `json:"can_download_original"`
	CanManage           bool `json:"can_manage"`
	CanRetryUpload      bool `json:"can_retry_upload"`
}

type RoomDocument struct {
	ID                   uuid.UUID                `json:"id"`
	OwnerKind            OwnerKind                `json:"owner_kind"`
	MediaSpaceID         *uuid.UUID               `json:"media_space_id"`
	ClassID              *uuid.UUID               `json:"class_id"`
	DisplayName          string                   `json:"display_name"`
	DeclaredMediaType    string                   `json:"declared_media_type"`
	ExpectedSizeBytes    int64                    `json:"expected_size_bytes"`
	Status               Status                   `json:"status"`
	Version              int64                    `json:"version"`
	PageCount            *int                     `json:"page_count"`
	FirstPageAspect      *float64                 `json:"first_page_aspect"`
	ActiveContent        bool                     `json:"active_content"`
	AllowStudentDownload bool                     `json:"allow_student_download"`
	RejectionReason      *string                  `json:"rejection_reason"`
	ExpiresAt            *time.Time               `json:"expires_at"`
	UploadedByViewer     bool                     `json:"uploaded_by_viewer"`
	CreatedAt            time.Time                `json:"created_at"`
	UpdatedAt            time.Time                `json:"updated_at"`
	ViewerAccess         RoomDocumentViewerAccess `json:"viewer_access"`
}

type RoomDocumentLibraryAccess struct {
	CanUpload        bool `json:"can_upload"`
	CanUploadToClass bool `json:"can_upload_to_class"`
	CanPresent       bool `json:"can_present"`
	CanManage        bool `json:"can_manage"`
}

type RoomDocumentPage struct {
	Items        []RoomDocument            `json:"items"`
	NextCursor   string                    `json:"next_cursor,omitempty"`
	ViewerAccess RoomDocumentLibraryAccess `json:"viewer_access"`
}

type RoomDocumentListParams struct {
	SpaceID uuid.UUID
	Limit   int
	After   *FileCursor
	Now     time.Time
}

type RoomDocumentListResult struct {
	Items        []RoomDocument
	HasMore      bool
	ViewerAccess RoomDocumentLibraryAccess
}

type RoomDocumentIntentInput struct {
	Scope                OwnerKind
	DisplayName          string
	DeclaredMediaType    string
	ExpectedSizeBytes    int64
	ChecksumSHA256       string
	ClientRequestID      uuid.UUID
	AllowStudentDownload *bool
}

type RoomDocumentViewCapability struct {
	Method             string    `json:"method"`
	URL                string    `json:"url"`
	ExpiresAt          time.Time `json:"expires_at"`
	VersionID          string    `json:"version_id"`
	ContentLengthBytes int64     `json:"content_length_bytes"`
	SHA256             string    `json:"sha256"`
	MediaType          string    `json:"media_type"`
	PageCount          int       `json:"page_count"`
	FirstPageAspect    float64   `json:"first_page_aspect"`
	ActiveContent      bool      `json:"active_content"`
}

type RoomViewTarget struct {
	ObjectKey          string
	VersionID          string
	MediaType          string
	ContentLengthBytes int64
	SHA256             []byte
	PageCount          int
	FirstPageAspect    float64
	ActiveContent      bool
}

type UpdateRoomDocumentInput struct {
	ExpectedVersion      int64
	AllowStudentDownload *bool
	Deleted              bool
}

type UpdateRoomDocumentResult struct {
	Document RoomDocument
	Deleted  bool
}

// FileOwner is an unauthenticated owner lookup used only to decide which
// authority (class policy or room grant) the repository must re-check.
type FileOwner struct {
	Kind         OwnerKind
	MediaSpaceID uuid.UUID
}

// RoomViewerState is the database-fresh room/class authority for one actor.
type RoomViewerState struct {
	OrganizationAdmin bool
	RoomActive        bool
	DynamicCoHost     bool
	ActiveParticipant bool
	ClassStaff        bool
}

type VerificationTarget struct {
	TenantID          uuid.UUID
	FileID            uuid.UUID
	Version           int64
	ObjectKey         string
	StorageVersionID  string
	DeclaredMediaType string
	ExpectedSizeBytes int64
	ExpectedChecksum  []byte
}

type RoomDocumentServiceAPI interface {
	ListRoomDocuments(context.Context, AccessContext, uuid.UUID, ListFilesInput) (RoomDocumentPage, error)
	CreateRoomDocumentIntent(context.Context, AccessContext, uuid.UUID, RoomDocumentIntentInput) (CreateIntentResult, error)
	IssueRoomDocumentViewCapability(context.Context, AccessContext, uuid.UUID, uuid.UUID) (RoomDocumentViewCapability, error)
	UpdateRoomDocument(context.Context, AccessContext, uuid.UUID, uuid.UUID, UpdateRoomDocumentInput) (UpdateRoomDocumentResult, error)
}

// SpaceAuthority is satisfied by media.LifecycleServiceAPI. GetSpace already
// conceals spaces the actor cannot see and returns the server-derived role.
type SpaceAuthority interface {
	GetSpace(context.Context, media.AccessContext, uuid.UUID) (media.MediaSpace, error)
}

// RoomRepository is the optional room-document persistence surface.
type RoomRepository interface {
	FileOwner(context.Context, uuid.UUID, uuid.UUID) (FileOwner, error)
	RoomViewerState(context.Context, AccessContext, uuid.UUID, uuid.UUID, uuid.UUID) (RoomViewerState, error)
	ListRoomDocuments(context.Context, AccessContext, RoomDocumentListParams) (RoomDocumentListResult, error)
	PrepareRoomView(context.Context, AccessContext, uuid.UUID, uuid.UUID, time.Time) (RoomViewTarget, error)
	UpdateRoomDocument(context.Context, AccessContext, uuid.UUID, uuid.UUID, UpdateRoomDocumentInput, time.Time) (UpdateRoomDocumentResult, error)
}

// VerificationRepository persists the P3-10-PDF/Image lifecycle. Its methods
// are system operations scoped by (tenant_id, id) of the claimed row.
type VerificationRepository interface {
	ClaimVerification(context.Context, uuid.UUID, uuid.UUID, time.Time) (VerificationTarget, bool, error)
	CompleteVerification(context.Context, VerificationTarget, VerificationResult, time.Time) (bool, error)
	ClaimStaleVerifications(context.Context, int, time.Time, time.Time) ([]VerificationTarget, error)
}
