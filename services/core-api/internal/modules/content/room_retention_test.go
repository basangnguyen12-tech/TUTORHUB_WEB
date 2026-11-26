package content

import (
	"context"
	"errors"
	"testing"
	"time"
)

type fakeRoomRetention struct {
	*fakeRepository
	limit   int
	targets []roomStorageCleanup
	err     error
}

func (r *fakeRoomRetention) AnchorClosedRoomDocuments(_ context.Context, limit int) (int, error) {
	r.limit = limit
	return 0, nil
}

func (r *fakeRoomRetention) PurgeExpiredRoomDocuments(context.Context, time.Time, int) ([]roomStorageCleanup, error) {
	return r.targets, r.err
}

type fakeRoomCleanupStore struct {
	*fakeMetadataReader
	version, key string
}

func (s *fakeRoomCleanupStore) DeleteVersion(_ context.Context, key, version string) error {
	s.key, s.version = key, version
	return errors.New("test storage outage")
}

func TestRoomRetentionCleanupRunsOnlyAfterSuccessfulBatch(t *testing.T) {
	repo := &fakeRoomRetention{fakeRepository: &fakeRepository{},
		targets: []roomStorageCleanup{{key: "a", version: "v"}, {key: "b", upload: "u"}}}
	store := &fakeRoomCleanupStore{fakeMetadataReader: &fakeMetadataReader{}}
	service, err := NewService(repo, store)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	for _, limit := range []int{-1, 101} {
		if _, err := service.PurgeExpiredRoomDocuments(ctx, limit); !errors.Is(err, ErrInvalidInput) {
			t.Fatalf("invalid limit %d: %v", limit, err)
		}
	}
	repo.err = errors.New("test commit failure")
	if _, err := service.PurgeExpiredRoomDocuments(ctx, 1); err == nil || store.version != "" || store.multipartAbortInput.UploadID != "" {
		t.Fatal("failed database transaction must leave storage untouched")
	}
	repo.err = nil
	if n, err := service.PurgeExpiredRoomDocuments(ctx, 0); err != nil || n != 2 || repo.limit != 25 {
		t.Fatalf("successful batch: purged=%d limit=%d err=%v", n, repo.limit, err)
	}
	if store.key != "a" || store.version != "v" || store.multipartAbortInput.Key != "b" || store.multipartAbortInput.UploadID != "u" {
		t.Fatal("missing exact storage version or multipart abort")
	}
	ctx, cancel := context.WithCancel(ctx)
	cancel()
	service.RunRetentionCleanup(ctx, time.Hour, func(error) { t.Fatal("unexpected cleanup on cancellation") })
}
