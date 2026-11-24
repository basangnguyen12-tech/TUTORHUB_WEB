package conversation

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"io"
	"net/http"
	"path"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/tutorhub-v2/core-api/internal/platform/objectstorage"
)

// ADR-0042 bounded classroom chat attachments.
const (
	AttachmentKindImage AttachmentKind = "image"
	AttachmentKindFile  AttachmentKind = "file"

	MaximumImageAttachmentBytes     = 5 * 1024 * 1024
	MaximumFileAttachmentBytes      = 10 * 1024 * 1024
	MaximumAttachmentsPerMessage    = 4
	maximumAttachmentNameCharacters = 255
	maximumAttachmentDimension      = 16384
	stagedAttachmentLifetime        = 15 * time.Minute
	actorAttachmentRateLimit        = 30
	actorAttachmentRateWindow       = time.Minute

	attachmentBackendB2     = "b2"
	attachmentBackendInline = "inline_dev"

	attachmentStateAttached = "attached"
)

var (
	// ErrAttachmentUnsupported rejects a type outside the server allowlist
	// (SVG, HTML, scripts, executables, unknown binaries).
	ErrAttachmentUnsupported = errors.New("conversation attachment type is not allowed")
	// ErrAttachmentTooLarge rejects bytes above the per-kind bound.
	ErrAttachmentTooLarge = errors.New("conversation attachment is too large")
	// ErrAttachmentsUnavailable means no attachment data plane is configured
	// (staging/production without object storage fail closed).
	ErrAttachmentsUnavailable = errors.New("conversation attachments are unavailable")
	// ErrAttachmentUnavailable means a referenced staged attachment is
	// missing, expired, already sent, or owned by someone else.
	ErrAttachmentUnavailable = errors.New("conversation attachment is unavailable")
)

type AttachmentKind string

type MessageAttachment struct {
	ID             uuid.UUID      `json:"id"`
	ConversationID uuid.UUID      `json:"conversation_id"`
	Kind           AttachmentKind `json:"kind"`
	DisplayName    string         `json:"display_name"`
	MediaType      string         `json:"media_type"`
	SizeBytes      int64          `json:"size_bytes"`
	WidthPx        *int           `json:"width_px,omitempty"`
	HeightPx       *int           `json:"height_px,omitempty"`
	CreatedAt      time.Time      `json:"created_at"`
}

type RoomSettingsInput struct {
	ParticipantChatEnabled bool
}

type UploadAttachmentInput struct {
	ClientAttachmentID uuid.UUID
	FileName           string
	Content            []byte
	WidthPx            *int
	HeightPx           *int
}

type AttachmentUploadResult struct {
	Attachment MessageAttachment
	Created    bool
}

// AttachmentContent streams reauthorized bytes. Callers must close Body.
type AttachmentContent struct {
	Attachment MessageAttachment
	Body       io.ReadCloser
}

// AttachmentStorage selects the attachment data plane. Store (Backblaze B2)
// wins when configured; AllowInline enables bounded inline bytes only for
// development/test environments.
type AttachmentStorage struct {
	Store       objectstorage.Store
	AllowInline bool
}

func (storage AttachmentStorage) available() bool {
	return storage.Store != nil || storage.AllowInline
}

// attachmentRecord is the validated server-side row the repository stores.
type attachmentRecord struct {
	ID                 uuid.UUID
	ClientAttachmentID uuid.UUID
	Fingerprint        []byte
	Kind               AttachmentKind
	DisplayName        string
	MediaType          string
	SizeBytes          int64
	WidthPx            *int
	HeightPx           *int
	Backend            string
	ObjectKey          string
	InlineBytes        []byte
}

// storedAttachment is a reauthorized attached row ready to stream.
type storedAttachment struct {
	Attachment  MessageAttachment
	Backend     string
	ObjectKey   string
	InlineBytes []byte
}

type fileTypeRule struct {
	mediaType string
	accepts   func(sniffed string, content []byte) bool
}

var oleCompoundSignature = []byte{0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1}

func sniffedIs(prefix string) func(string, []byte) bool {
	return func(sniffed string, _ []byte) bool {
		return strings.HasPrefix(sniffed, prefix)
	}
}

func oleCompound(_ string, content []byte) bool {
	return bytes.HasPrefix(content, oleCompoundSignature)
}

func zipContainer(sniffed string, _ []byte) bool {
	return sniffed == "application/zip"
}

