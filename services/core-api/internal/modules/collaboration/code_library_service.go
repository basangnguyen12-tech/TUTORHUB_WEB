package collaboration

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/tutorhub-v2/core-api/internal/modules/media"
)

// CodeLibraryService is the server authority for the Slice 3 snippet library
// and per-room scratchpads. Input is validated and canonicalized here; the
// repository re-derives class and ownership authority inside the write
// transaction. Source code, stdin and file names are never logged.
type CodeLibraryService struct {
	repository CodeLibraryRepository
	spaces     SpaceAuthority
	newID      func() uuid.UUID
}

type CodeLibraryServiceConfig struct {
	NewID func() uuid.UUID
}

func NewCodeLibraryService(
	repository CodeLibraryRepository,
	spaces SpaceAuthority,
	configs ...CodeLibraryServiceConfig,
) (*CodeLibraryService, error) {
	if repository == nil || spaces == nil {
		return nil, ErrUnavailable
	}
	service := &CodeLibraryService{repository: repository, spaces: spaces, newID: uuid.New}
	if len(configs) > 0 && configs[0].NewID != nil {
		service.newID = configs[0].NewID
	}
	return service, nil
}

func (service *CodeLibraryService) ListSnippets(
	ctx context.Context,
	access AccessContext,
	input CodeSnippetListInput,
) (CodeSnippetList, error) {
	if !validAccess(access) {
		return CodeSnippetList{}, ErrInvalidRequest
	}
	query, err := normalizeCodeSnippetListInput(access, input)
	if err != nil {
		return CodeSnippetList{}, err
	}
	limit := query.Fetch
	query.Fetch = limit + 1
	page, err := service.repository.ListSnippets(ctx, access, query)
	if err != nil {
		return CodeSnippetList{}, normalizeCodeLibraryError(err)
	}
	if query.Scope == CodeSnippetClass && !effectiveCodeClassRelation(access, page.Relation).Member {
		return CodeSnippetList{}, ErrNotFound
	}
	items := make([]CodeSnippetSummary, 0, min(len(page.Records), limit))
	for _, record := range page.Records {
		if len(items) == limit {
			break
		}
		// Defense in depth: the query is already scoped, but a row that the
		// pure policy does not consider readable is never projected.
		if record.Visibility != query.Scope || !codeSnippetReadable(access, record, page.Relation) {
			continue
		}
		items = append(items, projectCodeSnippetSummary(access, record, page.Relation))
	}
	list := CodeSnippetList{Items: items}
	if len(page.Records) > limit && len(items) > 0 {
		last := items[len(items)-1]
		cursor, err := encodeCodeSnippetCursor(access, input, limit, CodeSnippetCursor{
			UpdatedAt: last.UpdatedAt, ID: last.ID,
		})
		if err != nil {
			return CodeSnippetList{}, err
		}
		list.NextCursor = &cursor
	}
	return list, nil
}

func (service *CodeLibraryService) CreateSnippet(
	ctx context.Context,
	access AccessContext,
	input CodeSnippetCreateInput,
) (CodeSnippetCreateResult, error) {
	if !validAccess(access) {
		return CodeSnippetCreateResult{}, ErrInvalidRequest
	}
	input.IdempotencyKey = strings.TrimSpace(input.IdempotencyKey)
	input.Title = strings.TrimSpace(input.Title)
	if !idempotencyPattern.MatchString(input.IdempotencyKey) ||
		!validCodeSnippetVisibilityScope(input.Visibility, input.ClassID) ||
		!validCodeSnippetFields(input.Title, input.Description, input.FileName, input.Language, input.Content) {
		return CodeSnippetCreateResult{}, ErrInvalidRequest
	}
	digest := sha256.Sum256([]byte(input.Content))
	stored, err := service.repository.CreateSnippet(ctx, access, CodeSnippetCreateCommand{
		SnippetID: service.newID(), IdempotencyKey: input.IdempotencyKey,
		Fingerprint: codeSnippetCreateFingerprint(input, digest[:]),
		Visibility:  input.Visibility, ClassID: input.ClassID, Title: input.Title,
		Description: input.Description, FileName: input.FileName, Language: input.Language,
		Content: input.Content, ByteLength: len(input.Content), ContentSHA256: digest[:],
	})
	if err != nil {
		return CodeSnippetCreateResult{}, normalizeCodeLibraryError(err)
	}
	if !codeSnippetReadable(access, stored.Record, stored.Relation) {
		return CodeSnippetCreateResult{}, ErrNotFound
	}
	return CodeSnippetCreateResult{
		Snippet: projectCodeSnippet(access, stored.Record, stored.Relation), Created: stored.Created,
	}, nil
}

