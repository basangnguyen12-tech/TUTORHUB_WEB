package collaboration

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"regexp"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/tutorhub-v2/core-api/internal/policy"
)

// ROOM-TOOLS-CODE-03A (ADR-0043 §4 Slice 3): durable tenant/class-scoped code
// snippets and per-room scratchpads. Every decision about who may read, edit
// or delete is made by the pure functions in this file, which the Postgres
// repository evaluates inside the same transaction that locks the row, so an
// authorization check can never race the write it guards.

const (
	CodeSnippetMaxContentBytes      = 64 * 1024
	CodeSnippetMaxTitleRunes        = 120
	CodeSnippetMaxDescriptionRunes  = 280
	CodeSnippetDefaultPageSize      = 20
	CodeSnippetMaxPageSize          = 50
	CodeSnippetMaxQueryRunes        = 100
	CodeFileNameMaxLength           = 64
	CodeScratchpadMaxFiles          = 8
	CodeScratchpadMaxFileBytes      = 64 * 1024
	CodeScratchpadMaxTotalFileBytes = 256 * 1024
	CodeScratchpadMaxStdinBytes     = 16 * 1024
	CodeScratchpadMaxByteLength     = CodeScratchpadMaxTotalFileBytes + CodeScratchpadMaxStdinBytes
	CodeScratchpadMaxFilesJSONBytes = 300000
	CodeScratchpadTTL               = 30 * 24 * time.Hour
	codeSharedScratchpadListLimit   = 100
)

type CodeSnippetVisibility string

const (
	CodeSnippetPersonal CodeSnippetVisibility = "personal"
	CodeSnippetClass    CodeSnippetVisibility = "class"
)

// CodeLanguages is the exact `code.workspace.v1` language allowlist shared
// with `@tutorhub/collaboration-client` and the 000055 CHECK constraints.
var CodeLanguages = []string{
	"python", "javascript", "typescript", "html", "sql", "c", "cpp", "java", "css",
}

var (
	ErrCodeLibraryForbidden          = errors.New("code library action forbidden")
	ErrCodeSnippetQuotaExceeded      = errors.New("code snippets per member quota exceeded")
	ErrCodeStorageQuotaExceeded      = errors.New("code storage quota exceeded")
	ErrCodeScratchpadVersionConflict = errors.New("code scratchpad version conflict")
	ErrCodeScratchpadEmpty           = errors.New("code scratchpad empty")
	ErrCodeScratchpadTooLarge        = errors.New("code scratchpad too large")
)

var codeFileNamePattern = regexp.MustCompile(`^[A-Za-z0-9_.-]{1,64}$`)

type CodeSnippetViewerCapabilities struct {
	CanEdit   bool `json:"can_edit"`
	CanDelete bool `json:"can_delete"`
}

// CodeSnippetSummary is the list projection. It never carries the raw owner
// identifier; the author is projected by display name only.
type CodeSnippetSummary struct {
	ID                uuid.UUID                     `json:"id"`
	Visibility        CodeSnippetVisibility         `json:"visibility"`
	ClassID           *uuid.UUID                    `json:"class_id"`
	Title             string                        `json:"title"`
	Description       string                        `json:"description"`
	FileName          string                        `json:"file_name"`
	Language          string                        `json:"language"`
	ByteLength        int                           `json:"byte_length"`
	Version           int64                         `json:"version"`
	AuthorDisplayName string                        `json:"author_display_name"`
	Viewer            CodeSnippetViewerCapabilities `json:"viewer_capabilities"`
	CreatedAt         time.Time                     `json:"created_at"`
	UpdatedAt         time.Time                     `json:"updated_at"`
}

type CodeSnippet struct {
	CodeSnippetSummary
	Content       string `json:"content"`
	ContentSHA256 string `json:"content_sha256"`
}

type CodeSnippetList struct {
	Items      []CodeSnippetSummary `json:"items"`
	NextCursor *string              `json:"next_cursor"`
}

