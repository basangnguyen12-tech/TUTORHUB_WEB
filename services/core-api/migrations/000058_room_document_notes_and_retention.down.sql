BEGIN;

DROP INDEX tutorhub.media_spaces_document_retention_closed_idx;
DROP INDEX tutorhub.content_files_media_space_retention_idx;
DROP TABLE tutorhub.document_study_notes;

COMMIT;