func (service *CodeLibraryService) GetSnippet(
	ctx context.Context,
	access AccessContext,
	snippetID uuid.UUID,
) (CodeSnippet, error) {
	if !validAccess(access) || snippetID == uuid.Nil {
		return CodeSnippet{}, ErrInvalidRequest
	}
	record, relation, err := service.repository.GetSnippet(ctx, access, snippetID)
	if err != nil {
		return CodeSnippet{}, normalizeCodeLibraryError(err)
	}
	if record.ID != snippetID || !codeSnippetReadable(access, record, relation) {
		return CodeSnippet{}, ErrNotFound
	}
	return projectCodeSnippet(access, record, relation), nil
}

func (service *CodeLibraryService) UpdateSnippet(
	ctx context.Context,
	access AccessContext,
	snippetID uuid.UUID,
	input CodeSnippetUpdateInput,
) (CodeSnippet, error) {
	if !validAccess(access) || snippetID == uuid.Nil || input.ExpectedVersion < 1 {
		return CodeSnippet{}, ErrInvalidRequest
	}
	if input.Title == nil && input.Description == nil && input.FileName == nil &&
		input.Language == nil && input.Content == nil {
		return CodeSnippet{}, ErrInvalidRequest
	}
	if input.Title != nil {
		trimmed := strings.TrimSpace(*input.Title)
		input.Title = &trimmed
		if !validCodeLabel(trimmed, 1, CodeSnippetMaxTitleRunes, false) {
			return CodeSnippet{}, ErrInvalidRequest
		}
	}
	if (input.Description != nil && !validCodeLabel(*input.Description, 0, CodeSnippetMaxDescriptionRunes, true)) ||
		(input.FileName != nil && !validCodeFileName(*input.FileName)) ||
		(input.Language != nil && !validCodeLanguage(*input.Language)) ||
		(input.Content != nil && !validCodeText(*input.Content, CodeSnippetMaxContentBytes)) {
		return CodeSnippet{}, ErrInvalidRequest
	}
	stored, err := service.repository.UpdateSnippet(ctx, access, CodeSnippetUpdateCommand{
		SnippetID: snippetID, ExpectedVersion: input.ExpectedVersion,
		Title: input.Title, Description: input.Description, FileName: input.FileName,
		Language: input.Language, Content: input.Content,
	})
	if err != nil {
		return CodeSnippet{}, normalizeCodeLibraryError(err)
	}
	if !codeSnippetReadable(access, stored.Record, stored.Relation) {
		return CodeSnippet{}, ErrNotFound
	}
	return projectCodeSnippet(access, stored.Record, stored.Relation), nil
}

func (service *CodeLibraryService) DeleteSnippet(
	ctx context.Context,
	access AccessContext,
	snippetID uuid.UUID,
) error {
	if !validAccess(access) || snippetID == uuid.Nil {
		return ErrInvalidRequest
	}
	return normalizeCodeLibraryError(service.repository.DeleteSnippet(ctx, access, snippetID))
}

func (service *CodeLibraryService) GetScratchpad(
	ctx context.Context,
	access AccessContext,
	spaceID uuid.UUID,
) (CodeScratchpadProjection, error) {
	if _, err := service.authorizeSpace(ctx, access, spaceID); err != nil {
		return CodeScratchpadProjection{}, err
	}
	scratchpad, err := service.repository.GetScratchpad(ctx, access, spaceID)
	if err != nil {
		return CodeScratchpadProjection{}, normalizeCodeLibraryError(err)
	}
	return CodeScratchpadProjection{Scratchpad: scratchpad}, nil
}

func (service *CodeLibraryService) PutScratchpad(
	ctx context.Context,
	access AccessContext,
	spaceID uuid.UUID,
	input CodeScratchpadPutInput,
) (CodeScratchpad, error) {
	if !validAccess(access) || spaceID == uuid.Nil || input.ExpectedVersion < 0 {
		return CodeScratchpad{}, ErrInvalidRequest
	}
	filesJSON, byteLength, err := canonicalCodeScratchpad(input)
	if err != nil {
		return CodeScratchpad{}, err
	}
	if _, err := service.authorizeSpace(ctx, access, spaceID); err != nil {
		return CodeScratchpad{}, err
	}
	scratchpad, err := service.repository.PutScratchpad(ctx, access, CodeScratchpadPutCommand{
		MediaSpaceID: spaceID, FilesJSON: filesJSON, ActiveIndex: input.ActiveIndex,
		Stdin: input.Stdin, ByteLength: byteLength, ExpectedVersion: input.ExpectedVersion,
	})
	if err != nil {
		return CodeScratchpad{}, normalizeCodeLibraryError(err)
	}
	return scratchpad, nil
}