// CodeSnippetRecord is server-only repository data. OwnerUserID must never
// be serialized to a public response.
type CodeSnippetRecord struct {
	ID                uuid.UUID
	OwnerUserID       uuid.UUID
	Visibility        CodeSnippetVisibility
	ClassID           uuid.UUID
	Title             string
	Description       string
	FileName          string
	Language          string
	Content           string
	ByteLength        int
	ContentSHA256     []byte
	Version           int64
	AuthorDisplayName string
	CreatedAt         time.Time
	UpdatedAt         time.Time
	Deleted           bool
}

// CodeLibraryClassRelation is the actor's live relation to one class:
// Exists (the class belongs to the tenant), Member (owner or any active
// enrollment) and Staff (owner, active co_teacher or teaching_assistant).
type CodeLibraryClassRelation struct {
	Exists bool
	Member bool
	Staff  bool
}

type CodeSnippetListInput struct {
	Scope    CodeSnippetVisibility
	ClassID  uuid.UUID
	Language string
	Query    string
	Cursor   string
	Limit    int
}

type CodeSnippetCursor struct {
	UpdatedAt time.Time
	ID        uuid.UUID
}

type CodeSnippetListQuery struct {
	Scope    CodeSnippetVisibility
	ClassID  uuid.UUID
	Language string
	// Pattern is an ILIKE pattern whose `\`, `%` and `_` are escaped, or "".
	Pattern string
	After   *CodeSnippetCursor
	// Fetch is the page size plus one sentinel row.
	Fetch int
}

type CodeSnippetPage struct {
	Records  []CodeSnippetRecord
	Relation CodeLibraryClassRelation
}

type CodeSnippetCreateInput struct {
	IdempotencyKey string
	Visibility     CodeSnippetVisibility
	ClassID        uuid.UUID
	Title          string
	Description    string
	FileName       string
	Language       string
	Content        string
}

type CodeSnippetCreateCommand struct {
	SnippetID      uuid.UUID
	IdempotencyKey string
	Fingerprint    []byte
	Visibility     CodeSnippetVisibility
	ClassID        uuid.UUID
	Title          string
	Description    string
	FileName       string
	Language       string
	Content        string
	ByteLength     int
	ContentSHA256  []byte
}

type CodeSnippetCreateResult struct {
	Snippet CodeSnippet
	Created bool
}

type CodeSnippetStoredResult struct {
	Record   CodeSnippetRecord
	Relation CodeLibraryClassRelation
	Created  bool
}

type CodeSnippetUpdateInput struct {
	ExpectedVersion int64
	Title           *string
	Description     *string
	FileName        *string
	Language        *string
	Content         *string
}

type CodeSnippetUpdateCommand struct {
	SnippetID       uuid.UUID
	ExpectedVersion int64
	Title           *string
	Description     *string
	FileName        *string
	Language        *string
	Content         *string
}

type CodeScratchpadFile struct {
	Name     string `json:"name"`
	Language string `json:"language"`
	Content  string `json:"content"`
}

type CodeScratchpad struct {
	ID              uuid.UUID            `json:"id"`
	MediaSpaceID    uuid.UUID            `json:"media_space_id"`
	Files           []CodeScratchpadFile `json:"files"`
	ActiveIndex     int                  `json:"active_index"`
	Stdin           string               `json:"stdin"`
	ByteLength      int                  `json:"byte_length"`
	SharedWithStaff bool                 `json:"shared_with_staff"`
	SharedAt        *time.Time           `json:"shared_at"`
	Version         int64                `json:"version"`
	CreatedAt       time.Time            `json:"created_at"`
	UpdatedAt       time.Time            `json:"updated_at"`
	ExpiresAt       time.Time            `json:"expires_at"`
}

type CodeScratchpadProjection struct {
	Scratchpad *CodeScratchpad `json:"scratchpad"`
}

type CodeScratchpadPutInput struct {
	Files           []CodeScratchpadFile
	ActiveIndex     int
	Stdin           string
	ExpectedVersion int64
}

type CodeScratchpadPutCommand struct {
	MediaSpaceID    uuid.UUID
	FilesJSON       string
	ActiveIndex     int
	Stdin           string
	ByteLength      int
	ExpectedVersion int64
}

