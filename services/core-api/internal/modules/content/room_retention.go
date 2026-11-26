package content

import (
	"context"
	"log/slog"
	"time"

	"github.com/tutorhub-v2/core-api/internal/platform/logsafe"
	"github.com/tutorhub-v2/core-api/internal/platform/objectstorage"
)

type roomStorageCleanup struct{ key, version, upload string }

type roomRetentionRepository interface {
	AnchorClosedRoomDocuments(context.Context, int) (int, error)
	PurgeExpiredRoomDocuments(context.Context, time.Time, int) ([]roomStorageCleanup, error)
}

type roomVersionDeleter interface {
	DeleteVersion(context.Context, string, string) error
}

func (service *Service) cleanupRoomObject(ctx context.Context, target roomStorageCleanup) {
	if target.key == "" {
		return
	}
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	if target.version != "" {
		store, ok := service.storage.(roomVersionDeleter)
		if !ok || store.DeleteVersion(ctx, target.key, target.version) != nil {
			slog.Warn("room document cleanup", "error_code", logsafe.String("room_document_version_delete_failed"))
		}
	}
	if target.upload != "" {
		err := service.storage.AbortMultipart(ctx, objectstorage.MultipartAbortInput{Key: target.key, UploadID: target.upload})
		if err != nil {
			slog.Warn("room document cleanup", "error_code", logsafe.String("room_document_multipart_abort_failed"))
		}
	}
}

func (service *Service) PurgeExpiredRoomDocuments(ctx context.Context, limit int) (int, error) {
	if limit == 0 {
		limit = 25
	}
	if limit < 1 || limit > 100 {
		return 0, ErrInvalidInput
	}
	repository, ok := service.repository.(roomRetentionRepository)
	if !ok {
		return 0, ErrUnavailable
	}
	if _, err := repository.AnchorClosedRoomDocuments(ctx, limit); err != nil {
		return 0, err
	}
	targets, err := repository.PurgeExpiredRoomDocuments(ctx, service.now().UTC(), limit)
	if err != nil {
		return 0, err
	}
	for _, target := range targets {
		service.cleanupRoomObject(ctx, target)
	}
	return len(targets), nil
}

func (service *Service) RunRetentionCleanup(ctx context.Context, interval time.Duration, onError func(error)) {
	if interval <= 0 {
		interval = 5 * time.Minute
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if _, err := service.PurgeExpiredRoomDocuments(ctx, 25); err != nil && onError != nil && ctx.Err() == nil {
				onError(ErrUnavailable)
			}
		}
	}
}