func (service *CodeLibraryService) ShareScratchpad(
	ctx context.Context,
	access AccessContext,
	spaceID uuid.UUID,
	shared bool,
) (CodeScratchpadProjection, error) {
	if _, err := service.authorizeSpace(ctx, access, spaceID); err != nil {
		return CodeScratchpadProjection{}, err
	}
	scratchpad, err := service.repository.ShareScratchpad(ctx, access, spaceID, shared)
	if err != nil {
		return CodeScratchpadProjection{}, normalizeCodeLibraryError(err)
	}
	return CodeScratchpadProjection{Scratchpad: scratchpad}, nil
}

func (service *CodeLibraryService) ListSharedScratchpads(
	ctx context.Context,
	access AccessContext,
	spaceID uuid.UUID,
) (CodeSharedScratchpadList, error) {
	roomID, err := service.authorizeStaff(ctx, access, spaceID)
	if err != nil {
		return CodeSharedScratchpadList{}, err
	}
	items, err := service.repository.ListSharedScratchpads(ctx, access, spaceID, roomID, codeSharedScratchpadListLimit)
	if err != nil {
		return CodeSharedScratchpadList{}, normalizeCodeLibraryError(err)
	}
	if items == nil {
		items = []CodeSharedScratchpadSummary{}
	}
	return CodeSharedScratchpadList{Items: items}, nil
}

func (service *CodeLibraryService) GetSharedScratchpad(
	ctx context.Context,
	access AccessContext,
	spaceID uuid.UUID,
	scratchpadID uuid.UUID,
) (CodeSharedScratchpad, error) {
	if scratchpadID == uuid.Nil {
		return CodeSharedScratchpad{}, ErrInvalidRequest
	}
	roomID, err := service.authorizeStaff(ctx, access, spaceID)
	if err != nil {
		return CodeSharedScratchpad{}, err
	}
	scratchpad, err := service.repository.GetSharedScratchpad(ctx, access, spaceID, roomID, scratchpadID)
	if err != nil {
		return CodeSharedScratchpad{}, normalizeCodeLibraryError(err)
	}
	if scratchpad.ID != scratchpadID {
		return CodeSharedScratchpad{}, ErrNotFound
	}
	return scratchpad, nil
}