// CodeSharedScratchpadSummary is the staff-only list projection of a
// scratchpad whose owner explicitly enabled sharing. The participant key is
// RoomInstance-scoped and only present while the owner is connected.
type CodeSharedScratchpadSummary struct {
	ID                uuid.UUID  `json:"id"`
	AuthorDisplayName string     `json:"author_display_name"`
	ParticipantKey    *uuid.UUID `json:"participant_key"`
	FileCount         int        `json:"file_count"`
	ActiveFileName    string     `json:"active_file_name"`
	ActiveLanguage    string     `json:"active_language"`
	ByteLength        int        `json:"byte_length"`
	SharedAt          time.Time  `json:"shared_at"`
	UpdatedAt         time.Time  `json:"updated_at"`
}

type CodeSharedScratchpad struct {
	CodeSharedScratchpadSummary
	Files       []CodeScratchpadFile `json:"files"`
	ActiveIndex int                  `json:"active_index"`
	Stdin       string               `json:"stdin"`
}

type CodeSharedScratchpadList struct {
	Items []CodeSharedScratchpadSummary `json:"items"`
}

type CodeLibraryRepository interface {
	ListSnippets(context.Context, AccessContext, CodeSnippetListQuery) (CodeSnippetPage, error)
	GetSnippet(context.Context, AccessContext, uuid.UUID) (CodeSnippetRecord, CodeLibraryClassRelation, error)
	CreateSnippet(context.Context, AccessContext, CodeSnippetCreateCommand) (CodeSnippetStoredResult, error)
	UpdateSnippet(context.Context, AccessContext, CodeSnippetUpdateCommand) (CodeSnippetStoredResult, error)
	DeleteSnippet(context.Context, AccessContext, uuid.UUID) error
	GetScratchpad(context.Context, AccessContext, uuid.UUID) (*CodeScratchpad, error)
	PutScratchpad(context.Context, AccessContext, CodeScratchpadPutCommand) (CodeScratchpad, error)
	ShareScratchpad(context.Context, AccessContext, uuid.UUID, bool) (*CodeScratchpad, error)
	DynamicCoHost(context.Context, AccessContext, uuid.UUID, uuid.UUID) (bool, error)
	ListSharedScratchpads(context.Context, AccessContext, uuid.UUID, uuid.UUID, int) ([]CodeSharedScratchpadSummary, error)
	GetSharedScratchpad(context.Context, AccessContext, uuid.UUID, uuid.UUID, uuid.UUID) (CodeSharedScratchpad, error)
}

type CodeLibraryServiceAPI interface {
	ListSnippets(context.Context, AccessContext, CodeSnippetListInput) (CodeSnippetList, error)
	CreateSnippet(context.Context, AccessContext, CodeSnippetCreateInput) (CodeSnippetCreateResult, error)
	GetSnippet(context.Context, AccessContext, uuid.UUID) (CodeSnippet, error)
	UpdateSnippet(context.Context, AccessContext, uuid.UUID, CodeSnippetUpdateInput) (CodeSnippet, error)
	DeleteSnippet(context.Context, AccessContext, uuid.UUID) error
	GetScratchpad(context.Context, AccessContext, uuid.UUID) (CodeScratchpadProjection, error)
	PutScratchpad(context.Context, AccessContext, uuid.UUID, CodeScratchpadPutInput) (CodeScratchpad, error)
	ShareScratchpad(context.Context, AccessContext, uuid.UUID, bool) (CodeScratchpadProjection, error)
	ListSharedScratchpads(context.Context, AccessContext, uuid.UUID) (CodeSharedScratchpadList, error)
	GetSharedScratchpad(context.Context, AccessContext, uuid.UUID, uuid.UUID) (CodeSharedScratchpad, error)
}

func codeLibraryIsAdmin(access AccessContext) bool {
	for _, role := range access.OrganizationRoles {
		if role == policy.OrganizationRoleAdmin {
			return true
		}
	}
	return false
}

