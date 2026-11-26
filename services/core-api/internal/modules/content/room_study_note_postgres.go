package content

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

const studyNoteOwnerWhere = ` WHERE tenant_id = $1 AND owner_user_id = $2 AND media_space_id = $3 AND content_file_id = $4`

// The note owner always comes from the authenticated access. The same
// transaction gates the features, checks the document, and reads or writes
// only that actor's private row.
func (repository *PostgresRepository) roomStudyNote(
	ctx context.Context, access AccessContext, spaceID, fileID uuid.UUID, now time.Time, input *PutRoomStudyNoteInput,
) (RoomStudyNote, error) {
	ctx, cancel := context.WithTimeout(ctx, repository.queryTimeout)
	defer cancel()
	tx, err := repository.database.Begin(ctx)
	if err != nil {
		return RoomStudyNote{}, err
	}
	defer rollback(tx)
	access, grant, err := repository.requireRoomDocuments(ctx, tx, access, spaceID, input == nil)
	if err != nil {
		return RoomStudyNote{}, err
	}
	doc, _, _, err := repository.loadRoomDocument(ctx, tx, access, grant, fileID, now, input != nil)
	if err != nil {
		return RoomStudyNote{}, err
	}
	if doc.Status != StatusReady || (doc.ExpiresAt.Valid && !now.Before(doc.ExpiresAt.Time)) {
		return RoomStudyNote{}, ErrNotFound
	}
	if !hasRoomViewProof(doc) {
		return RoomStudyNote{}, ErrStorageUnavailable
	}
	note := RoomStudyNote{FileID: fileID, Entries: []StudyNoteEntry{}}
	if input == nil {
		var encoded string
		err = tx.QueryRow(ctx, `SELECT version, notes_json, byte_length, updated_at, expires_at
FROM tutorhub.document_study_notes`+studyNoteOwnerWhere+` AND expires_at > now()`,
			access.TenantID, access.ActorID, spaceID, fileID,
		).Scan(&note.Version, &encoded, &note.ByteLength, &note.UpdatedAt, &note.ExpiresAt)
		if err == nil {
			err = json.Unmarshal([]byte(encoded), &note.Entries)
		} else if errors.Is(err, pgx.ErrNoRows) {
			err = nil
		}
	} else {
		note, err = saveRoomStudyNote(ctx, tx, access, spaceID, fileID, int(doc.PageCount.Int32), *input)
	}
	if err != nil {
		return RoomStudyNote{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return RoomStudyNote{}, err
	}
	return note, nil
}

func saveRoomStudyNote(
	ctx context.Context, tx pgx.Tx, access AccessContext, spaceID, fileID uuid.UUID, pageCount int, input PutRoomStudyNoteInput,
) (RoomStudyNote, error) {
	if input.ExpectedVersion < 0 {
		return RoomStudyNote{}, ErrInvalidInput
	}
	entries, encoded, byteLength, err := normalizeStudyNote(input.Entries, pageCount)
	if err != nil {
		return RoomStudyNote{}, err
	}
	var version int64
	var live bool
	var oldBytes int
	err = tx.QueryRow(ctx, `SELECT version, expires_at > now(), byte_length
FROM tutorhub.document_study_notes`+studyNoteOwnerWhere+` FOR UPDATE`,
		access.TenantID, access.ActorID, spaceID, fileID,
	).Scan(&version, &live, &oldBytes)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return RoomStudyNote{}, err
	}
	if input.ExpectedVersion != version && (live || input.ExpectedVersion != 0) {
		return RoomStudyNote{}, ErrVersionConflict
	}
	// RequireFeature holds the exclusive tenant transaction lock across the
	// count and write, including concurrent writes to different documents.
	if byteLength > 0 && (!live || oldBytes == 0) {
		var active int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM (
 SELECT 1 FROM tutorhub.document_study_notes
 WHERE tenant_id = $1 AND owner_user_id = $2 AND expires_at > now() AND byte_length > 0
 LIMIT $3
) AS active`, access.TenantID, access.ActorID, maxActiveStudyNotes).Scan(&active); err != nil {
			return RoomStudyNote{}, err
		}
		if active >= maxActiveStudyNotes {
			return RoomStudyNote{}, ErrStudyNoteLimitExceeded
		}
	}
	note := RoomStudyNote{FileID: fileID, Entries: entries, ByteLength: byteLength}
	query := `INSERT INTO tutorhub.document_study_notes
 (tenant_id, owner_user_id, media_space_id, content_file_id, notes_json, byte_length, expires_at)
 VALUES ($1, $2, $3, $4, $5, $6, now() + interval '30 days')`
	if version != 0 {
		query = `UPDATE tutorhub.document_study_notes
 SET notes_json = $5, byte_length = $6, version = version + 1,
 updated_at = GREATEST(now(), updated_at), expires_at = GREATEST(now(), updated_at) + interval '30 days'` + studyNoteOwnerWhere
	}
	err = tx.QueryRow(ctx, query+` RETURNING version, updated_at, expires_at`,
		access.TenantID, access.ActorID, spaceID, fileID, encoded, byteLength,
	).Scan(&note.Version, &note.UpdatedAt, &note.ExpiresAt)
	return note, err
}