func (service *CodeLibraryService) authorizeSpace(
	ctx context.Context,
	access AccessContext,
	spaceID uuid.UUID,
) (media.MediaSpace, error) {
	if !validAccess(access) || spaceID == uuid.Nil {
		return media.MediaSpace{}, ErrInvalidRequest
	}
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

// authorizeStaff admits only the room's teaching staff: organization admins,
// static hosts/co-hosts, teaching assistants and co-hosts promoted inside
// the active RoomInstance. Everyone else receives the same concealed 404.
func (service *CodeLibraryService) authorizeStaff(
	ctx context.Context,
	access AccessContext,
	spaceID uuid.UUID,
) (uuid.UUID, error) {
	space, err := service.authorizeSpace(ctx, access, spaceID)
	if err != nil {
		return uuid.Nil, err
	}
	roomID := activeRoomInstanceID(space)
	state := CodeWorkspaceViewerState{}
	if roomID != uuid.Nil {
		dynamic, err := service.repository.DynamicCoHost(ctx, access, space.ID, roomID)
		if err != nil {
			return uuid.Nil, normalizeCodeLibraryError(err)
		}
		state.DynamicCoHost = dynamic
	}
	switch codeWorkspaceAudience(access, space, state) {
	case AudienceOrganizationAdmin, AudienceHost, AudienceCoHost, AudienceTeachingAssistant:
		return roomID, nil
	default:
		return uuid.Nil, ErrNotFound
	}
}

func validCodeSnippetVisibilityScope(visibility CodeSnippetVisibility, classID uuid.UUID) bool {
	return (visibility == CodeSnippetPersonal && classID == uuid.Nil) ||
		(visibility == CodeSnippetClass && classID != uuid.Nil)
}

func validCodeSnippetFields(title, description, fileName, language, content string) bool {
	return validCodeLabel(title, 1, CodeSnippetMaxTitleRunes, false) &&
		validCodeLabel(description, 0, CodeSnippetMaxDescriptionRunes, true) &&
		validCodeFileName(fileName) && validCodeLanguage(language) &&
		validCodeText(content, CodeSnippetMaxContentBytes)
}

func normalizeCodeSnippetListInput(access AccessContext, input CodeSnippetListInput) (CodeSnippetListQuery, error) {
	if !validCodeSnippetVisibilityScope(input.Scope, input.ClassID) {
		return CodeSnippetListQuery{}, ErrInvalidRequest
	}
	limit := input.Limit
	if limit == 0 {
		limit = CodeSnippetDefaultPageSize
	}
	if limit < 1 || limit > CodeSnippetMaxPageSize {
		return CodeSnippetListQuery{}, ErrInvalidRequest
	}
	if input.Language != "" && !validCodeLanguage(input.Language) {
		return CodeSnippetListQuery{}, ErrInvalidRequest
	}
	search := strings.TrimSpace(input.Query)
	if search != "" && !validCodeLabel(search, 1, CodeSnippetMaxQueryRunes, false) {
		return CodeSnippetListQuery{}, ErrInvalidRequest
	}
	input.Query = search
	query := CodeSnippetListQuery{
		Scope: input.Scope, ClassID: input.ClassID, Language: input.Language,
		Pattern: escapeCodeSnippetSearch(search), Fetch: limit,
	}
	if strings.TrimSpace(input.Cursor) != "" {
		cursor, err := decodeCodeSnippetCursor(access, input, limit, input.Cursor)
		if err != nil {
			return CodeSnippetListQuery{}, err
		}
		query.After = &cursor
	}
	return query, nil
}

func canonicalCodeScratchpad(input CodeScratchpadPutInput) (string, int, error) {
	if len(input.Files) < 1 || len(input.Files) > CodeScratchpadMaxFiles ||
		input.ActiveIndex < 0 || input.ActiveIndex >= len(input.Files) ||
		!validCodeText(input.Stdin, CodeScratchpadMaxStdinBytes) {
		return "", 0, ErrInvalidRequest
	}
	names := make(map[string]struct{}, len(input.Files))
	files := make([]CodeScratchpadFile, 0, len(input.Files))
	total := 0
	for _, file := range input.Files {
		folded := strings.ToLower(file.Name)
		if _, duplicate := names[folded]; duplicate || !validCodeFileName(file.Name) ||
			!validCodeLanguage(file.Language) || !validCodeText(file.Content, CodeScratchpadMaxFileBytes) {
			return "", 0, ErrInvalidRequest
		}
		names[folded] = struct{}{}
		total += len(file.Content)
		files = append(files, CodeScratchpadFile{Name: file.Name, Language: file.Language, Content: file.Content})
	}
	if total > CodeScratchpadMaxTotalFileBytes {
		return "", 0, ErrInvalidRequest
	}
	var encoded bytes.Buffer
	encoder := json.NewEncoder(&encoded)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(files); err != nil {
		return "", 0, ErrInvalidRequest
	}
	filesJSON := strings.TrimSuffix(encoded.String(), "\n")
	if len(filesJSON) > CodeScratchpadMaxFilesJSONBytes {
		return "", 0, ErrCodeScratchpadTooLarge
	}
	byteLength := total + len(input.Stdin)
	if byteLength > CodeScratchpadMaxByteLength {
		return "", 0, ErrInvalidRequest
	}
	return filesJSON, byteLength, nil
}

// decodeCodeScratchpadFiles re-validates stored JSON before it is projected,
// so a corrupted row fails closed instead of reaching a browser.
func decodeCodeScratchpadFiles(filesJSON string, activeIndex int) ([]CodeScratchpadFile, error) {
	decoder := json.NewDecoder(strings.NewReader(filesJSON))
	decoder.DisallowUnknownFields()
	var files []CodeScratchpadFile
	if err := decoder.Decode(&files); err != nil {
		return nil, ErrUnavailable
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return nil, ErrUnavailable
	}
	if _, _, err := canonicalCodeScratchpad(CodeScratchpadPutInput{Files: files, ActiveIndex: activeIndex}); err != nil {
		return nil, ErrUnavailable
	}
	return files, nil
}

const (
	codeSnippetCursorPrefix        = "thcsv1_"
	maximumCodeSnippetCursorLength = 512
)

type codeSnippetCursorPayload struct {
	UpdatedAt string `json:"updated_at"`
	ID        string `json:"id"`
	ScopeHash string `json:"scope_hash"`
}

func encodeCodeSnippetCursor(
	access AccessContext,
	input CodeSnippetListInput,
	limit int,
	cursor CodeSnippetCursor,
) (string, error) {
	if cursor.ID == uuid.Nil || cursor.UpdatedAt.IsZero() {
		return "", ErrInvalidRequest
	}
	contents, err := json.Marshal(codeSnippetCursorPayload{
		UpdatedAt: cursor.UpdatedAt.UTC().Format(time.RFC3339Nano),
		ID:        cursor.ID.String(),
		ScopeHash: codeSnippetCursorScopeHash(access, input, limit),
	})
	if err != nil {
		return "", ErrInvalidRequest
	}
	return codeSnippetCursorPrefix + base64.RawURLEncoding.EncodeToString(contents), nil
}

// decodeCodeSnippetCursor rejects malformed cursors and cursors minted for a
// different actor, tenant, scope, class, language, search or page size.
func decodeCodeSnippetCursor(
	access AccessContext,
	input CodeSnippetListInput,
	limit int,
	value string,
) (CodeSnippetCursor, error) {
	value = strings.TrimSpace(value)
	if len(value) > maximumCodeSnippetCursorLength || !strings.HasPrefix(value, codeSnippetCursorPrefix) {
		return CodeSnippetCursor{}, ErrInvalidRequest
	}
	contents, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(value, codeSnippetCursorPrefix))
	if err != nil {
		return CodeSnippetCursor{}, ErrInvalidRequest
	}
	decoder := json.NewDecoder(bytes.NewReader(contents))
	decoder.DisallowUnknownFields()
	var payload codeSnippetCursorPayload
	if err := decoder.Decode(&payload); err != nil {
		return CodeSnippetCursor{}, ErrInvalidRequest
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) ||
		payload.ScopeHash != codeSnippetCursorScopeHash(access, input, limit) {
		return CodeSnippetCursor{}, ErrInvalidRequest
	}
	updatedAt, err := time.Parse(time.RFC3339Nano, payload.UpdatedAt)
	if err != nil || updatedAt.IsZero() {
		return CodeSnippetCursor{}, ErrInvalidRequest
	}
	id, err := uuid.Parse(payload.ID)
	if err != nil || id == uuid.Nil || id.String() != payload.ID {
		return CodeSnippetCursor{}, ErrInvalidRequest
	}
	return CodeSnippetCursor{UpdatedAt: updatedAt.UTC(), ID: id}, nil
}