// effectiveCodeClassRelation lifts an organization admin to staff of every
// class that exists in the tenant. A class outside the tenant never exists.
func effectiveCodeClassRelation(access AccessContext, relation CodeLibraryClassRelation) CodeLibraryClassRelation {
	if !relation.Exists {
		return CodeLibraryClassRelation{}
	}
	if codeLibraryIsAdmin(access) {
		return CodeLibraryClassRelation{Exists: true, Member: true, Staff: true}
	}
	if relation.Staff {
		relation.Member = true
	}
	return relation
}

// codeSnippetReadable: personal snippets are readable by their owner only;
// class snippets by current class members, class staff and organization
// admins. Deleted snippets are never readable.
func codeSnippetReadable(access AccessContext, record CodeSnippetRecord, relation CodeLibraryClassRelation) bool {
	if record.Deleted || record.ID == uuid.Nil {
		return false
	}
	switch record.Visibility {
	case CodeSnippetPersonal:
		return record.OwnerUserID == access.ActorID
	case CodeSnippetClass:
		return effectiveCodeClassRelation(access, relation).Member
	default:
		return false
	}
}

// codeSnippetCapabilities: the owner manages a personal snippet; a class
// snippet is managed by its owner while still a class member, by class staff
// and by organization admins.
func codeSnippetCapabilities(
	access AccessContext,
	record CodeSnippetRecord,
	relation CodeLibraryClassRelation,
) CodeSnippetViewerCapabilities {
	if !codeSnippetReadable(access, record, relation) {
		return CodeSnippetViewerCapabilities{}
	}
	manage := false
	switch record.Visibility {
	case CodeSnippetPersonal:
		manage = record.OwnerUserID == access.ActorID
	case CodeSnippetClass:
		effective := effectiveCodeClassRelation(access, relation)
		manage = effective.Staff || (record.OwnerUserID == access.ActorID && effective.Member)
	}
	return CodeSnippetViewerCapabilities{CanEdit: manage, CanDelete: manage}
}

// codeSnippetCreateDecision: every active tenant member may create personal
// snippets. Class snippets require class staff or an organization admin; a
// class member without staff rights receives 403, anyone else a concealed
// 404.
func codeSnippetCreateDecision(
	access AccessContext,
	visibility CodeSnippetVisibility,
	relation CodeLibraryClassRelation,
) error {
	switch visibility {
	case CodeSnippetPersonal:
		return nil
	case CodeSnippetClass:
		effective := effectiveCodeClassRelation(access, relation)
		if !effective.Member {
			return ErrNotFound
		}
		if !effective.Staff {
			return ErrCodeLibraryForbidden
		}
		return nil
	default:
		return ErrInvalidRequest
	}
}

// authorizeCodeSnippetUpdate is evaluated against the row locked FOR UPDATE:
// unreadable rows are concealed, readable-but-not-editable rows are 403 and
// a stale optimistic version is a CAS conflict.
func authorizeCodeSnippetUpdate(
	access AccessContext,
	record CodeSnippetRecord,
	relation CodeLibraryClassRelation,
	expectedVersion int64,
) error {
	if !codeSnippetReadable(access, record, relation) {
		return ErrNotFound
	}
	if !codeSnippetCapabilities(access, record, relation).CanEdit {
		return ErrCodeLibraryForbidden
	}
	if record.Version != expectedVersion {
		return ErrVersionConflict
	}
	return nil
}

// authorizeCodeSnippetDelete conceals both missing snippets and snippets the
// viewer may not delete behind the same 404 (ROOM-TOOLS-CODE-03A contract).
func authorizeCodeSnippetDelete(
	access AccessContext,
	record CodeSnippetRecord,
	relation CodeLibraryClassRelation,
) error {
	if !codeSnippetCapabilities(access, record, relation).CanDelete {
		return ErrNotFound
	}
	return nil
}

// authorizeCodeScratchpadWrite is the scratchpad CAS rule: a live draft is
// replaced only at its exact version; creating a first draft, or overwriting
// an expired one, must not assert any version.
func authorizeCodeScratchpadWrite(live bool, currentVersion, expectedVersion int64) error {
	if live {
		if expectedVersion != currentVersion {
			return ErrCodeScratchpadVersionConflict
		}
		return nil
	}
	if expectedVersion != 0 {
		return ErrCodeScratchpadVersionConflict
	}
	return nil
}