func safePlainText(sniffed string, content []byte) bool {
	if !strings.HasPrefix(sniffed, "text/plain") || !utf8.Valid(content) {
		return false
	}
	head := content
	if len(head) > 4096 {
		head = head[:4096]
	}
	lowered := strings.ToLower(string(head))
	for _, marker := range []string{"<svg", "<script", "<html", "<!doctype", "<?xml", "<iframe"} {
		if strings.Contains(lowered, marker) {
			return false
		}
	}
	return true
}

// fileTypeRules is the ADR-0042 lesson-file allowlist keyed by extension; the
// bytes must also match the expected container or text shape.
var fileTypeRules = map[string]fileTypeRule{
	".pdf":  {mediaType: "application/pdf", accepts: sniffedIs("application/pdf")},
	".txt":  {mediaType: "text/plain", accepts: safePlainText},
	".csv":  {mediaType: "text/csv", accepts: safePlainText},
	".md":   {mediaType: "text/markdown", accepts: safePlainText},
	".zip":  {mediaType: "application/zip", accepts: zipContainer},
	".doc":  {mediaType: "application/msword", accepts: oleCompound},
	".xls":  {mediaType: "application/vnd.ms-excel", accepts: oleCompound},
	".ppt":  {mediaType: "application/vnd.ms-powerpoint", accepts: oleCompound},
	".docx": {mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", accepts: zipContainer},
	".xlsx": {mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", accepts: zipContainer},
	".pptx": {mediaType: "application/vnd.openxmlformats-officedocument.presentationml.presentation", accepts: zipContainer},
}

var imageMediaTypes = map[string]struct{}{
	"image/png":  {},
	"image/jpeg": {},
	"image/webp": {},
	"image/gif":  {},
}

// classifyAttachment derives kind and media type from magic bytes. The
// client-declared type is never trusted.
func classifyAttachment(displayName string, content []byte) (AttachmentKind, string, error) {
	if len(content) == 0 {
		return "", "", ErrInvalidInput
	}
	sniffed := http.DetectContentType(content)
	if _, image := imageMediaTypes[sniffed]; image {
		if len(content) > MaximumImageAttachmentBytes {
			return "", "", ErrAttachmentTooLarge
		}
		return AttachmentKindImage, sniffed, nil
	}
	if len(content) > MaximumFileAttachmentBytes {
		return "", "", ErrAttachmentTooLarge
	}
	rule, ok := fileTypeRules[strings.ToLower(path.Ext(displayName))]
	if !ok || !rule.accepts(sniffed, content) {
		return "", "", ErrAttachmentUnsupported
	}
	return AttachmentKindFile, rule.mediaType, nil
}

// normalizeAttachmentName keeps a bounded, printable base name. Directory
// parts, control and bidi-override characters are removed.
func normalizeAttachmentName(value string) string {
	if !utf8.ValidString(value) {
		value = strings.ToValidUTF8(value, "")
	}
	value = strings.ReplaceAll(value, "\\", "/")
	value = path.Base(value)
	var builder strings.Builder
	for _, character := range value {
		if unicode.IsControl(character) || unicode.Is(unicode.Bidi_Control, character) ||
			character == '"' {
			continue
		}
		builder.WriteRune(character)
	}
	value = strings.TrimSpace(builder.String())
	if value == "" || value == "." || value == "/" {
		value = "attachment"
	}
	if utf8.RuneCountInString(value) > maximumAttachmentNameCharacters {
		extension := path.Ext(value)
		if utf8.RuneCountInString(extension) > 16 {
			extension = ""
		}
		runes := []rune(strings.TrimSuffix(value, extension))
		keep := maximumAttachmentNameCharacters - utf8.RuneCountInString(extension)
		value = string(runes[:keep]) + extension
	}
	return value
}

func validAttachmentDimension(value *int) bool {
	return value == nil || (*value >= 1 && *value <= maximumAttachmentDimension)
}

// attachmentFingerprint binds an upload idempotency key to its exact payload.
func attachmentFingerprint(input UploadAttachmentInput, displayName string) []byte {
	digest := sha256.New()
	contentDigest := sha256.Sum256(input.Content)
	digest.Write([]byte(displayName))
	digest.Write([]byte{0})
	for _, dimension := range []*int{input.WidthPx, input.HeightPx} {
		var encoded [8]byte
		if dimension != nil {
			binary.BigEndian.PutUint64(encoded[:], uint64(*dimension))
		}
		digest.Write(encoded[:])
	}
	digest.Write(contentDigest[:])
	return digest.Sum(nil)
}

func attachmentObjectKey(tenantID, attachmentID uuid.UUID) string {
	return "tenants/" + tenantID.String() + "/chat-attachments/" + attachmentID.String()
}