func codeSnippetCursorScopeHash(access AccessContext, input CodeSnippetListInput, limit int) string {
	parts := []string{
		"code-snippets-v1",
		access.TenantID.String(),
		access.ActorID.String(),
		string(input.Scope),
		input.ClassID.String(),
		input.Language,
		strings.TrimSpace(input.Query),
		strconv.Itoa(limit),
	}
	digest := sha256.Sum256([]byte(strings.Join(parts, "\x00")))
	return base64.RawURLEncoding.EncodeToString(digest[:])
}

func codeSnippetCreateFingerprint(input CodeSnippetCreateInput, contentSHA256 []byte) []byte {
	digest := sha256.New()
	for _, part := range []string{
		"code-snippet-create-v1", string(input.Visibility), input.ClassID.String(),
		input.Title, input.Description, input.FileName, input.Language,
	} {
		var length [8]byte
		binary.BigEndian.PutUint64(length[:], uint64(len(part)))
		_, _ = digest.Write(length[:])
		_, _ = digest.Write([]byte(part))
	}
	_, _ = digest.Write(contentSHA256)
	return digest.Sum(nil)
}

func normalizeCodeLibraryError(err error) error {
	if err == nil {
		return nil
	}
	for _, candidate := range []error{
		ErrFeatureDisabled, ErrCodeLibraryForbidden, ErrCodeSnippetQuotaExceeded,
		ErrCodeStorageQuotaExceeded, ErrCodeScratchpadVersionConflict,
		ErrCodeScratchpadEmpty, ErrCodeScratchpadTooLarge,
	} {
		if errors.Is(err, candidate) {
			return candidate
		}
	}
	return normalizeError(err)
}