// codeStorageRequested returns the tenant usage a write would reach, and
// whether code_storage_bytes_per_tenant must be enforced at all: only growth
// is checked, so an over-quota tenant can always shrink content.
func codeStorageRequested(usedExcludingRow, currentBytes, nextBytes int64) (int64, bool) {
	if nextBytes <= currentBytes {
		return 0, false
	}
	return usedExcludingRow + nextBytes, true
}

func projectCodeSnippetSummary(
	access AccessContext,
	record CodeSnippetRecord,
	relation CodeLibraryClassRelation,
) CodeSnippetSummary {
	summary := CodeSnippetSummary{
		ID: record.ID, Visibility: record.Visibility, Title: record.Title,
		Description: record.Description, FileName: record.FileName, Language: record.Language,
		ByteLength: record.ByteLength, Version: record.Version,
		AuthorDisplayName: record.AuthorDisplayName,
		Viewer:            codeSnippetCapabilities(access, record, relation),
		CreatedAt:         record.CreatedAt.UTC(), UpdatedAt: record.UpdatedAt.UTC(),
	}
	if record.Visibility == CodeSnippetClass && record.ClassID != uuid.Nil {
		classID := record.ClassID
		summary.ClassID = &classID
	}
	return summary
}

func projectCodeSnippet(
	access AccessContext,
	record CodeSnippetRecord,
	relation CodeLibraryClassRelation,
) CodeSnippet {
	return CodeSnippet{
		CodeSnippetSummary: projectCodeSnippetSummary(access, record, relation),
		Content:            record.Content,
		ContentSHA256:      "sha256:" + hex.EncodeToString(record.ContentSHA256),
	}
}

// applyCodeSnippetPatch merges an already validated patch onto the locked
// record and recomputes the derived byte length and content digest.
func applyCodeSnippetPatch(record CodeSnippetRecord, command CodeSnippetUpdateCommand) CodeSnippetRecord {
	if command.Title != nil {
		record.Title = *command.Title
	}
	if command.Description != nil {
		record.Description = *command.Description
	}
	if command.FileName != nil {
		record.FileName = *command.FileName
	}
	if command.Language != nil {
		record.Language = *command.Language
	}
	if command.Content != nil {
		record.Content = *command.Content
		digest := sha256.Sum256([]byte(record.Content))
		record.ContentSHA256 = digest[:]
		record.ByteLength = len(record.Content)
	}
	return record
}

func validCodeLanguage(value string) bool {
	for _, language := range CodeLanguages {
		if value == language {
			return true
		}
	}
	return false
}

func validCodeFileName(value string) bool {
	return codeFileNamePattern.MatchString(value) && strings.Trim(value, ".") != ""
}

// validCodeText accepts UTF-8 text without NUL bytes (PostgreSQL `text`
// cannot store them). Newlines, carriage returns and tabs are code.
func validCodeText(value string, maximumBytes int) bool {
	return len(value) <= maximumBytes && utf8.ValidString(value) && !strings.ContainsRune(value, 0)
}

// validCodeLabel accepts a single-line label without control characters.
func validCodeLabel(value string, minimumRunes, maximumRunes int, multiline bool) bool {
	if !utf8.ValidString(value) {
		return false
	}
	count := utf8.RuneCountInString(value)
	if count < minimumRunes || count > maximumRunes {
		return false
	}
	for _, character := range value {
		if multiline && (character == '\n' || character == '\t') {
			continue
		}
		if unicode.IsControl(character) {
			return false
		}
	}
	return true
}

// escapeCodeSnippetSearch turns user text into a literal ILIKE pattern so `%`
// and `_` can never act as wildcards (`ESCAPE '\'` in the query).
func escapeCodeSnippetSearch(value string) string {
	if value == "" {
		return ""
	}
	replacer := strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`)
	return "%" + replacer.Replace(value) + "%"
}
