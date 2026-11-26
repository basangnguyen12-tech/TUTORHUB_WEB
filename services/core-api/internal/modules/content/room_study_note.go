package content

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"sort"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/tutorhub-v2/core-api/internal/modules/media"
)

var ErrStudyNoteLimitExceeded = errors.New("room document study note limit exceeded")

const (
	maxStudyNoteTextBytes = 64 * 1024
	maxStudyNoteJSONBytes = 96 * 1024
	maxActiveStudyNotes   = 200
)

type StudyNoteEntry struct {
	Page int    `json:"page"`
	Text string `json:"text"`
}

type RoomStudyNote struct {
	FileID     uuid.UUID        `json:"file_id"`
	Version    int64            `json:"version"`
	Entries    []StudyNoteEntry `json:"entries"`
	ByteLength int              `json:"byte_length"`
	UpdatedAt  *time.Time       `json:"updated_at"`
	ExpiresAt  *time.Time       `json:"expires_at"`
}

type PutRoomStudyNoteInput struct {
	ExpectedVersion int64
	Entries         []StudyNoteEntry
}

type roomStudyNoteRepository interface {
	roomStudyNote(context.Context, AccessContext, uuid.UUID, uuid.UUID, time.Time, *PutRoomStudyNoteInput) (RoomStudyNote, error)
}

func (service *Service) GetRoomStudyNote(ctx context.Context, access AccessContext, spaceID, fileID uuid.UUID) (RoomStudyNote, error) {
	return service.roomStudyNote(ctx, access, spaceID, fileID, nil)
}

func (service *Service) PutRoomStudyNote(ctx context.Context, access AccessContext, spaceID, fileID uuid.UUID, input PutRoomStudyNoteInput) (RoomStudyNote, error) {
	return service.roomStudyNote(ctx, access, spaceID, fileID, &input)
}

func (service *Service) roomStudyNote(ctx context.Context, access AccessContext, spaceID, fileID uuid.UUID, input *PutRoomStudyNoteInput) (RoomStudyNote, error) {
	if service == nil {
		return RoomStudyNote{}, ErrUnavailable
	}
	if !validAccess(access) || fileID == uuid.Nil || spaceID == uuid.Nil {
		return RoomStudyNote{}, ErrNotFound
	}
	repository, ok := service.repository.(roomStudyNoteRepository)
	if !ok {
		return RoomStudyNote{}, ErrUnavailable
	}
	access, space, err := service.roomAccess(ctx, access, spaceID)
	if err == nil {
		if !access.room.canView || (!access.room.canManage && space.Status != media.SpaceStatusOpen) {
			return RoomStudyNote{}, ErrNotFound
		}
		var note RoomStudyNote
		note, err = repository.roomStudyNote(ctx, access, spaceID, fileID, service.now().UTC(), input)
		if err == nil {
			return note, nil
		}
	}
	if errors.Is(err, ErrAccessDenied) {
		return RoomStudyNote{}, ErrNotFound
	}
	if errors.Is(err, ErrStudyNoteLimitExceeded) {
		return RoomStudyNote{}, err
	}
	return RoomStudyNote{}, normalizeRepositoryError(err)
}

// Normalize before counting bytes so the stored length matches the returned text.
func normalizeStudyNote(entries []StudyNoteEntry, pageCount int) ([]StudyNoteEntry, string, int, error) {
	if entries == nil || pageCount < 1 {
		return nil, "", 0, ErrInvalidInput
	}
	normalized := make([]StudyNoteEntry, 0)
	pages := make(map[int]bool)
	var byteLength int
	for _, entry := range entries {
		if !utf8.ValidString(entry.Text) || strings.ContainsRune(entry.Text, 0) {
			return nil, "", 0, ErrInvalidInput
		}
		text := strings.ReplaceAll(strings.ReplaceAll(entry.Text, "\r\n", "\n"), "\r", "\n")
		text = strings.TrimRightFunc(text, unicode.IsSpace)
		if text == "" {
			continue
		}
		byteLength += len(text)
		if entry.Page < 1 || entry.Page > pageCount || pages[entry.Page] ||
			len(text) > 4096 || utf8.RuneCountInString(text) > 2000 || byteLength > maxStudyNoteTextBytes {
			return nil, "", 0, ErrInvalidInput
		}
		pages[entry.Page] = true
		normalized = append(normalized, StudyNoteEntry{Page: entry.Page, Text: text})
	}
	sort.Slice(normalized, func(i, j int) bool { return normalized[i].Page < normalized[j].Page })
	var encoded bytes.Buffer
	encoder := json.NewEncoder(&encoded)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(normalized); err != nil {
		return nil, "", 0, ErrInvalidInput
	}
	data := strings.TrimSuffix(encoded.String(), "\n")
	if len(data) > maxStudyNoteJSONBytes {
		return nil, "", 0, ErrInvalidInput
	}
	return normalized, data, byteLength, nil
}
